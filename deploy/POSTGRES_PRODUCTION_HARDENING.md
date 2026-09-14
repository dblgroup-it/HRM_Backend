# PostgreSQL Production Hardening — DBL HRM

For the PostgreSQL 18 instance on the Windows server. **Nothing here is applied
automatically** — every item is a change an operator makes deliberately, with
the verification command beside it.

Paths assume a default install: `C:\Program Files\PostgreSQL\18\`, data
directory `C:\Program Files\PostgreSQL\18\data\`.

---

## 1. Do not let the database listen to the network

The application and the database are on the same host. `DATABASE_URL` points at
`localhost:5432`, so PostgreSQL has no reason to accept a connection from
anywhere else.

**Check what it is bound to now:**

```sql
SHOW listen_addresses;
```

```bat
netstat -ano | findstr ":5432"
```

`127.0.0.1:5432` only is what you want. `0.0.0.0:5432` means it is reachable
from the network.

**To restrict** — in `postgresql.conf`:

```conf
listen_addresses = 'localhost'
```

Restart is required (a reload will not move the listener):

```bat
net stop postgresql-x64-18 && net start postgresql-x64-18
```

**Firewall.** Confirm no inbound rule exposes 5432. Inspect first — do not add
or remove rules from a script:

```bat
netsh advfirewall firewall show rule name=all | findstr /I "5432"
```

If a rule exists and the database is meant to be local-only, delete it through
the firewall UI or with an explicit, reviewed command.

---

## 2. Authentication rules (`pg_hba.conf`)

**Inspect:**

```sql
SELECT type, database, user_name, address, auth_method
FROM pg_hba_file_rules ORDER BY line_number;
```

What you want, and nothing more:

```conf
# TYPE  DATABASE  USER      ADDRESS         METHOD
host    dbl_hrm   hrm_app   127.0.0.1/32    scram-sha-256
host    all       postgres  127.0.0.1/32    scram-sha-256
```

Any line with `trust`, or an `ADDRESS` of `0.0.0.0/0`, is a finding. Reload
after editing:

```sql
SELECT pg_reload_conf();
```

Confirm password hashing is modern:

```sql
SHOW password_encryption;   -- expect: scram-sha-256, not md5
```

---

## 3. Statement and transaction timeouts

Today there are none. One runaway query — a bad report, an accidental
cross join — can hold a connection out of a pool of 20 indefinitely, and an
abandoned open transaction can block VACUUM and hold locks behind it.

Set them **on the application role**, not globally, so `pg_dump`, migrations and
maintenance are unaffected:

```sql
-- Substitute the role in DATABASE_URL.
ALTER ROLE hrm_app SET statement_timeout = '30s';
ALTER ROLE hrm_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE hrm_app SET lock_timeout = '10s';
```

Verify (takes effect on the role's *next* connection — restart the app):

```sql
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'hrm_app';
```

**30 seconds is a judgement, not a law.** The AI screening endpoints allow up to
85 seconds for the *provider* call, but that happens outside the database; no
single query in this application should approach 30s at current volumes. If the
Excel export of a large approval sheet ever trips it, raise it for that path
rather than removing it.

Alternatively, set them in `DATABASE_URL` so they travel with the connection:

```
...&options=-c%20statement_timeout%3D30s%20-c%20idle_in_transaction_session_timeout%3D60s
```

---

## 4. Connection pool

Already configured, and correctly:

```
?schema=public&connection_limit=20&pool_timeout=10
```

One PM2 instance in fork mode (deliberately — see `ecosystem.config.js`) means
one pool of 20. Check it against the server's ceiling:

```sql
SHOW max_connections;                        -- default 100
SELECT count(*) FROM pg_stat_activity;       -- current
SELECT usename, count(*) FROM pg_stat_activity GROUP BY usename;
```

20 of 100 leaves ample room for `psql`, backups and migrations. **If PM2 is ever
scaled beyond one instance, the pool multiplies** — and so does the in-memory
rate limiter, and realtime breaks. Scaling out is a three-part change, not a
config tweak.

---

## 5. SSL

Not required here: the connection is a loopback on the same host, so there is no
network to intercept. Enable it only if the database is ever moved to a separate
machine — at which point `sslmode=require` in `DATABASE_URL` and a certificate
become mandatory, not optional.

```sql
SHOW ssl;
```

---

## 6. Least privilege for the application role

Check what the application account can actually do:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
FROM pg_roles WHERE rolname = 'hrm_app';
```

`rolsuper = f` is what you want. If the application connects as `postgres`, it
is running as superuser — which means a SQL-injection bug anywhere (there are
none today; the codebase uses no raw SQL beyond `SELECT 1`) would be
catastrophic rather than contained, and it also defeats §7.

Creating a dedicated role is a change with a deployment step, so it is listed
here rather than applied:

```sql
CREATE ROLE hrm_app LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE dbl_hrm TO hrm_app;
GRANT USAGE ON SCHEMA public TO hrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrm_app;
```

> Migrations need DDL rights, which `hrm_app` deliberately lacks. Run
> `prisma migrate deploy` with the owner role — `deploy.sh` would need a
> separate `MIGRATION_DATABASE_URL`. Plan that before switching roles.

---

## 7. Make the audit log hard to rewrite

`audit_logs` is an ordinary table: anything with the application's connection
can update or delete a row. The application only ever **inserts** into it, so
removing the other rights costs nothing and makes quiet tampering much harder.

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM hrm_app;
```

**What breaks:** nothing in the application. Verified by inspection — the only
writes to `audit_logs` are `create` calls in `AuditService.record()`. Reading is
unaffected.

**What this does not do:** stop a superuser, or anyone with the `postgres`
password. It raises the bar; it is not a guarantee. Shipping entries to
append-only storage is the next step if the business needs one.

Verify:

```sql
SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_name = 'audit_logs';
```

---

## 8. Autovacuum and bloat

`audit_logs` and `notifications` grow on every mutating request and every
notification. Nothing prunes them today.

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN ('audit_logs','notifications','candidates','requisitions')
ORDER BY n_live_tup DESC;
```

Retention, once the business has agreed a period (24 months is a common default
for HR audit records — confirm against your own policy):

```sql
DELETE FROM audit_logs   WHERE created_at < now() - interval '24 months';
DELETE FROM notifications WHERE created_at < now() - interval '6 months' AND read = true;
```

---

## 9. Verification checklist

```sql
SHOW listen_addresses;          -- localhost
SHOW password_encryption;       -- scram-sha-256
SHOW max_connections;           -- comfortably above the pool
SHOW ssl;                       -- off is fine for loopback
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = current_user;
SELECT type, database, user_name, address, auth_method FROM pg_hba_file_rules;
SELECT grantee, privilege_type FROM information_schema.role_table_grants
  WHERE table_name = 'audit_logs';
```

```bat
netstat -ano | findstr ":5432"
netsh advfirewall firewall show rule name=all | findstr /I "5432"
```
