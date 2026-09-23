#!/usr/bin/env bash
#
# Deploy DBL HRM — both halves, from here.
#
#   ./deploy.sh              # backend + frontend (the usual)
#   ./deploy.sh backend      # API only
#   ./deploy.sh frontend     # SPA only
#
# The two repos are separate checkouts but one release: the frontend talks to
# this API and is built against it, so deploying one without the other is
# almost never what anybody means. One script, run from the backend, is how
# this has always been done here.
#
# Per-machine settings, none of which belong in the repo:
#
#   FRONTEND_DIR   where the frontend checkout is   (default: ../HRM_Frontend)
#   WEB_ROOT       where the built SPA is published (default: read from
#                  $FRONTEND_DIR/.deploy-target, which is gitignored)
#   BACKUP_DIR     where the pre-migration database dump goes
#                  (default: ~/hrm_backups). Every backend deploy dumps the
#                  database and checks the dump is complete before migrating.
#   SKIP_BACKUP=1  skip that dump — only if you have just taken one yourself.
#
# Set them once in the environment, or write the web root to the file:
#   echo /var/www/hrm > ../HRM_Frontend/.deploy-target

set -euo pipefail

cd "$(dirname "$0")"
BACKEND_DIR="$(pwd)"
FRONTEND_DIR="${FRONTEND_DIR:-$BACKEND_DIR/../HRM_Frontend}"

what="${1:-all}"
case "$what" in
  all|backend|frontend) ;;
  *) echo "usage: ./deploy.sh [all|backend|frontend]" >&2; exit 2 ;;
esac

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[1;31mdeploy failed:\033[0m %s\n' "$1" >&2; exit 1; }

# Pull one checkout, refusing anything that needs a human. Prints what moved.
pull_repo() {
  local name="$1"
  # A dirty tree on a server means somebody edited production by hand. Pulling
  # over it either fails halfway or silently discards their fix.
  if [ -n "$(git status --porcelain)" ]; then
    git status --short
    die "$name has uncommitted changes. Commit, stash or discard them first."
  fi
  git fetch origin main
  local before after
  before="$(git rev-parse HEAD)"
  # --ff-only: never create a merge commit on a server.
  git merge --ff-only origin/main \
    || die "$name cannot fast-forward — this checkout has diverged from origin/main."
  after="$(git rev-parse HEAD)"
  if [ "$before" = "$after" ]; then
    note "already at $(git rev-parse --short HEAD) — rebuilding anyway"
  else
    note "$(git rev-parse --short "$before") → $(git rev-parse --short "$after")"
    git --no-pager log --oneline "$before..$after" | sed 's/^/      /'
  fi
}

# ── Tools the Windows server does not put on PATH ───────────────────────────
#
# Inside Git Bash on the production server neither pm2 nor pg_dump is on PATH,
# so a bare `pm2` stops the deploy halfway. Resolve both explicitly, falling
# back to where they are installed there. (Carried over from
# scripts/deploy.sh, which learned this the hard way.)

locate_pm2() {
  if command -v pm2 >/dev/null 2>&1; then command -v pm2; return 0; fi
  local npm_prefix c
  npm_prefix="$(npm config get prefix 2>/dev/null | tr -d '\r')"
  for c in "$npm_prefix/pm2.cmd" "$npm_prefix/bin/pm2" \
           "/c/Users/Administrator/AppData/Roaming/npm/pm2.cmd"; do
    if [ -x "$c" ] || [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

locate_pg_dump() {
  if command -v pg_dump >/dev/null 2>&1; then command -v pg_dump; return 0; fi
  local c
  for c in "/c/Program Files/PostgreSQL/18/bin/pg_dump.exe" \
           "/c/Program Files/PostgreSQL/17/bin/pg_dump.exe" \
           "/c/Program Files/PostgreSQL/16/bin/pg_dump.exe" \
           "/c/Program Files/PostgreSQL/15/bin/pg_dump.exe"; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

# Back the database up and prove the dump is whole before any migration runs.
# A release that adds a migration is exactly when a way back matters, and an
# empty or truncated dump is worse than none because it looks like one.
backup_database() {
  local pg_dump url pg_url dir file
  pg_dump="$(locate_pg_dump)" || die "pg_dump not found on PATH or under C:\\Program Files\\PostgreSQL\\<15-18>\\bin.
  Add its bin folder to PATH, or run with SKIP_BACKUP=1 if you have backed up yourself."
  # tr -d '\r': the server's .env has CRLF endings, and a trailing carriage
  # return makes pg_dump reject the URL with an opaque "invalid URI".
  url="$(grep -m1 '^DATABASE_URL=' .env | tr -d '\r' | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//')"
  [ -n "$url" ] || die "DATABASE_URL not found in the backend .env"
  # Prisma's own query parameters mean nothing to libpq and make it refuse the URL.
  pg_url="$(printf '%s' "$url" | sed -E 's/[?&](schema|connection_limit|pool_timeout|pgbouncer|connect_timeout)=[^&]*//g; s/\?$//')"

  dir="${BACKUP_DIR:-$HOME/hrm_backups}"
  mkdir -p "$dir"
  file="$dir/hrm_backup_$(date +%Y%m%d_%H%M%S).sql"
  note "pg_dump: $pg_dump"
  note "to:      $file"
  "$pg_dump" "$pg_url" > "$file" || { rm -f "$file"; die "pg_dump failed. Nothing was migrated."; }

  if [ ! -s "$file" ]; then
    rm -f "$file"
    die "the backup is empty (bad DATABASE_URL, auth, or a pg_dump older than the server). Nothing was migrated."
  fi
  if ! tail -c 4096 "$file" | grep -q "PostgreSQL database dump complete"; then
    die "the backup does not end with pg_dump's completion marker, so it looks truncated.
  Kept for inspection: $file. Nothing was migrated."
  fi
  note "verified: complete ($(du -h "$file" | cut -f1))"
  LAST_BACKUP="$file"
}

LAST_BACKUP=""

# ── Backend ─────────────────────────────────────────────────────────────────

deploy_backend() {
  cd "$BACKEND_DIR"

  [ -f .env ] || die "backend .env is missing — the API needs DATABASE_URL and JWT_SECRET."
  PM2="$(locate_pm2)" || die "pm2 not found on PATH or in the npm global folder. Install it with: npm i -g pm2"
  note "pm2: $PM2"

  say "Backend — pulling"
  pull_repo backend

  say "Backend — installing (locked)"
  npm ci

  # Before the build: the Prisma client's types are compiled in.
  say "Backend — generating the Prisma client"
  npm run prisma:generate

  if [ "${SKIP_BACKUP:-0}" = "1" ]; then
    say "Backend — backup skipped (SKIP_BACKUP=1)"
  else
    say "Backend — backing up the database"
    backup_database
  fi

  # Before the new code starts, so the columns exist when it reads them.
  say "Backend — applying migrations"
  npm run prisma:deploy

  say "Backend — building"
  npm run build
  [ -f dist/main.js ] || die "the backend build produced no dist/main.js."

  # The API serves from code loaded into memory at boot, so a rebuilt dist/
  # changes nothing until the process is replaced. A build that was never
  # restarted is the failure this line exists to prevent; it has happened.
  #
  # startOrReload covers a first deploy as well as every one after. One
  # fork-mode instance is deliberate — see ecosystem.config.js, Socket.IO
  # broadcasts do not survive cluster mode — so this is a brief restart rather
  # than a handover. Connected clients reconnect on their own.
  say "Backend — restarting PM2"
  mkdir -p logs
  "$PM2" startOrReload ecosystem.config.js --update-env
  "$PM2" save
}

# ── Frontend ────────────────────────────────────────────────────────────────

deploy_frontend() {
  [ -d "$FRONTEND_DIR" ] \
    || die "no frontend checkout at $FRONTEND_DIR. Set FRONTEND_DIR to where it lives."
  cd "$FRONTEND_DIR"
  [ -d .git ] || die "$FRONTEND_DIR is not a git checkout."

  # VITE_API_BASE_URL is compiled into the bundle, so a missing or localhost
  # .env produces a build that silently talks to nobody. Cheaper to catch here
  # than as a white screen in production.
  [ -f .env ] || die "frontend .env is missing — VITE_API_BASE_URL is baked into the bundle."
  if grep -qE '^VITE_API_BASE_URL=.*localhost' .env; then
    die "frontend VITE_API_BASE_URL still points at localhost. Fix .env before building."
  fi

  say "Frontend — pulling"
  pull_repo frontend

  say "Frontend — installing (locked)"
  npm ci

  say "Frontend — building"
  npm run build
  [ -f dist/index.html ] || die "the frontend build produced no dist/index.html."

  local target="${WEB_ROOT:-}"
  if [ -z "$target" ] && [ -f .deploy-target ]; then
    target="$(tr -d '[:space:]' < .deploy-target)"
  fi

  if [ -z "$target" ]; then
    say "Frontend — built to $FRONTEND_DIR/dist"
    note "No WEB_ROOT set, so nothing was published."
    note "Point the web server at that directory, or set it once with:"
    note "  echo /var/www/hrm > $FRONTEND_DIR/.deploy-target"
    return
  fi

  [ -d "$target" ] || die "WEB_ROOT '$target' does not exist."

  # --delete so a chunk dropped from the build is dropped from the server too;
  # a stale one left behind only breaks for the browser still asking for it.
  say "Frontend — publishing to $target"
  rsync -a --delete dist/ "$target/"
}

# ── Go ──────────────────────────────────────────────────────────────────────

# Spelled out as `if`, not `[ … ] || [ … ] && deploy_backend`: that groups as
# (a || b) && c, so on `./deploy.sh frontend` the first line evaluates false,
# returns 1, and `set -e` kills the script before anything runs.
if [ "$what" = "all" ] || [ "$what" = "backend" ]; then
  deploy_backend
fi
if [ "$what" = "all" ] || [ "$what" = "frontend" ]; then
  deploy_frontend
fi

cd "$BACKEND_DIR"
say "Done"
note "backend   $(git rev-parse --short HEAD)"
if [ "$what" != "backend" ] && [ -d "$FRONTEND_DIR/.git" ]; then
  note "frontend  $(git -C "$FRONTEND_DIR" rev-parse --short HEAD)"
fi
[ -n "$LAST_BACKUP" ] && printf '\nDatabase backup taken before migrating:\n  %s\n' "$LAST_BACKUP"
printf '\nTail the API log with:  pm2 logs hrm-backend\n\n'
