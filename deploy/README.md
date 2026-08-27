# Deploy notes

## nginx

The production nginx config lives only at `C:\nginx\conf\nginx.conf` on the
server — it is **not** version-controlled. [`nginx.conf.example`](./nginx.conf.example)
in this folder is a documented copy of the working config; keep it in sync
by hand whenever the live config changes.

**The one thing most likely to silently break here again: `/socket.io/`.**
It was missing entirely at one point, and because the SPA fallback
(`try_files $uri $uri/ /index.html`) matches *any* unmatched path, nginx
served `index.html` back for every WebSocket handshake instead of erroring —
so realtime (`requisition:changed`, `candidate:changed`, notifications)
silently never connected for anyone, with no visible error anywhere except
users reporting that live updates "just don't work."

If you ever touch the nginx config, check both of these are still true:

1. A `location /socket.io/` block exists, separate from the SPA catch-all.
2. It sets `proxy_http_version 1.1` and the `Upgrade`/`Connection` headers.
   Without these, nginx proxies the WebSocket upgrade request as if it were
   a normal HTTP request, and the upgrade just fails.

A quick way to check it's working from anywhere:

```bash
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://talenthub.dbl-group.com/socket.io/?EIO=4&transport=websocket"
```

A `101 Switching Protocols` means nginx is proxying the upgrade correctly.
A `200` with an HTML body means it's hitting the SPA fallback instead — the
`/socket.io/` block is missing, misplaced, or not matching.

## Deploying

See [`scripts/deploy.sh`](../scripts/deploy.sh) — a single script covering
DB backup (with verification — see its header comment for why that matters),
backend build + migrate, and an atomic frontend swap so nginx never serves a
half-built `dist/`. Read the summary and rollback instructions it prints at
the end before considering a deploy finished.
