#!/usr/bin/env bash
#
# Restore drill: prove a backup can actually be restored, and measure how long
# it takes.
#
#   ./scripts/restore-test.sh                       # newest backup
#   ./scripts/restore-test.sh /path/to/hrm_x.sql.gz # a specific one
#
# A backup that has never been restored is a hypothesis, not a backup. This
# restores into a SEPARATE, TEMPORARY database, compares row counts against the
# live one, reports the elapsed time (that number is your RTO), and drops the
# temporary database again.
#
# IT NEVER TOUCHES THE PRODUCTION DATABASE. The target name is generated with a
# timestamp and refused if it resolves to the live database name.
#
# Exit codes: 0 restore verified · 1 restore failed or counts disagree
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/hrm_backups}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[%s] ERROR: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

find_tool() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for v in 18 17 16 15; do
    local c="/c/Program Files/PostgreSQL/$v/bin/$name.exe"
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}
PSQL="$(find_tool psql)"       || die "psql not found."
CREATEDB="$(find_tool createdb)" || die "createdb not found."
DROPDB="$(find_tool dropdb)"   || die "dropdb not found."

set +x
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$BACKEND_DIR/.env" | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$DATABASE_URL" ] || die "DATABASE_URL not found in $BACKEND_DIR/.env"

# Prisma's URL carries driver options pg_dump/psql do not understand
# (?schema=public&connection_limit=20). Strip the query string; the schema is
# already in the dump and the pool settings are meaningless to these tools.
DATABASE_URL="${DATABASE_URL%%\?*}"

# Split the URL so the temporary database can be addressed on the same server
# without ever rewriting the live name by accident.
BASE_URL="${DATABASE_URL%\?*}"
LIVE_DB="$(basename "$BASE_URL")"
SERVER_URL="$(dirname "$BASE_URL")"
TEST_DB="hrm_restore_test_$(date +%Y%m%d_%H%M%S)"

# Hard stop: the target must not be the live database under any circumstance.
[ "$TEST_DB" != "$LIVE_DB" ] || die "refusing to run: the test database name matches the live one."
case "$TEST_DB" in hrm_restore_test_*) ;; *) die "refusing to run: unexpected test database name." ;; esac

# ── pick the backup ────────────────────────────────────────────────────────
ARTIFACT="${1:-}"
if [ -z "$ARTIFACT" ]; then
  ARTIFACT="$(find "$BACKUP_DIR" -name 'hrm_*.sql.gz*' -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1 || true)"
fi
[ -n "$ARTIFACT" ] && [ -f "$ARTIFACT" ] || die "no backup found. Looked in $BACKUP_DIR — run scripts/backup-production.sh first."
log "restoring: $(basename "$ARTIFACT") ($(du -h "$ARTIFACT" | cut -f1))"

WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  "$DROPDB" --if-exists "$TEST_DB" 2>/dev/null || true
}
trap cleanup EXIT

# ── decrypt / decompress ───────────────────────────────────────────────────
SQL="$WORK/restore.sql"
case "$ARTIFACT" in
  *.enc)
    [ -n "$PASSPHRASE_FILE" ] || die "backup is encrypted but BACKUP_PASSPHRASE_FILE is not set."
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
      -in "$ARTIFACT" -out "$WORK/restore.sql.gz" -pass "file:$PASSPHRASE_FILE" \
      || die "decryption failed — wrong passphrase?"
    gunzip -c "$WORK/restore.sql.gz" > "$SQL"
    ;;
  *.gz) gunzip -c "$ARTIFACT" > "$SQL" ;;
  *)    cp "$ARTIFACT" "$SQL" ;;
esac

tail -c 4096 "$SQL" | grep -q "PostgreSQL database dump complete" \
  || die "this backup is truncated — it would not have restored. That is exactly what this drill is for."

# ── restore, timed ─────────────────────────────────────────────────────────
STARTED="$(date +%s)"
log "creating $TEST_DB"
"$CREATEDB" "$TEST_DB" || die "could not create the temporary database."
log "restoring (this is the number that becomes your RTO)…"
"$PSQL" --quiet --set ON_ERROR_STOP=on "$SERVER_URL/$TEST_DB" < "$SQL" >/dev/null \
  || die "restore FAILED. The backup is not usable. Investigate before relying on it."
ELAPSED=$(( $(date +%s) - STARTED ))
log "restored in ${ELAPSED}s"

# ── compare against live ───────────────────────────────────────────────────
# Counts only — no row content is read, printed or copied anywhere.
COUNT_SQL="SELECT 'users', count(*) FROM users
 UNION ALL SELECT 'employees', count(*) FROM employees
 UNION ALL SELECT 'requisitions', count(*) FROM requisitions
 UNION ALL SELECT 'candidates', count(*) FROM candidates
 UNION ALL SELECT 'onboardings', count(*) FROM onboardings
 UNION ALL SELECT 'board_approvals', count(*) FROM board_approvals
 UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
 ORDER BY 1;"

"$PSQL" -At -F'|' "$DATABASE_URL"          -c "$COUNT_SQL" > "$WORK/live.txt"
"$PSQL" -At -F'|' "$SERVER_URL/$TEST_DB"   -c "$COUNT_SQL" > "$WORK/restored.txt"

printf '\n%-18s %10s %10s   %s\n' "TABLE" "LIVE" "RESTORED" "RESULT"
STATUS=0
while IFS='|' read -r table live; do
  restored="$(grep "^${table}|" "$WORK/restored.txt" | cut -d'|' -f2 || echo '?')"
  if [ "$live" = "$restored" ]; then
    printf '%-18s %10s %10s   ok\n' "$table" "$live" "$restored"
  else
    printf '%-18s %10s %10s   MISMATCH\n' "$table" "$live" "$restored"
    STATUS=1
  fi
done < "$WORK/live.txt"

echo
if [ "$STATUS" -eq 0 ]; then
  log "RESTORE VERIFIED. Every checked table matches. RTO for this dataset: ${ELAPSED}s."
  log "Record today's date as the last successful restore drill."
else
  log "COUNTS DISAGREE. Some difference is expected if the system was in use during the backup;"
  log "a large or structural difference is not. Investigate before relying on this backup."
fi

log "dropping $TEST_DB"
exit "$STATUS"
