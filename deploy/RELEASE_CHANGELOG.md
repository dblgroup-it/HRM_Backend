# Release Changelog — Security Hardening Release

**Release:** `hrm-prod-2026-09-security`
**Scope:** remediation of the findings in `PRODUCTION_READINESS_AUDIT.md`.
**No new features.** No unrelated refactoring. Every change below traces to a
numbered audit finding.

**Status: DEVELOPMENT VERIFIED.** Nothing here has been applied to production.

---

## Security Fixes

### CRITICAL

- **Employee records could be rewritten by any signed-in user.**
  `PATCH /employees/:id` had no `@Roles`, no `@CurrentUser` and no service-side
  check — any account with any role could change any of ~4,600 employees' name,
  personal phone, personal email, gender and date of birth. Because it writes
  `User.email`, it also let one user point a colleague's sign-in identifier
  wherever they liked. Now gated to super user / Head of Talent Acquisition /
  CHRO, with a duplicate-email guard. *(Audit C-1)*

- **CVs, joining documents and medical reports were permanently world-readable
  by URL.** Nine call sites published Drive objects as
  `{ type: 'anyone', role: 'reader' }` — no expiry, no access log, no
  revocation. All nine removed; documents are streamed by the API from private
  storage. *(Audit C-2 — see **Private File Access** below)*

### HIGH

- Salary figures were being copied into `audit_logs` in cleartext, contradicting
  that file's own documented policy. 15 pay/score fields added to the redaction
  set. *(H-1)*
- TOTP seeds would have been written into `audit_logs` on enrolment.
  `twoFactorSecret` and `otpHash` added to the redaction set. *(H-2)*
- Email 2FA codes were generated with `Math.random()` — predictable from
  observed output. Now `crypto.randomInt`. *(H-3)*
- `users.email` has no unique constraint and five duplicate clusters exist;
  login resolved a shared address arbitrarily. *(H-4)*
- Login returned before hashing when no account matched, making response time an
  account-existence oracle. *(H-5)*
- The four public board-approval endpoints had no rate limit while returning
  candidate name, role and agreed salary. *(H-6)*
- Concurrent approvals and board votes could both be recorded — the read
  happened outside the transaction that wrote the decision. *(H-7)*
- `deploy.sh` expanded `$DATABASE_URL` into its summary, printing the database
  password into every deploy log. *(H-8)*
- The Google refresh token — the credential for every CV and medical report —
  was written to the application log. *(H-9)*

### MEDIUM / LOW

- BDJobs signature compared with `!==`; now `crypto.timingSafeEqual`. *(M-10)*
- `POST /candidates/talent-pool/search` took an inline body type the global
  `ValidationPipe` cannot see, so unbounded text reached an AI prompt. *(M-11)*
- `GET /requisitions/:id/candidates/screening-status` had no access check. *(L-1)*
- `salutation` was interpolated into letter HTML unescaped. *(L-2)*
- Admin password reset did not invalidate the target's live sessions. *(L-3)*

---

## Authentication

- **Account lockout.** 5 consecutive wrong passwords → 15-minute lock
  (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`). Counts against the *account*,
  because per-IP throttling does not stop a distributed guesser. A locked
  account is refused before the password is considered, so the lock cannot be
  probed with a correct password.
- **Bounded 2FA attempts.** One challenge now allows 5 codes, then is torn down
  and the password step must be repeated. The counter rides in the signed
  challenge token, so it cannot be edited.
- **Forced first-login password change.** New `mustChangePassword`; a session
  holding it reaches only change-password / me / logout — enforced by
  `FirstLoginGuard`, re-read from the database each request so the flag cannot
  be stripped from a JWT. Set automatically on admin password reset.
- **Password policy.** 12 characters minimum, passphrases encouraged, **no
  composition rules** (they push people towards short predictable patterns).
  Rejects the employee code, any password containing it, the email address, and
  obvious defaults. bcrypt cost raised 10 → 12 on change.
- **TOTP secrets encrypted at rest** — see *Medical Data Protection*'s sibling
  section below.
- Login lookup is deterministic: employee code first (guaranteed unique), then
  email; an address matching more than one account is **refused** with a message
  telling the user to sign in with their employee code.
- A bcrypt comparison always runs, even when no account matched.

## Authorization

- Employee updates require an administrative role (CRITICAL above).
- **Employee directory minimised.** `GET /employees` no longer returns
  `dateOfBirth`, personal `phone` or personal `email` for every employee to
  every signed-in user. Those three are returned by `GET /employees/:id` only,
  and only to super user / Head of Talent Acquisition / CHRO. No UI depended on
  them in the list — verified. *(Audit P-2)*
- Screening-status now runs the same access check as its sibling routes.
- Unit A → Unit B isolation and recruiter scoping are now covered by tests at
  the service boundary.

## Private File Access

The largest change in the release.

- **`shareAnyoneWithLink` has no callers.** The remaining definition takes a
  mandatory `reason` argument and logs every use. CI fails the build if a call
  is reintroduced.
- **`common/files/`** — `FileGrantService` mints short-lived HMAC-signed grants
  naming exactly one file; `SecureFileService` streams from private Drive
  storage with a sanitised `Content-Disposition` and `no-store`.
- **Every document link in every API response points at this API**, not at
  `drive.google.com`: candidate CVs (5 serializers), onboarding documents,
  medical reports, requisition attachments, board attachments, approval-sheet
  rows, interview panels.
- **Token holders get token-scoped routes**, not grants —
  `GET /board-vote/:token/cv`, `GET /board-sheet/:token/cv/:candidateId`,
  `GET /eval/:token/cv`. The candidate is resolved *from the token*; a sheet
  token is checked against its own sheet, so a URL cannot be edited to reach
  another candidate.
- **Authenticated routes** alongside: `GET /candidates/:id/cv/file`,
  `GET /onboarding/docs/:docId/file`, `GET /onboarding/:id/medical-report/file`.
- `POST /admin/candidates/fix-cv-sharing` now **revokes** public access instead
  of granting it; the path is unchanged so an operator bookmark still works.
- New operator tool: `scripts/revoke-public-drive-access.ts`, **dry-run by
  default**, idempotent, logs ids only — never a name.

> **Behaviour change operators must communicate.** After the sweep runs, Drive
> links inside emails sent *before* this release stop working. Recipients open
> the record in DBL HRM, or ask for the sheet to be resent. No redirect is
> offered: any redirect that revived those URLs would have to keep the files
> public, which is the thing being fixed.

### Post-release fix — secure document viewing (regression)

Two defects shipped with the private-document change and both surfaced as
"View CV shows 404 Page not found". Found by tracing one CV request end to end;
neither was a design problem, and the Drive architecture is unchanged.

1. **Relative document URLs resolved against the wrong origin.** The API
   returns `/api/files/<grant>`. A relative href resolves against the page's
   own origin, and in development the SPA is served by Vite on a different port
   from NestJS — so the request went to the dev server, which answered with
   `index.html`, and React Router rendered the app's own 404. The backend was
   never reached. Fixed with one helper, `resolveApiFileUrl`, applied at all 15
   document links; it resolves against the configured API base, matching how
   `httpClient` already works. Production, where nginx serves both from one
   origin, was unaffected and stays correct.

2. **`Content-Disposition` threw on every real CV.** Node's `setHeader` rejects
   any character outside Latin-1, and every CV in this system is named
   `"<Candidate> — CV.pdf"` with an em dash — so the header line threw and the
   request 500'd. This would have broken document viewing in production too,
   independently of the URL problem. Now RFC 6266: an ASCII fallback in
   `filename`, the real UTF-8 name percent-encoded in `filename*`.

Two related hardening fixes went in alongside:

- **Google-native files are exported rather than failing.** `syncFromDrive`
  imports whatever sits in the "01 All CVs" folder, so a Google Doc CV can be
  picked up — and `alt: 'media'` cannot download one. Docs, Slides and Drawings
  now export to PDF and Sheets to XLSX.
- **Drive errors are no longer all reported as 404.** A missing file is 404; a
  Drive outage or a credential problem is 503. Drive's own error text is never
  forwarded to the caller. Collapsing everything into 404 is part of why the
  original regression was hard to place.

**Drive permissions were not touched** — the sweep has still never been run
with `--execute`, and the secure API was verified against a genuinely private
file to prove it does not depend on public access.

## Medical Data Protection

- `serializeMedicalSummary()` and `serializeFullMedicalExam()` are now separate.
  Recruitment receives `{ fitToJoin, examDate, issueDate, refNo,
  consultantName, recorded, redacted: true }`.
- **Withheld from non-medical roles:** hepatitis B status, liver function, urine
  results, past illness history, family history of diabetes/hypertension, blood
  group, blood pressure, vision, hearing, height, weight, date of birth,
  clinical remarks. *(Audit P-1)*
- Medical **documents** require a medical role to stream, whatever recruitment
  access the caller holds. Ordinary joining documents use recruitment access.
- Four more medical fields added to audit redaction.

## Database Integrity

- **14 CHECK constraints** where there were previously **zero** — `filled <=
  sanctioned`, non-negative pay, marks within their paper totals, 0–100 match
  scores, non-negative approval ordering, token expiry after creation. All added
  `NOT VALID` so the migration cannot fail on legacy data.
- **Partial unique index** on `role_assignments (role_id, user_id) WHERE unit_id
  IS NULL` — the existing composite unique could never catch duplicate *global*
  grants, because PostgreSQL treats NULLs as distinct.
- `token_hash` added to five token tables (see below).
- Full review: `RELEASE_MIGRATIONS.md`.

## Audit Logging

- **Now audited:** login success, login failure, logout, password change,
  password reset, 2FA enable, 2FA disable, account lockout. None of these
  existed before — the events most wanted during an investigation were invisible.
- **Never recorded:** the identifier tried, the password, the OTP, the TOTP
  seed, any token, or any pay figure.
- `scripts/redact-audit-pay-values.sql` redacts values already written **in
  place** — the entry, actor, timestamp and the fact a field changed all
  survive. Idempotent; verified on a throwaway copy (7 rows redacted, all 318
  records preserved).

## Deployment / nginx

- `deploy.sh` no longer prints the database password.
- `deploy/nginx.conf.example` completed: `client_max_body_size 20m` (the 1 MB
  default silently rejects real CVs with a 413 the application never sees),
  HSTS, CSP (`script-src 'self'`, **no** `unsafe-eval`, **no** script
  `unsafe-inline`), `nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `X-Frame-Options`, `server_tokens off`, TLS session cache, `no-store` on
  `index.html`, immutable caching on `/assets/` with `=404` so a missing asset
  cannot be served as HTML.
- Step-by-step operator procedure: `PRODUCTION_NGINX_APPLY.md`.
- Google Drive removed from the CSP now that documents are self-hosted.

## Backup & Recovery

- `scripts/backup-production.sh` — locates `pg_dump` explicitly, strips Prisma's
  URL parameters, **proves the dump is complete** before counting it, compresses,
  AES-256 encrypts, copies off-server, prunes by retention. Never prints the
  connection string or the passphrase.
- `scripts/restore-test.sh` — restores into a **separate temporary database**,
  compares row counts, reports elapsed time, drops the temporary database. It
  cannot touch production: the target name is timestamped and asserted twice.
- `BACKUP_AND_RESTORE_RUNBOOK.md` — RPO/RTO, schedule, retention, off-site,
  encryption, real-restore procedure, and an anonymisation script for
  development copies.
- Proven end-to-end on development: dump → verify → compress → encrypt →
  off-site → decrypt → restore → 7/7 tables matched → dropped.

## Tests & CI

- **0 → 94 tests**, 9 suites. Jest + ts-jest added; `npm test` wired.
- Coverage is at the **service boundary**, not around a mocked gate: employee
  update authorization, audit redaction, RBAC/unit isolation, login and
  lockout, password policy, AES-256-GCM encryption, file grants, action-token
  hashing, CV access, medical summary vs full record.
- The first tranche was **proven to bite**: reintroducing the two original
  defects produced 8 failures.
- GitHub Actions on both repositories, including a job that fails the build if
  `shareAnyoneWithLink` reappears.
- `release-check.sh` — one command, 16 gates, non-zero exit on any failure,
  including five security invariants.

## Repository hygiene (this pass)

- `.gitignore` in **both** repositories now covers every `.env` variant except
  the template. Previously `.env.production`, `.env.local`, `.env.bak` and
  similar were committable — exactly the files an operator creates on a server.
- `HRM_Frontend/.env.example` now defaults `VITE_USE_MOCK_API=false`. It shipped
  as `true`, so a copied-as-is template produced a site that served fabricated
  data and accepted a hard-coded demo password while appearing to work.
- `google-refresh-token.txt` added to `.gitignore`.

---

## Interview delegation tracking (new)

Not a security fix — a gap reported during release preparation and included
deliberately. When Corporate HR or a recruiter sent candidates out for a first
interview, nothing recorded that it had happened before, and there was nowhere
to look afterwards.

**Three things were missing, all now addressed:**

- **Re-sends were invisible.** The delegation row is upserted, so sending the
  same candidate to the same interviewer again just overwrote the note;
  `createdAt` stayed at the first hand-off. Now `sendCount` and `lastSentAt`
  are kept alongside it, so the pair reads *"assigned on the 8th, chased again
  on the 14th"*. Verified end to end: a re-send took `send_count` 1 → 2, left
  `created_at` untouched and moved `last_sent_at`.

- **The picker was blind.** Choosing someone to hand five CVs to said nothing
  about the twenty they were already carrying, so work piled onto whoever
  appeared first. Each person in the send dialog now shows *holds N · X not
  started (oldest Nd) · Y in progress · Z done*, and a candidate already with
  that person is flagged **before** the click.

- **No view after sending.** A **First interviews** scoreboard on the candidate
  pipeline groups every delegation on the requisition by interviewer, with each
  candidate's position: *No action yet → Interview scheduled → Interviewed,
  marks pending → Marks in → Decided*, plus days waiting and a re-send flag.

The stage is **derived, never stored** (`delegation-progress.ts`). A stored
status would need updating from six places — schedule, reschedule, cancel,
evaluate, reject, advance — and would be wrong the first time one was missed.
Two judgements worth knowing: a round whose slot has passed counts as held even
if nobody marked it `COMPLETED`, and a cancelled round is back to square one.

One migration, `20260914120000_delegation_send_tracking`, additive with
defaults that reproduce the previous behaviour exactly. 15 tests pin the stage
vocabulary down, including the clock-skew and cancelled-round cases.

---

## Known Deferred Items

Accepted and scheduled, not forgotten. None blocks this release.

| # | Item | Why deferred | Where it lives |
| --- | --- | --- | --- |
| 1 | **Salary `Float` → `Decimal(12,2)`** | `Prisma.Decimal` is an object, not a number: it ripples through every salary read, comparison, letter, export and frontend display. That risk must not ride along with a security release. | `HRM_Backend/prisma/planned/salary_decimal/` — **outside `prisma/migrations/`** so it cannot be applied by accident. SQL written with explicit `USING` clauses; code changes enumerated. **READY FOR SCHEDULED DEPLOYMENT.** |
| 2 | **`timestamp` → `timestamptz`** (95 of 98 columns; server is `Asia/Dhaka`) | Prisma is self-consistent (UTC in, UTC out); only raw SQL misreads them, and the codebase has none beyond `SELECT 1`. Conversion must run with `SET timezone='UTC'` or every value shifts six hours. | Not written. `PRODUCTION_READINESS_AUDIT.md` M-6. |
| 3 | **Evaluation, onboarding and proficiency tokens still stored raw** | Their links are re-displayed and re-sent, so they must stay reconstructible — completing this is a UI change ("copy link" → "resend"), not a storage change. Board-vote and facility tokens, where a database read means *casting someone's decision*, **are** hashed. | Column and dual-read lookup already in place; marked in the code. |
| 4 | **Forced password rollout — business decision** | The migration defaults `must_change_password` to `false`, so nothing changes for anyone. Deciding when to disrupt ~4,600 people is not a deployment's call. | Reviewed SQL in `FINAL_GO_LIVE_GATE.md` §7c. Start with a pilot group. |
| 5 | **AI prompt-injection hardening — still outstanding** | CV text reaches the screening prompt without instruction-hardening, and a score above the threshold auto-moves a candidate to `AI_SHORTLISTED`. Bounded: the AI never rejects, hires or sets a salary, and a human reviews every shortlist. | Not started. Add a delimiter and an explicit "treat the document as untrusted content" instruction, plus an "AI-suggested" marker in the UI. |
| 6 | **`UNIQUE` on `users.email`** | Five duplicate clusters exist in the data. Login already refuses an ambiguous address, so this is cleanup, not exposure. | `PRODUCTION_DB_PRECHECK.sql` §3 lists them masked. |
| 7 | **Dropping the raw `token` columns (stage 2)** | Must wait for every legacy link to expire; onboarding links never expire, so that residue needs an explicit sweep. | Monitor `PRODUCTION_DB_PRECHECK.sql` §7. |
| 8 | **4 HIGH npm advisories (backend)** | All Prisma-CLI-only, not reachable from `dist/main.js`. `brace-expansion` reaches production via `exceljs`, but the DoS needs an attacker-controlled glob pattern, which does not exist here. | Revisit at the Prisma 8 upgrade. |
| 9 | **26 pre-existing prettier errors** in files this work did not touch | `npm run lint` rewrites files (`--fix`); reformatting unrelated files would bury the security diff. | Separate formatting commit. |
| 10 | **`REVOKE UPDATE, DELETE ON audit_logs`** | Touches database roles; the application only ever inserts, so nothing breaks — but it is an operator change, not a code change. | `POSTGRES_PRODUCTION_HARDENING.md` §7. |

---

**DEVELOPMENT VERIFIED.** Build, typecheck, lint, 94 tests, three migrations and
every operator script were exercised on the development machine against the
development database. **PRODUCTION VERIFIED: nothing.**
