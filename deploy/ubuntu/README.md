# DBL HRM on Ubuntu 24.04 — first install

The Linux production server. Two parts: `setup-server.sh` installs the software
(once, as root), then the app is cloned and deployed with the same `deploy.sh`
as always (as the `dbl-hrm` user).

| Piece | Where |
| --- | --- |
| App user | `dbl-hrm` — system account, no password, reached only via `sudo -iu dbl-hrm` |
| App folder | `/home/dbl-hrm` (0750, the user's home) — nothing else on the box can read it |
| Backend / frontend | `/home/dbl-hrm/HRM_Backend`, `/home/dbl-hrm/HRM_Frontend` |
| Pre-migration dumps | `/home/dbl-hrm/backups` (0700, `BACKUP_DIR` set in the user's `.profile`) |
| Built SPA (web root) | `/var/www/dbl-hrm` |
| Database | PostgreSQL 18, database `dbl_hrm`, role `dbl_hrm`, localhost only (data in `/var`) |
| nginx site | `/etc/nginx/sites-available/dbl-hrm` (+ `snippets/dbl-hrm-security-headers.conf`) |
| TLS certificate | `/etc/nginx/ssl/talenthub.dbl-group.com.{crt,key}` |
| API process | `pm2-dbl-hrm.service` → PM2 app `hrm-backend` on `127.0.0.1:4000` |

CVs, letters and joining documents live on Google Drive; the server holds the
database and the two `.env` files, nothing else.

## The machine

Checked 2026-09-29 (`nproc`, `free -h`, `lscpu`):

| | |
| --- | --- |
| Host | `hrms` — 192.168.22.207, talenthub.dbl-group.com, Ubuntu 24.04 |
| CPU | 4 cores, Intel Xeon Silver 4410Y |
| RAM | 5.7 GB (≈1 GB used at idle, 4.7 GB available) |
| Swap | 6 GB |
| Disk | LVM `VG0`: `/` is 20 GB and nearly empty; the app, backups and database live on `home-lv` and `var-lv` (see *Before you start*) |

Where the memory goes:

| Process | Typical | Limit |
| --- | --- | --- |
| `hrm-backend` (Node, one process) | ~215 MB idle, 300–450 MB busy | heap 1 GB, PM2 restarts it at 1.5 GB |
| PostgreSQL | 0.5–1.5 GB | its own config |
| Chromium, per PDF letter being rendered | ~150 MB, only while rendering | — |
| `pm2-logrotate`, nginx, the OS | ~0.5 GB | — |

### PM2 memory settings

In `ecosystem.config.js`, sized for this machine (commit `dd9973c`):

- `node_args: '--max-old-space-size=1024'` — the V8 heap cap. The real ceiling:
  past it Node dies with *JavaScript heap out of memory*.
- `max_memory_restart: '1500M'` — PM2's safety net. Deliberately above the heap
  cap, so a slow leak ends in a clean PM2 restart rather than a crash.

Together they keep the API under ~1.5 GB and leave ~3 GB for PostgreSQL,
Chromium and the OS. On a bigger box, scale both (8 GB RAM → `1536` / `2G`).

**Changing `node_args` needs the process recreated.** `deploy.sh` does a PM2
*reload*, which does not pick up new `node_args` (it does pick up
`max_memory_restart`). After deploying such a change, once, out of hours
(≈5 s of downtime):

```bash
pm2 delete hrm-backend && pm2 start ecosystem.config.js && pm2 save
ps -o args= -p $(pm2 pid hrm-backend)                 # must show --max-old-space-size=1024
pm2 describe hrm-backend | grep "max memory restart"  # 1572864000 = 1500 MB
```

`pm2 save` matters: `pm2-dbl-hrm.service` restores the saved list after a
reboot, so skipping it brings back the old settings.

Do **not** raise `instances` or switch to cluster mode — Socket.IO broadcasts
only reach clients on the same process (see the comment in
`ecosystem.config.js`).

## Before you start

- **Disk.** `/var` (PostgreSQL) and `/home` (the app and its backups) must be
  grown from the installer's 5 GB / 10 GB:
  `lvextend -r -L 60G /dev/VG0/var-lv`, the same for `home-lv`.
- **DNS.** `ping -c3 google.com` must work. The script stops if it cannot
  resolve its sources.

## 1. Software (root)

From a machine with the backend checkout:

```bash
scp -r HRM_Backend/deploy/ubuntu root@192.168.22.207:/root/dbl-hrm-setup
```

On the server:

```bash
bash /root/dbl-hrm-setup/setup-server.sh
```

It writes the new database password to `/root/dbl-hrm-db-credentials`.

## 2. Code (dbl-hrm)

The repos are private. Create a GitHub **fine-grained personal access token**,
read-only *Contents* on `HRM_Backend` and `HRM_Frontend`, then:

```bash
sudo -iu dbl-hrm
git config --global credential.helper store
git clone https://github.com/dblgroup-it/HRM_Backend.git     # user: GitHub name, password: the token
git clone https://github.com/dblgroup-it/HRM_Frontend.git
```

## 3. Environment files (dbl-hrm)

Create `~/HRM_Backend/.env` and `~/HRM_Frontend/.env` (variable reference:
`../PRODUCTION_ENV_CHECKLIST.md`). `DATABASE_URL` is the line in
`/root/dbl-hrm-db-credentials` — delete that file once it is copied. Then:

```bash
dos2unix ~/HRM_Backend/.env ~/HRM_Frontend/.env     # if pasted from Windows
chmod 600 ~/HRM_Backend/.env ~/HRM_Frontend/.env
echo /var/www/dbl-hrm > ~/HRM_Frontend/.deploy-target
```

## 4. First deploy (dbl-hrm)

```bash
cd ~/HRM_Backend && ./deploy.sh
curl -s http://127.0.0.1:4000/api/health
```

Installs, backs up, migrates, builds, starts PM2 and saves the process list,
so `pm2-dbl-hrm.service` brings it back after a reboot. Every later release is
the same `./deploy.sh`.

Do **not** run `npm run db:seed` here — it creates sample units and employees
and resets the admin password to `password123`.

## 5. Certificate and go-live

Until the real certificate is in place nginx serves a 30-day self-signed one.
Put the real pair at `/etc/nginx/ssl/talenthub.dbl-group.com.crt` / `.key`
(server certificate first, then intermediates, in the `.crt`), then
`nginx -t && systemctl reload nginx`.

To test before go-live, point one laptop at the new box —
`192.168.22.207 talenthub.dbl-group.com` in its hosts file — and check sign-in,
realtime notifications, an upload, and one offer-letter PDF.

**Never run the old and new servers at once** — each runs the ZingHR sync, the
Gmail sender and the reminder crons. If ZingHR, BDJobs or the mail relay
whitelist the old server's IP, add the new one first.

## Day to day

```bash
sudo -iu dbl-hrm
pm2 logs hrm-backend        # API log
pm2 status
systemctl status nginx postgresql pm2-dbl-hrm     # as root
pm2 monit                   # live CPU / memory / heap of hrm-backend
df -h /home /var            # the app + backups, and PostgreSQL
free -h
```

**Reading `pm2 monit`.** *Heap Usage* at 85–95% is normal: it is used heap
over the heap Node has reserved *so far*, not over the 1 GB cap, and Node
grows the heap as it needs to. What matters is **Restarts** (the `↺` column
in `pm2 status`). Every `deploy.sh` run and every reload counts as one, so
note the number after a deploy — if it climbs without a deploy, the API is
crashing and PM2 is bringing it back. Find out why:

```bash
pm2 logs hrm-backend --err --lines 50 --nostream
grep -iE "heap out of memory|exceeded|FATAL|Unhandled" ~/HRM_Backend/logs/*.log | tail -30
```

*heap out of memory* or *exceeded memory limit* → memory; anything else →
read the stack trace. The counter was reset to 0 when the process was
recreated on 2026-09-29.

**Backups** land in `/home/dbl-hrm/backups` (`BACKUP_DIR` in `.profile`), one
dump per deploy. They are never pruned — keep an eye on `/home`.

## Capacity and load testing

The target is **500 people signed in and working at once**. Each clicks every
5–10 s, so that is roughly **50–100 requests a second** at the API — not 500
simultaneous requests, which real use does not produce. On this machine that
is within reach; prove it with the k6 script before relying on it.

From a Mac on the LAN, out of office hours, with `pm2 monit` open on the
server:

```bash
brew install k6
cd HRM_Backend
K6_USER=<employee code> K6_PASS=<password> k6 run deploy/ubuntu/load-test.js
```

It ramps to 500 virtual users over ~7 minutes and only reads (GETs).

**Pass:** under 1% failed requests, p95 under 1.5 s, `hrm-backend` below ~90%
CPU, no new restarts.

What the result can hit, in the order it tends to:

1. **429 Too Many Requests** — the global rate limit is 1,200 requests a
   minute *per client IP* (`ThrottlerModule` in `src/app.module.ts`). k6 on one
   machine is one IP, so all 500 virtual users share one allowance. That is
   the protection working, not the server failing; real users each have their
   own. To measure capacity, raise the limit for the test only (and put it
   back), or run k6 from several machines.
2. **`hrm-backend` at ~100% CPU while the box is mostly idle** — the API is one
   Node process and uses one of the four cores. Going past that needs the
   Socket.IO cluster adapter plus sticky sessions, not just more instances.
3. **Memory climbing to the 1.5 GB restart** — a leak or an unusually heavy
   endpoint; see *PM2 memory settings*.
4. **Timeouts waiting for the database** — the Prisma pool is
   `connection_limit=20` in `DATABASE_URL`. Raise to 30–40 (PostgreSQL's
   default `max_connections` is 100).

PDF letters are the heaviest thing the app does (a Chromium each), but they
are rare and one at a time in practice; the load test deliberately leaves
them out.
