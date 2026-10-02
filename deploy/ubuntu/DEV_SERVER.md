# The dev server — https://talenthub.dbl-group.com:4500

A second copy of DBL HRM on the same Ubuntu server, for testing before
anything reaches the live site.

| | Live | Dev |
|---|---|---|
| Address | https://talenthub.dbl-group.com | https://talenthub.dbl-group.com:4500 |
| Code | `main` branch, `~/HRM_Backend`, `~/HRM_Frontend` | `dev` branch, `~/dev/HRM_Backend`, `~/dev/HRM_Frontend` |
| PM2 app | `hrm-backend` (port 4000) | `hrm-backend-dev` (port 4600) |
| Database | `dbl_hrm` | a dated copy, `dbl_hrm_dev_YYYYMMDD`, made nightly at 02:45; the last 7 days kept |
| Web root | `/var/www/dbl-hrm` | `/var/www/dbl-hrm-dev` |

**Nothing leaves the dev server.** It runs with `SANDBOX_MODE=true`: emails,
calendar invites, BDJobs posts and the IT webhook are held in the *Sandbox
outbox* (Configuration → Dev tools) instead of being sent; Drive uploads go
to a separate "DEV SANDBOX" folder and live Drive files are never moved,
shared or deleted; the Gmail CV import, ZingHR sync, Drive backup and morning
nudges do not run. It refuses to start on anything but a dated copy, so it
cannot open the live database even if its `.env` is wrong. Its own database
user (`dbl_hrm_dev`) has no rights on the live tables.

Sign-in on the dev site uses the same accounts and passwords as live (it is a
copy). A sign-in or reset code that would be emailed is in the outbox, and in
`pm2 logs hrm-backend-dev`.

---

## One-time setup

### 1. Root steps — from your admin account (not dbl-hrm)

Paste this whole block:

```bash
# A database user for the copies, with a random password handed to dbl-hrm.
DEV_DB_PASS=$(openssl rand -hex 16)
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE dbl_hrm_dev LOGIN CREATEDB PASSWORD '$DEV_DB_PASS';"
echo "$DEV_DB_PASS" | sudo tee /home/dbl-hrm/.dev-db-pass >/dev/null
sudo chown dbl-hrm:dbl-hrm /home/dbl-hrm/.dev-db-pass && sudo chmod 600 /home/dbl-hrm/.dev-db-pass

# Where the dev build is published.
sudo mkdir -p /var/www/dbl-hrm-dev && sudo chown dbl-hrm:dbl-hrm /var/www/dbl-hrm-dev

# Port 4500 through the firewall.
sudo ufw allow 4500/tcp

# The nginx site for :4500 (same certificate as the live site).
sudo sed -e 's#__DOMAIN__#talenthub.dbl-group.com#g' -e 's#__WEB_ROOT__#/var/www/dbl-hrm-dev#g' \
  /home/dbl-hrm/HRM_Backend/deploy/ubuntu/dbl-hrm-dev.nginx.conf | sudo tee /etc/nginx/sites-available/dbl-hrm-dev >/dev/null
sudo ln -sf /etc/nginx/sites-available/dbl-hrm-dev /etc/nginx/sites-enabled/dbl-hrm-dev
sudo nginx -t && sudo systemctl reload nginx
```

Expected: `CREATE ROLE`, `Rule added`, and `nginx: configuration file … test
is successful`. If the role already exists, see *Starting again* below.

If the network has its own firewall in front of the server, port 4500 must be
open there too (ask whoever manages it).

### 2. Everything else — as dbl-hrm

```bash
sudo -iu dbl-hrm
cd ~/HRM_Backend && git pull --ff-only
~/HRM_Backend/deploy/ubuntu/setup-dev-server.sh
```

It clones the `dev` branch, writes both `.env` files, makes the first copy of
the live database, deploys the dev app and adds the nightly copy to the
crontab. It ends with `Done — open https://talenthub.dbl-group.com:4500`.

Check:

```bash
pm2 ls                         # hrm-backend AND hrm-backend-dev, both online
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4600/api/v1/health   # 200
crontab -l | grep dev-clone    # the 02:45 line
```

Open https://talenthub.dbl-group.com:4500 — every page carries a striped
**DEV SERVER** bar naming the day of the copy.

### 3. (Optional) Let "Deploy to Prod" update GitHub

Deploy to Prod works without this — it takes the tested commits straight from
the dev checkouts. With it, GitHub `main` is also moved to what went live.

The server needs **write** access to both repositories. GitHub deploy keys are
one per repository, so make two:

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/hrm_backend_deploy -C "dbl-hrm backend"
ssh-keygen -t ed25519 -N '' -f ~/.ssh/hrm_frontend_deploy -C "dbl-hrm frontend"
cat >> ~/.ssh/config <<'EOF'
Host github-hrm-backend
  HostName github.com
  User git
  IdentityFile ~/.ssh/hrm_backend_deploy
  IdentitiesOnly yes
Host github-hrm-frontend
  HostName github.com
  User git
  IdentityFile ~/.ssh/hrm_frontend_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
cat ~/.ssh/hrm_backend_deploy.pub ~/.ssh/hrm_frontend_deploy.pub
```

On GitHub, for **each** repository: *Settings → Deploy keys → Add deploy key*,
paste its key (backend key on HRM_Backend, frontend key on HRM_Frontend), and
tick **Allow write access**. Then point the live checkouts at them:

```bash
git -C ~/HRM_Backend  remote set-url origin git@github-hrm-backend:dblgroup-it/HRM_Backend.git
git -C ~/HRM_Frontend remote set-url origin git@github-hrm-frontend:dblgroup-it/HRM_Frontend.git
git -C ~/HRM_Backend fetch && git -C ~/HRM_Frontend fetch     # no password prompt = working
```

---

## Day to day

- **Test a change:** it is pushed to the `dev` branch, and the dev site
  updates itself within about two minutes (`dev-autodeploy.sh` in the
  crontab asks GitHub every 2 minutes; Dev tools shows the last update and
  whether it worked). A commit that fails to deploy is not retried until the
  next push; the dev site keeps running the previous version. By hand, any
  time: `cd ~/dev/HRM_Backend && ./deploy.sh`. Test at :4500.
- **Pick the day's data:** Configuration → Dev tools → *Data copy*. "Always
  the newest" follows each night's copy; picking a day pins it. Only the
  last 7 days are kept — when a pinned day passes 7 days old it is removed
  and the dev site goes back to the newest. The dev app restarts in a few
  seconds.
- **Put it live:** Dev tools → *Deploy to production* (the admin@dbl-group.com
  login only). It lists every commit that will go live; type `DEPLOY`. It
  backs up the live database, deploys, checks health — and if anything fails,
  restores the previous release by itself and shows the error log. GitHub
  `main` is updated only after a healthy deploy. If live has a change dev
  does not (a hotfix), it refuses: merge `main` into `dev` first.
- **What happened:** Configuration → API Logs (errors and slow calls, live and
  dev), and `~/dev/promote/logs/` for every deploy from the button.

Copies kept: the last 7 days by date, nothing older (put `KEEP_DAYS=N` in
front of the command in the crontab line to change it). Each is about the size
of the live database — check with `df -h` now and then.

## Starting again

```bash
pm2 delete hrm-backend-dev && pm2 save
rm -rf ~/dev
crontab -l | grep -v dev-clone-db | crontab -
# as admin:
sudo -u postgres psql -c "SELECT 'DROP DATABASE \"' || datname || '\";' FROM pg_database WHERE datname LIKE 'dbl_hrm_dev_%'" -At | sudo -u postgres psql
sudo -u postgres psql -c "DROP ROLE dbl_hrm_dev;"
```
