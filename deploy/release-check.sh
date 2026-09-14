#!/usr/bin/env bash
#
# One command to run before deploying. Fails on the first real gate that fails.
#
#   ./release-check.sh
#
# Provider-neutral: the same gates GitHub Actions runs, runnable from a laptop
# or from the production server before `deploy.sh`. Touches nothing — no
# install beyond `npm ci` into node_modules, no database writes, no network
# calls except the npm registry.
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
