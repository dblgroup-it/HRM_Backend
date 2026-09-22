#!/usr/bin/env bash
#
# HRM production deploy — Windows server (Git Bash), PostgreSQL 18, nginx, PM2.
#
# Run from anywhere; paths are resolved relative to this script's own
# location, assuming the layout:
#   <repo root>/HRM_Backend/scripts/deploy.sh   (this file)
#   <repo root>/HRM_Frontend/
#
# What it does, in order:
#   1. Locate pg_dump and take a DB backup, then PROVE the backup is real
#      before touching anything else (see "why this script exists" below).
#   2. Stop the PM2 app — `npm ci` deletes node_modules, and Windows will
#      throw EBUSY/EPERM (and can leave the tree half-deleted) if a running
#      node process still has files in it open. Stop first, always.
#   3. Backend: npm ci, prisma generate, npm run build, THEN migrate. The
#      build comes before the migration on purpose — see the block itself.
#   4. Restart PM2, then WAIT for /api/health to answer before going on —
#      pm2 reports "online" for a process that booted, threw and is about to
#      be restarted, so without this a failed boot was announced as a
#      successful deploy. Placed before the frontend swap on purpose: if the
#      API is not coming back, stop while the site still serves the previous,
#      working frontend.
#   5. Frontend: build to a scratch directory, then atomically swap it into
#      dist/ — nginx serves HRM_Frontend/dist directly, and a plain
#      `vite build` empties that directory in place before rebuilding, which
#      would serve broken/missing assets to real visitors for the whole
#      build. Building elsewhere and swapping keeps the live site up.
#   6. Print a summary and the manual rollback command.
#
# Why this script exists:
#   A previous manual deploy ran
#     pg_dump "$URL" > ~/backup.sql && echo "backup saved"
#   pg_dump was not on PATH on this server (it lives at
#   "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"), so the redirect
#   silently created a 0-byte file and `echo` reported success anyway —
#   right before a migration batch that included DROP TABLE / DROP COLUMN.
#   This script refuses to proceed unless the backup file is provably a
#   complete pg_dump output (non-empty AND ends with pg_dump's own
#   "PostgreSQL database dump complete" trailer).
#
# This script does NOT touch anything until the backup is verified, and it
# does NOT run automatically — read the summary/rollback output either way.

set -euo pipefail

# ── paths ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BACKEND_DIR/.." && pwd)"
FRONTEND_DIR="${FRONTEND_DIR:-$REPO_ROOT/HRM_Frontend}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/hrm_backups}"
PM2_APP="hrm-backend"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/hrm_backup_${TIMESTAMP}.sql"

log()  { printf '\n==> %s\n' "$1"; }
step() { printf '    -- %s\n' "$1"; }
die()  { printf '\nABORT: %s\n' "$1" >&2; exit 1; }

[ -d "$BACKEND_DIR" ]  || die "Backend dir not found: $BACKEND_DIR"
[ -d "$FRONTEND_DIR" ] || die "Frontend dir not found: $FRONTEND_DIR (set FRONTEND_DIR=... to override)"
[ -f "$BACKEND_DIR/.env" ] || die "$BACKEND_DIR/.env not found"

# ── 0. locate pg_dump explicitly — do not trust PATH ────────────────────
locate_pg_dump() {
  if command -v pg_dump >/dev/null 2>&1; then
    command -v pg_dump
    return 0
  fi
  local candidates=(
    "/c/Program Files/PostgreSQL/18/bin/pg_dump.exe"
    "/c/Program Files/PostgreSQL/17/bin/pg_dump.exe"
    "/c/Program Files/PostgreSQL/16/bin/pg_dump.exe"
    "/c/Program Files/PostgreSQL/15/bin/pg_dump.exe"
  )
  local c
  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

PG_DUMP="$(locate_pg_dump)" || die "pg_dump not found on PATH or in any known PostgreSQL install location.
  Checked: PATH, and PostgreSQL 15/16/17/18 under 'C:\\Program Files\\PostgreSQL\\<ver>\\bin'.
  Fix: either add pg_dump's bin folder to PATH, or edit the candidates list at the top of this script."
log "Using pg_dump: $PG_DUMP"
# psql ships in the same bin/ as pg_dump — used only in the printed rollback
# command below, never run automatically.
PSQL="$(dirname "$PG_DUMP")/psql.exe"
[ -x "$PSQL" ] || PSQL="psql"

# `tr -d '\r'` is load-bearing: .env on this server has CRLF line endings, so
# without it DATABASE_URL carries a trailing carriage return and pg_dump fails
# with an opaque "invalid URI" error.
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$BACKEND_DIR/.env" | tr -d '\r' | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$DATABASE_URL" ] || die "DATABASE_URL not found in $BACKEND_DIR/.env"

# Prisma's DATABASE_URL carries query params that libpq does NOT understand
# (schema, connection_limit, pool_timeout, pgbouncer). Passing the raw URL to
# pg_dump fails with: `invalid URI query parameter: "schema"`. Strip them for
# pg_dump/psql only — Prisma itself still needs the full URL.
PG_URL="$(printf '%s' "$DATABASE_URL" \
  | sed -E 's/[?&]schema=[^&]*//; s/[?&]connection_limit=[^&]*//; s/[?&]pool_timeout=[^&]*//; s/[?&]pgbouncer=[^&]*//; s/[?&]connect_timeout=[^&]*//; s/\?$//')"

# ── locate pm2 — it is NOT on PATH inside Git Bash on this server ────────
# Bare `pm2` calls would fail: the `pm2 stop` below is failure-tolerant, so
# npm ci would then delete node_modules out from under the RUNNING app
# (EBUSY/EPERM on Windows), and the later `pm2 start` would abort the deploy
# with the site down. Resolve it explicitly instead.
locate_pm2() {
  if command -v pm2 >/dev/null 2>&1; then command -v pm2; return 0; fi
  local npm_prefix c
  npm_prefix="$(npm config get prefix 2>/dev/null | tr -d '\r')"
  local candidates=(
    "$npm_prefix/pm2.cmd"
    "/c/Users/Administrator/AppData/Roaming/npm/pm2.cmd"
  )
  for c in "${candidates[@]}"; do
    if [ -x "$c" ] || [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}
PM2="$(locate_pm2)" || die "pm2 not found on PATH or in the npm global prefix.
  Install it (npm i -g pm2) or add the npm global bin folder to PATH."
log "Using pm2: $PM2"

# ── 1. backup — and PROVE it's real before doing anything else ─────────
log "[1/6] Backing up database"
mkdir -p "$BACKUP_DIR"
step "pg_dump -> $BACKUP_FILE"
"$PG_DUMP" "$PG_URL" > "$BACKUP_FILE"

if [ ! -s "$BACKUP_FILE" ]; then
  rm -f "$BACKUP_FILE"
  die "backup file is empty. pg_dump likely failed silently (bad DATABASE_URL, auth failure, or wrong pg_dump version for this server's Postgres). Nothing was touched."
fi
if ! tail -c 4096 "$BACKUP_FILE" | grep -q "PostgreSQL database dump complete"; then
  die "backup file does not end with pg_dump's completion marker — it looks truncated or incomplete.
  File kept for inspection: $BACKUP_FILE
  Nothing was touched — fix the backup before re-running."
fi
step "verified: non-empty and complete ($(du -h "$BACKUP_FILE" | cut -f1))"

# ── 1b. warm the Chromium cache BEFORE stopping anything ─────────────────
#
# The offer, appointment, Code of Conduct and reference-check PDFs are rendered
# by puppeteer, which downloads its own Chromium (~550MB) on `npm ci`. That
# download would otherwise happen in step 3 — with PM2 already stopped — so a
# slow link or a proxy would hold the API down for the length of it, and a
# failed download would leave it down.
#
# The browser lives in the user cache, NOT in node_modules, so it survives
# `npm ci` and this only actually downloads once. Failure here is not fatal:
# the app falls back to sending letters inline, and PUPPETEER_EXECUTABLE_PATH
# can point at an installed Chrome or Edge instead.
log "[1b/6] Ensuring the PDF browser is present (before anything is stopped)"
if npx --yes puppeteer@"$(node -p "require('$BACKEND_DIR/package.json').dependencies.puppeteer.replace(/^[^0-9]*/,'')" 2>/dev/null || echo latest)" browsers install chrome >/dev/null 2>&1; then
  step "PDF browser ready"
else
  step "could not fetch the PDF browser — letters will send inline until it is installed"
fi

# ── 2. stop PM2 before npm ci ────────────────────────────────────────────
log "[2/6] Stopping $PM2_APP (required before npm ci — see header comment)"
"$PM2" stop "$PM2_APP" 2>/dev/null || step "$PM2_APP was not running — continuing"

# Report what pm2 ACTUALLY says, rather than asserting a state.
#
# The old trap hardcoded "hrm-backend IS STOPPED AND THE SITE IS DOWN". That was
# wrong on 2026-09-06 and again on 2026-09-07: both failures happened in step 5,
# by which point step 4 has already restarted pm2 — the app was online and the
# API healthy while the trap declared it stopped. A trap that misreports state
# gets the next failure misdiagnosed, so it now asks pm2 instead of guessing.
#
# `pm2 pid` is used rather than parsing `pm2 jlist` JSON: it prints the pid, or
# 0 when the app is registered but stopped.
pm2_state() {
  local pid
  if ! "$PM2" describe "$PM2_APP" >/dev/null 2>&1; then
    printf 'NOT REGISTERED with pm2'
    return
  fi
  pid="$("$PM2" pid "$PM2_APP" 2>/dev/null | tr -d '[:space:]')"
  case "$pid" in
    ''|0)      printf 'STOPPED (registered, pid 0)' ;;
    *[!0-9]*)  printf 'UNCLEAR (pm2 pid returned "%s")' "$pid" ;;
    *)         printf 'ONLINE (pid %s)' "$pid" ;;
  esac
}

# Likewise for the thing nginx actually serves.
dist_state() {
  if [ -d "$FRONTEND_DIR/dist" ]; then
    printf 'present (%s files)' "$(find "$FRONTEND_DIR/dist" -type f 2>/dev/null | wc -l | tr -d '[:space:]')"
  else
    printf 'ABSENT — nginx will return 500 for every request'
  fi
}

# From here on, a failure may leave the site degraded. Make that loud — and
# accurate.
on_error() {
  printf '\n\n*** DEPLOY FAILED ***\n' >&2
  printf '  %-16s %s\n' "$PM2_APP:" "$(pm2_state)" >&2
  printf '  %-16s %s\n' "frontend dist/:" "$(dist_state)" >&2
  printf 'Backup taken before any changes: %s\n' "$BACKUP_FILE" >&2
  printf 'To bring the previous version back up:\n' >&2
  printf '  1. cd "%s" && git checkout <previous-commit> -- .\n' "$BACKEND_DIR" >&2
  printf '  2. npm ci && npx prisma generate && npm run build\n' >&2
  printf '  3. pm2 start ecosystem.config.js  (or: pm2 restart %s)\n' "$PM2_APP" >&2
  printf 'If a migration already ran and needs reverting, restore the DB — see the rollback command this script would have printed at the end.\n' >&2
}
trap on_error ERR

# ── 3. backend: install, generate, migrate, build ───────────────────────
log "[3/6] Backend: npm ci, prisma generate, build, then migrate"
cd "$BACKEND_DIR"
step "npm ci (deletes and reinstalls node_modules)"
npm ci
step "prisma generate"
npx prisma generate

# `nest build` empties dist/ before it compiles, so a build that dies part-way
# leaves no entrypoint at all — and dist/ is not tracked in git, so there is
# nothing to restore from. That is exactly what happened on 2026-09-14: the
# compiler was killed for running out of heap, and the API stayed down until a
# build finally succeeded, because `pm2 start` had no dist/main.js to run.
# Keep the previous build first, the same way the frontend swap below does.
step "setting the current build aside as dist.old"
rm -rf dist.old
if [ -d dist ]; then mv dist dist.old; fi

# Build BEFORE migrating.
#
# `prisma generate` reads schema.prisma, not the database, so nothing in the
# build needs the migration to have run. Migrating first would mean a failed
# compile leaves a migrated database with no code that matches it — the one
# state that cannot be walked back without restoring the backup, and the
# slowest possible way to discover a typo.
step "npm run build"
if ! npm run build || [ ! -f dist/main.js ]; then
  if [ -d dist.old ]; then
    rm -rf dist
    mv dist.old dist
    step "build failed — previous dist/ restored"
  fi
  die "backend build failed. The database was NOT migrated and the previous build is back in place, so the API can be restarted as it was:
  pm2 start \"$BACKEND_DIR/ecosystem.config.js\"
Backup taken before any changes: $BACKUP_FILE"
fi
step "built; previous build kept as dist.old for one deploy cycle"

step "prisma migrate status (review before deploy)"
npx prisma migrate status || true
step "prisma migrate deploy — DESTRUCTIVE, applies all pending migrations"
npx prisma migrate deploy

# ── 4. restart PM2 ───────────────────────────────────────────────────────
log "[4/6] Starting $PM2_APP"
if "$PM2" describe "$PM2_APP" >/dev/null 2>&1; then
  "$PM2" restart "$PM2_APP"
else
  "$PM2" start "$BACKEND_DIR/ecosystem.config.js"
fi
"$PM2" save
step "last 30 log lines:"
"$PM2" logs "$PM2_APP" --lines 30 --nostream || true

# ── 4b. prove the API actually answers before touching the frontend ─────
#
# `pm2 restart` returns as soon as the process is spawned, and pm2 reports
# "online" for a process that booted, threw and is about to be restarted —
# so a Nest boot failure (a bad migration, a missing env var, a Prisma client
# that no longer matches the schema) used to sail straight past here and be
# announced as DEPLOY COMPLETE, with the API 500ing.
#
# This is deliberately placed BEFORE the frontend swap: if the API is not
# coming back, the right thing is to stop and roll the backend back while the
# site is still serving the previous, working frontend against it.
log "[4b/6] Waiting for the API to answer"
API_PORT="$(grep -m1 '^PORT=' "$BACKEND_DIR/.env" | tr -d '\r' | cut -d'=' -f2- | tr -d '"')"
API_PORT="${API_PORT:-4000}"
HEALTH_URL="http://127.0.0.1:${API_PORT}/api/health"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"

api_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1
  else
    # No curl on this box — fall back to node, which is certainly present.
    node -e "
      const http = require('http');
      const req = http.get(process.argv[1], (res) => {
        process.exit(res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1);
      });
      req.on('error', () => process.exit(1));
      req.setTimeout(5000, () => { req.destroy(); process.exit(1); });
    " "$HEALTH_URL" >/dev/null 2>&1
  fi
}

healthy=0
waited=0
while [ "$waited" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
  if api_ok; then healthy=1; break; fi
  sleep 2
  waited=$((waited + 2))
done

if [ "$healthy" -ne 1 ]; then
  step "no answer from $HEALTH_URL after ${HEALTH_TIMEOUT_SECONDS}s"
  "$PM2" logs "$PM2_APP" --lines 60 --nostream || true
  die "the API did not come back up. The frontend was NOT touched, so the site is still serving the previous build.
  The database HAS been migrated — check the logs above before deciding whether to roll the code back or fix forward.
  Previous backend build is still on disk as: $BACKEND_DIR/dist.old
  To put it back:
    cd \"$BACKEND_DIR\" && rm -rf dist && mv dist.old dist && \"$PM2\" restart $PM2_APP
  Backup taken before any changes: $BACKUP_FILE"
fi
step "API healthy at $HEALTH_URL (after ${waited}s)"

# ── 5. frontend: build to scratch dir, atomic swap ──────────────────────
log "[5/6] Frontend: build + atomic swap into dist/"
cd "$FRONTEND_DIR"
step "npm ci"
npm ci

TMP_DIST="dist.new.$$"
rm -rf "$TMP_DIST"
step "npm run build -- --outDir $TMP_DIST (nginx serves dist/ directly and a plain build empties it in place, which would take the live site down mid-build)"
npm run build -- --outDir "$TMP_DIST"

if [ ! -d "$TMP_DIST" ] || [ -z "$(ls -A "$TMP_DIST")" ]; then
  rm -rf "$TMP_DIST"
  die "frontend build produced no output — dist/ was NOT touched, the live site is still the previous build."
fi

step "swapping dist/ (previous build kept as dist.old for one deploy cycle)"

# Vite hands off to esbuild workers that can outlive the "built in Ns" line by a
# second or two, still holding handles inside the freshly written output dir.
# Windows refuses to rename a directory with an open handle (EPERM, surfaced by
# mv as "Permission denied"). That is exactly how this swap failed on
# 2026-09-06 (dist.new.1242) and 2026-09-07 (dist.new.234) — both times leaving
# dist/ ABSENT and nginx returning 500 for every visitor until someone reran the
# mv by hand. Failing here is strictly worse than never having deployed.
# Windows releases a file handle a moment AFTER the process holding it exits,
# so waiting for esbuild to disappear returns too early — and if `ps -W` does
# not list it at all, the loop below breaks on its first pass and we go straight
# into the retry backoff. Five consecutive deploys have then needed three or
# four attempts, costing a fixed 1+2+4 = 7s each time.
#
# So: wait a fixed minimum regardless of what `ps` reports, then keep waiting
# while esbuild is still visible. Tunable if a slower box needs longer.
# 6s, from measurement rather than taste. Two deploys with a 3s settle both
# succeeded on attempt 4 — delays 1+1+2 after the settle, so the handle frees
# around 6-7s after the build finishes. Starting at 6 puts the first attempt
# where the handle actually becomes free instead of three attempts before it.
SWAP_SETTLE_SECONDS="${SWAP_SETTLE_SECONDS:-6}"
step "letting build children exit and release their handles (${SWAP_SETTLE_SECONDS}s)"
sleep "$SWAP_SETTLE_SECONDS"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  # `ps -W` lists Windows processes under Git Bash. Where it is unavailable the
  # grep never matches and this simply falls through — the settle above and the
  # retry loop below are the real safety nets.
  ps -W 2>/dev/null | grep -iq '[e]sbuild' || break
  sleep 1
done

rm -rf dist.old
# Written as an if, not `[ -d dist ] && mv ...`: under `set -e` that AND-list
# returns non-zero when dist/ is absent, which would abort the deploy and fire
# the failure trap even though nothing had gone wrong.
if [ -d dist ]; then mv dist dist.old; fi

# Retry with a gentle-then-backing-off schedule: 1s, 1s, 2s, 3s, 5s, 8s between
# seven attempts, 20s in total. The early steps are short on purpose — the
# handle frees a few seconds after the build, and a coarse 1-2-4 schedule
# overshoots it and waits 7s to discover what a 1s retry would have found in 3.
# Each `mv` sits inside an `if` so a failure does not trip `set -e` before we
# can recover.
SWAP_DELAYS="1 1 2 3 5 8"
swapped=0
attempt=0
for delay in $SWAP_DELAYS _final; do
  attempt=$((attempt + 1))
  if mv "$TMP_DIST" dist 2>/dev/null; then
    swapped=1
    # Spelled as an if, not `[ ... ] && step ...` — see the dist-swap comment
    # above for why a bare AND-list is a hazard under `set -e`.
    if [ "$attempt" -gt 1 ]; then step "swap succeeded on attempt $attempt"; fi
    break
  fi
  # `_final` is a sentinel, not a delay: the last pass is an attempt with no
  # sleep after it, so the loop ends on a try rather than on a wait.
  if [ "$delay" != "_final" ]; then
    step "swap attempt $attempt/7 failed (a build child still holds $TMP_DIST) — retrying in ${delay}s"
    sleep "$delay"
  fi
done

if [ "$swapped" -ne 1 ]; then
  # INVARIANT: never exit with dist/ absent. Serving the previous build is bad;
  # serving nothing is worse. Whichever recovery path runs, record what dist/
  # actually ends up holding so the abort message below tells the truth — the
  # recovery taken determines both what is live and how to finish by hand.
  recovered="dist/ was left untouched"
  manual_fix="cd \"$FRONTEND_DIR\" && rm -rf dist.old && mv dist dist.old && mv \"$TMP_DIST\" dist"
  if [ ! -d dist ] && [ -d dist.old ]; then
    if mv dist.old dist 2>/dev/null; then
      step "ROLLED BACK: previous build restored to dist/ — the site is UP on the OLD frontend"
      recovered="dist/ serves the PREVIOUS build — the site is up, but on the OLD frontend"
    else
      # Rename of the old dir failed too. Copy it back instead: a copy only
      # needs read access, so it survives handles that block a rename.
      if cp -r dist.old dist 2>/dev/null; then
        step "ROLLED BACK by copy: dist/ repopulated from dist.old — the site is UP on the OLD frontend"
        recovered="dist/ serves a COPY of the previous build — the site is up, but on the OLD frontend"
      else
        printf '\nCRITICAL: dist/ is ABSENT and could not be restored. The site WILL 500.\n  Fix by hand: cd "%s" && mv dist.old dist\n\n' "$FRONTEND_DIR" >&2
        recovered="dist/ is ABSENT — THE SITE IS RETURNING 500"
      fi
    fi
  elif [ ! -d dist ]; then
    # No previous build to fall back on (first deploy). Copying the new build in
    # is the only way to leave dist/ populated.
    if cp -r "$TMP_DIST" dist 2>/dev/null; then
      step "no dist.old to roll back to — copied the new build into dist/ instead"
      recovered="dist/ holds a COPY of the NEW build (there was no previous build to fall back to) — the site is up on the new frontend"
      manual_fix="cd \"$FRONTEND_DIR\" && rm -rf dist && mv \"$TMP_DIST\" dist   # replaces the copy with the real build dir"
    else
      printf '\nCRITICAL: dist/ is ABSENT, no dist.old exists, and the copy failed. The site WILL 500.\n\n' >&2
      recovered="dist/ is ABSENT — THE SITE IS RETURNING 500"
    fi
  fi

  die "frontend swap failed after 5 attempts: could not rename '$TMP_DIST' to 'dist' (Permission denied — a build child process is still holding it).
  The new build succeeded and is STILL THERE, unswapped: $FRONTEND_DIR/$TMP_DIST
  $recovered
  Backend changes (including any migrations) HAVE been applied.
  To finish by hand once the handle clears:
    $manual_fix"
fi
step "frontend swapped in"

trap - ERR

# ── 6. summary ────────────────────────────────────────────────────────────
cat <<SUMMARY

============================================================
 DEPLOY COMPLETE
============================================================
 Backend:  $PM2_APP restarted — check: pm2 logs $PM2_APP
 Frontend: $FRONTEND_DIR/dist swapped in (previous build kept at dist.old)
 DB backup: $BACKUP_FILE

 Smoke-test the live site now.

 --- Rollback (manual — read before running) -----------------------------
 Frontend only (undo the swap):
   cd "$FRONTEND_DIR" && rm -rf dist && mv dist.old dist

 Database (only if a migration needs reverting — this REPLACES all data
 in the target database with the backup's contents; take a fresh backup
 of the current state first if you might need it):
   dropdb --if-exists <db_name> && createdb <db_name> && \\
     "$PSQL" "<DATABASE_URL from $BACKEND_DIR/.env>" < "$BACKUP_FILE"
 (confirm <db_name> matches DATABASE_URL in $BACKEND_DIR/.env before running this)

 Backend code (previous commit):
   cd "$BACKEND_DIR" && git checkout <previous-commit> -- . && \\
     npm ci && npx prisma generate && npm run build && pm2 restart $PM2_APP
============================================================
SUMMARY
