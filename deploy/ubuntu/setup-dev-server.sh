#!/usr/bin/env bash
#
# One-time setup of the DEV server (https://talenthub.dbl-group.com:4500),
# run as the dbl-hrm user after the root steps in DEV_SERVER.md.
#
#   ~/HRM_Backend/deploy/ubuntu/setup-dev-server.sh
#
# Safe to run again: anything already in place is left alone.
#
# It makes ~/dev/HRM_Backend and ~/dev/HRM_Frontend on the `dev` branch,
# writes their .env files from the live ones (with the dev settings below),
# makes the first copy of the live database, deploys the dev app as
# hrm-backend-dev, and adds the nightly copy to the crontab.

set -euo pipefail

DOMAIN="${DOMAIN:-talenthub.dbl-group.com}"
PROD_DIR="$HOME/HRM_Backend"
PROD_FE="$HOME/HRM_Frontend"
DEV_ROOT="$HOME/dev"
DEV_BE="$DEV_ROOT/HRM_Backend"
DEV_FE="$DEV_ROOT/HRM_Frontend"
WEB_ROOT_DEV="${WEB_ROOT_DEV:-/var/www/dbl-hrm-dev}"
PASS_FILE="$HOME/.dev-db-pass"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[1;31msetup failed:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -un)" = "dbl-hrm" ] || die "run this as the dbl-hrm user (sudo -iu dbl-hrm)."
[ -f "$PROD_DIR/.env" ] || die "no live backend at $PROD_DIR."
[ -d "$WEB_ROOT_DEV" ] && [ -w "$WEB_ROOT_DEV" ] || die "$WEB_ROOT_DEV is missing or not writable — do the root steps in DEV_SERVER.md first."

mkdir -p "$DEV_ROOT"

# ── 1. Checkouts on the dev branch ──────────────────────────────────────────
say "Dev checkouts (branch dev)"
for pair in "$PROD_DIR:$DEV_BE" "$PROD_FE:$DEV_FE"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  if [ -d "$dst/.git" ]; then
    note "$dst already there"
  else
    url="$(git -C "$src" remote get-url origin)"
    git clone --branch dev "$url" "$dst" || die "could not clone the dev branch of $url"
  fi
done

# ── 2. .env files ───────────────────────────────────────────────────────────
# Copy a setting's line from the live .env, replaced if we set it.
set_env() { # file key value
  local f="$1" k="$2" v="$3"
  if grep -q "^$k=" "$f"; then
    # Escape for sed's replacement side.
    local esc; esc="$(printf '%s' "$v" | sed -e 's/[\/&|]/\\&/g')"
    sed -i "s|^$k=.*|$k=$esc|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

say "Dev backend .env"
if [ -f "$DEV_BE/.env" ]; then
  note "already there — left as it is"
else
  [ -f "$PASS_FILE" ] || die "no $PASS_FILE — the root steps write the dev database password there."
  DEV_DB_PASS="$(tr -d '[:space:]' < "$PASS_FILE")"
  cp "$PROD_DIR/.env" "$DEV_BE/.env"
  chmod 600 "$DEV_BE/.env"
  set_env "$DEV_BE/.env" PORT 4600
  set_env "$DEV_BE/.env" SANDBOX_MODE true
  set_env "$DEV_BE/.env" DATABASE_URL "\"postgresql://dbl_hrm_dev:$DEV_DB_PASS@127.0.0.1:5432/postgres?schema=public\""
  # Its own signing key: a live session must never open the dev site, nor
  # the other way round. TOTP_ENCRYPTION_KEY stays the live one, so people
  # with an authenticator app can still sign in to the copy.
  set_env "$DEV_BE/.env" JWT_SECRET "$(openssl rand -hex 32)"
  set_env "$DEV_BE/.env" CORS_ORIGIN "https://$DOMAIN:4500"
  set_env "$DEV_BE/.env" FRONTEND_URL "https://$DOMAIN:4500"
  # Belt and braces: sandbox mode already holds every email.
  set_env "$DEV_BE/.env" MAIL_USER ""
  set_env "$DEV_BE/.env" MAIL_APP_PASSWORD ""
  set_env "$DEV_BE/.env" ZINGHR_SYNC_ENABLED false
  set_env "$DEV_BE/.env" PM2_APP_NAME hrm-backend-dev
  set_env "$DEV_BE/.env" PM2_MAX_MEMORY 800M
  set_env "$DEV_BE/.env" DEPLOY_BRANCH dev
  set_env "$DEV_BE/.env" DEPLOY_SKIP_BACKUP 1
  rm -f "$PASS_FILE"
  note "written (the password file was removed)"
fi

say "Dev frontend .env"
if [ -f "$DEV_FE/.env" ]; then
  note "already there — left as it is"
else
  cp "$PROD_FE/.env" "$DEV_FE/.env"
  set_env "$DEV_FE/.env" VITE_API_BASE_URL "https://$DOMAIN:4500/api"
  note "written"
fi
echo "$WEB_ROOT_DEV" > "$DEV_FE/.deploy-target"

# ── 3. First copy of the live database ──────────────────────────────────────
say "Installing the dev backend's tools"
( cd "$DEV_BE" && npm ci --no-audit --no-fund && npm run prisma:generate ) >/dev/null

say "First copy of the live database"
"$DEV_BE/deploy/ubuntu/dev-clone-db.sh" || die "the database copy failed — see above."

# ── 4. Deploy the dev app ───────────────────────────────────────────────────
say "Deploying the dev site"
( cd "$DEV_BE" && ./deploy.sh ) || die "the dev deploy failed — see above."

# ── 5. Nightly copy ─────────────────────────────────────────────────────────
say "Nightly copy at 02:45"
LINE="45 2 * * * $DEV_BE/deploy/ubuntu/dev-clone-db.sh >> $DEV_ROOT/clone.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "dev-clone-db.sh"; then
  note "already in the crontab"
else
  ( crontab -l 2>/dev/null; echo "$LINE" ) | crontab -
  note "added"
fi

say "Auto-update from the dev branch every 2 minutes"
LINE2="*/2 * * * * PATH=/usr/local/bin:/usr/bin:/bin $DEV_BE/deploy/ubuntu/dev-autodeploy.sh"
if crontab -l 2>/dev/null | grep -qF "dev-autodeploy.sh"; then
  note "already in the crontab"
else
  ( crontab -l 2>/dev/null; echo "$LINE2" ) | crontab -
  note "added"
fi

say "Done — open https://$DOMAIN:4500"
note "Both apps:  pm2 ls     (hrm-backend = live, hrm-backend-dev = dev)"
note "Dev log:    pm2 logs hrm-backend-dev"
