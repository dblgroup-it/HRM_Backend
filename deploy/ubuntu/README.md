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
```
