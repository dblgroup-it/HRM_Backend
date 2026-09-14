#!/usr/bin/env bash
#
# Scheduled PostgreSQL backup for DBL HRM.
#
# Runs standalone (Task Scheduler / cron); deploy.sh takes its own backup before
# a release, which is a different thing — that one protects a deployment, this
# one protects the data.
#
#   ./scripts/backup-production.sh
#
# What it does, in order:
#   1. locate pg_dump explicitly (PATH is unreliable on the Windows box)
#   2. dump, compress
#   3. PROVE the dump is complete before it counts as a backup
#   4. encrypt at rest, if a passphrase is configured
#   5. copy off-server, if a destination is configured
#   6. prune by retention
#
# Exit codes:  0 success · 1 backup failed · 2 backup OK but off-server copy
#              failed (the local copy is good; the off-site one is not)
#
# Never prints DATABASE_URL, the encryption passphrase, or any row of data.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/hrm_backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
# Optional. A directory on a different machine: a mapped drive, a UNC path, a
# mounted share. Set BACKUP_OFFSITE_DIR to enable.
OFFSITE_DIR="${BACKUP_OFFSITE_DIR:-}"
# Optional. When set, the dump is encrypted with AES-256 before it is written
# anywhere. Read from a file so it never appears in a process list.
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { printf '[%s] ERROR: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

# ── locate pg_dump ─────────────────────────────────────────────────────────
locate_pg_dump() {
  if command -v pg_dump >/dev/null 2>&1; then command -v pg_dump; return; fi
  for c in \
    "/c/Program Files/PostgreSQL/18/bin/pg_dump.exe" \
    "/c/Program Files/PostgreSQL/17/bin/pg_dump.exe" \
    "/c/Program Files/PostgreSQL/16/bin/pg_dump.exe" \
    "/c/Program Files/PostgreSQL/15/bin/pg_dump.exe"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}
PG_DUMP="$(locate_pg_dump)" || die "pg_dump not found on PATH or in any known PostgreSQL install directory."
log "pg_dump: $PG_DUMP"

# ── connection string ──────────────────────────────────────────────────────
# Read from .env and never echoed. `set +x` is belt and braces in case the
# caller exported it.
set +x
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$BACKEND_DIR/.env" | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$DATABASE_URL" ] || die "DATABASE_URL not found in $BACKEND_DIR/.env"

# Prisma's URL carries driver options pg_dump/psql do not understand
# (?schema=public&connection_limit=20). Strip the query string; the schema is
# already in the dump and the pool settings are meaningless to these tools.
DATABASE_URL="${DATABASE_URL%%\?*}"

mkdir -p "$BACKUP_DIR"
PLAIN="$BACKUP_DIR/hrm_${TIMESTAMP}.sql"

# ── 1. dump ────────────────────────────────────────────────────────────────
log "dumping -> $(basename "$PLAIN")"
"$PG_DUMP" "$DATABASE_URL" > "$PLAIN" || die "pg_dump failed. Nothing was written that can be trusted."

# ── 2. prove it is complete ────────────────────────────────────────────────
# An interrupted pg_dump leaves a large, plausible-looking, USELESS file. The
# only reliable signal is its own end-of-dump marker.
[ -s "$PLAIN" ] || { rm -f "$PLAIN"; die "dump is empty."; }
if ! tail -c 4096 "$PLAIN" | grep -q "PostgreSQL database dump complete"; then
  die "dump does not end with pg_dump's completion marker — it is truncated. Kept for inspection: $PLAIN"
fi
ROWS_MARKER="$(grep -c '^COPY ' "$PLAIN" || true)"
log "verified complete — $(du -h "$PLAIN" | cut -f1), ${ROWS_MARKER} tables"

# ── 3. compress ────────────────────────────────────────────────────────────
gzip -9 "$PLAIN"
ARTIFACT="${PLAIN}.gz"
log "compressed -> $(basename "$ARTIFACT") ($(du -h "$ARTIFACT" | cut -f1))"

# ── 4. encrypt at rest (optional but strongly recommended) ─────────────────
# The dump contains every employee and candidate record in plaintext. On a
# shared or backed-up volume that is a second, unguarded copy of the HR master.
if [ -n "$PASSPHRASE_FILE" ]; then
  [ -r "$PASSPHRASE_FILE" ] || die "BACKUP_PASSPHRASE_FILE is set but not readable."
  command -v openssl >/dev/null 2>&1 || die "openssl not found, but encryption was requested."
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$ARTIFACT" -out "${ARTIFACT}.enc" -pass "file:$PASSPHRASE_FILE" \
    || die "encryption failed."
  shred -u "$ARTIFACT" 2>/dev/null || rm -f "$ARTIFACT"
  ARTIFACT="${ARTIFACT}.enc"
  log "encrypted -> $(basename "$ARTIFACT")"
else
  log "WARNING: BACKUP_PASSPHRASE_FILE is not set — this backup is stored UNENCRYPTED."
fi

# ── 5. off-server copy ─────────────────────────────────────────────────────
# A backup on the same disk as the database protects against a bad migration
# and nothing else: not disk failure, not ransomware, not losing the server.
OFFSITE_OK=1
if [ -n "$OFFSITE_DIR" ]; then
  if mkdir -p "$OFFSITE_DIR" 2>/dev/null && cp "$ARTIFACT" "$OFFSITE_DIR/" 2>/dev/null; then
    log "copied off-server -> $OFFSITE_DIR"
  else
    OFFSITE_OK=0
    log "WARNING: off-server copy to $OFFSITE_DIR FAILED. The local backup is good."
  fi
else
  log "WARNING: BACKUP_OFFSITE_DIR is not set — this backup exists only on this server."
fi

# ── 6. retention ───────────────────────────────────────────────────────────
PRUNED="$(find "$BACKUP_DIR" -name 'hrm_*.sql.gz*' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')"
[ "$PRUNED" -gt 0 ] && log "pruned $PRUNED backup(s) older than $RETENTION_DAYS days"

KEPT="$(find "$BACKUP_DIR" -name 'hrm_*.sql.gz*' -type f | wc -l | tr -d ' ')"
log "done — $KEPT backup(s) retained in $BACKUP_DIR"

[ "$OFFSITE_OK" -eq 1 ] || exit 2
exit 0
