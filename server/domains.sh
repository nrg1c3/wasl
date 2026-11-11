#!/usr/bin/env bash
# NRG server: serve n8n on api.nrg-egypt.com and the short project links.
# Run as root on the server:
#   curl -fsSL https://raw.githubusercontent.com/nrg1c3/wasl/main/server/domains.sh | bash
# Safe to run again (after editing the links file, run it again).
# The short links live ONLY on the server, in /opt/nrg/links.txt (this repo is public, so the list is not kept here).
# One line per link:   host   path   where-it-goes    ("/" is the address itself and catches any other path)
# - The old address (<ip>.sslip.io) keeps working next to the new one.
# - A host is only added once its DNS points at this server, so no failed certificates.
# - n8n moves to the new address only after https://api.../healthz answers.
# - Before changing anything it saves .env and Caddyfile in /opt/nrg/backups.
set -euo pipefail

API_HOST="${API_HOST:-api.nrg-egypt.com}"
LINKS_FILE="${LINKS_FILE:-/opt/nrg/links.txt}"
BASE=/opt/nrg

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root."
[ -f "$BASE/.env" ] && [ -f "$BASE/docker-compose.yml" ] || die "No n8n setup in $BASE. Run install.sh first."
cd "$BASE"

IP="$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')"
OLD_HOST="${IP}.sslip.io"
resolves_here() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -qx "$IP"; }

say "1/5 Saving a copy of the settings"
STAMP="$(date +%Y-%m-%d_%H%M)"
mkdir -p backups
cp .env "backups/env_before_domains_$STAMP.txt" && chmod 600 "backups/env_before_domains_$STAMP.txt"
cp Caddyfile "backups/Caddyfile_before_domains_$STAMP.txt"

say "2/5 Checking which addresses already point at this server ($IP)"
[ -f "$LINKS_FILE" ] || die "No links file at $LINKS_FILE. Nothing was changed. (Without it the short links would be removed.)"
LINKS="$(cat "$LINKS_FILE")"
HOSTS="$API_HOST $(printf '%s\n' "$LINKS" | awk '!/^[[:space:]]*#/ && NF>=3 {print $1}' | sort -u | tr '\n' ' ')"
READY=""; WAIT=""
for h in $HOSTS; do
  if resolves_here "$h"; then READY="$READY $h"; echo "   ready:   $h"; else WAIT="$WAIT $h"; echo "   waiting: $h (DNS not pointing here yet)"; fi
done
resolves_here "$API_HOST" || die "$API_HOST does not point at $IP yet. Add the DNS record, wait 15 minutes, then run this again. Nothing was changed."

say "3/5 Writing the web server settings"
{
  echo "# managed by domains.sh: edit $LINKS_FILE on this server and run domains.sh again"
  echo "(n8n) {"
  echo "	encode gzip"
  echo "	reverse_proxy n8n:5678 {"
  echo "		header_up X-Real-IP {remote_host}"
  echo "	}"
  echo "}"
  echo "$OLD_HOST {"
  echo "	import n8n"
  echo "}"
  echo "$API_HOST {"
  echo "	import n8n"
  echo "}"
  for h in $READY; do
    [ "$h" = "$API_HOST" ] && continue
    echo "$h {"
    # specific paths first, then "/" as the catch-all for this host
    printf '%s\n' "$LINKS" | awk -v h="$h" '!/^[[:space:]]*#/ && NF>=3 && $1==h && $2!="/" {printf "\thandle %s {\n\t\tredir %s 302\n\t}\n", $2, $3}'
    printf '%s\n' "$LINKS" | awk -v h="$h" '!/^[[:space:]]*#/ && NF>=3 && $1==h && $2=="/" {printf "\thandle {\n\t\tredir %s 302\n\t}\n", $3}'
    echo "}"
  done
} > Caddyfile.new

docker run --rm -v "$BASE/Caddyfile.new:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
  || die "The new settings did not pass the check. Nothing was changed. (See $BASE/Caddyfile.new)"
cat Caddyfile.new > Caddyfile   # same file, so the running web server sees it
rm -f Caddyfile.new
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

say "4/5 Waiting for the certificate of https://$API_HOST (up to 3 minutes)"
OK=0
for i in $(seq 1 36); do
  if curl -fsS -o /dev/null "https://$API_HOST/healthz" 2>/dev/null; then OK=1; break; fi
  sleep 5
done
[ "$OK" = 1 ] || die "https://$API_HOST does not answer yet. The old address still works. Run this again in 10 minutes."

say "5/5 Moving n8n to https://$API_HOST (webhooks stop for about 30 seconds)"
if grep -q "^DOMAIN=$API_HOST$" .env; then
  echo "   n8n is already on $API_HOST"
else
  sed -i "s/^DOMAIN=.*/DOMAIN=$API_HOST/" .env
  docker compose up -d n8n caddy
  for i in $(seq 1 36); do
    if curl -fsS -o /dev/null "https://$API_HOST/healthz" 2>/dev/null; then break; fi
    sleep 5
  done
fi

echo
say "Done."
echo "   n8n:          https://$API_HOST   (old address still works: https://$OLD_HOST)"
for h in $READY; do [ "$h" = "$API_HOST" ] || echo "   short link:   https://$h"; done
[ -z "$WAIT" ] || warn "Not added yet (DNS not ready):$WAIT  -> run this again later."
echo
echo "   Tell Claude: \"domains.sh done\". Never send passwords or keys in chat."
