#!/usr/bin/env bash
#
# Deploy the DBL HRM API on the server.
#
#   ./deploy.sh
#
# Pulls main, installs locked dependencies, applies any new Prisma migrations,
# builds, and restarts PM2. Safe to re-run: every step is idempotent, and a
# release with no new migration simply reports "No pending migrations".
#
# Why a script rather than a remembered sequence: the steps are not optional
# and the order matters. `prisma generate` before `build` (the client's types
# are compiled in), `prisma migrate deploy` before the new code starts (so the
# columns exist when it reads them), and a PM2 restart last — the API serves
# from dist/ loaded into memory at boot, so a rebuilt dist/ changes nothing
# until the process is replaced. A build that was never restarted is the
# failure this script exists to prevent; it has happened.

set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mdeploy failed:\033[0m %s\n' "$1" >&2; exit 1; }

# ── Preflight ───────────────────────────────────────────────────────────────

[ -f .env ] || die ".env is missing. The API cannot start without DATABASE_URL and JWT_SECRET."

command -v pm2 >/dev/null 2>&1 || die "pm2 is not on PATH. Install it with: npm i -g pm2"

# A dirty tree on the server means somebody edited production by hand. Pulling
# over it either fails halfway or silently discards their fix; stop and let a
# person decide which.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "the working tree has uncommitted changes. Commit, stash or discard them first."
fi

# ── Pull ────────────────────────────────────────────────────────────────────

say "Fetching main"
git fetch origin main
before="$(git rev-parse HEAD)"

# --ff-only: never create a merge commit on a server. If this refuses, the
# server has commits that main does not, which is a question for a human.
git merge --ff-only origin/main || die "cannot fast-forward — this checkout has diverged from origin/main."

after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ]; then
  say "Already up to date at $(git rev-parse --short HEAD) — rebuilding and restarting anyway"
else
  say "Updated $(git rev-parse --short "$before") → $(git rev-parse --short "$after")"
  git --no-pager log --oneline "$before..$after" | sed 's/^/    /'
fi

# ── Build ───────────────────────────────────────────────────────────────────

say "Installing dependencies (locked)"
npm ci

say "Generating the Prisma client"
npm run prisma:generate

say "Applying database migrations"
npm run prisma:deploy

say "Building"
npm run build

[ -f dist/main.js ] || die "the build produced no dist/main.js."

# ── Restart ─────────────────────────────────────────────────────────────────

# startOrReload covers both cases: a first deploy where nothing is running, and
# every one after. Single instance in fork mode is deliberate (see
# ecosystem.config.js — Socket.IO broadcasts do not survive cluster mode), so
# this is a brief restart rather than a zero-downtime handover. Connected
# clients reconnect on their own.
say "Restarting PM2"
mkdir -p logs
pm2 startOrReload ecosystem.config.js --update-env
pm2 save

say "Done — $(git rev-parse --short HEAD) is live"
pm2 describe hrm-backend | sed -n '/status/p;/uptime/p;/restarts/p' || true
printf '\nTail the log with:  pm2 logs hrm-backend\n\n'
