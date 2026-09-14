# Backup & Restore Runbook — DBL HRM

Covers the production PostgreSQL database on the Windows server.

**Two scripts, two different jobs:**

| Script | When it runs | What it protects against |
| --- | --- | --- |
| `HRM_Backend/scripts/deploy.sh` | before every release (automatically) | a bad migration or a failed deploy |
| `HRM_Backend/scripts/backup-production.sh` | on a schedule | disk failure, ransomware, accidental deletion, losing the server |
| `HRM_Backend/scripts/restore-test.sh` | quarterly, and once before go-live | a backup that was never actually restorable |

Before this release only the first existed — which means **backups happened
only when somebody deployed**, they sat on the same disk as the database,
unencrypted, with no retention, and none had ever been restored.

---

## Objectives

| | Target | Basis |
| --- | --- | --- |
| **RPO** (data you can afford to lose) | **24 hours** | one scheduled backup per night. Tighten to 1 hour with WAL archiving if the business decides a day of hiring activity is too much to re-enter. |
| **RTO** (time to be running again) | **under 1 hour** | measured restore of the current dataset is **~1 second** for the data itself; the hour is provisioning, verification and DNS, not the restore. Re-measure with `restore-test.sh` as the database grows — it prints the number. |
| **Retention** | 30 daily, plus the 1st of each month kept for 12 months | `BACKUP_RETENTION_DAYS` handles the daily window; the monthly copies are a manual pull to off-site storage. |

---

## Configuration

Set these as system environment variables on the server (not in `.env` — the
scripts read `.env` only for `DATABASE_URL`):

| Variable | Example | Effect if unset |
| --- | --- | --- |
| `BACKUP_DIR` | `C:\hrm_backups` | defaults to `%USERPROFILE%\hrm_backups` |
| `BACKUP_RETENTION_DAYS` | `30` | 30 |
| `BACKUP_OFFSITE_DIR` | `\\fileserver\hrm-backups` or a mapped drive | **no off-server copy** — the script warns loudly |
| `BACKUP_PASSPHRASE_FILE` | `C:\hrm_secrets\backup.pass` | **backups are stored unencrypted** — the script warns loudly |

Create the passphrase file once, readable only by the account the task runs as:

```bat
mkdir C:\hrm_secrets
powershell -Command "[System.Web.Security.Membership]::GeneratePassword(48,8)" > C:\hrm_secrets\backup.pass
icacls C:\hrm_secrets\backup.pass /inheritance:r /grant:r "%USERNAME%:R"
```

**Store that passphrase in the company password manager as well.** An encrypted
backup whose passphrase is only on the server it was protecting you from losing
is not a backup.

---

## Daily schedule (Task Scheduler)

```bat
schtasks /Create ^
  /TN "DBL HRM - Nightly Database Backup" ^
  /TR "\"C:\Program Files\Git\bin\bash.exe\" -lc \"cd /c/apps/DBL-HRM/HRM_Backend && ./scripts/backup-production.sh >> /c/hrm_backups/backup.log 2>&1\"" ^
  /SC DAILY /ST 01:30 ^
  /RU SYSTEM /RL HIGHEST /F
```

01:30 is after the ZingHR sync (20:36) and well clear of working hours.

Check it is registered and has run:

```bat
schtasks /Query /TN "DBL HRM - Nightly Database Backup" /V /FO LIST | findstr /I "Status Last Next Result"
```

`Last Result: 0` is success. **`2` means the backup itself is fine but the
off-server copy failed** — the local copy is good; fix the share.

---

## What the backup script guarantees

1. Locates `pg_dump` explicitly — PATH on this server has been unreliable before.
2. Strips Prisma's `?schema=…&connection_limit=…` parameters, which `pg_dump`
   rejects outright.
3. **Proves the dump is complete** before counting it: non-empty *and* ending
   with pg_dump's own `PostgreSQL database dump complete` marker. An
   interrupted dump leaves a large, plausible-looking, useless file; this is the
   only reliable way to tell.
4. Compresses (~4.3 MB → ~1.0 MB today).
5. Encrypts with AES-256 (PBKDF2, 200k iterations) when a passphrase is set.
6. Copies off-server when a destination is set.
7. Prunes by retention.
8. Never prints `DATABASE_URL`, the passphrase, or any row of data.

---

## Restore drill — do this before go-live, then quarterly

```bash
cd /c/apps/DBL-HRM/HRM_Backend
BACKUP_PASSPHRASE_FILE=/c/hrm_secrets/backup.pass ./scripts/restore-test.sh
```

It restores the newest backup into a **separate temporary database**, compares
row counts against live, prints the elapsed time, and drops the temporary
database. It cannot touch production: the target name is generated with a
timestamp, is asserted to differ from the live database name, and is asserted to
match `hrm_restore_test_*` before anything is created.

Verified output from a real run against the current dataset:

```
[00:50:33] restoring: hrm_20260914_005026.sql.gz.enc (1.0M)
[00:50:34] restored in 1s

TABLE                    LIVE   RESTORED   RESULT
audit_logs                318        318   ok
board_approvals             7          7   ok
candidates                 16         16   ok
employees                4613       4613   ok
onboardings                 7          7   ok
requisitions                8          8   ok
users                    4614       4614   ok

[00:50:34] RESTORE VERIFIED. RTO for this dataset: 1s.
```

Exit code 0 means verified. **Record the date of each successful drill** —
"when did we last prove this works?" is the only question that matters when you
need it.

Small count differences are expected if the system was in use during the
backup. A large or structural difference is not.

---

## Real restore — production is down or corrupted

Do these in order. Do not skip step 1.

```bash
# 1. BACK UP THE CURRENT STATE FIRST, however broken it looks.
#    A restore discards everything since the backup, and you may need the
#    corrupted database to work out what happened.
cd /c/apps/DBL-HRM/HRM_Backend
BACKUP_DIR=/c/hrm_backups/emergency ./scripts/backup-production.sh

# 2. Stop the application so nothing writes during the restore.
pm2 stop hrm-backend

# 3. Prove the backup you are about to trust actually restores.
BACKUP_PASSPHRASE_FILE=/c/hrm_secrets/backup.pass ./scripts/restore-test.sh /c/hrm_backups/hrm_YYYYMMDD_HHMMSS.sql.gz.enc

# 4. Only after step 3 passes: restore over the live database.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in /c/hrm_backups/hrm_YYYYMMDD_HHMMSS.sql.gz.enc \
  -out /tmp/restore.sql.gz -pass file:/c/hrm_secrets/backup.pass
gunzip -c /tmp/restore.sql.gz > /tmp/restore.sql

dropdb dbl_hrm && createdb dbl_hrm
psql "<DATABASE_URL from .env, without the ?query>" < /tmp/restore.sql

# 5. Bring it back up and check migration state.
npx prisma migrate status
pm2 start hrm-backend
rm -f /tmp/restore.sql /tmp/restore.sql.gz
```

**Afterwards:** any Google Drive document uploaded after the backup still exists
in Drive but has no database row pointing at it. Those are orphans, not losses —
they can be re-attached by hand from the recruitment Drive account.

---

## Handling of the backup files themselves

A dump contains **every employee and candidate record in plaintext**: names,
dates of birth, phone numbers, addresses, salaries, medical clearance status.
Treat a backup file exactly as you would the database.

- `backups/` and `*.sql.gz` are in `.gitignore`. Never commit one.
- Never attach one to a ticket, an email, or a chat message.
- Never copy one to a developer laptop. For development, restore and then
  anonymise — see below.
- The off-site destination must be access-controlled, not a public share.

### Anonymising a copy for development

```sql
-- Run ONLY against a restored copy, never against production.
UPDATE users SET
  name  = 'Employee ' || substr(md5(id), 1, 6),
  email = 'user+' || substr(md5(id), 1, 8) || '@example.invalid',
  phone = NULL,
  password_hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', -- 'password'
  two_factor_secret = NULL, otp_hash = NULL;
UPDATE employees SET date_of_birth = NULL, line_manager_name = 'Manager';
UPDATE candidates SET
  name = 'Candidate ' || substr(md5(id), 1, 6),
  email = 'cand+' || substr(md5(id), 1, 8) || '@example.invalid',
  phone = NULL, cv_address = NULL, cv_profile = NULL,
  match_summary = NULL, notes = NULL, salary_expectation = NULL;
UPDATE salary_fixations SET
  proposed_salary = NULL, proposed_salary_override = NULL, average_score = NULL;
DELETE FROM medical_exams;
DELETE FROM audit_logs;
UPDATE onboardings SET candidate_address = NULL, offer_letter_html = NULL,
  appointment_letter_html = NULL;
```

---

## Monitoring

| Check | How | Frequency |
| --- | --- | --- |
| Backup ran and succeeded | `schtasks /Query … | findstr "Last Result"` — expect `0` | daily |
| Backup is recent | `dir C:\hrm_backups\hrm_*.gz*` — newest under 26h old | daily |
| Off-site copy is arriving | listing on the destination | weekly |
| Disk space | backups accumulate; retention prunes at 30 days | weekly |
| Restore actually works | `restore-test.sh`, exit 0 | quarterly + before go-live |

An alert on "no backup file newer than 26 hours" is worth more than all the
others combined: a backup job that silently stopped is the failure mode that
actually happens.
