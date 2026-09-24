#!/usr/bin/env bash
#
# Provision a fresh Ubuntu 24.04 server for DBL HRM. Run once, as root:
#
#   sudo bash /root/dbl-hrm-setup/setup-server.sh
#
# Installs everything the app needs and nothing of the app itself — cloning,
# .env and the first ./deploy.sh are the operator's, see README.md beside this.
# Safe to re-run: every step checks before it acts, and the database password
# is only generated when the role does not exist yet.
#
# Overridable: APP_USER (dbl-hrm), APP_HOME (/home/dbl-hrm),
#              DOMAIN (talenthub.dbl-group.com), DB_NAME (dbl_hrm), DB_USER (dbl_hrm)

set -euo pipefail

APP_USER="${APP_USER:-dbl-hrm}"
APP_HOME="${APP_HOME:-/home/dbl-hrm}"
DOMAIN="${DOMAIN:-talenthub.dbl-group.com}"
DB_NAME="${DB_NAME:-dbl_hrm}"
DB_USER="${DB_USER:-dbl_hrm}"
PG_VERSION=18
NODE_MAJOR=22
WEB_ROOT=/var/www/dbl-hrm
SSL_DIR=/etc/nginx/ssl
CRED_FILE=/root/dbl-hrm-db-credentials
HERE="$(cd "$(dirname "$0")" && pwd)"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[1;31msetup failed:\033[0m %s\n' "$1" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

[ "$(id -u)" = 0 ] || die "run as root (sudo bash $0)."
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || note "warning: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}."

# apt reports a DNS failure as a wall of "Ign:" lines and then installs
# nothing. Say it once, plainly, before starting.
for h in archive.ubuntu.com deb.nodesource.com apt.postgresql.org github.com registry.npmjs.org; do
  getent hosts "$h" >/dev/null \
    || die "cannot resolve $h — fix DNS (or the proxy) first; see README.md, 'Before you start'."
done

# ── Base ────────────────────────────────────────────────────────────────────

say "Base packages"
apt-get update
apt-get -y upgrade
apt-get install -y git curl wget rsync unzip ca-certificates gnupg lsb-release \
  build-essential dos2unix htop ufw openssl fontconfig unattended-upgrades fail2ban

# Security patches install themselves; SSH guessing gets banned (default
# sshd jail: 5 failures → 10 min ban).
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now unattended-upgrades
cat > /etc/fail2ban/jail.d/sshd.local <<'JAIL'
[sshd]
enabled = true
backend = systemd
JAIL
systemctl enable fail2ban
systemctl restart fail2ban || note "warning: fail2ban did not start — check 'journalctl -u fail2ban'; continuing."

# The ZingHR sync cron (36 20 * * *) is read in the server's local time, and
# the old server ran on Dhaka time.
timedatectl set-timezone Asia/Dhaka

# ── Node.js + PM2 ───────────────────────────────────────────────────────────

say "Node.js $NODE_MAJOR"
if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
note "node $(node -v), npm $(npm -v)"

say "PM2"
command -v pm2 >/dev/null || npm install -g pm2
note "pm2 $(pm2 -v)"

# ── PostgreSQL ──────────────────────────────────────────────────────────────

say "PostgreSQL $PG_VERSION"
# Ubuntu's own archive stops at 16; the dev machines run 18, and pg_dump must
# be at least the server's version or deploy.sh's pre-migration backup fails.
PGDG_KEY=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
if [ ! -f "$PGDG_KEY" ]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o "$PGDG_KEY" https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=$PGDG_KEY] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update
fi
apt-get install -y "postgresql-$PG_VERSION" "postgresql-client-$PG_VERSION"

# Sized for this box (~6 GB RAM shared with Node and Chromium). Localhost
# only: the API is the one client, and it is on this machine.
PG_CONF_D="/etc/postgresql/$PG_VERSION/main/conf.d"
mkdir -p "$PG_CONF_D"
cat > "$PG_CONF_D/dbl-hrm.conf" <<'CONF'
listen_addresses = 'localhost'
shared_buffers = 1GB
effective_cache_size = 3GB
maintenance_work_mem = 256MB
work_mem = 16MB
CONF
systemctl enable --now postgresql
systemctl restart postgresql

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  # Hex, so the password never needs URL-encoding inside DATABASE_URL.
  DB_PASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$DB_PASS';"
  umask 077
  cat > "$CRED_FILE" <<CRED
# Written by setup-server.sh on $(date -Is). Copy DATABASE_URL into
# $APP_HOME/HRM_Backend/.env, then delete this file.
DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME?schema=public&connection_limit=20&pool_timeout=10"
CRED
  note "created role $DB_USER — DATABASE_URL written to $CRED_FILE"
else
  note "role $DB_USER already exists — password left alone"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  note "created database $DB_NAME"
fi

# ── Chromium runtime (puppeteer PDFs) ───────────────────────────────────────

say "Chromium libraries"
# Puppeteer downloads its own Chromium on npm ci, but not the shared
# libraries it links against; without these every letter PDF fails.
apt-get install -y libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libdrm2 libdbus-1-3 libexpat1 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
  libgtk-3-0t64 libx11-xcb1

say "Fonts"
# The letters ask for Times New Roman, Arial and Calibri (letters.ts,
# coc-form.ts). Carlito is metric-compatible with Calibri, so page breaks
# land where they do on Windows; Noto covers Bangla names.
echo ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true | debconf-set-selections
apt-get install -y ttf-mscorefonts-installer fonts-crosextra-carlito fonts-liberation \
  fonts-noto-core fonts-noto-color-emoji
fc-cache -f >/dev/null

# ── App user ────────────────────────────────────────────────────────────────

say "App user '$APP_USER' in $APP_HOME"
# A system account with no password: nobody can SSH in as it or su to it with
# a guess — the only way in is `sudo -iu dbl-hrm` from an admin. Its home is the
# app folder, so the checkouts, .env files, PM2 state, puppeteer's Chromium,
# the git token and the database dumps all live under one directory.
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash "$APP_USER"
fi
[ "$(getent passwd "$APP_USER" | cut -d: -f6)" = "$APP_HOME" ] \
  || die "user $APP_USER exists with a different home — expected $APP_HOME."
passwd -l "$APP_USER" >/dev/null
# 0750 on the top folder is the lock: no other account (nginx included) can
# even list it, whatever the permissions inside. The backups hold every
# employee record, so they are owner-only on top of that.
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$APP_HOME"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$APP_HOME/backups"
# deploy.sh dumps to $BACKUP_DIR before every migration; point it here.
PROFILE="$APP_HOME/.profile"
touch "$PROFILE"
grep -q '^export BACKUP_DIR=' "$PROFILE" || echo "export BACKUP_DIR=\"$APP_HOME/backups\"" >> "$PROFILE"
chown "$APP_USER:$APP_USER" "$PROFILE"
# nginx only ever sees the built SPA — public files, nothing else.
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$WEB_ROOT"
note "app $APP_HOME (750), backups $APP_HOME/backups (700), web root $WEB_ROOT"

# PM2 runs as the app user, never root: npm ci puts puppeteer's Chromium in
# that user's ~/.cache, so the user who deploys must be the user who runs.
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
systemctl enable "pm2-$APP_USER" >/dev/null
sudo -u "$APP_USER" -H bash -lc '
  pm2 describe pm2-logrotate >/dev/null 2>&1 || pm2 install pm2-logrotate
  pm2 set pm2-logrotate:max_size 20M
  pm2 set pm2-logrotate:retain 14
  pm2 set pm2-logrotate:compress true
' >/dev/null
note "pm2-$APP_USER.service enabled, log rotation 20M × 14"

# ── nginx ───────────────────────────────────────────────────────────────────

say "nginx"
apt-get install -y nginx
mkdir -p "$SSL_DIR"
CRT="$SSL_DIR/$DOMAIN.crt"
KEY="$SSL_DIR/$DOMAIN.key"
if [ ! -f "$CRT" ] || [ ! -f "$KEY" ]; then
  # nginx will not start with a missing certificate, so put a short-lived
  # self-signed one in its place. Replace it with the real one (copied from
  # the old server) before go-live — README.md, step 5.
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=$DOMAIN" \
    -keyout "$KEY" -out "$CRT" 2>/dev/null
  note "no certificate found — installed a SELF-SIGNED placeholder at $CRT"
fi
chmod 600 "$KEY"
install -m 644 "$HERE/dbl-hrm-security-headers.conf" /etc/nginx/snippets/dbl-hrm-security-headers.conf
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__WEB_ROOT__|$WEB_ROOT|g" \
    "$HERE/dbl-hrm.nginx.conf" > /etc/nginx/sites-available/dbl-hrm
ln -sf /etc/nginx/sites-available/dbl-hrm /etc/nginx/sites-enabled/dbl-hrm
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# ── Firewall ────────────────────────────────────────────────────────────────

say "Firewall"
# SSH first, or enabling the firewall locks this session out.
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'

say "Server ready"
note "Node $(node -v) · PM2 $(pm2 -v) · $(psql --version) · $(nginx -v 2>&1)"
[ -f "$CRED_FILE" ] && note "Database credentials: $CRED_FILE"
note "Next: README.md beside this script, step 2 (sudo -iu $APP_USER)."
