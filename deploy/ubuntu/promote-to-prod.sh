#!/usr/bin/env bash
#
# Put what is running on the dev server live — and undo it if it fails.
#
# Started by the "Deploy to Prod" button on the dev site (admin only), never
# by hand in normal use. It can be run by hand from the dev backend checkout:
#
#   ~/dev/HRM_Backend/deploy/ubuntu/promote-to-prod.sh
#
#   1. checks the dev checkouts are clean, and that the tested commits build
#      on what is live (fast-forward only — if live has something dev does
#      not, it stops rather than overwrite it)
#   2. hands those exact commits to the live checkouts (fetched straight from
#      the dev checkouts, so GitHub is not needed for this)
#   3. runs the live ./deploy.sh on them: database backup, migrations, build,
#      restart, health checks
#   4. if any of that fails: puts the live checkouts back at the previous
#      release, rebuilds and restarts them, and keeps the error log
#   5. only after a healthy deploy: pushes the commits to GitHub `main`, when
#      the server is allowed to push — so GitHub matches what is live
#
# It runs in a clean environment: the dev app that starts it carries
# SANDBOX_MODE, the dev database and the dev port, none of which may reach
# the live deploy.
#
# Progress: $STATE_DIR/state.json (what the page shows) and one log per run.
#
# Settings (environment, optional):
#   PROD_DIR / PROD_FRONTEND_DIR   live checkouts (default ~/HRM_Backend, ~/HRM_Frontend)
#   DEV_DIR  / DEV_FRONTEND_DIR    dev checkouts  (default ~/dev/HRM_Backend, ~/dev/HRM_Frontend)
#   STATE_DIR                      default ~/dev/promote
#   PUSH_TO_GITHUB=0               deploy without pushing to GitHub

# A clean slate: only what a login shell would have.
if [ -z "${PROMOTE_CLEAN_ENV:-}" ]; then
  exec env -i PROMOTE_CLEAN_ENV=1 HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
    PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM=dumb \
    PROD_DIR="${PROD_DIR:-}" PROD_FRONTEND_DIR="${PROD_FRONTEND_DIR:-}" \
    DEV_DIR="${DEV_DIR:-}" DEV_FRONTEND_DIR="${DEV_FRONTEND_DIR:-}" \
    STATE_DIR="${STATE_DIR:-}" PUSH_TO_GITHUB="${PUSH_TO_GITHUB:-1}" \
    bash "$0" "$@"
fi

set -uo pipefail

PROD_DIR="${PROD_DIR:-$HOME/HRM_Backend}"
PROD_FRONTEND_DIR="${PROD_FRONTEND_DIR:-$HOME/HRM_Frontend}"
DEV_DIR="${DEV_DIR:-$HOME/dev/HRM_Backend}"
DEV_FRONTEND_DIR="${DEV_FRONTEND_DIR:-$HOME/dev/HRM_Frontend}"
STATE_DIR="${STATE_DIR:-$HOME/dev/promote}"
PUSH_TO_GITHUB="${PUSH_TO_GITHUB:-1}"

mkdir -p "$STATE_DIR/logs"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
LOG="$STATE_DIR/logs/$RUN_ID.log"
STATE="$STATE_DIR/state.json"
LOCK="$STATE_DIR/lock"

# Everything below goes to this run's log.
exec >>"$LOG" 2>&1

say() { printf '\n[%s] ==> %s\n' "$(date '+%T')" "$1"; }

STARTED="$(date -u +%FT%TZ)"
BE_FROM="" BE_TO="" FE_FROM="" FE_TO="" PUSHED="false"
write_state() { # status message
  local msg="${2//\"/\'}"
  cat > "$STATE.tmp" <<EOF
{"runId":"$RUN_ID","status":"$1","message":"$msg","startedAt":"$STARTED","finishedAt":"$( [ "$1" = running ] && echo '' || date -u +%FT%TZ)","log":"$LOG","backend":{"from":"$BE_FROM","to":"$BE_TO"},"frontend":{"from":"$FE_FROM","to":"$FE_TO"},"pushed":$PUSHED}
EOF
  mv "$STATE.tmp" "$STATE"
}

# One at a time: a second press while a deploy runs is refused.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Another promotion is running (lock $LOCK)."
  exit 3
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

fail() { write_state failed "$1"; say "FAILED: $1"; exit 1; }

write_state running "Checking"
say "Promotion $RUN_ID"

# ── 1. What is being promoted ───────────────────────────────────────────────
for d in "$DEV_DIR" "$DEV_FRONTEND_DIR" "$PROD_DIR" "$PROD_FRONTEND_DIR"; do
  [ -d "$d/.git" ] || fail "$d is not a git checkout"
done
for d in "$DEV_DIR" "$DEV_FRONTEND_DIR"; do
  [ -z "$(git -C "$d" status --porcelain)" ] || fail "$d has uncommitted changes — only committed, tested code is promoted"
done

BE_TO="$(git -C "$DEV_DIR" rev-parse HEAD)"
FE_TO="$(git -C "$DEV_FRONTEND_DIR" rev-parse HEAD)"
BE_FROM="$(git -C "$PROD_DIR" rev-parse HEAD)"
FE_FROM="$(git -C "$PROD_FRONTEND_DIR" rev-parse HEAD)"
write_state running "Checking"

if [ "$BE_TO" = "$BE_FROM" ] && [ "$FE_TO" = "$FE_FROM" ]; then
  write_state nothing "Live already runs exactly what dev runs — nothing to deploy."
  say "Nothing to deploy"; exit 0
fi

# Bring the tested commits into the live checkouts, straight from the dev
# checkouts on this same machine.
say "Fetching the dev commits into the live checkouts"
git -C "$PROD_DIR" fetch --quiet "$DEV_DIR" "$BE_TO" || fail "could not fetch $BE_TO from $DEV_DIR"
git -C "$PROD_FRONTEND_DIR" fetch --quiet "$DEV_FRONTEND_DIR" "$FE_TO" || fail "could not fetch $FE_TO from $DEV_FRONTEND_DIR"

# Never overwrite live work: the dev commits must contain what is live.
git -C "$PROD_DIR" merge-base --is-ancestor "$BE_FROM" "$BE_TO" \
  || fail "live backend has commits the dev build does not ($(git -C "$PROD_DIR" rev-parse --short "$BE_FROM")). Merge main into dev, test, and promote again."
git -C "$PROD_FRONTEND_DIR" merge-base --is-ancestor "$FE_FROM" "$FE_TO" \
  || fail "live frontend has commits the dev build does not ($(git -C "$PROD_FRONTEND_DIR" rev-parse --short "$FE_FROM")). Merge main into dev, test, and promote again."

say "Backend  $(git -C "$PROD_DIR" rev-parse --short "$BE_FROM") → $(git -C "$PROD_DIR" rev-parse --short "$BE_TO")"
git -C "$PROD_DIR" --no-pager log --oneline "$BE_FROM..$BE_TO" | sed 's/^/    /'
say "Frontend $(git -C "$PROD_FRONTEND_DIR" rev-parse --short "$FE_FROM") → $(git -C "$PROD_FRONTEND_DIR" rev-parse --short "$FE_TO")"
git -C "$PROD_FRONTEND_DIR" --no-pager log --oneline "$FE_FROM..$FE_TO" | sed 's/^/    /'

# ── 2/3. Deploy ─────────────────────────────────────────────────────────────
write_state running "Deploying to the live site"
say "Running the live deploy"
if ( cd "$PROD_DIR" && FRONTEND_DIR="$PROD_FRONTEND_DIR" \
       DEPLOY_BACKEND_REF="$BE_TO" DEPLOY_FRONTEND_REF="$FE_TO" ./deploy.sh ); then
  say "Live deploy succeeded"
else
  # ── 4. Roll back ──────────────────────────────────────────────────────────
  write_state rolling_back "The deploy failed — putting the previous release back"
  say "Deploy FAILED — rolling back to the previous release"
  if ( cd "$PROD_DIR" && git reset --hard --quiet "$BE_FROM" \
         && git -C "$PROD_FRONTEND_DIR" reset --hard --quiet "$FE_FROM" \
         && FRONTEND_DIR="$PROD_FRONTEND_DIR" ROLLBACK=1 \
            DEPLOY_BACKEND_REF="$BE_FROM" DEPLOY_FRONTEND_REF="$FE_FROM" ./deploy.sh ); then
    write_state rolled_back "The deploy failed and the previous release was restored. Nothing was pushed to GitHub. See the log for the error."
    say "Rolled back — the live site runs the previous release"
    exit 1
  fi
  write_state rollback_failed "The deploy failed AND the rollback failed. The live site needs attention now: see the log, and run ./deploy.sh on the server."
  say "ROLLBACK FAILED"
  exit 2
fi

# ── 5. GitHub ───────────────────────────────────────────────────────────────
MSG="Deployed to the live site."
if [ "$PUSH_TO_GITHUB" = "1" ]; then
  write_state running "Updating GitHub main"
  say "Pushing to GitHub main (fast-forward only)"
  ok=1
  ( cd "$PROD_DIR" && git push origin "HEAD:main" ) || ok=0
  ( cd "$PROD_FRONTEND_DIR" && git push origin "HEAD:main" ) || ok=0
  if [ "$ok" = "1" ]; then
    PUSHED="true"; MSG="Deployed to the live site, and GitHub main updated."
  else
    MSG="Deployed to the live site. GitHub main was NOT updated (no push access, or main moved) — push it from a computer."
  fi
fi
write_state success "$MSG"
say "$MSG"
