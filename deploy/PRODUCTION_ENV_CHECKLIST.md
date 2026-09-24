# Production Environment Checklist

Every variable the production backend reads, what happens if it is wrong, and
how to verify it. **Placeholders only — this file contains no real value, and
must never be edited to contain one.**

Target file on the server: `C:\apps\DBL-HRM\HRM_Backend\.env`
(ignored by git — verified: `.env` and every `.env.*` variant except
`.env.example` are covered).

Template: `HRM_Backend/.env.example` — all 39 variables documented, every
credential-bearing key left empty.

---

## Enforced at boot

`validateEnv()` in `HRM_Backend/src/main.ts` **exits the process** in production
if any of these is wrong. The server will not start — which is the intended
behaviour, and far better than starting with a weak secret.

| Variable | Rule | Failure message names the variable |
| --- | --- | --- |
| `DATABASE_URL` | must be set | ✓ |
| `JWT_SECRET` | set, ≥24 chars, not `dev-secret-change-me` | ✓ |
| `CORS_ORIGIN` | set, not `*` | ✓ |
| `GOOGLE_OAUTH_REDIRECT_URI` | set, must not contain `localhost` | ✓ |
| `TOTP_ENCRYPTION_KEY` | set, ≥32 chars | ✓ **new in this release** |

Verified on the development machine: booting a production build with
`TOTP_ENCRYPTION_KEY` empty was refused and the message named the variable;
with it set, the server started and `GET /api/health` returned 200.

---

## 1. Core

```dotenv
NODE_ENV=production
PORT=4000
API_PREFIX=api

# The database is on this host. Keep the pool settings — Prisma needs them and
# the scripts strip the query string before handing the URL to pg_dump/psql.
DATABASE_URL="postgresql://<db_user>:<db_password>@localhost:5432/<db_name>?schema=public&connection_limit=20&pool_timeout=10"
```

- [ ] `NODE_ENV` is exactly `production`
- [ ] `DATABASE_URL` points at `localhost` — confirm PostgreSQL is not listening
      on a public interface (`POSTGRES_PRODUCTION_HARDENING.md` §1)
- [ ] Password is not the account's default and not shared with anything else

> The value in `.env.example` (`postgres:postgres@localhost`) is a development
> placeholder, not a credential.

## 2. Authentication

```dotenv
JWT_SECRET=<48+ random characters — openssl rand -base64 48>
JWT_EXPIRES_IN=1d

# REQUIRED IN PRODUCTION. The server refuses to start without it.
TOTP_ENCRYPTION_KEY=<64 hex characters — openssl rand -hex 32>

LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCKOUT_MINUTES=15
PASSWORD_MIN_LENGTH=6
PASSWORD_MAX_LENGTH=12
```

- [ ] `JWT_SECRET` is unique to production, ≥24 characters, never committed
- [ ] **`TOTP_ENCRYPTION_KEY` generated on the server**, 32 bytes:

      ```bash
      openssl rand -hex 32
      ```

- [ ] A copy of `TOTP_ENCRYPTION_KEY` is in the company password manager

> **Why the copy matters.** The key encrypts TOTP seeds at rest (AES-256-GCM).
> Lose it and every enrolled authenticator stops working — each user must
> re-enrol. Rotating it has the same effect, deliberately.
>
> Outside production the server derives a key from `JWT_SECRET` so a developer
> checkout works with no setup. That derived key is **not** usable in
> production, so a development database restored into production cannot quietly
> decrypt with a guessable key.

- [ ] Lockout values agreed with the business (5 / 15 are the defaults)
- [ ] `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` agreed — 6 to 12 (owner decision, 2026-09-24), no composition rules

## 3. URLs and CORS

```dotenv
CORS_ORIGIN=https://<your-production-host>
FRONTEND_URL=https://<your-production-host>
```

- [ ] `CORS_ORIGIN` is the exact production origin — **never `*`** (refused at boot)
- [ ] `FRONTEND_URL` set **explicitly**. It builds every link in every email —
      offer letters, board approvals, evaluation links, onboarding pages. If it
      is wrong, every one of those links points somewhere wrong.
- [ ] Both use `https://`, no trailing slash

## 4. Mail (Gmail SMTP)

```dotenv
MAIL_USER=<recruitment_mailbox@your-domain>
MAIL_APP_PASSWORD=<16-character Google app password>
MAIL_FROM="DBL Group Recruitment <recruitment_mailbox@your-domain>"
```

- [ ] App password, **not** the account password
- [ ] Mailbox is the same account that owns the recruitment Drive
- [ ] Send one test email after deploy

## 5. Google (Drive, Calendar, OAuth)

```dotenv
GOOGLE_CLIENT_ID=<oauth client id>
GOOGLE_CLIENT_SECRET=<oauth client secret>
GOOGLE_OAUTH_REDIRECT_URI=https://<your-production-host>/api/integrations/google/oauth/callback
GOOGLE_REFRESH_TOKEN=<long-lived refresh token>
GOOGLE_DRIVE_ROOT_FOLDER_ID=<drive folder id>
GOOGLE_DRIVE_ROOT_FOLDER_NAME="DBL HRM Recruitment"
```

- [ ] `GOOGLE_OAUTH_REDIRECT_URI` contains **no `localhost`** (refused at boot)
      and matches the Google Cloud console exactly
- [ ] `GOOGLE_REFRESH_TOKEN` present — without it the Drive integration is
      unconfigured and **every document stream fails**, which now means CVs and
      joining documents cannot be opened at all
- [ ] After the one-time consent flow, `HRM_Backend/google-refresh-token.txt`
      was copied into `.env` and then **deleted** from the server

> The refresh token is no longer written to the application log (it used to be).
> Rotate it only if old PM2 logs were ever shared outside the team.

## 6. AI provider

```dotenv
AI_PROVIDER=anthropic          # or: gemini
ANTHROPIC_API_KEY=<api key>
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
GEMINI_API_KEY=<api key>
GEMINI_MODEL=gemini-2.5-flash
```

- [ ] Only the selected provider's key needs a value
- [ ] A spend alert is set on the provider account — the public application
      endpoint triggers a screening call per accepted CV

## 7. BDJobs

```dotenv
BDJOBS_BASE_URL=https://application.bdjobs.com/v1
BDJOBS_AUTH_TOKEN=<shared token>
BDJOBS_COMPANY_ID=<company id>
BDJOBS_DECODE_ID=<decode id>
BDJOBS_SIGNATURE_FORMAT={token}&^^{decodeId}*&*{ts}
```

- [ ] `BDJOBS_AUTH_TOKEN` and `BDJOBS_DECODE_ID` set — the inbound candidate
      endpoint verifies a SHA-256 signature built from both, in constant time,
      with a 5-minute replay window. Without them it returns
      `NOT_CONFIGURED` and accepts nothing.
- [ ] `BDJOBS_SIGNATURE_FORMAT` matches what BDJobs actually sends

## 8. ZingHR

```dotenv
ZINGHR_BASE_URL=https://portal.zinghr.com
ZINGHR_SUBSCRIPTION_NAME=<subscription>
ZINGHR_TOKEN=<api token>
ZINGHR_EMPLOYEE_CODE_PREFIX=151
ZINGHR_SYNC_CRON=36 20 * * *
ZINGHR_SYNC_ENABLED=true
```

- [ ] Prefix matches the employee codes actually in use
- [ ] Sync schedule does not collide with the 01:30 nightly backup

> The sync **upserts and never deletes**, so a partial upstream response cannot
> wipe employee data. Preserve that if it is ever refactored.

## 9. Optional

```dotenv
IT_WEBHOOK_URL=            # leave empty unless used; sign it if enabled
NUDGE_APPROVAL_DAYS=3
```

## 10. Frontend

`HRM_Frontend/.env` — baked into the build, so **never put a secret here**:

```dotenv
VITE_API_BASE_URL=https://<your-production-host>/api
VITE_USE_MOCK_API=false
```

- [ ] `VITE_USE_MOCK_API=false`
- [ ] `VITE_API_BASE_URL` ends in `/api` and matches `CORS_ORIGIN`'s host

---

## Final verification

```bat
:: 1. No .env is tracked by git (expect no output)
cd C:\apps\DBL-HRM\HRM_Backend && git ls-files | findstr /R "^\.env$"
cd C:\apps\DBL-HRM\HRM_Frontend && git ls-files | findstr /R "^\.env$"

:: 2. The one-time OAuth output file is gone
dir C:\apps\DBL-HRM\HRM_Backend\google-refresh-token.txt

:: 3. The server starts — this is the real test of the boot-enforced set
pm2 restart hrm-backend && pm2 logs hrm-backend --lines 30
::    "Invalid configuration:" names any variable that is wrong
::    "🚀 HRM API ready" means all five passed

:: 4. Health
curl -s -o NUL -w "%%{http_code}\n" https://<your-production-host>/api/health
```

- [ ] `.env` not tracked in either repository
- [ ] `google-refresh-token.txt` not present on the server
- [ ] Backend starts with no configuration error
- [ ] Health returns 200

---

**Status: DEVELOPMENT VERIFIED only.** The variable list, the boot enforcement
and the failure messages were exercised on the development machine. **No
production `.env` has been read, written or validated.**
