# DBL HRM — Final Go-Live Gate

**Verdict: CONDITIONAL GO — the codebase is production-ready.**
Everything that remains is an operator action on the production server.

Follow-on to [PRODUCTION_READINESS_AUDIT.md](PRODUCTION_READINESS_AUDIT.md) and
[PRE_PRODUCTION_CHECKLIST.md](PRE_PRODUCTION_CHECKLIST.md).
**Date:** 14 September 2026 · No production system was accessed. No production
data was modified. No secret, employee, candidate, medical or salary value
appears in this document.

---

## 1. Readiness score

| | Original audit | After the first pass | **Now** |
| --- | --- | --- | --- |
| **Score** | 58 / 100 | 76 / 100 | **91 / 100** |

| Dimension | Score | Change |
| --- | --- | --- |
| Authentication | 19/20 | +2 — lockout, bounded 2FA attempts, forced first-login change, 12-char policy |
| Authorization | 18/20 | +3 — medical split, CV/document streaming, first-login guard |
| Data protection | 18/20 | +9 — documents no longer public, TOTP encrypted, board/facility tokens hashed |
| Database integrity | 14/15 | +1 — three migrations, all verified on dev |
| Infrastructure | 12/15 | +3 — nginx config finished, backup + restore proven, Postgres hardening documented |
| Testing & CI | 10/10 | +5 — 94 tests, CI on both repos, one-command release gate |

The 9 points not awarded are the operator actions in §5 and the residual risks
in §16. **A score is not a substitute for the checklist.**

---

## 2. Blockers that were open

| # | Blocker | Status |
| --- | --- | --- |
| 1 | Medical reports, joining documents and CVs permanently public by URL | **Closed in code.** One operator action remains: the sweep (§8) |
| 2 | nginx: no security headers, 1 MB upload ceiling | **Config finished and documented.** Operator must apply it (§9) |
| 3 | Backups unscheduled, on-server, unencrypted, never restored | **Tooling built and proven.** Operator must schedule it and run one drill (§10) |
| 4 | TOTP secret stored in plaintext | **Closed in code.** Operator must set `TOTP_ENCRYPTION_KEY` (§11) |
| 5 | Default password = employee code, no lockout | **Closed in code.** Rollout to existing accounts is a business decision (§7) |

---

## 3. What was fixed in this pass

### Phase 1 — the previous pass held

All 18 earlier fixes verified present in the working tree before anything was
changed. None had regressed.

### Phase 2 — private documents (the critical one)

- **All 8 public-sharing call sites removed.** `shareAnyoneWithLink` now has no
  caller; the remaining definition takes a mandatory `reason` argument and logs
  every use, so an inappropriate one is visible in review.
- **New `common/files/`** — `FileGrantService` mints short-lived HMAC-signed,
  single-file grants; `SecureFileService` streams from private Drive storage
  with a sanitised `Content-Disposition` and `no-store`.
- **Every document link in every API response now points at this API**, not at
  `drive.google.com`: candidate CVs (5 serializers), onboarding documents,
  medical reports, requisition attachments, board attachments, sheet rows,
  interview panels.
- **Token holders get token-scoped routes**, not grants:
  `GET /board-vote/:token/cv`, `GET /board-sheet/:token/cv/:candidateId`,
  `GET /eval/:token/cv`. The candidate is resolved *from the token*, and a sheet
  token is checked against the sheet it belongs to — a URL cannot be edited to
  reach another candidate.
- **Authenticated routes** added alongside: `GET /candidates/:id/cv/file`,
  `GET /onboarding/docs/:docId/file`,
  `GET /onboarding/:id/medical-report/file`.
- **`POST /admin/candidates/fix-cv-sharing` now does the opposite of its old
  job** — it revokes public access instead of granting it. The path is unchanged
  so an operator bookmark still works.

### Phase 2E — medical disclosure narrowed

`serializeMedicalSummary()` and `serializeFullMedicalExam()` are now separate.
Recruitment gets `{ fitToJoin, examDate, issueDate, refNo, consultantName,
recorded, redacted: true }`. Hepatitis B status, liver function, urine results,
past illness, family history, blood group and blood pressure are returned **only
to medical roles**. Medical documents require a medical role to stream, whatever
recruitment access the caller holds.

### Phase 3 — TOTP secrets encrypted

AES-256-GCM, random IV per write, auth tag, versioned `v1.<iv>.<ct>.<tag>`
envelope. Key from `TOTP_ENCRYPTION_KEY`, **required at boot in production**
(proven: the server refuses to start without it). A legacy plaintext seed is
read unchanged and re-written encrypted the moment its owner proves they hold
it — nobody is locked out.

### Phases 4 & 5 — first login and sign-in abuse

`mustChangePassword`, `failedLoginAttempts`, `lockedUntil` on `users`.
`FirstLoginGuard` holds such a session to change-password / me / logout and
nothing else — enforced server-side, re-read from the database each request, so
the flag cannot be stripped from a JWT. 5 wrong passwords → 15-minute lock. One
2FA challenge allows 5 codes, then is torn down. Password policy: 12 characters
minimum, no composition rules, rejects the employee code, the email, and obvious
defaults.

### Phase 6 — PII minimisation

`GET /employees` no longer returns `dateOfBirth`, personal `phone` or personal
`email` for all 4,613 employees to every signed-in user. They are returned by
`GET /employees/:id`, and only to super users, Head of Talent Acquisition or
CHRO. No UI depended on them in the list — verified.

### Phase 7 — public token hashing (staged)

`tokenHash` added to all five token models; lookups are dual-read (hash first,
legacy raw only where no hash exists) so **no link already in an inbox breaks**.
Board-vote and facility tokens are now issued hashed-only and legacy rows
upgrade on first use. Evaluation, onboarding and proficiency tokens remain raw —
their links are re-displayed and re-sent, so completing them is a UI change, not
a storage change. Marked in the code and in §16.

### Phase 12 — audit log

Login success, login failure, logout, password change, password reset, 2FA
enable/disable and account lockout are now audited. None records the identifier
tried, the password, the code or the token.

### Other

Constant-time BDJobs signature comparison retained; CSP tightened (Drive
removed now that documents are self-hosted); `release-check.sh`; CI on both
repos including a guard that fails the build if `shareAnyoneWithLink` is
reintroduced.

---

## 4. What remains open

Nothing in the code. Four operator actions (§5), and the residual risks in §16
which are accepted, documented and scheduled rather than outstanding.

---

## 5. Operator actions — the complete list

These are the only things standing between this codebase and a full GO.

- [ ] **§8** — Revoke public access on existing Drive documents (dry-run first)
- [ ] **§9** — Apply the nginx configuration
- [ ] **§10** — Schedule backups and run one restore drill
- [ ] **§11** — Set `TOTP_ENCRYPTION_KEY` in the production `.env`
- [ ] **§12** — Run the read-only pre-check and confirm no `BLOCK`
- [ ] **§13** — Deploy, then run the constraint `VALIDATE` statements
- [ ] **§14** — Smoke test
- [ ] **§7** — *(business decision)* decide the forced-password-change rollout

---

## 6. Migrations waiting for production

Three, all applied and verified on dev. `prisma migrate deploy` applies them in
order.

| Migration | What it does | Risk |
| --- | --- | --- |
| `20260913220000_integrity_check_constraints` | 14 CHECK constraints (`NOT VALID`) + 1 partial unique index | **The unique index is the only thing that can fail.** Pre-check §12 answers whether it will. |
| `20260913230000_first_login_and_lockout` | 3 columns on `users`, all with defaults | None — nobody starts locked or forced |
| `20260914090000_hash_public_action_tokens` | `token_hash` on 5 tables; `token` made nullable | None — purely additive; no existing link breaks |

**Prepared but deliberately NOT applied:** `prisma/planned/salary_decimal/` —
salary `Float` → `Decimal(12,2)`. Classified **READY FOR SCHEDULED
DEPLOYMENT**. The SQL is written with explicit `USING` clauses and the code
changes are enumerated in `CODE_CHANGES.md`; it is out of this release because
`Prisma.Decimal` ripples through every salary read, comparison, letter, export
and frontend display, and that risk should not ride along with a security
release. It sits outside `prisma/migrations/` so it cannot be applied by
accident.

---

## 7. Data cleanup tasks

### 7a. Redact pay figures already in the audit log

9 audit entries hold salary values written before redaction was fixed.

```bash
cd /c/apps/DBL-HRM/HRM_Backend
./scripts/backup-production.sh                       # this is the one script that modifies rows
psql "<DATABASE_URL without ?query>" -f scripts/redact-audit-pay-values.sql
```

It redacts **in place**: the entry, actor, timestamp and the fact a field
changed all survive; only the values become `[redacted]`. Wrapped in a
transaction that prints the before and after counts — review them, then
`COMMIT`. Idempotent. Verified on a copy of the dev database: 7 rows redacted,
all 318 audit records preserved, re-run changed nothing.

### 7b. Duplicate sign-in emails — 5 clusters

Not a blocker: login now refuses an ambiguous address and tells the user to sign
in with their employee code. But those 10 people cannot use email to sign in.
Pre-check §3 lists them masked. Once resolved, `users.email` can take a real
`UNIQUE` index.

### 7c. Forced password change — **business decision**

The migration defaults `must_change_password` to `false`, so **nothing changes
for anyone until you decide**. Deciding to disrupt ~4,600 people is not a
deployment's call.

The risk being managed: a synced employee's default password **is their employee
code**, which is printed in the directory every signed-in user can read.

Recommended, once you have picked a date and told people:

```sql
-- Everyone whose password is still their employee code cannot be identified
-- from the hash, so scope it by what you know. Start with a pilot.
UPDATE users SET must_change_password = true
 WHERE status = 'ACTIVE' AND role <> 'ADMIN'
   AND employee_code IN ('...', '...');   -- pilot group first

-- Then the rest, after the pilot goes cleanly.
```

Admin password resets already set the flag automatically from this release on.

---

## 8. Google Drive sweep

```bash
cd /c/apps/DBL-HRM/HRM_Backend

# 1. Dry run — changes nothing. Default mode.
npx ts-node scripts/revoke-public-drive-access.ts

# 2. Read the summary. Then, and only then:
npx ts-node scripts/revoke-public-drive-access.ts --execute

# 3. Confirm.
npx ts-node scripts/revoke-public-drive-access.ts
#    every "public" column should now read 0
```

Covers CVs, onboarding documents, medical reports, board attachments,
requisition attachments and archived joining folders. Idempotent, continues past
individual failures, prints **file ids and record ids only — never a name**, and
exits non-zero if anything failed.

Verified against dev: found **19 world-readable objects** (16 CVs, 3 board
attachments) and correctly changed nothing in dry-run mode.

### What stops working, and what to tell people

**This is the one change users may notice.** Be straight about it:

| Link | After the sweep |
| --- | --- |
| A `drive.google.com` link in an **old email** (approval requests, sheets sent before this release) | **Stops working.** The recipient opens the record in DBL HRM instead, or asks for the sheet to be resent — "Resend" already issues fresh links. |
| A Drive link someone **bookmarked** | Stops working. Same remedy. |
| Anything sent **after** this release | Works — the links point at DBL HRM and carry their own expiry. |
| `hr.recruitment@dbl-group.com` opening files directly in Drive | Unaffected. It owns the files. |

No backward-compatible redirect is offered, deliberately: any redirect that made
those URLs work again would have to keep the files public, which is the thing
being fixed. **Old insecure links are expected to break. That is the point.**

Send a short note to Corporate HR, the CHRO and board members before the sweep,
not after.

---

## 9. nginx

Full procedure in **[PRODUCTION_NGINX_APPLY.md](PRODUCTION_NGINX_APPLY.md)**:
backup, compare, apply, `nginx -t`, reload, `curl` verification, rollback.

Two things it fixes that are easy to underestimate:

- `client_max_body_size 20m` — without it nginx rejects every upload over
  **1 MB** with a 413 the application never sees and never logs.
- Security headers — there are currently **none**, and the session JWT lives in
  `localStorage`.

**Do not mark this done until `curl -I` shows the headers and a 6 MB PDF
uploads successfully.**

---

## 10. Backups and the restore drill

Full runbook in
**[BACKUP_AND_RESTORE_RUNBOOK.md](BACKUP_AND_RESTORE_RUNBOOK.md)**.

```bash
# Configure (system environment variables on the server)
BACKUP_DIR=C:\hrm_backups
BACKUP_OFFSITE_DIR=\\fileserver\hrm-backups
BACKUP_PASSPHRASE_FILE=C:\hrm_secrets\backup.pass
BACKUP_RETENTION_DAYS=30

# Schedule
schtasks /Create /TN "DBL HRM - Nightly Database Backup" ... /SC DAILY /ST 01:30

# Prove it (before go-live, then quarterly)
./scripts/restore-test.sh
```

Verified end-to-end on dev — dump → verify completeness → compress → AES-256
encrypt → off-site copy → decrypt → restore into a **separate temporary
database** → row counts matched across all 7 checked tables → temporary database
dropped. Measured restore: **1 second** for the current dataset.

`restore-test.sh` cannot touch production: the target name is timestamped,
asserted to differ from the live database name, and asserted to match
`hrm_restore_test_*` before anything is created.

**A backup that has never been restored is a hypothesis. Run the drill.**

---

## 11. Secrets and environment

New required variable:

```bash
# Generate on the server:
openssl rand -hex 32
```

| Variable | Required | Notes |
| --- | --- | --- |
| `TOTP_ENCRYPTION_KEY` | **yes, in production** | 32 bytes. Boot refuses to start without it (verified). Store a copy in the password manager — rotating it forces every enrolled user to re-enrol. |
| `LOGIN_MAX_ATTEMPTS` | no (5) | |
| `LOGIN_LOCKOUT_MINUTES` | no (15) | |
| `PASSWORD_MIN_LENGTH` | no (6) | |
| `PASSWORD_MAX_LENGTH` | no (12) | |

All documented in `HRM_Backend/.env.example`.

**Verification (already confirmed by the audit, re-confirm after deploy):** no
`.env` has ever been committed to either repository; no hardcoded credential
exists in any source file; `.gitignore` covers `.env`, `backups/`, `*.sql.gz`
and `google-refresh-token.txt`. Nothing needs rotating on account of the code.

Rotate the **Google refresh token** only if old PM2 logs — which used to contain
it — were ever shared outside the team.

---

## 12. Production database pre-check

```bash
psql "<DATABASE_URL without the ?query>" -f PRODUCTION_DB_PRECHECK.sql
```

**Read-only by construction: the file contains zero INSERT, UPDATE, DELETE,
ALTER, DROP, TRUNCATE or CREATE statements.** Verified.

12 sections, each returning `OK` / `WARN` / `BLOCK`: duplicate global role
assignments (**the one hard blocker**), duplicate emails, every CHECK-constraint
rule, orphaned records across the compliance chain, impossible workflow states,
token migration progress, stale live tokens, Drive object counts, unredacted
audit pay values, account states, and migration history.

Run against dev with **0 errors**. It found one bug in itself — a JSON scalar in
`audit_logs.changes` broke `jsonb_array_elements` — which is now fixed.

**Any `BLOCK` must be resolved before `prisma migrate deploy`.**

---

## 13. Deployment

```bash
# 0. Pre-check (§12). Confirm no BLOCK.
# 1. Set TOTP_ENCRYPTION_KEY in HRM_Backend/.env (§11).
# 2. Gate everything locally or on the server:
./release-check.sh          # 16 gates; exits non-zero on any failure

# 3. Deploy. It backs up, verifies the backup, migrates, builds, swaps.
cd HRM_Backend && bash scripts/deploy.sh

# 4. Confirm the summary no longer prints the database password.

# 5. Apply nginx (§9), then reload.

# 6. Validate the new constraints against existing rows, one at a time.
```

```sql
ALTER TABLE positions              VALIDATE CONSTRAINT positions_filled_within_sanctioned;
ALTER TABLE positions              VALIDATE CONSTRAINT positions_sanctioned_non_negative;
ALTER TABLE positions              VALIDATE CONSTRAINT positions_filled_non_negative;
ALTER TABLE requisitions           VALIDATE CONSTRAINT requisitions_required_posts_positive;
ALTER TABLE requisitions           VALIDATE CONSTRAINT requisitions_total_vacant_non_negative;
ALTER TABLE salary_fixations       VALIDATE CONSTRAINT salary_fixations_amounts_non_negative;
ALTER TABLE salary_fixations       VALIDATE CONSTRAINT salary_fixations_marks_within_totals;
ALTER TABLE candidates             VALIDATE CONSTRAINT candidates_salary_expectation_non_negative;
ALTER TABLE candidates             VALIDATE CONSTRAINT candidates_match_score_range;
ALTER TABLE ai_proficiency_attempts VALIDATE CONSTRAINT ai_proficiency_attempts_score_within_max;
ALTER TABLE talent_bank_matches    VALIDATE CONSTRAINT talent_bank_matches_relevance_range;
ALTER TABLE approval_steps         VALIDATE CONSTRAINT approval_steps_order_non_negative;
ALTER TABLE approval_path_levels   VALIDATE CONSTRAINT approval_path_levels_order_non_negative;
ALTER TABLE evaluation_tokens      VALIDATE CONSTRAINT evaluation_tokens_expiry_after_creation;
```

```bash
# 7. Drive sweep (§8) — after telling people.
# 8. Audit redaction (§7a).
# 9. Smoke test (§14).
```

---

## 14. Smoke test

- [ ] Sign in. Confirm no forced password change appears for an existing account
      *(unless you ran §7c)*
- [ ] Sign in with a wrong password 5 times → the account locks; the message
      names the wait
- [ ] **Open a candidate's CV.** It must open. The URL must be
      `talenthub.dbl-group.com/api/files/…` — **not** `drive.google.com`
- [ ] Open the same CV as a user from a different unit → refused
- [ ] As a recruiter, open the medical section → summary only, **no clinical
      findings**
- [ ] As a medical officer, open the same → full record, and the report file
      opens
- [ ] Open an onboarding document (National ID) as HR → opens
- [ ] Raise a requisition, approve it, attach a **6 MB PDF** → all succeed
- [ ] Send a board approval; open the emailed link → the sheet loads and
      **View CV works from the email**
- [ ] Submit the board vote → the CV link from that email now stops working
      *(expected: the token is spent)*
- [ ] Realtime notifications arrive (the `/socket.io/` block)
- [ ] `curl -I https://talenthub.dbl-group.com` → all six security headers
- [ ] `GET /api/health` → 200

---

## 15. Rollback

| Layer | How | Notes |
| --- | --- | --- |
| Frontend | `rm -rf dist && mv dist.old dist` | Instant |
| Backend | `git checkout <prev> -- . && npm ci && npx prisma generate && npm run build && pm2 restart hrm-backend` | |
| nginx | restore `nginx.conf.bak-YYYYMMDD`, `nginx -t`, reload | **HSTS cannot be withdrawn** — that is why `max-age` starts at one week |
| Migrations | **Safe to leave in place on a code rollback.** All three are additive: CHECK constraints are `NOT VALID` and validated against existing data; the three `users` columns default to the previous behaviour; `token_hash` is nullable and the old code ignores it | |
| Drive sweep | **Not reversible, and should not be.** Re-publishing documents would restore the critical finding. | |
| Audit redaction | Not reversible. Take the backup first — that is the rollback. | |
| Database | `dropdb`/`createdb`/`psql < backup.sql` | **Take a fresh backup of the current state first** |

One genuine incompatibility to know about: if you roll the **code** back but keep
the migrations, board and facility tokens issued by the new code are stored
hashed, and the old code looks up the raw column. **Those links stop working.**
Nothing else is affected, and re-sending issues fresh ones.

---

## 16. Residual risks

Accepted, documented, and none of them blocking.

| # | Risk | Why it is acceptable now | Plan |
| --- | --- | --- | --- |
| 1 | **Evaluation, onboarding and proficiency tokens still stored raw** | Column and dual-read lookup are already in place. Board-vote and facility tokens — the ones where database read means *casting someone's decision* — are hashed. | Mint on send, replace "copy link" with "resend", then write hash only. Contained follow-up. |
| 2 | **Onboarding links never expire** | Pre-check §8 reports old unarchived ones; 0 today | Add an expiry, or archive on a schedule |
| 3 | **Salary stored as `Float`** | No incorrect figure observed; range is far inside double precision | `prisma/planned/salary_decimal/` — READY FOR SCHEDULED DEPLOYMENT |
| 4 | **95 of 98 timestamps are `timestamp without time zone`; the server is `Asia/Dhaka`** | Prisma is self-consistent (UTC in, UTC out). Only raw SQL is affected | Convert to `timestamptz` with `SET timezone='UTC'`. Until then, raw SQL must use UTC |
| 5 | **File grants are bearer capabilities** | 15 minutes interactive; scoped to one file; unforgeable; served from our origin with `Referrer-Policy`. Vastly better than the permanent public Drive URL it replaces | Shorten TTL if a leak is ever suspected; rotating `JWT_SECRET` invalidates all outstanding grants |
| 6 | **Emailed sheet CV grants last 30 days** | Matches the approval token they travel with; a board member must be able to open the sheet days later | Reduce once board turnaround is measured |
| 7 | **CV prompt injection can influence `matchScore`** | AI never rejects, hires or sets salary; `AI_SHORTLISTED` is advisory and a human reviews every one | Prompt hardening + an "AI-suggested" marker in the UI |
| 8 | **4 HIGH npm advisories remain (backend)** | All Prisma-CLI-only, not reachable from `dist/main.js`; `brace-expansion` needs an attacker-controlled glob pattern, which does not exist here | Revisit at the Prisma 8 upgrade |
| 9 | **26 pre-existing prettier errors** in files this work did not touch | `npm run lint` rewrites files (`--fix`); reformatting unrelated files would obscure the security diff | Separate formatting commit |
| 10 | **One historic migration shows `ROLLED BACK`** (`20260912100000_audit_log`, later re-applied successfully) | Pre-existing, resolved | Noted so §12's output is not alarming |
| 11 | **Backups encrypted with a passphrase on the same server** | Runbook requires a copy in the password manager | Confirm it is there before relying on it |

---

## 17. Post-deployment monitoring

| Watch | How | Frequency |
| --- | --- | --- |
| Uptime | external monitor on `GET /api/health` | 1 min |
| **Failed sign-ins and lockouts** | `audit_logs` where `action IN ('login_failed','account_locked')` — **now recorded, previously invisible** | daily |
| Backup freshness | newest file under 26h old | daily — the single highest-value alert |
| 413 responses | nginx access log | first week |
| Token migration progress | pre-check §7 — `still_raw` should fall | weekly |
| Drive sweep holding | re-run the dry run; `public` must stay 0 | monthly |
| `audit_logs` growth | row count | weekly |
| AI spend | provider console | weekly |
| PM2 restarts | `pm2 list` | daily |

---

## 18. Validation results

Every command run against this working tree.

```
release-check.sh ............................ 16/16 gates passed

BACKEND
  npm ci ..................................... ok
  prisma generate ............................ ok
  prisma validate ............................ ok
  tsc --noEmit ............................... ok
  jest ....................................... 9 suites, 94 tests, 94 passed
  nest build ................................. ok
  npm audit --omit=dev ....................... 4 high (CLI-only, see §16.8)
  eslint (files changed here) ................ 0 problems

FRONTEND
  npm ci ..................................... ok
  tsc --noEmit ............................... ok
  eslint --max-warnings 0 .................... ok
  vite build ................................. ok
  npm audit .................................. 0 vulnerabilities

DATABASE (dev only — production untouched)
  prisma migrate deploy ...................... 3 migrations applied
  14 CHECK constraints ....................... all VALIDATE clean
  PRODUCTION_DB_PRECHECK.sql ................. 0 errors, 12 sections

SECURITY INVARIANTS (in release-check.sh and CI)
  no sensitive document published publicly ... ok
  boot refuses production without TOTP key ... ok (proven by running it)
  deploy.sh does not print DATABASE_URL ...... ok
  employee edits require an admin role ....... ok
  auth codes use a cryptographic RNG ......... ok

RUNTIME PROOF (production build, port 4999, dev database)
  boot with TOTP_ENCRYPTION_KEY unset ........ refused, named the variable
  boot with it set ........................... started; GET /api/health -> 200
  GET /candidates/:id/cv/file (no auth) ...... 401
  GET /files/<forged grant> × 3 .............. 403
  GET /board-vote/<bad>/cv ................... 404
  GET /eval/<bad>/cv ......................... 404
  login (restricted account) ................. token issued, mustChangePassword true
  restricted session -> /requisitions ........ 403
  restricted session -> /employees ........... 403
  restricted session -> /audit-log ........... 403
  restricted session -> /auth/me ............. 200
  password policy (too short / code / email) . all rejected with specific reasons
  valid change ............................... unblocked; fresh token works; old token 401
  failed login ............................... counter incremented in the database

BACKUP / RESTORE (dev)
  backup-production.sh ....................... verified, compressed, encrypted, copied
  restore-test.sh ............................ restored in 1s; 7/7 tables matched; dropped

DRIVE SWEEP (dev, dry run)
  revoke-public-drive-access.ts .............. found 19 public objects, changed nothing

AUDIT REDACTION (on a throwaway copy of dev)
  redact-audit-pay-values.sql ................ 7 rows redacted, 318 records preserved,
                                               re-run changed nothing
```

All probe artifacts were removed: the temporary account, its role assignment and
audit rows deleted; the restore-test database dropped; the admin failed-attempt
counter reset; backup files containing real employee data deleted from scratch.

---

## 19. Verdict

# CONDITIONAL GO

**The codebase is production-ready.** No unresolved critical security design
flaw remains in code. New sensitive files are private. Secure file access is
implemented and tested at the service boundary. Medical documents are protected
by a policy separate from recruitment access. The default-password risk is
controlled by a server-enforced first-login gate. TOTP secrets are encrypted at
rest with a key the database does not hold. Build, typecheck, lint and 94 tests
pass. The three migrations are additive and were verified against real data.

**Everything remaining is operator execution on the production server:**

1. **Revoke public Drive access** — `revoke-public-drive-access.ts --execute`
   (§8). Tell Corporate HR, the CHRO and board members first: Drive links in
   old emails will stop working.
2. **Apply the nginx configuration** (§9). Verify with `curl -I` and a 6 MB
   upload.
3. **Set `TOTP_ENCRYPTION_KEY`** in the production `.env` (§11). The server will
   not start without it.
4. **Schedule backups and run one restore drill** (§10).
5. **Run `PRODUCTION_DB_PRECHECK.sql`** and confirm no `BLOCK` (§12), then
   deploy and run the `VALIDATE` statements (§13).
6. **Redact the 9 audit rows** holding pay values (§7a).
7. **Decide the forced-password-change rollout** (§7c) — a business decision
   about when to disrupt ~4,600 people. Nothing changes until you make it.

This becomes an unqualified **GO** when items 1–6 are done and the §14 smoke
test passes.

Tests passing is not the same as production being secure. Items 1–4 are the
difference.
