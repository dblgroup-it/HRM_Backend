# Applying the nginx configuration — Windows Server

The live config at `C:\nginx\conf\nginx.conf` is **not** version-controlled.
`HRM_Backend/deploy/nginx.conf.example` is the reviewed copy. This page is the
exact sequence to bring the live file in line with it.

**Nothing in this repository changes the running server.** Until an operator
works through this, the live site has no CSP, no HSTS, and a 1 MB upload
ceiling that silently rejects every CV over that size.

Run everything from an **Administrator** PowerShell or Command Prompt.

---

## 0. Why this matters (read once)

Two of the four go-live blockers live in this file:

| | Symptom if skipped |
| --- | --- |
| `client_max_body_size 20m` | Every upload above **1 MB** fails with a 413 produced by nginx. The request never reaches the application, so nothing appears in `logs/error.log` and the user sees a generic failure. The API itself accepts up to 15 MB. |
| Security headers | No CSP, no HSTS, no `nosniff`, no frame protection. The session JWT is held in `localStorage`, so a single injected script can take a session. |

---

## 1. Back up the current config

```bat
copy C:\nginx\conf\nginx.conf C:\nginx\conf\nginx.conf.bak-%DATE:~-4%%DATE:~4,2%%DATE:~7,2%
dir C:\nginx\conf\nginx.conf.bak-*
```

Confirm the backup exists before going further. This file is your rollback.

---

## 2. Compare the live file with the reviewed one

```bat
fc C:\nginx\conf\nginx.conf C:\apps\DBL-HRM\HRM_Backend\deploy\nginx.conf.example
```

Expect differences in paths (certificate locations, the `dist` root) — those are
environment-specific and the live values are correct. What you are looking for
is whether the live file is **missing** any of the blocks in section 3.

> If `fc` shows the live file is missing the `location /socket.io/` block,
> stop and add it: without it realtime notifications silently never connect.

---

## 3. What must be present

Copy these into the live file, keeping its own paths. Each is quoted from
`deploy/nginx.conf.example`.

### 3a. In the `http { }` block, before any `server`

```nginx
server_tokens off;

client_max_body_size 20m;
client_body_timeout 60s;
```

### 3b. Inside the `server { listen 443 ssl; }` block

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;

add_header Strict-Transport-Security "max-age=604800" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
add_header X-Frame-Options "DENY" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
```

**About HSTS.** `max-age=604800` is one week, deliberately short. Browsers cache
it and you cannot take it back quickly, so if anything about HTTPS is not yet
solid for every hostname on this certificate, a mistake is survivable. Once the
site has run for a week with no TLS problems, raise it to `max-age=31536000`.

**About `style-src 'unsafe-inline'`.** It is required, and it is safe. The offer
and appointment letters and every print view are inline-styled HTML because
they are also **emailed**, where linked stylesheets do not survive. Inline
styles cannot execute script; `script-src` carries no `'unsafe-inline'` and no
`'unsafe-eval'`, and that is the directive that actually stops injected script.

### 3c. Cache policy — add after the SPA fallback

```nginx
location = /index.html {
    add_header Cache-Control "no-store, must-revalidate" always;
    try_files $uri =404;
}

location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
}
```

`deploy.sh` swaps `dist/` atomically and the new `index.html` names new
content-hashed assets. A cached `index.html` asks for files that no longer
exist — and because the SPA fallback answers any unmatched path with
`index.html`, the browser gets HTML where it expected JavaScript, with a 200
status. The symptom is a white screen and no server-side error.

---

## 4. Test before reloading

```bat
C:\nginx\nginx.exe -t
```

Expected:

```
nginx: the configuration file C:\nginx/conf/nginx.conf syntax is ok
nginx: configuration file C:\nginx/conf/nginx.conf test is successful
```

**If this fails, do not reload.** Fix the file, or restore the backup from
step 1. A reload with a broken config takes the site down.

---

## 5. Reload (no downtime)

```bat
C:\nginx\nginx.exe -s reload
```

A reload starts new workers with the new config and retires the old ones as
they finish; open connections are not dropped.

---

## 6. Verify from another machine

```bash
curl -sSI https://talenthub.dbl-group.com | findstr /I "strict-transport content-security x-content-type referrer permissions x-frame server"
```

All six headers must be present. Then check the two behavioural fixes:

```bash
# index.html must not be cacheable
curl -sSI https://talenthub.dbl-group.com/ | findstr /I "cache-control"
#   expect: Cache-Control: no-store, must-revalidate

# a missing asset must 404, not return HTML with a 200
curl -sSo NUL -w "%{http_code} %{content_type}\n" https://talenthub.dbl-group.com/assets/does-not-exist.js
#   expect: 404 ...   (NOT "200 text/html")
```

**Upload test — this is the one that is easy to skip and the one most likely to
bite.** Sign in and attach a **6 MB PDF** to a requisition. It must succeed. If
it fails with 413, `client_max_body_size` did not take effect.

---

## 7. Rollback

```bat
copy /Y C:\nginx\conf\nginx.conf.bak-YYYYMMDD C:\nginx\conf\nginx.conf
C:\nginx\nginx.exe -t
C:\nginx\nginx.exe -s reload
```

One caveat: **HSTS cannot be rolled back from the server.** Browsers that have
already seen the header will keep forcing HTTPS for `max-age`. That is why the
value starts at one week rather than a year.

---

## 8. Keep the two files in sync

The live config is not in git, and that has already caused one outage — a
missing `/socket.io/` block meant realtime silently never connected for anyone,
with no error anywhere. After any change to either file, reconcile them:

```bat
copy C:\nginx\conf\nginx.conf C:\apps\DBL-HRM\HRM_Backend\deploy\nginx.conf.example
```

then edit out any secret paths and commit.
