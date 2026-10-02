#!/usr/bin/env bash
#
# Copy the live database into a dated copy for the dev server.
#
#   ~/HRM_Backend/deploy/ubuntu/dev-clone-db.sh           # today's copy (skips if it exists)
#   ~/HRM_Backend/deploy/ubuntu/dev-clone-db.sh --force   # make today's copy again
#
# Run nightly from the dbl-hrm user's crontab (see deploy/ubuntu/DEV_SERVER.md):
#
#   45 2 * * * $HOME/HRM_Backend/deploy/ubuntu/dev-clone-db.sh >> $HOME/dev/clone.log 2>&1
#
# What it does, in order:
#   1. dumps the live database (read-only — it only ever reads the live one)
#   2. restores it into  <prefix>YYYYMMDD  (Dhaka date), owned by the dev
#      database user, via a temporary name so a half-made copy is never seen
#   3. applies the dev branch's migrations to the copy, so the dev code and
#      its database match
#   4. keeps the copies of the last KEEP_DAYS days (default 7) and drops the
#      rest — a pinned copy included, which sends the dev site back to the
#      newest
#   5. restarts the dev app when it follows "latest", so it moves onto today's
#
# Settings (environment, optional):
#   PROD_DIR     live backend checkout   (default ~/HRM_Backend)
#   DEV_DIR      dev backend checkout    (default ~/dev/HRM_Backend)
#   KEEP_DAYS    days of copies to keep (default 7)
#   DEV_APP      PM2 name of the dev app (default hrm-backend-dev)

set -euo pipefail

PROD_DIR="${PROD_DIR:-$HOME/HRM_Backend}"
DEV_DIR="${DEV_DIR:-$HOME/dev/HRM_Backend}"
KEEP_DAYS="${KEEP_DAYS:-${KEEP_COPIES:-7}}"
DEV_APP="${DEV_APP:-hrm-backend-dev}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

say() { printf '[%s] %s\n' "$(date '+%F %T')" "$1"; }
die() { say "FAILED: $1"; exit 1; }

# A value from an .env file, quotes and Prisma's ?schema=… stripped (the
# PostgreSQL tools reject the query string).
env_value() {
  grep -m1 "^$2=" "$1/.env" 2>/dev/null | tr -d '\r' | cut -d'=' -f2- \
    | sed -e 's/^"//' -e 's/"$//' || true
}
strip_query() { printf '%s' "${1%%\?*}"; }
# The same server URL pointed at another database.
with_db() { printf '%s/%s' "${1%/*}" "$2"; }

[ -f "$PROD_DIR/.env" ] || die "no live .env at $PROD_DIR/.env"
[ -f "$DEV_DIR/.env" ]  || die "no dev .env at $DEV_DIR/.env — set up the dev server first"

PROD_URL="$(strip_query "$(env_value "$PROD_DIR" DATABASE_URL)")"
DEV_URL="$(strip_query "$(env_value "$DEV_DIR" DATABASE_URL)")"
PREFIX="$(env_value "$DEV_DIR" SANDBOX_DB_PREFIX)"; PREFIX="${PREFIX:-dbl_hrm_dev_}"
PICK_FILE="$(env_value "$DEV_DIR" SANDBOX_DB_FILE)"; PICK_FILE="${PICK_FILE:-.dev-db}"
case "$PICK_FILE" in /*) ;; *) PICK_FILE="$DEV_DIR/$PICK_FILE" ;; esac

[ -n "$PROD_URL" ] || die "DATABASE_URL missing from the live .env"
[ -n "$DEV_URL" ]  || die "DATABASE_URL missing from the dev .env"
[[ "$PREFIX" =~ ^[a-z0-9_]+$ ]] || die "SANDBOX_DB_PREFIX may only hold a-z, 0-9 and _"

# The dev user works from the maintenance database; it owns the copies.
ADMIN_URL="$(with_db "$DEV_URL" postgres)"
LIVE_DB="${PROD_URL##*/}"
[[ "$LIVE_DB" == "$PREFIX"* ]] && die "the live DATABASE_URL names a copy ($LIVE_DB) — refusing"

psql_dev() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qAt "$@"; }
db_exists() { [ "$(psql_dev -c "SELECT 1 FROM pg_database WHERE datname='$1'")" = "1" ]; }
drop_db() {
  # Close whatever is connected (the dev app, if it is on this copy) first.
  psql_dev -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$1' AND pid <> pg_backend_pid()" >/dev/null
  psql_dev -c "DROP DATABASE IF EXISTS \"$1\""
}

TODAY="$(TZ=Asia/Dhaka date +%Y%m%d)"
NAME="${PREFIX}${TODAY}"
TMP="${NAME}_new"

if db_exists "$NAME" && [ "$FORCE" = "0" ]; then
  say "$NAME already exists — nothing to do (use --force to make it again)"
else
  # Room for the copy: the live database's size, twice over for the restore.
  live_bytes="$(psql "$PROD_URL" -qAt -c "SELECT pg_database_size(current_database())")"
  data_dir="/var/lib/postgresql"; [ -d "$data_dir" ] || data_dir="/"
  free_bytes="$(df -Pk "$data_dir" | awk 'NR==2 { print $4 * 1024 }')"
  if [ "$free_bytes" -lt $((live_bytes * 2)) ]; then
    die "not enough disk: live database $((live_bytes/1024/1024)) MB, free $((free_bytes/1024/1024)) MB. Lower KEEP_DAYS or free space."
  fi

  say "Copying $LIVE_DB ($((live_bytes/1024/1024)) MB) → $NAME"
  drop_db "$TMP"
  psql_dev -c "CREATE DATABASE \"$TMP\""
  # --no-owner/--no-privileges: everything ends up owned by the dev user,
  # which has no rights on the live database itself.
  pg_dump -Fc "$PROD_URL" \
    | pg_restore --no-owner --no-privileges --no-comments --exit-on-error -d "$(with_db "$DEV_URL" "$TMP")" \
    || { drop_db "$TMP"; die "copy failed — the half-made $TMP was removed"; }

  say "Applying the dev branch's migrations to the copy"
  ( cd "$DEV_DIR" && DATABASE_URL="$(with_db "$DEV_URL" "$TMP")" npx prisma migrate deploy ) \
    || { drop_db "$TMP"; die "migrations failed on the copy — removed it"; }

  db_exists "$NAME" && drop_db "$NAME"
  psql_dev -c "ALTER DATABASE \"$TMP\" RENAME TO \"$NAME\""
  say "Made $NAME"
fi

# ── Keep the last KEEP_DAYS days, nothing older ─────────────────────────────
# By date (Dhaka), today included: with 7, on the 9th the 3rd onward stays.
# The newest copy is always kept, so a dev site whose nightly job stopped
# still has something to open. A pinned copy gets no exemption: once it is
# older than that it goes, and the dev site goes back to the newest.
PINNED=""
[ -f "$PICK_FILE" ] && PINNED="$(tr -d '[:space:]' < "$PICK_FILE")"
CUTOFF="$(TZ=Asia/Dhaka date -d "$((KEEP_DAYS - 1)) days ago" +%Y%m%d 2>/dev/null \
  || TZ=Asia/Dhaka date -v-"$((KEEP_DAYS - 1))"d +%Y%m%d)"
NEWEST="$(psql_dev -c "SELECT datname FROM pg_database WHERE datname ~ '^${PREFIX}[0-9]{8}$' ORDER BY datname DESC LIMIT 1")"
for db in $(psql_dev -c "SELECT datname FROM pg_database WHERE datname ~ '^${PREFIX}[0-9]{8}$' ORDER BY datname"); do
  day="${db#"$PREFIX"}"
  if [ "$day" -ge "$CUTOFF" ] || [ "$db" = "$NEWEST" ]; then continue; fi
  say "Removing copy $db (older than $KEEP_DAYS days)"
  drop_db "$db"
  if [ "$db" = "$PINNED" ]; then
    echo latest > "$PICK_FILE"
    PINNED="latest"
    say "It was the pinned copy — the dev site now follows the newest"
  fi
done

# ── Move the dev app onto today's copy if it follows "latest" ───────────────
if [ -z "$PINNED" ] || [ "$PINNED" = "latest" ]; then
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$DEV_APP" >/dev/null 2>&1; then
    say "Dev site follows the latest copy — restarting $DEV_APP"
    pm2 restart "$DEV_APP" --update-env >/dev/null
  fi
else
  say "Dev site is pinned to $PINNED — left as it is"
fi
say "Done"
