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

DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$BACKEND_DIR/.env" | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$DATABASE_URL" ] || die "DATABASE_URL not found in $BACKEND_DIR/.env"

# ── 1. backup — and PROVE it's real before doing anything else ─────────
log "[1/6] Backing up database"
mkdir -p "$BACKUP_DIR"
step "pg_dump -> $BACKUP_FILE"
"$PG_DUMP" "$DATABASE_URL" > "$BACKUP_FILE"

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
pm2 stop "$PM2_APP" 2>/dev/null || step "$PM2_APP was not running — continuing"

# From here on, if anything fails, the site is down. Make that loud.
on_error() {
  printf '\n\n*** DEPLOY FAILED — %s IS STOPPED AND THE SITE IS DOWN ***\n' "$PM2_APP" >&2
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
if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP"
else
  pm2 start "$BACKEND_DIR/ecosystem.config.js"
fi
pm2 save
step "last 30 log lines:"
pm2 logs "$PM2_APP" --lines 30 --nostream || true

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
rm -rf dist.old
[ -d dist ] && mv dist dist.old
mv "$TMP_DIST" dist
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
     "$PSQL" "$DATABASE_URL" < "$BACKUP_FILE"
 (confirm <db_name> matches DATABASE_URL in $BACKEND_DIR/.env before running this)

 Backend code (previous commit):
   cd "$BACKEND_DIR" && git checkout <previous-commit> -- . && \\
     npm ci && npx prisma generate && npm run build && pm2 restart $PM2_APP
============================================================
SUMMARY
