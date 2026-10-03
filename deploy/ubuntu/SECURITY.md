# Security — the DBL HRM server

What protects the server, the one script that applies the server-side
hardening, and the two steps that must be done by hand.

## Already in place

- **Everything that holds data needs a sign-in.** The only public pages are
  the careers page, applying, and emailed links — those carry long secret
  tokens that expire.
- **Password guessing:** 5 wrong passwords lock that account for 15 minutes;
  every address is rate-limited on sign-in and password reset.
- **Firewall (ufw):** only SSH, the website (80/443) and the dev site (4500)
  are open. The database answers this machine only.
- **SSH guessing** is banned by fail2ban (5 failures → 10 minutes).
- **Security updates** install themselves (unattended-upgrades).
- **HTTPS** everywhere, with strict browser security headers.

## 1. Apply the hardening (one script, as root)

```bash
sudo bash /home/dbl-hrm/dev/HRM_Backend/deploy/ubuntu/harden-server.sh
```

It:

- makes nginx **drop attack paths** on the live and dev sites — anything
  `.php`, `.env`, `.git`, `wp-admin`, `phpmyadmin` and the like
  (`dbl-hrm-block-probes.conf`). None of them exist in this app, so nothing
  real is affected; the request never reaches the app or its API log;
- makes fail2ban **ban an address that sends 3 of them within 10 minutes for
  a day**, and an address banned 3 times in a day from every port for a week;
- prints a **report** — green ✔ for what is right, yellow ! for what is left.

Every change is tested first. If nginx or fail2ban rejects it, the previous
files go back and the script stops — the sites keep running as they were.
Safe to run again.

Useful afterwards:

```bash
sudo fail2ban-client status dbl-hrm-probe              # who is banned now
sudo fail2ban-client set dbl-hrm-probe unbanip 1.2.3.4  # lift a ban
```

Internal addresses (10.x, 172.16–31.x, 192.168.x) are never banned. If the
report says *"every recent visitor address is internal"*, the company firewall
hides who is really calling: nginx still drops the attacks, but bans cannot
single anyone out — ask the network team whether the firewall can pass the
real address (or block scanners itself).

## 2. SSH: keys instead of passwords (by hand — carefully)

A password can be guessed; a key cannot. **Done wrong, this locks you out of
the server**, so: do it in office hours, keep your current SSH window open
the whole time, and test from a *second* window before closing the first.

**On your PC** (Windows: open *PowerShell*):

```powershell
ssh-keygen -t ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub
```

Press Enter at the questions (a passphrase is optional but better). Copy the
one line it prints, starting `ssh-ed25519`.

**On the server, as root** — paste your line in place of `PASTE_KEY_HERE`:

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo 'PASTE_KEY_HERE' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

**Test it:** open a *new* PowerShell window and run
`ssh root@192.168.22.207`. It must let you in **without asking for the server
password** (it may ask for your key's passphrase). If it asks for the server
password, stop here — the key is not working; nothing has been switched off yet.

**Only when the test works**, switch passwords off:

```bash
# 00- so it is read first: for SSH the first setting wins, and Ubuntu may ship
# a 50-cloud-init.conf that turns passwords back on.
cat > /etc/ssh/sshd_config.d/00-dbl-hrm.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && { systemctl reload ssh 2>/dev/null || systemctl restart ssh; }
sshd -T | grep -E '^(passwordauthentication|permitrootlogin) '   # expect: no / prohibit-password
```

(Restarting SSH does not drop the window you are typing in.)

Test once more from a new window, then close the old one. Anyone else who
needs SSH sends you their `.pub` line and you add it the same way. Keep the
server's console access (the VM host) as the way back if a key is ever lost.

## 3. Two-factor sign-in for the admin account (in the app)

`admin@dbl-group.com` can delete requisitions and deploy to the live site, so
it is the account most worth protecting.

1. Sign in as `admin@dbl-group.com` → **Settings → Security → Set up
   two-factor**.
2. Choose **Authenticator app** (Google Authenticator, Microsoft
   Authenticator, Authy) and scan the QR code.
3. **The admin login is shared:** everyone who uses it must scan the **same QR
   code** into their own phone *during this setup* — afterwards it cannot be
   shown again (it would have to be turned off and set up anew). Gather them
   first.
4. Enter a code to confirm.

From then on, signing in asks for the password and a 6-digit code from the
phone. Do the same for every super user.

## Reading the API Logs

Configuration → API Logs shows the attempts that still reach the app. After
step 1, the PHP / `.env` / `wp-admin` probes no longer appear there — nginx
drops them first. A few odd 404s a day (`/api/mcp`, `/api/version`) are
harmless scanners asking what the software is; nothing answers them.
