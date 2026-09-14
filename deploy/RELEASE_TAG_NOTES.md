# Release Tag Notes

**Recommended tag:** `hrm-prod-2026-09-security`

Apply the **same tag in both repositories** — they deploy together and a
mismatched pair is very hard to diagnose later.

> **Not tagged, not committed, not pushed.** Everything below is a proposal.
> The working tree is prepared; the commands are yours to run.

---

## Release purpose

Remediation of the production-readiness audit. One critical authorization hole,
one critical data-exposure class, and the hardening that follows from both.
**No new features.**

The system was never *shipped* insecure — it was never shipped at all. This is
the release that makes the first production deployment defensible.

---

## Migrations included

```
20260913220000_integrity_check_constraints     14 CHECK constraints + 1 partial unique index
20260913230000_first_login_and_lockout          3 columns on users, all defaulted
20260914090000_hash_public_action_tokens        token_hash on 5 tables; token made nullable
```

All additive. No `DROP`, no `DELETE`, no `TRUNCATE`, no `ALTER COLUMN … TYPE`.
Per-migration review, lock levels and rollback notes: `RELEASE_MIGRATIONS.md`.

**Deliberately excluded:** the salary `Decimal` conversion lives in
`prisma/planned/`, outside `prisma/migrations/`, so `prisma migrate deploy`
cannot pick it up.

---

## Major security changes

1. **`PATCH /employees/:id` had no authorization at all.** Any signed-in account
   could rewrite any of ~4,600 employees' identity fields, including the email
   used as a sign-in identifier. Now restricted to super user / Head of Talent
   Acquisition / CHRO.
2. **Sensitive documents are no longer public.** CVs, joining documents
   (national ID, certificates) and **Medical Fitness Reports** were published to
   Google Drive as "anyone with the link" — permanent, unauthenticated,
   unlogged. All nine call sites removed; documents stream through the API.
3. **Medical disclosure narrowed.** Recruitment sees fit / not fit and
   provenance. Clinical findings go to medical roles only.
4. **TOTP seeds encrypted at rest** (AES-256-GCM), key outside the database,
   **required at boot** in production.
5. **Sign-in hardened.** Account lockout, bounded 2FA attempts, forced
   first-login password change, 12-character policy, no timing oracle,
   deterministic account resolution.
6. **The audit log stopped leaking.** Salary and credential material redacted;
   authentication events recorded for the first time.
7. **Operational.** Database password out of deploy logs; Google refresh token
   out of application logs; nginx security headers and upload limit; scheduled,
   encrypted, off-site, restore-tested backups.
8. **0 → 94 tests**, CI on both repositories, one-command release gate.

---

## Behaviour change operators must announce

**Google Drive links in emails sent before this release will stop working**
once the sweep runs (`scripts/revoke-public-drive-access.ts --execute`).

| Affected | What happens | What the recipient does |
| --- | --- | --- |
| Approval requests and hiring sheets sent before this release | The `drive.google.com` link 404s or denies access | Opens the record in DBL HRM, or asks for a resend — "Resend" already issues fresh links |
| Bookmarked Drive links | Same | Same |
| Anything sent after this release | Works — links point at DBL HRM and carry their own expiry | — |
| `hr.recruitment@` opening files in Drive directly | Unaffected — it owns the files | — |

**No backward-compatible redirect is provided, on purpose.** Any redirect that
revived those URLs would have to keep the files publicly readable, which is
exactly the finding being closed. Old insecure links are *meant* to break.

**Notify Corporate HR, the CHRO and board members before the sweep, not after.**

Second, smaller change: `GET /employees` no longer returns date of birth or
personal contact details in the list. Those move to the detail view for HR
roles. No screen depended on them in the list.

---

## Operator prerequisites

Before deploying this tag:

- [ ] `TOTP_ENCRYPTION_KEY` generated on the server (`openssl rand -hex 32`) and
      copied into the password manager — **the backend will not start without it**
- [ ] `PRODUCTION_DB_PRECHECK.sql` run, **no `BLOCK`** — specifically §2,
      duplicate global role assignments, which would abort the migration
      part-way through
- [ ] A verified backup exists (`deploy.sh` takes one, but confirm)
- [ ] `PRODUCTION_NGINX_APPLY.md` read — the 1 MB upload ceiling will reject
      real CVs until it is applied
- [ ] HR / CHRO / board notified about the Drive link change

Full sequence: `PRODUCTION_DEPLOY_HANDOFF.md`.

---

## Rollback notes

| Layer | Action | Notes |
| --- | --- | --- |
| Frontend | `rm -rf dist && mv dist.old dist` | Instant; `deploy.sh` keeps `dist.old` for one cycle |
| Backend | `git checkout <previous-tag> -- . && npm ci && npx prisma generate && npm run build && pm2 restart hrm-backend` | |
| Migrations | **Leave them.** All three are additive and their defaults reproduce the previous behaviour | |
| nginx | Restore `nginx.conf.bak-YYYYMMDD`, `nginx -t`, reload | **HSTS cannot be withdrawn** — browsers cache it, which is why `max-age` starts at one week, not a year |
| Drive sweep | **Not reversible, and should not be** | Re-publishing documents would restore the critical finding |
| Audit redaction | Not reversible | The backup taken before it is the rollback |
| Database | `dropdb` / `createdb` / `psql < backup.sql` | **Take a fresh backup of the current state first** |

**One genuine incompatibility.** If you roll the *code* back but keep the
migrations, board-vote and facility tokens issued by the new code are stored
hashed and the old code looks up the raw column — **those links stop working**.
Nothing else is affected; re-sending issues fresh ones. Links issued before the
release are unaffected either way.

---

## Suggested commands

Run these yourself when you are ready. **Nothing has been staged, committed,
tagged or pushed.**

```bash
# Backend
cd HRM_Backend
git add -A                      # .gitignore now covers every .env variant
git status                      # review before committing
git commit -m "security: private document access, medical scoping, auth hardening

Remediates the production-readiness audit. No new features.

- employee update authorization (CRITICAL)
- documents streamed from private storage, never public Drive links (CRITICAL)
- medical clinical findings restricted to medical roles
- TOTP secrets encrypted at rest (AES-256-GCM), required at boot
- account lockout, bounded 2FA attempts, forced first-login change
- salary and credential material redacted from the audit log
- authentication events audited for the first time
- 3 additive migrations; 94 tests; CI and release gate

See RELEASE_CHANGELOG.md and RELEASE_MIGRATIONS.md."
git tag -a hrm-prod-2026-09-security -m "Security hardening release — see RELEASE_TAG_NOTES.md"

# Frontend
cd ../HRM_Frontend
git add -A
git status
git commit -m "security: forced first-login password change; mock API off by default

Companion to the backend security release.

- ChangePasswordRequiredPage; ProtectedRoute holds a restricted session
- mustChangePassword carried through the auth store
- .env.example defaults VITE_USE_MOCK_API=false
- CI workflow

See ../RELEASE_CHANGELOG.md."
git tag -a hrm-prod-2026-09-security -m "Security hardening release — see RELEASE_TAG_NOTES.md"

# Push both, with tags, when you are ready
git -C ../HRM_Backend push origin main --follow-tags
git -C ../HRM_Frontend push origin main --follow-tags
```

Before pushing, confirm no `.env` is staged:

```bash
git -C HRM_Backend  diff --cached --name-only | grep -E '^\.env' && echo "STOP"
git -C HRM_Frontend diff --cached --name-only | grep -E '^\.env' && echo "STOP"
```

(Expect no output from both.)

---

**DEVELOPMENT VERIFIED.** This tag has not been created, pushed or deployed.
