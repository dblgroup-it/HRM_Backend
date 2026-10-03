#!/usr/bin/env bash
#
# Security hardening for the DBL HRM server, and a report of what is left.
# Run as root (safe to run again — anything already in place is left alone):
#
#   sudo bash /home/dbl-hrm/dev/HRM_Backend/deploy/ubuntu/harden-server.sh
#
#   1. nginx drops attack paths (.php, .env, .git, wp-admin …) on the live and
#      dev sites before they reach the app — dbl-hrm-block-probes.conf
#   2. fail2ban bans an address that sends 3 of them in 10 minutes for a day,
#      and repeat offenders from every port for a week
#   3. prints a report: SSH, database exposure, firewall, updates, bans
#
# Nothing here touches SSH or the firewall rules: changing SSH from a script
# can lock you out. The report says what to do there, by hand
# (deploy/ubuntu/SECURITY.md).
#
# Every nginx/fail2ban change is tested before it is applied; a failing test
# puts the previous files back and stops, so the sites keep running as they were.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/hrm-hardening-backup-$STAMP"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
good() { printf '    \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31mhardening stopped:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run as root: sudo bash $0"
mkdir -p "$BACKUP"

# ── 1. nginx: drop attack paths ─────────────────────────────────────────────
say "nginx — dropping attack paths"
[ -f /etc/nginx/snippets/dbl-hrm-block-probes.conf ] && cp -a /etc/nginx/snippets/dbl-hrm-block-probes.conf "$BACKUP/"
install -m 644 "$HERE/dbl-hrm-block-probes.conf" /etc/nginx/snippets/dbl-hrm-block-probes.conf

changed=()
for site in /etc/nginx/sites-available/dbl-hrm /etc/nginx/sites-available/dbl-hrm-dev; do
  [ -f "$site" ] || continue
  if grep -q "dbl-hrm-block-probes.conf" "$site"; then
    note "$(basename "$site"): already included"
    continue
  fi
  cp -a "$site" "$BACKUP/"
  # Before the server-level `root` line of each HTTPS server block.
  awk '/^    root / { print "    include snippets/dbl-hrm-block-probes.conf;\n" } { print }' \
    "$BACKUP/$(basename "$site")" > "$site"
  changed+=("$site")
done

if ! nginx -t 2>/tmp/hrm-nginx-test.txt; then
  cat /tmp/hrm-nginx-test.txt
  for f in "$BACKUP"/*; do
    case "$(basename "$f")" in
      dbl-hrm|dbl-hrm-dev) cp -a "$f" /etc/nginx/sites-available/ ;;
      dbl-hrm-block-probes.conf) cp -a "$f" /etc/nginx/snippets/ ;;
    esac
  done
  [ -f "$BACKUP/dbl-hrm-block-probes.conf" ] || rm -f /etc/nginx/snippets/dbl-hrm-block-probes.conf
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  die "nginx rejected the change — the previous config was put back; the sites are unchanged."
fi
systemctl reload nginx
for s in "${changed[@]}"; do good "$(basename "$s"): attack paths now dropped"; done
good "nginx reloaded"

# Prove it on the live site from here: an attack path is dropped, the app answers.
probe="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/.env -H 'Host: talenthub.dbl-group.com' || true)"
app="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/api/v1/health -H 'Host: talenthub.dbl-group.com' || true)"
[ "$probe" = "000" ] && good "/.env is dropped" || warn "/.env answered $probe (expected no answer)"
[ "$app" = "200" ] && good "the live API still answers (200)" || warn "the live API answered $app — check the site now"

# ── 2. fail2ban: ban whoever keeps probing ──────────────────────────────────
say "fail2ban — banning repeat probers"
command -v fail2ban-client >/dev/null || { apt-get install -y fail2ban >/dev/null; }
for f in /etc/fail2ban/filter.d/dbl-hrm-probe.conf /etc/fail2ban/jail.d/dbl-hrm.local; do
  [ -f "$f" ] && cp -a "$f" "$BACKUP/"
done
install -m 644 "$HERE/fail2ban/dbl-hrm-probe.filter.conf" /etc/fail2ban/filter.d/dbl-hrm-probe.conf
install -m 644 "$HERE/fail2ban/dbl-hrm.jail.conf" /etc/fail2ban/jail.d/dbl-hrm.local
[ -f /var/log/nginx/access.log ] || warn "no /var/log/nginx/access.log — the probe jail will wait for it"

if ! fail2ban-client -t >/tmp/hrm-f2b-test.txt 2>&1; then
  cat /tmp/hrm-f2b-test.txt
  rm -f /etc/fail2ban/filter.d/dbl-hrm-probe.conf /etc/fail2ban/jail.d/dbl-hrm.local
  for f in "$BACKUP"/dbl-hrm-probe.conf "$BACKUP"/dbl-hrm.local; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
      dbl-hrm-probe.conf) cp -a "$f" /etc/fail2ban/filter.d/ ;;
      dbl-hrm.local) cp -a "$f" /etc/fail2ban/jail.d/ ;;
    esac
  done
  die "fail2ban rejected the new jails — removed them; fail2ban runs as before."
fi
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
sleep 2
for j in sshd dbl-hrm-probe recidive; do
  if fail2ban-client status "$j" >/dev/null 2>&1; then
    good "jail $j active ($(fail2ban-client status "$j" | awk -F: '/Currently banned/ {gsub(/ /,"",$2); print $2}') banned now)"
  else
    warn "jail $j is not running — journalctl -u fail2ban -n 30"
  fi
done

# ── 3. Report ───────────────────────────────────────────────────────────────
say "Report"

# Can fail2ban see who is attacking? Only if visitors' real addresses reach
# nginx — behind a NAT firewall every request may come from one inside address.
if [ -f /var/log/nginx/access.log ]; then
  total="$(tail -n 5000 /var/log/nginx/access.log | awk '{print $1}' | sort -u | wc -l)"
  public="$(tail -n 5000 /var/log/nginx/access.log | awk '{print $1}' | sort -u \
    | grep -vcE '^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|f[cd])' || true)"
  if [ "$public" -gt 0 ]; then
    good "visitors' real addresses reach the server ($public public of $total recent) — bans work"
  else
    warn "every recent visitor address is internal ($total seen) — the company firewall hides who"
    note "  is calling, so bans cannot single anyone out. The nginx blocking still works; ask the"
    note "  network team whether the firewall can pass the real address or block scanners itself."
  fi
fi

# SSH — reported, never changed here.
sshd_t="$(sshd -T 2>/dev/null || true)"
rootlogin="$(awk '/^permitrootlogin / {print $2}' <<<"$sshd_t")"
passauth="$(awk '/^passwordauthentication / {print $2}' <<<"$sshd_t")"
keys=0; for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do [ -s "$f" ] && keys=$((keys + $(grep -c . "$f"))); done
[ "$passauth" = "no" ] && good "SSH: password sign-in is off" \
  || warn "SSH: password sign-in is ON — move to keys (SECURITY.md, step 2)"
case "$rootlogin" in
  no|prohibit-password|without-password) good "SSH: root cannot sign in with a password ($rootlogin)" ;;
  *) warn "SSH: root may sign in with a password ($rootlogin) — SECURITY.md, step 2" ;;
esac
note "SSH keys on this server: $keys"

# The database must not be reachable from the network.
pg_listen="$(ss -ltnH 'sport = :5432' | awk '{print $4}' | tr '\n' ' ')"
if grep -qvE '^(127\.0\.0\.1|\[::1\]):5432' <<<"$(tr ' ' '\n' <<<"$pg_listen" | grep .)"; then
  warn "PostgreSQL listens beyond this machine: $pg_listen"
else
  good "PostgreSQL listens on this machine only ($pg_listen)"
fi

# Firewall and updates.
ufw status | grep -q "Status: active" && good "firewall (ufw) is on" || warn "firewall (ufw) is OFF"
note "open ports: $(ufw status | awk '/ALLOW/ && !/\(v6\)/ {print $1}' | sort -u | tr '\n' ' ')"
systemctl is-enabled unattended-upgrades >/dev/null 2>&1 && good "security updates install themselves" \
  || warn "automatic security updates are off — apt install unattended-upgrades"
[ -f /var/run/reboot-required ] && warn "an update is waiting for a reboot (do it out of hours)" || good "no reboot pending"

say "Done"
note "Backups of anything changed: $BACKUP"
note "See bans:      fail2ban-client status dbl-hrm-probe"
note "Lift a ban:    fail2ban-client set dbl-hrm-probe unbanip <address>"
