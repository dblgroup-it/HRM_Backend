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
#   3. Backend: npm ci, prisma generate, prisma migrate deploy, npm run build.
#   4. Restart PM2.
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
log "[3/6] Backend: npm ci, prisma generate, prisma migrate deploy, build"
cd "$BACKEND_DIR"
step "npm ci (deletes and reinstalls node_modules)"
npm ci
step "prisma generate"
npx prisma generate
step "prisma migrate status (review before deploy)"
npx prisma migrate status || true
step "prisma migrate deploy — DESTRUCTIVE, applies all pending migrations"
npx prisma migrate deploy
step "npm run build"
npm run build

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
step "waiting for build child processes to release $TMP_DIST"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  # `ps -W` lists Windows processes under Git Bash. If ps is unavailable the
  # grep simply never matches and we fall through to the retry loop below,
  # which is the real safety net.
  ps -W 2>/dev/null | grep -iq '[e]sbuild' || break
  sleep 1
done

rm -rf dist.old
# Written as an if, not `[ -d dist ] && mv ...`: under `set -e` that AND-list
# returns non-zero when dist/ is absent, which would abort the deploy and fire
# the failure trap even though nothing had gone wrong.
if [ -d dist ]; then mv dist dist.old; fi

# Retry with backoff: 1s, 2s, 4s, 8s between five attempts. Each `mv` is inside
# an `if` condition so a failure does not trip `set -e` before we can recover.
swapped=0
delay=1
for attempt in 1 2 3 4 5; do
  if mv "$TMP_DIST" dist 2>/dev/null; then
    swapped=1
    # Spelled as an if, not `[ ... ] && step ...` — see the dist-swap comment
    # above for why a bare AND-list is a hazard under `set -e`.
    if [ "$attempt" -gt 1 ]; then step "swap succeeded on attempt $attempt"; fi
    break
  fi
  if [ "$attempt" -lt 5 ]; then
    step "swap attempt $attempt/5 failed (a build child still holds $TMP_DIST) — retrying in ${delay}s"
    sleep "$delay"
    delay=$(( delay * 2 ))
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
     "$PSQL" "$PG_URL" < "$BACKUP_FILE"
 (confirm <db_name> matches DATABASE_URL in $BACKEND_DIR/.env before running this)

 Backend code (previous commit):
   cd "$BACKEND_DIR" && git checkout <previous-commit> -- . && \\
     npm ci && npx prisma generate && npm run build && pm2 restart $PM2_APP
============================================================
SUMMARY
