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
| `client_max_body_size 20m` | nginx's default is 1 MB, and above it nginx returns a 413 the application never sees and never logs. **Check before assuming it is missing** — on the DBL server it was already set (2026-08-12), and a 2 MB POST returned 500 identically through nginx and direct to the API, which means the failure was in the application, not the proxy. Diagnose the live config, do not infer it from this file. |
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

> **Read this before you paste.** `add_header` does **not** accumulate across
> levels. A `location` that declares *any* `add_header` inherits **none** from
> the enclosing `server` block. An earlier version of this runbook put the
> two cache blocks below in without accounting for that, and the result was
> that `/`, `/index.html` and every file under `/assets/` came back with
> **zero** security headers — worse than before it was applied, because the
> root had previously had two. Verifying on a proxied path such as
> `/api/health` shows all six and hides the problem completely: `/api/` has no
> `add_header` of its own, so it still inherits.
>
> The fix is to define the header set **once** in its own file and `include`
> it everywhere an `add_header` appears.

Put the six headers from 3b into `C:\nginx\conf\hrm-security-headers.conf`:

```nginx
# Included anywhere an add_header appears, because declaring one add_header in
# a location drops every inherited one. Defined once so the three copies
# cannot drift apart.
add_header X-Frame-Options            "DENY"                             always;
add_header X-Content-Type-Options     "nosniff"                          always;
add_header Referrer-Policy            "strict-origin-when-cross-origin"  always;
add_header X-XSS-Protection           "0"                                always;
add_header Strict-Transport-Security  "max-age=604800"                   always;
add_header Content-Security-Policy    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
```

Then reference it in the `server` block **and** in both cache locations:

```nginx
server {
    # ...
    include hrm-security-headers.conf;

    location = /index.html {
        include hrm-security-headers.conf;
        add_header Cache-Control "no-store, must-revalidate" always;
        try_files $uri =404;
    }

    location /assets/ {
        include hrm-security-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }
}
```

Verify on a **static** path, not only a proxied one:

```bash
curl -kI https://localhost/ | grep -ci "^x-frame-options\|^content-security-policy"
curl -kI https://localhost/index.html
curl -kI https://localhost/assets/index-*.js
```

All three must show the full set. If `/api/health` shows six and `/` shows
none, this is the bug.

`deploy.sh` swaps `dist/` atomically and the new `index.html` names new
content-hashed assets. A cached `index.html` asks for files that no longer
exist — and because the SPA fallback answers any unmatched path with
`index.html`, the browser gets HTML where it expected JavaScript, with a 200
status. The symptom is a white screen and no server-side error.

### 3d. Duplicate headers on `/api/` — a decision, not a defect

The API sets its own security headers with helmet, and nginx now adds six more
to every response including proxied ones. Three of them disagree:

| Header | helmet (from the API) | nginx |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | `max-age=604800` |
| `X-Frame-Options` | `SAMEORIGIN` | `DENY` |
| `Referrer-Policy` | `no-referrer` | `strict-origin-when-cross-origin` |

Per RFC 6797 §8.1 a user agent processes the **first** `Strict-Transport-Security`
field and ignores the rest, so helmet's one year with `includeSubDomains` wins
over the one week this runbook chose deliberately "so a mistake is survivable".
HSTS is per **host**, not per path — one request to `/api/*` pins the whole
hostname — and it cannot be withdrawn from the server side once sent.

**What makes this less urgent than it looks:** browsers do not apply HSTS to IP
addresses (RFC 6797 §2.3 — it is defined over domain names). This server's
`server_name` is currently `175.29.126.125 192.168.22.168 localhost`, so for
anyone reaching the system by IP the header is inert today and no pinning has
actually happened.

**What makes it urgent later:** the moment a real hostname is pointed at this
server, `includeSubDomains` starts forcing HTTPS on **every** `*.dbl-group.com`
host, including ones nobody here controls. Any DBL subdomain still served over
plain HTTP becomes unreachable in browsers that have seen the header, for up to
a year, with no server-side undo.

**Decide before attaching a domain name.** Recommended: make nginx the single
source for these three and stop helmet sending them, so there is one place to
change and no duplicates anywhere —

```ts
helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
  hsts: false,            // nginx owns HSTS at the edge
  frameguard: false,      // nginx sends DENY
  referrerPolicy: false,  // nginx sends strict-origin-when-cross-origin
})
```

and drop `includeSubDomains` until somebody confirms every `*.dbl-group.com`
host is HTTPS-only. The trade-off is that a request reaching the API directly on
port 4000, bypassing nginx, would carry no security headers — acceptable only
while nginx is the sole public entry point, which it should be regardless.

This is a security-policy decision for whoever owns the DBL domain, so nothing
here has been changed in code.

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
