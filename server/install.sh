#!/usr/bin/env bash
# NRG server setup: n8n + PostgreSQL + Caddy (HTTPS) + daily backups, on a fresh Ubuntu 24.04.
# Run as root:  curl -fsSL https://nrg1c3.github.io/wasl/server/install.sh | bash -s -- [your-domain]
# No domain? Leave it empty and the server uses <ip>.sslip.io with a real HTTPS certificate.
# Safe to run again: it never overwrites an existing .env (that file holds the encryption key).
set -euo pipefail

DOMAIN="${1:-}"
BASE=/opt/nrg
N8N_VERSION="${N8N_VERSION:-latest}"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root (on Hetzner you log in as root)."
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "This script is for Ubuntu (found: ${ID:-unknown})."

say "1/7 Updating the system"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl ufw unattended-upgrades openssl cron
dpkg-reconfigure -f noninteractive unattended-upgrades || true

say "2/7 Adding 2 GB of swap (protects against running out of memory)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "3/7 Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

say "4/7 Firewall: only SSH, HTTP and HTTPS are open"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

IP="$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')"
[ -n "$DOMAIN" ] || DOMAIN="${IP}.sslip.io"

say "5/7 Writing the settings in $BASE (address: https://$DOMAIN)"
mkdir -p "$BASE/backups"
cd "$BASE"

if [ ! -f .env ]; then
  cat > .env <<EOF
DOMAIN=$DOMAIN
N8N_VERSION=$N8N_VERSION
POSTGRES_USER=n8n
POSTGRES_DB=n8n
POSTGRES_PASSWORD=$(openssl rand -hex 24)
N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
TZ=Africa/Cairo
COMPOSE_PROJECT_NAME=nrg
EOF
  chmod 600 .env
else
  sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" .env
fi

cat > docker-compose.yml <<'EOF'
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10

  n8n:
    image: n8nio/n8n:${N8N_VERSION}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_DATABASE: ${POSTGRES_DB}
      DB_POSTGRESDB_USER: ${POSTGRES_USER}
      DB_POSTGRESDB_PASSWORD: ${POSTGRES_PASSWORD}
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
      N8N_HOST: ${DOMAIN}
      N8N_PROTOCOL: https
      N8N_PORT: "5678"
      WEBHOOK_URL: https://${DOMAIN}/
      N8N_PROXY_HOPS: "1"
      GENERIC_TIMEZONE: ${TZ}
      TZ: ${TZ}
      N8N_RUNNERS_ENABLED: "true"
      N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true"
      N8N_DIAGNOSTICS_ENABLED: "false"
      EXECUTIONS_DATA_PRUNE: "true"
      EXECUTIONS_DATA_MAX_AGE: "168"
      EXECUTIONS_DATA_PRUNE_MAX_COUNT: "50000"
    volumes:
      - n8n_data:/home/node/.n8n
    expose:
      - "5678"

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      - n8n
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  pgdata:
  n8n_data:
  caddy_data:
  caddy_config:
EOF

cat > Caddyfile <<'EOF'
{$DOMAIN} {
	encode gzip
	reverse_proxy n8n:5678 {
		header_up X-Real-IP {remote_host}
	}
}
EOF

say "6/7 Daily backup at 3:30 AM Cairo time (keeps the last 14 days)"
cat > backup.sh <<'EOF'
#!/usr/bin/env bash
# Database dump + n8n files, kept for 14 days in /opt/nrg/backups.
set -euo pipefail
cd /opt/nrg
set -a; . ./.env; set +a
STAMP="$(date +%Y-%m-%d_%H%M)"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "backups/db_$STAMP.sql.gz"
docker run --rm -v nrg_n8n_data:/data:ro -v /opt/nrg/backups:/out alpine tar czf "/out/n8n_files_$STAMP.tar.gz" -C /data .
cp .env "backups/env_$STAMP.txt" && chmod 600 "backups/env_$STAMP.txt"
find backups -type f -mtime +14 -delete
echo "backup ok $STAMP"
EOF
chmod 700 backup.sh
( crontab -l 2>/dev/null | grep -v '/opt/nrg/backup.sh' ; echo "30 3 * * * /opt/nrg/backup.sh >> /opt/nrg/backups/backup.log 2>&1" ) | crontab -
timedatectl set-timezone Africa/Cairo || true

say "7/7 Starting n8n (the first start takes 1 to 2 minutes)"
grep -q '^COMPOSE_PROJECT_NAME=' .env || echo 'COMPOSE_PROJECT_NAME=nrg' >> .env
docker compose pull
docker compose up -d

for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "https://$DOMAIN/healthz" 2>/dev/null; then OK=1; break; fi
  sleep 5
done

echo
if [ "${OK:-0}" = 1 ]; then
  say "Done. Open:  https://$DOMAIN"
else
  say "Started. If the page does not open yet, wait 2 minutes, then open:  https://$DOMAIN"
fi
cat <<EOF

  Next:
  1. Open the address above and create the owner account (email + password, only you).
  2. Keep a copy of /opt/nrg/.env somewhere safe. It holds the encryption key; without it
     a backup cannot decrypt your saved credentials.
  3. Send Claude only the address above. Never send passwords or keys in chat.
EOF
