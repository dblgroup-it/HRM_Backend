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
# After a backend restart the API must answer on /api/health and
# /api/v1/health, and the frontend is only published once the running API
# answers the version that build calls — so `./deploy.sh frontend` cannot put
# an app in front of a backend that does not speak its API version.
#
# Read from the backend .env when not set in the environment (so the dev
# server's checkout deploys itself with this same script):
#
#   PM2_APP_NAME   the PM2 app to restart        (default hrm-backend; dev: hrm-backend-dev)
#   DEPLOY_BRANCH  the branch to pull            (default main; dev: dev)
#   DEPLOY_SKIP_BACKUP=1  never dump before migrating (the dev server — its
#                  database is a throwaway copy)
#
# Used by deploy/ubuntu/promote-to-prod.sh, not by hand:
#
#   DEPLOY_BACKEND_REF / DEPLOY_FRONTEND_REF   deploy exactly this commit
#                  (fast-forward only) instead of pulling the branch
#   ROLLBACK=1     put the checkouts back at those commits (reset, not
#                  fast-forward), skip the backup and the migrations, rebuild
#                  and restart — the way back after a failed deploy
#
# Set them once in the environment, or write the web root to the file:
#   echo /var/www/hrm > ../HRM_Frontend/.deploy-target

set -euo pipefail

cd "$(dirname "$0")"
BACKEND_DIR="$(pwd)"
FRONTEND_DIR="${FRONTEND_DIR:-$BACKEND_DIR/../HRM_Frontend}"

# A setting from the backend .env, unless the environment already has it.
env_setting() {
  grep -m1 "^$1=" "$BACKEND_DIR/.env" 2>/dev/null | tr -d '\r' | cut -d'=' -f2- \
    | sed -e 's/^"//' -e 's/"$//' || true
}
export PM2_APP_NAME="${PM2_APP_NAME:-$(env_setting PM2_APP_NAME)}"
PM2_APP_NAME="${PM2_APP_NAME:-hrm-backend}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$(env_setting DEPLOY_BRANCH)}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
[ "$(env_setting DEPLOY_SKIP_BACKUP)" = "1" ] && SKIP_BACKUP=1
ROLLBACK="${ROLLBACK:-0}"

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
  local name="$1" ref="${2:-}"
  # A dirty tree on a server means somebody edited production by hand. Pulling
  # over it either fails halfway or silently discards their fix.
  if [ -n "$(git status --porcelain)" ]; then
    git status --short
    die "$name has uncommitted changes. Commit, stash or discard them first."
  fi
  local before after
  before="$(git rev-parse HEAD)"
  if [ -n "$ref" ]; then
    # A named commit (promotion, or the way back after one). Its objects were
    # fetched by the caller, so this works without reaching GitHub.
    git cat-file -e "$ref^{commit}" 2>/dev/null || die "$name does not have commit $ref."
    if [ "$ROLLBACK" = "1" ]; then
      git reset --hard "$ref" >/dev/null
    else
      git merge --ff-only "$ref" \
        || die "$name cannot fast-forward to $ref — the live checkout has commits the dev build does not."
    fi
  else
    git fetch origin "$DEPLOY_BRANCH"
    # --ff-only: never create a merge commit on a server.
    git merge --ff-only "origin/$DEPLOY_BRANCH" \
      || die "$name cannot fast-forward — this checkout has diverged from origin/$DEPLOY_BRANCH."
  fi
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

# ── API health ──────────────────────────────────────────────────────────────

# The port the API listens on, from the backend's own .env (as PM2 starts it).
api_port() {
  local p
  p="$(grep -E '^PORT=' "$BACKEND_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'[:space:]' || true)"
  echo "${p:-4000}"
}

# Wait until the running API answers 200 on a path. The app needs a few
# seconds to boot after a restart, so this polls rather than asking once.
wait_for_api() {
  local path="$1" tries="${2:-60}" code=""
  command -v curl >/dev/null 2>&1 || { note "curl not installed — skipped the $path check"; return 0; }
  for _ in $(seq 1 "$tries"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(api_port)$path" || true)"
    [ "$code" = "200" ] && { note "$path → 200"; return 0; }
    sleep 1
  done
  note "$path → ${code:-no answer}"
  return 1
}

# The API version this frontend build calls (API_VERSION in its constants).
# A v2 build is then checked against /api/v2, not assumed.
frontend_api_version() {
  grep -oE "API_VERSION = '[^']+'" "$FRONTEND_DIR/src/shared/constants/index.ts" 2>/dev/null \
    | head -1 | cut -d"'" -f2 || true
}

# The dev server's dated copies (<prefix>YYYYMMDD), each migrated in turn.
migrate_dev_copies() {
  local url prefix base query db n=0
  url="$(env_setting DATABASE_URL)"
  [ -n "$url" ] || die "DATABASE_URL missing from the dev .env."
  prefix="$(env_setting SANDBOX_DB_PREFIX)"; prefix="${prefix:-dbl_hrm_dev_}"
  base="${url%%\?*}"; base="${base%/*}"          # postgresql://user:pass@host:port
  query=""; [[ "$url" == *\?* ]] && query="?${url#*\?}"
  for db in $(psql "${base}/postgres" -qAt -c \
      "SELECT datname FROM pg_database WHERE datname ~ '^${prefix}[0-9]{8}$' ORDER BY datname"); do
    note "$db"
    DATABASE_URL="${base}/${db}${query}" npm run --silent prisma:deploy \
      || die "migrations failed on the copy $db."
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || die "no dev copies to migrate — run deploy/ubuntu/dev-clone-db.sh first."
}

# ── Backend ─────────────────────────────────────────────────────────────────

deploy_backend() {
  cd "$BACKEND_DIR"

  [ -f .env ] || die "backend .env is missing — the API needs DATABASE_URL and JWT_SECRET."
  PM2="$(locate_pm2)" || die "pm2 not found on PATH or in the npm global folder. Install it with: npm i -g pm2"
  note "pm2: $PM2"

  say "Backend — pulling"
  pull_repo backend "${DEPLOY_BACKEND_REF:-}"

  say "Backend — installing (locked)"
  npm ci

  # Before the build: the Prisma client's types are compiled in.
  say "Backend — generating the Prisma client"
  npm run prisma:generate

  if [ "$ROLLBACK" = "1" ]; then
    say "Backend — backup skipped (rollback)"
  elif [ "${SKIP_BACKUP:-0}" = "1" ]; then
    say "Backend — backup skipped (SKIP_BACKUP=1)"
  else
    say "Backend — backing up the database"
    backup_database
  fi

  # Before the new code starts, so the columns exist when it reads them.
  if [ "$ROLLBACK" = "1" ]; then
    # Migrations are not undone: they only ever add, and the previous code
    # runs on the newer schema. The pre-deploy dump is there if one must be.
    say "Backend — migrations left as they are (rollback)"
  elif [ "$(env_setting SANDBOX_MODE)" = "true" ]; then
    # The dev server: its .env names Postgres's maintenance database and the
    # app opens a dated copy at boot, so migrate every copy — then switching
    # to any day still matches this code.
    say "Backend — applying migrations to every dev copy"
    migrate_dev_copies
  else
    say "Backend — applying migrations"
    npm run prisma:deploy
  fi

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

  # Both paths must answer: /api/v1 is what the app calls, the unversioned
  # /api is what emailed links, the BDJobs webhook and the Google callback
  # already point at. A restart that came up broken is caught here, not by
  # the first person to sign in.
  say "Backend — checking the API answers"
  wait_for_api /api/health \
    || die "the API did not come up on port $(api_port). Look at: $PM2 logs $PM2_APP_NAME --err --lines 50"
  wait_for_api /api/v1/health 10 \
    || die "the API is up but /api/v1 does not answer — the frontend could not reach it."
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
  pull_repo frontend "${DEPLOY_FRONTEND_REF:-}"

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

  # Never publish an app the running API cannot answer. This is what makes
  # `./deploy.sh frontend` safe on its own: a build calling /api/v1 put in
  # front of an older backend would fail on every screen.
  local ver
  ver="$(frontend_api_version)"
  if [ -n "$ver" ]; then
    say "Frontend — checking the API serves /api/$ver"
    wait_for_api "/api/$ver/health" 10 \
      || die "the running API does not answer /api/$ver, which this build calls. Deploy the backend first: ./deploy.sh backend"
  fi

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
printf '\nTail the API log with:  pm2 logs %s\n\n' "$PM2_APP_NAME"
