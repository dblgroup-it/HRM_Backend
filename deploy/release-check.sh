#!/usr/bin/env bash
#
# One command to run before deploying. Fails on the first real gate that fails.
#
#   ./release-check.sh
#
# Provider-neutral: the same gates GitHub Actions runs. No database writes and
# no network calls except the npm registry.
#
# NOT SAFE AGAINST A RUNNING APP. The gates below run `npm ci`, which DELETES
# node_modules before reinstalling it. On Windows the OS refuses to unlink files
# a live process holds open, so running this while PM2 serves the app leaves the
# tree half-deleted: the running process survives on modules already loaded into
# memory, but the next restart fails. Learned the hard way on the production
# server — hence the guard below. Run this on a build machine, or stop the app
# first (`deploy.sh` does exactly that at its step 2).
set -uo pipefail

# This script lives in HRM_Backend/deploy/ so that it ships with the backend
# repository — the monorepo root is NOT a git repository, so anything left
# there never reaches a server. The workspace root is two levels up.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/HRM_Backend"
FRONTEND="$ROOT/HRM_Frontend"

if [ ! -d "$BACKEND" ] || [ ! -d "$FRONTEND" ]; then
  printf 'Cannot find HRM_Backend and HRM_Frontend beside each other under %s\n' "$ROOT" >&2
  printf 'Both repositories must be checked out into the same parent directory.\n' >&2
  exit 2
fi

# ── refuse to run while an app is live ──────────────────────────────────────
# `npm ci` deletes node_modules. See the header comment: on Windows that
# corrupts the tree under a running process instead of failing cleanly.
#
# This guard used to start with `command -v pm2`, which is exactly wrong on the
# machine it exists to protect: pm2 is NOT on PATH inside Git Bash on the
# production server (deploy.sh carries its own locate_pm2 for that reason), so
# the guard skipped itself and the gates ran `npm ci` against the live app —
# the very thing it was written to prevent. Found on 2026-09-19, by which point
# it had already half-deleted node_modules under a running process once.
#
# So: find pm2 the way deploy.sh does, and — because that can still come up
# empty — also ask the only question that matters regardless of pm2, which is
# whether anything is actually serving the API port.
locate_pm2() {
  if command -v pm2 >/dev/null 2>&1; then command -v pm2; return 0; fi
  local npm_prefix c
  npm_prefix="$(npm config get prefix 2>/dev/null | tr -d '\r')"
  for c in "$npm_prefix/pm2.cmd" "$npm_prefix/pm2" \
           "/c/Users/Administrator/AppData/Roaming/npm/pm2.cmd"; do
    if [ -x "$c" ] || [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

api_port_busy() {
  local port="${PORT:-4000}"
  # Whichever of these exists on the box; silence is "nothing listening".
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:"$port" 2>/dev/null | grep -q . && return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ano 2>/dev/null | grep -qE "[:.]${port}[[:space:]]+.*LISTEN" && return 0
  fi
  return 1
}

if [ "${ALLOW_LIVE_NPM_CI:-0}" != "1" ]; then
  LIVE=0
  if PM2_BIN="$(locate_pm2)"; then
    LIVE="$("$PM2_BIN" jlist 2>/dev/null \
      | tr ',' '\n' \
      | grep -c '"status":"online"' || true)"
  fi
  # A listening API port is a live app whatever pm2 says — and it is the
  # condition that actually makes `npm ci` destructive here.
  if [ "${LIVE:-0}" -eq 0 ] && api_port_busy; then
    LIVE=1
    printf '\n\033[33mNote\033[0m — pm2 reported nothing, but port %s is being served.\n' "${PORT:-4000}" >&2
  fi
  if [ "${LIVE:-0}" -gt 0 ]; then
    printf '\n\033[31mREFUSING TO RUN\033[0m — the app appears to be live (%s signal(s)).\n' "$LIVE" >&2
    printf '\n' >&2
    printf 'The gates run `npm ci`, which deletes node_modules. A live process holds\n' >&2
    printf 'those files open, so the delete half-succeeds and the app cannot restart.\n' >&2
    printf '\n' >&2
    printf 'Do one of these instead:\n' >&2
    printf '  * Run this on a build machine, not the server that serves traffic.\n' >&2
    printf '  * Stop the app first:  pm2 stop <app>   (deploy.sh does this itself)\n' >&2
    printf '  * Override only if you know the tree is not in use:\n' >&2
    printf '      ALLOW_LIVE_NPM_CI=1 %s\n' "$0" >&2
    exit 2
  fi
fi

FAILED=()
PASSED=0

bold()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; PASSED=$((PASSED+1)); }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED+=("$*"); }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }

# gate <label> <dir> <command...>
gate() {
  local label="$1"; shift
  local dir="$1"; shift
  if ( cd "$dir" && "$@" ) >/tmp/release-check.$$ 2>&1; then
    ok "$label"
  else
    bad "$label"
    printf '      ---- last 15 lines ----\n'
    tail -15 /tmp/release-check.$$ | sed 's/^/      /'
  fi
  rm -f /tmp/release-check.$$
}

# soft <label> <dir> <command...>  — reported, never fatal
soft() {
  local label="$1"; shift
  local dir="$1"; shift
  if ( cd "$dir" && "$@" ) >/tmp/release-check.$$ 2>&1; then
    ok "$label"
  else
    warn "$label — see output below (not a release blocker)"
    tail -8 /tmp/release-check.$$ | sed 's/^/      /'
  fi
  rm -f /tmp/release-check.$$
}

printf '\033[1mDBL HRM — release check\033[0m\n'
printf 'node %s · npm %s\n' "$(node -v)" "$(npm -v)"

# ── Backend ────────────────────────────────────────────────────────────────
bold "Backend"
gate "npm ci"                  "$BACKEND" npm ci --no-audit --no-fund
gate "prisma generate"         "$BACKEND" npx prisma generate
gate "prisma validate"         "$BACKEND" npx prisma validate
gate "typecheck"               "$BACKEND" npx tsc --noEmit
gate "tests"                   "$BACKEND" npm test
gate "build"                   "$BACKEND" npm run build
soft "dependency audit (prod)" "$BACKEND" npm audit --omit=dev --audit-level=high
# Lint is report-only: the repo carries pre-existing formatting drift in files
# unrelated to this work, and `npm run lint` rewrites files (--fix).
soft "lint (report only)"      "$BACKEND" npx eslint "src/**/*.ts"

# ── Frontend ───────────────────────────────────────────────────────────────
bold "Frontend"
gate "npm ci"       "$FRONTEND" npm ci --no-audit --no-fund
gate "typecheck"    "$FRONTEND" npx tsc --noEmit
gate "tests"        "$FRONTEND" npm test
gate "lint"         "$FRONTEND" npm run lint
gate "build"        "$FRONTEND" npm run build
# Production dependencies only. Dev-time advisories in the test runner or the
# bundler do not ship in the built assets, and failing a release on them
# teaches people to ignore the gate.
soft "dependency audit (prod)" "$FRONTEND" npm audit --omit=dev --audit-level=high

# ── Security invariants ────────────────────────────────────────────────────
# Cheap, specific guards against regressions that have actually happened here.
bold "Security invariants"

if grep -rn "shareAnyoneWithLink" "$BACKEND/src" --include='*.ts' \
     | grep -qv 'drive.service.ts'; then
  bad "public Drive sharing reintroduced — CVs/medical reports must stay private"
  grep -rn "shareAnyoneWithLink" "$BACKEND/src" --include='*.ts' \
    | grep -v 'drive.service.ts' | sed 's/^/      /'
else
  ok "no sensitive document is published as 'anyone with the link'"
fi

if grep -q "TOTP_ENCRYPTION_KEY" "$BACKEND/src/main.ts"; then
  ok "boot refuses to start in production without TOTP_ENCRYPTION_KEY"
else
  bad "the TOTP encryption key is no longer validated at boot"
fi

if awk '/^cat <<SUMMARY/,/^SUMMARY$/' "$BACKEND/scripts/deploy.sh" | grep -q '"\$DATABASE_URL"'; then
  bad "deploy.sh prints the database password into the deploy log again"
else
  ok "deploy.sh does not expand DATABASE_URL into its summary"
fi

if grep -q "requireEmployeeAdmin" "$BACKEND/src/modules/employees/employees.service.ts"; then
  ok "employee records cannot be edited without an administrative role"
else
  bad "the employee-update authorization gate is missing"
fi

# Match a CALL, not the word — the fix itself carries a comment explaining why
# Math.random is wrong here, and a naive grep flags its own explanation.
if grep -nE "[^a-zA-Z.]Math\.random\s*\(" "$BACKEND/src/modules/auth/auth.service.ts" \
     | grep -qv "^\s*[0-9]*:\s*//"; then
  bad "auth is calling Math.random again — second-factor codes must use crypto"
  grep -nE "[^a-zA-Z.]Math\.random\s*\(" "$BACKEND/src/modules/auth/auth.service.ts" | sed 's/^/      /'
elif grep -q "randomInt(" "$BACKEND/src/modules/auth/auth.service.ts"; then
  ok "authentication codes use a cryptographic random source"
else
  bad "auth no longer uses crypto.randomInt for second-factor codes"
fi

if grep -rnE "href=\{[a-zA-Z.]*\.(cvUrl|url|hrApprovalAttachmentUrl)\}" "$FRONTEND/src" --include='*.tsx' | grep -q .; then
  bad "a document link bypasses resolveApiFileUrl — it will 404 in development"
  grep -rnE "href=\{[a-zA-Z.]*\.(cvUrl|url|hrApprovalAttachmentUrl)\}" "$FRONTEND/src" --include='*.tsx' | sed 's/^/      /'
else
  ok "every document link is resolved against the API origin"
fi

# ── Verdict ────────────────────────────────────────────────────────────────
bold "Result"
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '  \033[32m%s gates passed. Safe to deploy.\033[0m\n\n' "$PASSED"
  exit 0
fi
printf '  \033[31m%d gate(s) FAILED:\033[0m\n' "${#FAILED[@]}"
for f in "${FAILED[@]}"; do printf '    - %s\n' "$f"; done
printf '\n  Do not deploy until these pass.\n\n'
exit 1
