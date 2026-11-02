#!/usr/bin/env bash
# NRG server: copy the daily backups (/opt/nrg/backups) to a Hetzner Storage Box, every day.
# Run once as root on the server:
#   curl -fsSL -o o.sh raw.githubusercontent.com/nrg1c3/wasl/main/server/offsite.sh
#   bash o.sh u123456
# (u123456 = the Storage Box username from the Hetzner console; the address is built from it.)
# The first run asks for the Storage Box password ONCE, to install this server's key. Never send that password to anyone.
# Safe to run again.
set -euo pipefail

BOX_USER="${1:-}"
[ -n "$BOX_USER" ] || { echo "Usage: bash o.sh <storage-box-username>   (example: bash o.sh u123456)"; exit 1; }
[[ "$BOX_USER" =~ ^u[0-9]+(-sub[0-9]+)?$ ]] || { echo "That does not look like a Storage Box username (it starts with u and numbers)."; exit 1; }
BOX_HOST="${BOX_HOST:-$BOX_USER.your-storagebox.de}"
BASE=/opt/nrg
KEY=/root/.ssh/nrg_offsite
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root."
[ -d "$BASE/backups" ] || die "No backups folder in $BASE. Run install.sh first."
command -v rsync >/dev/null || { apt-get update -y && apt-get install -y rsync; }

say "1/4 Making a key for this server (only once)"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -t ed25519 -N '' -C "nrg-server-offsite" -f "$KEY" >/dev/null
ssh-keygen -F "[$BOX_HOST]:23" >/dev/null 2>&1 || ssh-keyscan -p 23 "$BOX_HOST" >> /root/.ssh/known_hosts 2>/dev/null

say "2/4 Giving the key to the Storage Box"
if ssh -p 23 -i "$KEY" -o BatchMode=yes "$BOX_USER@$BOX_HOST" ls >/dev/null 2>&1; then
  echo "   the key already works"
else
  echo "   Type the Storage Box password when asked (it is not saved anywhere):"
  ssh -p 23 "$BOX_USER@$BOX_HOST" install-ssh-key < "$KEY.pub" || die "Could not install the key. In the Hetzner console, check that SSH support is ON for the Storage Box, then run this again."
  ssh -p 23 -i "$KEY" -o BatchMode=yes "$BOX_USER@$BOX_HOST" ls >/dev/null 2>&1 || die "The key still does not work. Run this again in a few minutes."
fi

say "3/4 Writing the daily copy job"
cat > "$BASE/offsite_copy.sh" <<EOF
#!/usr/bin/env bash
# Mirrors /opt/nrg/backups to the Storage Box folder nrg-backups/ (managed by offsite.sh).
set -euo pipefail
rsync -a --delete -e "ssh -p 23 -i $KEY -o BatchMode=yes" /opt/nrg/backups/ "$BOX_USER@$BOX_HOST:nrg-backups/"
echo "offsite ok \$(date +%Y-%m-%d_%H%M)"
EOF
chmod 700 "$BASE/offsite_copy.sh"
# 04:30 Cairo time, one hour after the local backup (03:30)
{ crontab -l 2>/dev/null | grep -v '/opt/nrg/offsite_copy.sh' || true; echo "30 4 * * * /opt/nrg/offsite_copy.sh >> /opt/nrg/backups/offsite.log 2>&1"; } | crontab -

say "4/4 First copy now"
"$BASE/offsite_copy.sh"

echo
say "Done. Every day at 4:30 AM the backups are copied to $BOX_HOST (folder nrg-backups)."
echo "   Tell Claude: \"offsite done\". Never send passwords in chat."
