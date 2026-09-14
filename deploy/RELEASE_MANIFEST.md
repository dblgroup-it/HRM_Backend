# Release Manifest

**Release candidate:** `hrm-prod-2026-09-security`
**Prepared:** 14 September 2026, on a **development** machine.
**Contains no credential, no database URL, no PII.**

---

## 1. Source

| | Backend | Frontend |
| --- | --- | --- |
| Repository | `dblgroup-it/HRM_Backend` | `dblgroup-it/HRM_Frontend` |
| Branch | `main` | `main` |
| Base commit | `0d5d7d48af308207a50ef32d99a9f4b50139dde0` | `5a8da07a1481b794c36a704576e7b2d16262cba1` |
| vs `origin/main` | 0 ahead, 0 behind | 0 ahead, 0 behind |
| Release changes | **uncommitted in the working tree** | **uncommitted in the working tree** |
| Modified files | 35 | 4 |
| New files | 29 | 2 |
| Source diff (excl. lockfile) | +1,776 / −322 across 34 files | +37 / −2 across 4 files |

> The release is **prepared, not committed.** No commit, tag or push has been
> made. Suggested commands: `RELEASE_TAG_NOTES.md`.

**Recommended tag (both repositories):** `hrm-prod-2026-09-security`

---

## 2. Toolchain

| | Version | Note |
| --- | --- | --- |
| Node | **22.22.3** | Match on the server; CI pins 22 |
| npm | **10.9.8** | `npm ci` — lockfiles are authoritative |
| TypeScript | 5.9.3 | |
| NestJS | 11.1.26 | |
| Prisma CLI / client | **6.19.3** / 6.19.3 | Must match |
| React | 19.2.7 | |
| Vite | 6.4.3 | |
| PostgreSQL | **18.x expected** | Dev verified on 18.4. `pg_dump` must match the server major version |

---

## 3. Migrations

115 in the repository; **4 new in this release**, applied in filename order:

| # | Migration | Additive | Can fail |
| --- | --- | --- | --- |
| 1 | `20260913220000_integrity_check_constraints` | yes | **yes — the partial unique index.** Pre-check §2 |
| 2 | `20260913230000_first_login_and_lockout` | yes | no |
| 3 | `20260914090000_hash_public_action_tokens` | yes | no |
| 4 | `20260914120000_delegation_send_tracking` | yes | no |

Verified by scan: no `DROP TABLE`, `DROP COLUMN`, `DELETE`, `TRUNCATE`, `UPDATE`
or `ALTER COLUMN … TYPE` in any of the three.

**Excluded on purpose:** salary `Float` → `Decimal` lives in
`HRM_Backend/prisma/planned/salary_decimal/` — confirmed **absent** from
`prisma/migrations/`, so `prisma migrate deploy` cannot pick it up. No
`timestamptz` migration exists.

Full review: `RELEASE_MIGRATIONS.md`.

---

## 4. Validation — DEVELOPMENT VERIFIED

Re-run from a clean `npm ci` immediately before this manifest.

| Gate | Result |
| --- | --- |
| `release-check.sh` | **16 / 16 gates passed** |
| Backend `npm ci` | pass |
| Backend `npx prisma generate` | pass |
| Backend `npx prisma validate` | pass |
| Backend `npx tsc --noEmit` | pass |
| Backend `npm test` | **94 passed, 94 total** (9 suites) |
| Backend `npm run build` | pass |
| Backend `npm audit --omit=dev` | 8 (1 low, 3 moderate, **4 high**) — all CLI-only, §7 |
| Backend eslint (files changed here) | 0 problems |
| Frontend `npm ci` | pass |
| Frontend `npx tsc --noEmit` | pass |
| Frontend `npm run lint` (`--max-warnings 0`) | pass |
| Frontend `npm run build` | pass |
| Frontend `npm audit` | **0 vulnerabilities** |

Security invariants (in `release-check.sh` and CI):

| Invariant | Result |
| --- | --- |
| No sensitive document published as "anyone with the link" | pass |
| Boot refuses production without `TOTP_ENCRYPTION_KEY` | pass |
| `deploy.sh` does not expand `DATABASE_URL` | pass |
| Employee edits require an administrative role | pass |
| Auth codes use a cryptographic RNG | pass |

### Test suites (94 tests)

| Suite | Covers |
| --- | --- |
| `employees.service.spec.ts` | The critical authorization gap |
| `audit.service.spec.ts` | Salary, credential and medical redaction |
| `permissions.service.spec.ts` | Unit isolation, recruiter scoping, visibility |
| `auth.service.spec.ts` | Login resolution, timing, lockout, first login, policy |
| `secret-encryption.service.spec.ts` | AES-256-GCM, IV uniqueness, tamper, wrong key |
| `file-grant.service.spec.ts` | Forgery, expiry, cross-file substitution |
| `action-token.spec.ts` | Entropy, hash-only storage, dual-read |
| `candidates.cv-access.spec.ts` | CV access and cross-unit refusal |
| `onboarding.medical-access.spec.ts` | Summary vs full clinical record |

---

## 5. Repository hygiene

| Check | Result |
| --- | --- |
| `.env` tracked in either repository | **no** |
| Any `.env` ever committed (full history) | **no** |
| `google-refresh-token.txt` ignored | yes |
| Database dumps / `*.sql.gz` / `backups/` ignored | yes |
| Logs, `dist/`, `node_modules/` ignored | yes |
| Private keys, credentials, employee exports tracked | **none** |
| Credential keys in `.env.example` | all empty or placeholder |
| Debug code, probe scripts, screenshots in the diff | **none** |
| Whitespace-only churn | **none** |

**Two gaps found and closed during preparation:**

1. `.gitignore` covered `.env` and `.env.*.local` only — `.env.production`,
   `.env.local` and `.env.bak` were committable. Both repositories now ignore
   every `.env*` except `.env.example`.
2. `HRM_Frontend/.env.example` shipped `VITE_USE_MOCK_API=true`. Copied as-is to
   production it would serve fabricated data and accept a hard-coded demo
   password while appearing to work. Now `false`, with the reason in a comment.

---

## 6. Operator assets

| File | Purpose |
| --- | --- |
| `PRODUCTION_DEPLOY_HANDOFF.md` | **Start here** — the 21-step sequence |
| `PRODUCTION_ENV_CHECKLIST.md` | Every variable, placeholders only |
| `PRODUCTION_DB_PRECHECK.sql` | Read-only pre-flight, 12 sections |
| `RELEASE_MIGRATIONS.md` | Per-migration locks and rollback |
| `PRODUCTION_NGINX_APPLY.md` | Windows nginx procedure |
| `BACKUP_AND_RESTORE_RUNBOOK.md` | RPO/RTO, schedule, restore drill |
| `POSTGRES_PRODUCTION_HARDENING.md` | Timeouts, listen address, least privilege |
| `RELEASE_CHANGELOG.md` | What changed and what is deferred |
| `RELEASE_TAG_NOTES.md` | Tag, behaviour changes, rollback |
| `FINAL_GO_LIVE_GATE.md` | Gate and residual risks |
| `PRODUCTION_READINESS_AUDIT.md` | The original 26 findings |
| `release-check.sh` | One-command gate |
| `scripts/revoke-public-drive-access.ts` | Drive sweep (dry-run default) |
| `scripts/redact-audit-pay-values.sql` | In-place audit redaction |
| `scripts/backup-production.sh` / `restore-test.sh` | Backup and drill |

All present; every document cross-link resolves.

---

## 7. Residual risks

| # | Risk | Status |
| --- | --- | --- |
| 1 | Salary stored as `Float` | Migration prepared, outside `migrations/` |
| 2 | 95 of 98 timestamps lack a timezone; server is `Asia/Dhaka` | Prisma self-consistent; raw SQL must use UTC |
| 3 | Evaluation, onboarding and proficiency tokens still raw | Column and dual-read in place; needs a UI change |
| 4 | Onboarding links never expire | Pre-check §8 reports stale ones |
| 5 | File grants are bearer capabilities (15 min; 30 days in emailed sheets) | Scoped to one file, unforgeable, revocable by rotating `JWT_SECRET` |
| 6 | CV prompt injection can influence `matchScore` | AI never rejects, hires or sets salary; human reviews every shortlist |
| 7 | 4 HIGH npm advisories (backend) | Prisma-CLI-only, unreachable from `dist/main.js` |
| 8 | 26 pre-existing prettier errors in untouched files | Deliberately excluded to keep the diff readable |
| 9 | Backup passphrase may live only on the server | Runbook requires a password-manager copy |
| 10 | `users.email` has no unique constraint (5 duplicate clusters) | Login refuses ambiguity; cleanup pending |

---

## 8. Required operator actions

None of these can be done from a development machine.

1. Verified production backup
2. `TOTP_ENCRYPTION_KEY` generated, set, and copied to the password manager
3. `PRODUCTION_DB_PRECHECK.sql` — **no `BLOCK`** (§2 duplicate global role
   assignments is the hard one)
4. `release-check.sh` on the server
5. `deploy.sh`, then the 14 `VALIDATE CONSTRAINT` statements
6. nginx applied — headers **and** `client_max_body_size 20m`
7. Drive sweep: dry run → **notify HR/CHRO/board** → `--execute`
8. Audit pay-value redaction
9. Nightly backup scheduled + one restore drill
10. Smoke test, PM2, Socket.IO, health endpoint
11. GO / NO-GO recorded with a name and a date

Separate business decision: the forced-password-change rollout
(`FINAL_GO_LIVE_GATE.md` §7c). Nothing changes until someone decides.

---

## 9. Verification boundary

| | |
| --- | --- |
| **DEVELOPMENT VERIFIED** | Everything in §4, the three migrations against the development database, the backup/restore cycle, the Drive sweep **dry run**, and the audit redaction on a throwaway copy. |
| **PRODUCTION VERIFIED** | **Nothing.** No production system was accessed, no production database command was run, no production Drive permission was changed, no live nginx was modified, and no production backup was executed. |
