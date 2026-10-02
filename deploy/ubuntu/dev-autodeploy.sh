#!/usr/bin/env bash
#
# Keep the dev server on the newest `dev` branch, by itself.
#
# Run every 2 minutes from the dbl-hrm crontab:
#
#   */2 * * * * $HOME/dev/HRM_Backend/deploy/ubuntu/dev-autodeploy.sh
#
# Asks GitHub whether `dev` moved (backend or frontend) — the server cannot
# be reached from outside, but it can reach GitHub, exactly as it pulls — and
# if so runs the dev ./deploy.sh. A commit that fails to deploy is not tried
# again every two minutes: it waits for the next push. Each run's log is kept
# in ~/dev/autodeploy/, and state.json is what Dev tools shows.
#
# Never touches the live site: it only ever deploys the dev checkouts.

set -uo pipefail

DEV_DIR="${DEV_DIR:-$HOME/dev/HRM_Backend}"
DEV_FRONTEND_DIR="${DEV_FRONTEND_DIR:-$HOME/dev/HRM_Frontend}"
STATE_DIR="${AUTODEPLOY_DIR:-$HOME/dev/autodeploy}"
BRANCH="${DEPLOY_BRANCH:-dev}"

mkdir -p "$STATE_DIR/logs"
LOCK="$STATE_DIR/lock"
STATE="$STATE_DIR/state.json"
FAILED="$STATE_DIR/failed-at"   # "<backend sha> <frontend sha>" that failed

# One at a time; a deploy can take longer than two minutes. A lock older than
# an hour is a crashed run, not a running one.
if [ -d "$LOCK" ]; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$LOCK"; else exit 0; fi
fi
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

remote_sha() { git -C "$1" ls-remote --quiet origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1; }

be_remote="$(remote_sha "$DEV_DIR")"
fe_remote="$(remote_sha "$DEV_FRONTEND_DIR")"
# GitHub unreachable: try again next time, quietly.
[ -n "$be_remote" ] && [ -n "$fe_remote" ] || exit 0

be_local="$(git -C "$DEV_DIR" rev-parse HEAD)"
fe_local="$(git -C "$DEV_FRONTEND_DIR" rev-parse HEAD)"
[ "$be_remote" = "$be_local" ] && [ "$fe_remote" = "$fe_local" ] && exit 0

# This exact pair already failed — wait for a new push.
[ "$(cat "$FAILED" 2>/dev/null)" = "$be_remote $fe_remote" ] && exit 0

RUN="$(date +%Y%m%d-%H%M%S)"
LOG="$STATE_DIR/logs/$RUN.log"
write_state() { # status message
  cat > "$STATE.tmp" <<EOF
{"runId":"$RUN","status":"$1","message":"${2//\"/\'}","at":"$(date -u +%FT%TZ)","backend":"${be_remote:0:7}","frontend":"${fe_remote:0:7}","log":"$LOG"}
EOF
  mv "$STATE.tmp" "$STATE"
}

write_state running "Updating the dev site"
# A clean environment, like any deploy: nothing from cron's or anyone's shell.
if env -i HOME="$HOME" USER="${USER:-}" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM=dumb \
     bash -c "cd '$DEV_DIR' && ./deploy.sh" >"$LOG" 2>&1; then
  rm -f "$FAILED"
  write_state success "The dev site runs the newest dev branch."
else
  echo "$be_remote $fe_remote" > "$FAILED"
  write_state failed "The dev deploy failed; the dev site still runs the previous version. It will try again on the next push."
fi

# Keep the last 50 run logs.
ls -1t "$STATE_DIR"/logs/*.log 2>/dev/null | tail -n +51 | xargs -r rm -f
