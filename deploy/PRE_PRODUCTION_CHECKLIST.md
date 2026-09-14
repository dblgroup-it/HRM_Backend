# DBL HRM — Pre-Production Checklist

Companion to [PRODUCTION_READINESS_AUDIT.md](PRODUCTION_READINESS_AUDIT.md).
Items marked **[BLOCKING]** must be done before go-live. Items marked
`(done)` were completed during the audit and are listed so you can verify them,
not repeat them.

---

## [ ] Security

- [x] ~~Authorization gate on `PATCH /employees/:id`~~ *(done — C-1)*
- [x] ~~Rate limits on the 4 public board-approval endpoints~~ *(done — H-6)*
- [x] ~~Constant-time BDJobs signature comparison~~ *(done — M-10)*
- [x] ~~`salutation` escaped in generated letter HTML~~ *(done — L-2)*
- [ ] **[BLOCKING]** Apply security headers to the live nginx config — CSP,
      HSTS, `nosniff`, `frame-ancestors`, `Referrer-Policy`,
      `Permissions-Policy`, `server_tokens off`.
      Source: `HRM_Backend/deploy/nginx.conf.example`
- [ ] Add magic-byte validation to uploads (currently trusts the browser's
      declared `Content-Type`) — F-1
- [ ] Add a CAPTCHA or per-requisition daily cap to the public apply endpoint —
      each accepted CV triggers a billable AI call — F-2
- [ ] Sign the outbound IT provisioning webhook if `IT_WEBHOOK_URL` is enabled

## [ ] Database

- [x] ~~14 CHECK constraints + partial unique index~~ *(done — migration
      `20260913220000_integrity_check_constraints`, applied to dev)*
- [ ] **Before deploying that migration**, confirm production has no duplicate
      global role assignment (the partial unique index cannot be `NOT VALID`):
      ```sql
      SELECT role_id, user_id, count(*) FROM role_assignments
       WHERE unit_id IS NULL GROUP BY 1,2 HAVING count(*) > 1;
      ```
      Expect 0 rows.
- [ ] After deploying, run the 14 `ALTER TABLE … VALIDATE CONSTRAINT` statements
      (listed in §24 of the audit) during a quiet period
- [ ] Add `statement_timeout` and `idle_in_transaction_session_timeout` to
      `DATABASE_URL`
- [ ] Clean up the 5 duplicate-email clusters, then add `UNIQUE` on `users.email`
- [ ] Plan the salary `Float` → `NUMERIC(12,2)` conversion — M-5
- [ ] Plan the `timestamp` → `timestamptz` conversion (run with
      `SET timezone='UTC'`) — M-6
- [ ] Review cascade deletes on `Evaluation → User` and the requisition chain;
      consider `Restrict` so hiring history cannot vanish silently
- [ ] Confirm PostgreSQL is **not** listening on a public interface

## [ ] Authentication

- [x] ~~OTP generated with `crypto.randomInt`, not `Math.random`~~ *(done — H-3)*
- [x] ~~Login costs the same whether or not the account exists~~ *(done — H-5)*
- [x] ~~An ambiguous email is refused rather than resolved at random~~ *(done — H-4)*
- [x] ~~Admin password reset revokes the target's live sessions~~ *(done — L-3)*
- [ ] Force a password change on first login — the default password **is** the
      employee code, and the employee directory is readable by every user
- [ ] Raise the password minimum above 6 characters
- [ ] Add account lockout after N consecutive failures
- [ ] Add a failure counter to 2FA verification (currently only throttled)
- [ ] Encrypt `users.two_factor_secret` at rest (AES-256-GCM, key from env) —
      **easiest now, before anyone enrols** — M-4

## [ ] Authorization

- [x] ~~Access check on `GET /requisitions/:id/candidates/screening-status`~~ *(done — L-1)*
- [x] ~~Unit A ↛ Unit B isolation covered by regression tests~~ *(done)*
- [ ] **Confirm the role list for editing employee records** — the audit chose
      super user / Head of Talent Acquisition / CHRO. Change it if unit HR
      should also be able to correct their own unit
- [ ] Decide whether legacy role-routed approvers should be able to *open* the
      requisitions they can currently *see* in their list (`load()` and
      `requisitionVisibility()` disagree — §10)

## [ ] Environment

- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` ≥24 chars and unique *(enforced at boot)*
- [ ] `CORS_ORIGIN` set to the real origin, not `*` *(enforced at boot)*
- [ ] `GOOGLE_OAUTH_REDIRECT_URI` is the production URL *(enforced at boot)*
- [ ] `FRONTEND_URL` set explicitly — it builds every link in every email
- [ ] `pm2 startup && pm2 save` so the app survives a reboot
- [ ] `pm2 install pm2-logrotate`
- [ ] Call `app.enableShutdownHooks()` so a restart drains in-flight requests

## [ ] Secrets

- [x] ~~Database password removed from the deploy summary~~ *(done — H-8)*
- [x] ~~Google refresh token no longer written to the application log~~ *(done — H-9)*
- [x] ~~`google-refresh-token.txt` added to `.gitignore`~~ *(done)*
- [x] ~~Secret scan: no `.env` ever committed, no hardcoded credentials~~ *(verified)*
- [ ] Delete `HRM_Backend/google-refresh-token.txt` from the server after the
      value is copied into `.env`
- [ ] Rotate the Google refresh token **only if** old PM2 logs were ever shared
      outside the team (they previously contained it)
- [ ] Check old PM2 logs for the database password and delete those files

## [ ] PII

- [ ] Remove `dateOfBirth` from the `GET /employees` list projection; return it
      only on the detail route, for HR roles — P-2
- [ ] Purge the 7 existing `audit_logs` rows that still carry cleartext salary
      values (redaction is fixed going forward)
- [x] ~~Salary, credentials and medical findings redacted from new audit entries~~ *(done — H-1, H-2)*
- [ ] Add a retention policy for `audit_logs` and `notifications`
- [ ] Confirm the candidate privacy notice mentions that CVs are sent to an
      external AI provider — A-2

## [ ] Medical data

- [ ] **[BLOCKING]** Stop publishing the Medical Fitness Report to Google Drive
      as "anyone with the link" — C-2,
      `onboarding.service.ts:1134`
- [ ] Revoke public access on medical reports already uploaded
      (`revokeAnyoneAccess` already exists in `drive.service.ts`)
- [ ] Narrow `GET /onboarding/:id/medical-exam` for non-medical roles to
      `{ fitToJoin, medicalStatus, examDate, clearedBy }` rather than the full
      clinical record — P-1
- [x] ~~Clinical findings redacted from the audit log~~ *(done)*

## [ ] Salary data

- [x] ~~Salary figures no longer copied into the audit log~~ *(done — H-1)*
- [x] ~~Negative salary and marks-above-total rejected by the database~~ *(done — M-1)*
- [ ] Convert salary columns to `NUMERIC(12,2)` — M-5

## [ ] Integrations

- [x] ~~BDJobs signature comparison is constant-time~~ *(done)*
- [x] ~~BDJobs replay window verified (5 minutes)~~ *(verified — already correct)*
- [x] ~~ZingHR sync upserts and never deletes~~ *(verified — preserve this)*
- [ ] Confirm BDJobs credentials are set in production
      (Configuration → Integrations)
- [ ] Confirm the Google OAuth consent has been completed against the
      production callback URL

## [ ] AI

- [ ] Add prompt hardening to the CV screening and document extraction prompts —
      CV content is untrusted input and can currently influence `matchScore`,
      which auto-moves a candidate to `AI_SHORTLISTED` — A-1
- [ ] Show an "AI-suggested" marker on AI-shortlisted candidates so the
      provenance of the decision stays visible to the reviewer
- [x] ~~AI talent search input validated and length-bounded~~ *(done — M-11)*
- [ ] Set a spend alert on the AI provider account

## [ ] Files

- [ ] **[BLOCKING]** Stop setting `{type:'anyone', role:'reader'}` on new
      uploads (9 call sites) and serve documents through an authorized API
      route instead — C-2
- [ ] **[BLOCKING]** Sweep existing files: CVs, joining-doc folders, medical
      reports, requisition and board attachments
- [ ] **[BLOCKING]** `client_max_body_size 20m` in the live nginx config —
      without it every upload over 1 MB fails at the proxy with an error that
      never reaches the application log — M-8
- [ ] Verify by uploading a 6 MB PDF after deployment

## [ ] Backups

- [x] ~~`deploy.sh` verifies the backup is complete before touching anything~~ *(verified)*
- [ ] **[BLOCKING]** Run one restore drill and record how long it takes — that
      number is your RTO, and it is currently unknown
- [ ] Schedule automated backups (they currently happen **only** when someone
      deploys)
- [ ] Copy backups off the server
- [ ] Encrypt backups at rest — they contain every employee record in plaintext
- [ ] Set a retention policy and monitor disk space
- [ ] Define RPO and RTO and write them down

## [ ] Infrastructure

- [ ] Apply `HRM_Backend/deploy/nginx.conf.example` to
      `C:\nginx\conf\nginx.conf`; `nginx -t`; reload
- [ ] Reconcile the live nginx config with the documented copy and keep them in
      sync (a missing `/socket.io/` block has silently broken realtime before)
- [ ] Confirm TLS certificate expiry and set a renewal reminder
- [ ] Keep PM2 at `instances: 1, exec_mode: 'fork'` — cluster mode silently
      breaks realtime and multiplies every rate limit. If you ever scale out,
      you need a Socket.IO cluster adapter **and** Redis-backed throttling
      together

## [ ] Performance

- [x] ~~Frontend builds clean (964 KB main bundle, 231 KB gzipped)~~ *(verified)*
- [ ] Cache `PermissionsService.holderAssignments()` — it loads every unit on
      every notification fan-out
- [ ] Replace the `generateMedicalRefNo()` in-memory max scan with a sequence
      (it is also racy on simultaneous first saves)
- [ ] Add `requisitions(raisedById)` index once volume grows
- [ ] Consider route-level code splitting for the frontend bundle

## [ ] Testing

- [x] ~~jest installed, `npm test` wired~~ *(done)*
- [x] ~~34 security regression tests, proven to fail on the original defects~~ *(done)*
- [ ] Extend coverage to the onboarding, board and salary services
- [ ] Add an end-to-end test for the full requisition → offer lifecycle
- [ ] Clear the 26 pre-existing prettier errors in files this audit did not
      touch (`npm run lint` runs with `--fix`)

## [ ] Monitoring

- [ ] Point an external uptime monitor at `GET /api/health` — nothing polls it
- [ ] **Log login successes and failures** (not currently audited at all) and
      alert on bursts
- [ ] Alert on PM2 restarts — `max_restarts: 10` can mask a crash loop
- [ ] Watch nginx for 413 responses after the body-size change
- [ ] Track `audit_logs` row growth and disk usage

## [ ] Deployment

- [ ] Run the duplicate-global-role query (see **Database** above)
- [ ] `git pull`, then `bash scripts/deploy.sh`
- [ ] Confirm the deploy summary no longer prints the database password
- [ ] Apply the nginx changes and reload
- [ ] Browser smoke test: login → 2FA → raise → approve → candidate → board
      sheet → print hiring record
- [ ] Upload a 6 MB PDF
- [ ] Confirm realtime notifications arrive
- [ ] Run the 14 `VALIDATE CONSTRAINT` statements
- [ ] `curl -I https://talenthub.dbl-group.com` and confirm the new headers

## [ ] Rollback

- [ ] Confirm `dist.old` exists after the deploy (frontend rollback)
- [ ] Note the previous commit hash before deploying
- [ ] Confirm the backup file path printed by `deploy.sh` and that it is
      readable
- [ ] Understand that the constraints migration is **safe to leave in place**
      on a code rollback — it is additive, and the previous code never wrote
      values that violate it
- [ ] If a full database restore is ever needed: **take a fresh backup of the
      current state first** — a restore discards everything since

---

## Before the next feature ships

Put `npm test`, `tsc --noEmit` and `npm run build` behind a pre-push hook or a
small CI job, for both repositories.

The gap that produced this audit's critical finding was not a knowledge gap.
It was the absence of anything that would notice.
