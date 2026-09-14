# Production Deploy Handoff

**For the operator on the production Windows Server.**

Everything in this repository was prepared and verified on a **development
machine**. Nothing here has touched production.

| Label | Means |
| --- | --- |
| **DEVELOPMENT VERIFIED** | Run on a developer's PC against the development database. Proves the code and the scripts work. Proves **nothing** about your server. |
| **PRODUCTION VERIFIED** | You ran it on the production server and saw the result. **No item in this repository carries this label yet.** |

Nothing checked on the development PC may be reported as production-verified.

Work through the 21 steps **in order**. Several are ordered deliberately —
step 11 (dry run) before 13 (sweep), step 12 (notify) before 13, and step 1
(backup) before everything.

**Stop at the first failure and do not continue.** Every step says what a
failure means.

---

### Before you start

- Roughly 60–90 minutes, plus the notification lead time in step 12.
- Outside working hours. Step 7 restarts the backend; step 10 reloads nginx.
- Have `FINAL_GO_LIVE_GATE.md`, `PRODUCTION_NGINX_APPLY.md` and
  `PRODUCTION_ENV_CHECKLIST.md` open.
- The Drive sweep (step 13) is **not reversible**, and should not be.

---

## 1. Confirm a production backup exists

```bash
cd /c/apps/DBL-HRM/HRM_Backend
./scripts/backup-production.sh
ls -la "$HOME/hrm_backups" | tail -5
```

The script refuses to count a dump that does not end with pg_dump's own
completion marker — an interrupted dump leaves a large, plausible, useless file.

- [ ] A backup from **today** exists and the script exited 0
- [ ] `Last Result: 2` means the backup is fine but the off-server copy failed —
      acceptable to proceed, but fix the share

**Failure → STOP.** Do not deploy without a verified backup.
*Status: ☐ PRODUCTION VERIFIED*

## 2. Confirm environment variables

Work through `PRODUCTION_ENV_CHECKLIST.md` against
`C:\apps\DBL-HRM\HRM_Backend\.env`.

- [ ] `NODE_ENV=production`
- [ ] `CORS_ORIGIN` and `FRONTEND_URL` are the real production origin, no
      trailing slash
- [ ] `GOOGLE_REFRESH_TOKEN` present — without it **every document stream
      fails**, which now means no CV can be opened
- [ ] `HRM_Frontend/.env` has `VITE_USE_MOCK_API=false`

*Status: ☐ PRODUCTION VERIFIED*

## 3. Generate and set `TOTP_ENCRYPTION_KEY`

**New and mandatory. The backend will not start without it.**

```bash
openssl rand -hex 32
```

Add to `HRM_Backend/.env`:

```dotenv
TOTP_ENCRYPTION_KEY=<the 64 hex characters from above>
```

- [ ] Set in `.env`
- [ ] **Copied into the company password manager** — lose it and every enrolled
      authenticator must be re-enrolled

*Status: ☐ PRODUCTION VERIFIED*

## 4. Run the database pre-check

```bash
psql "<DATABASE_URL without the ?query part>" -f PRODUCTION_DB_PRECHECK.sql
```

Read-only: the file contains no `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`,
`TRUNCATE` or `CREATE`.

*Status: ☐ PRODUCTION VERIFIED*

## 5. Confirm no `BLOCK`

Read every `verdict` column.

- [ ] **§2 duplicate global role assignments — the one hard blocker.** Zero
      groups. A duplicate aborts the migration **part-way through the release**,
      because a unique index cannot be added `NOT VALID`. The output names which
      id to keep.
- [ ] §5 orphaned records: all `OK`
- [ ] §6 `duplicate approval order_index`: `OK`

`WARN` is informational — note it and continue. **Any `BLOCK` → STOP** and fix
it before step 7.

*Status: ☐ PRODUCTION VERIFIED*

## 6. Run the release gate

```bash
cd /c/apps/DBL-HRM
./release-check.sh
```

16 gates: install, Prisma, typecheck, 94 tests, builds, and five security
invariants. Exits non-zero on any failure.

- [ ] `16 gates passed. Safe to deploy.`

**Failure → STOP.** *(DEVELOPMENT VERIFIED on the dev PC; this run makes it
production-verified for this server.)*

*Status: ☐ PRODUCTION VERIFIED*

## 7. Run the deployment script

```bash
cd /c/apps/DBL-HRM/HRM_Backend
bash scripts/deploy.sh
```

It backs up, verifies the backup, stops PM2, `npm ci`, applies migrations,
builds, restarts PM2, and swaps the frontend `dist/` atomically.

- [ ] Exited 0
- [ ] **The summary does not print the database password** (fixed this release —
      confirm it stayed fixed)
- [ ] Previous frontend kept at `dist.old`

*Status: ☐ PRODUCTION VERIFIED*

## 8. Confirm Prisma migrations applied

`deploy.sh` runs `prisma migrate deploy`. Verify:

```bash
npx prisma migrate status
```

- [ ] `20260913220000_integrity_check_constraints` applied
- [ ] `20260913230000_first_login_and_lockout` applied
- [ ] `20260914090000_hash_public_action_tokens` applied
- [ ] `20260914120000_delegation_send_tracking` applied
- [ ] **No salary/Decimal migration applied** — it lives in `prisma/planned/`
      and must not appear

Per-migration detail: `RELEASE_MIGRATIONS.md`.

*Status: ☐ PRODUCTION VERIFIED*

## 9. Validate the new constraints

During a quiet period, **one at a time**. `VALIDATE` takes only a
`SHARE UPDATE EXCLUSIVE` lock (reads and writes continue) but does scan the
table. A failure names the offending row and changes nothing.

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

- [ ] All 14 succeeded

A failure is **not** an emergency: the constraint stays `NOT VALID`, still binds
new writes, and you have found a real data problem to investigate.

*Status: ☐ PRODUCTION VERIFIED*

## 10. Apply the nginx configuration

Follow `PRODUCTION_NGINX_APPLY.md` exactly: back up, compare, edit, `nginx -t`,
reload.

- [ ] `nginx -t` succeeded **before** reloading
- [ ] Reloaded
- [ ] `client_max_body_size 20m` present — without it every upload over **1 MB**
      fails with a 413 the application never sees and never logs

*Status: ☐ PRODUCTION VERIFIED*

## 11. Drive sweep — DRY RUN first

```bash
cd /c/apps/DBL-HRM/HRM_Backend
npx ts-node scripts/revoke-public-drive-access.ts
```

Default mode changes nothing.

- [ ] It ran and printed a summary
- [ ] Note how many objects are public, by class

**Do not run `--execute` yet.** Step 12 comes first.

*Status: ☐ PRODUCTION VERIFIED*

## 12. Notify HR, CHRO and board members

**Before the sweep, not after.** Drive links in emails sent before this release
will stop working.

Suggested wording:

> From today, candidate CVs and hiring documents open through DBL HRM rather
> than through Google Drive. **Drive links in older emails will stop working.**
> Open the record in DBL HRM instead, or ask us to resend the approval — the
> resent link will work. This change means documents are no longer readable by
> anyone who happens to have a link.

- [ ] Corporate HR notified
- [ ] CHRO notified
- [ ] Board members notified
- [ ] Enough lead time given for anyone mid-approval

*Status: ☐ PRODUCTION VERIFIED*

## 13. Execute the Drive permission sweep

```bash
npx ts-node scripts/revoke-public-drive-access.ts --execute
npx ts-node scripts/revoke-public-drive-access.ts      # confirm: public = 0
```

- [ ] `--execute` completed
- [ ] Re-run shows **0 public** in every class
- [ ] Exit code 0 (non-zero means some objects failed — re-run; it is idempotent)

**Not reversible, and should not be.**

*Status: ☐ PRODUCTION VERIFIED*

## 14. Redact historic salary values in the audit log

```bash
./scripts/backup-production.sh        # this step modifies rows
psql "<DATABASE_URL without ?query>" -f scripts/redact-audit-pay-values.sql
```

Wrapped in a transaction that prints the row count before and after. Review
both, then `COMMIT` (or `ROLLBACK`). Redacts **in place** — entry, actor,
timestamp and the fact a field changed all survive.

- [ ] `remaining_unredacted` is **0**
- [ ] Total `audit_logs` row count unchanged

*Status: ☐ PRODUCTION VERIFIED*

## 15. Run the restore drill

```bash
BACKUP_PASSPHRASE_FILE=/c/hrm_secrets/backup.pass ./scripts/restore-test.sh
```

Restores the newest backup into a **separate temporary database**, compares row
counts, prints the elapsed time, drops the temporary database. It cannot touch
production — the target name is timestamped and asserted twice.

- [ ] Exit 0, every checked table matched
- [ ] **Elapsed time recorded — that is your real RTO**
- [ ] Today's date recorded as the last successful drill
- [ ] The nightly task is scheduled (`BACKUP_AND_RESTORE_RUNBOOK.md`)

A backup that has never been restored is a hypothesis.

*Status: ☐ PRODUCTION VERIFIED*

## 16. Smoke test

In a browser, signed in as a real user:

- [ ] Sign in normally — **no** forced password change appears (unless you ran
      the §7c rollout)
- [ ] Five wrong passwords → the account locks and the message names the wait
- [ ] **Open a candidate's CV.** It opens, and the URL is
      `…/api/files/…` — **not** `drive.google.com`
- [ ] The same CV as a user from another unit → refused
- [ ] As a recruiter, open the medical section → **summary only**, no clinical
      findings
- [ ] As a medical officer → full record, and the report file opens
- [ ] Open a joining document (National ID) as HR → opens
- [ ] Raise a requisition, approve it, attach a **6 MB PDF** → all succeed
- [ ] Open **First interviews** on a requisition's candidate pipeline → the
      scoreboard lists who holds what and where each candidate stands
- [ ] Open the send dialog → each interviewer shows their current load, and a
      candidate already with them is flagged before you click
- [ ] Send a board approval; open the emailed link → sheet loads and **View CV
      works from the email**
- [ ] Submit that vote → the CV link from that email stops working *(expected —
      the token is spent)*

*Status: ☐ PRODUCTION VERIFIED*

## 17. Verify PM2

```bash
pm2 list
pm2 logs hrm-backend --lines 40
```

- [ ] `hrm-backend` online, restart count not climbing
- [ ] No `Invalid configuration:` in the log
- [ ] `🚀 HRM API ready` present
- [ ] Still `instances: 1, exec_mode: fork` — cluster mode silently breaks
      realtime and multiplies the in-memory rate limiter

*Status: ☐ PRODUCTION VERIFIED*

## 18. Verify Socket.IO

- [ ] Sign in as two users in two browsers; an action by one raises a live
      notification for the other
- [ ] Browser dev tools show a `/socket.io/` **websocket** connection, not
      repeated polling

A missing `/socket.io/` nginx block has silently broken realtime here before —
no error anywhere, just no notifications.

*Status: ☐ PRODUCTION VERIFIED*

## 19. Verify secure document links

- [ ] Every document URL in the UI is `…/api/files/…` or `…/api/candidates/…/cv/file`
- [ ] **No `drive.google.com` link remains in the UI**
- [ ] An expired or edited `/api/files/<grant>` returns 403
- [ ] Signed out, `/api/candidates/<id>/cv/file` returns 401

*Status: ☐ PRODUCTION VERIFIED*

## 20. Verify the health endpoint and headers

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<production-host>/api/health
curl -sSI https://<production-host> | grep -iE "strict-transport|content-security|x-content-type|referrer-policy|permissions-policy|x-frame"
```

- [ ] Health returns **200**
- [ ] All six security headers present
- [ ] External uptime monitor pointed at `/api/health`

*Status: ☐ PRODUCTION VERIFIED*

## 21. Decide GO / NO-GO

**GO** requires steps 1–20 all marked PRODUCTION VERIFIED.

If any failed, the system is **NO-GO** until it is resolved. Partial completion
is not a GO — in particular, deploying the code without step 10 leaves a 1 MB
upload ceiling, and without step 13 the documents are still public.

- [ ] Steps 1–20 verified
- [ ] Residual risks in `RELEASE_CHANGELOG.md` read and accepted
- [ ] Someone owns the follow-ups (deferred items 1–10)
- [ ] **Decision recorded, with a name and a date**

```
Decision:  GO / NO-GO
Decided by:
Date:
Notes:
```

---

## Separate business decision — not part of this deployment

**Forced password change for existing accounts.** The migration defaults
`must_change_password` to `false`, so **nothing changes for anyone** until
someone decides. Deciding when to disrupt ~4,600 people is not a deployment's
call.

The risk it manages: a synced employee's default password **is their employee
code**, which is printed in the directory every signed-in user can read.

Reviewed SQL and a pilot-first approach: `FINAL_GO_LIVE_GATE.md` §7c.

---

## If something goes wrong

`RELEASE_TAG_NOTES.md` → *Rollback notes*, and `FINAL_GO_LIVE_GATE.md` §15.

Short version: frontend and backend roll back cleanly; **leave the migrations in
place** (all additive, defaults reproduce the previous behaviour); the Drive
sweep and the audit redaction are not reversible — the backup from step 1 is the
rollback for those.

One incompatibility: rolling the code back while keeping the migrations means
board-vote and facility links issued by the new code stop working, because they
are stored hashed and the old code reads the raw column. Re-sending fixes it.
