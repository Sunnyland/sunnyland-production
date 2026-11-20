Sunnyland Production on the PrintCRM server

Prepared 18 November 2026. Paul verified Debian 13.3 (trixie), x86_64, system Node 20.19.2, Python 3.13.5 and no listener on port 5180. The installer is ready; it has not yet been run on that server.

The intended arrangement is iPhone/Mac HTTPS requests to the existing HAProxy, followed by a direct private connection to the Sunnyland Production service on PrintCRM. The existing PrintCRM website stays on port 3000. Sunnyland Production uses port 5180 if the server inspection confirms it is free. The Windows SSH tunnel is retired only after the new service works.

| Component | Intended setting |
| --- | --- |
| Public app base | https://printcrm.sunnyland.com.au/sunnyland-production |
| HAProxy server | deb-proxy-a, managed at 192.168.0.20 |
| App server | PrintCRM, 192.168.0.35 |
| Code | /opt/sunnyland-production/app |
| Dedicated runtime | /opt/sunnyland-production/node/bin/node, Node 24.22.3 |
| State | /var/lib/sunnyland-production |
| Service identity | sunnyland-production |
| Process manager | A separate systemd service |

Node 24.22.3 is available from the official Node.js downloads and is the version used for the Windows pilot tests. The installer downloads the Linux x64 archive over HTTPS and checks both the official checksum file and the checksum pinned from the release page. It does not replace system Node or change existing PM2 processes. The source package has no npm dependencies.

**Server inspection (completed by Paul)**

From a local Mac Terminal, use the existing administrator connection:

```bash
ssh slp@192.168.0.35
```

Then run these read-only checks:

```bash
hostname
cat /etc/os-release
uname -m
command -v node
node --version
python3 --version
systemctl --version | head -n 1
ss -lnt '( sport = :5180 )'
df -h /opt /var/lib
```

This assistant session cannot open SSH to 192.168.0.35:22; its connection is denied before authentication. These checks must come from the user's existing SSH session. Do not send passwords or private keys.

**Copy and install**

Pause app use for the cutover. If the old Windows SSH tunnel is still connected, close it with Ctrl+C. Keep the existing Windows database as the rollback source. Do not enter stock in two separate copies of the app.

First, in the Mac's SSH session on PrintCRM as `slp`, confirm administrator access and prepare a private transfer directory:

```bash
sudo -v
install -d -m 700 "$HOME/sunnyland-transfer"
```

Use the `slp` password when sudo requests it. If sudo reports that this account is not permitted, stop and report that message; do not change passwords or account permissions.

Then on the Windows PC, open PowerShell and run:

```powershell
Set-Location -LiteralPath 'C:\Users\Paul\Documents\Codex\2026-11-17\new-chat'
scp -r '.\outputs\stock\Sunnyland_Production_Pilot_0.1.zip' '.\work\private-migration\Sunnyland-PrintCRM-State' slp@192.168.0.35:~/sunnyland-transfer/
```

Enter the existing `slp` SSH password privately if requested. The database snapshot is transferred directly to the private directory on your server; it is not in the downloadable code package. If SSH reports a new host key, verify it against your trusted Mac connection. If the copy fails, stop and report the error before installation.

Back in the `slp` SSH session on PrintCRM, run:

```bash
python3 -m zipfile -e "$HOME/sunnyland-transfer/Sunnyland_Production_Pilot_0.1.zip" "$HOME/sunnyland-transfer/install"
sudo python3 "$HOME/sunnyland-transfer/install/SunnylandProduction/deploy/install_printcrm.py" --snapshot "$HOME/sunnyland-transfer/Sunnyland-PrintCRM-State"
```

The installer refuses to overwrite an existing Sunnyland service, account or state directory. It checks source and snapshot integrity, downloads a dedicated runtime, runs the 23 Node tests, creates a restricted service account, copies the existing state, validates the unit and starts only this service. It checks health and rejection of unauthenticated data requests, restarts once, compares all account/ledger tables with the snapshot, then enables startup. It does not install a worker or timer, change HAProxy, edit printIQ or send messages.

The final JSON must show `"health": "ok"`, `"accountAndLedgerVerified": true`, `"restartVerified": true` and `"enabledAtBoot": true`. If it stops, keep the output and state files; do not reset the account or delete the database to retry. The full Linux installation is verified by these checks on the server, not by the Windows preparation tests.

After success, verify directly on PrintCRM:

```bash
curl --fail --show-error --max-time 10 http://192.168.0.35:5180/health
systemctl is-active sunnyland-production
```

**Preserve the existing account and state**

The source database is `work/production/data/production.sqlite` on Paul's Windows PC. It was checked during preparation: integrity passed, 1,862 catalogue stock identities, one staff account, zero sessions, zero queued messages, and no recorded stock lots, jobs or media. Those counts are a point-in-time observation, not a substitute for a fresh cutover check.

`backup_state.py` uses SQLite's online backup API. It preserves the database, checks its integrity, copies referenced immutable media and verifies their recorded hashes. It refuses to overwrite an existing destination. It does not change the source database, reset passwords, send messages or activate a worker.

A private preparation snapshot is useful as a checkpoint. For actual cutover, pause writes to the old service and make a fresh snapshot; transfer it directly to PrintCRM over SSH/SFTP. Never publish that snapshot or include it in the source ZIP: it contains password hashes. Do not copy only the live `.sqlite` file while WAL writes may be pending. The snapshot is a complete SQLite database and does not require the old WAL or SHM files.

Install the snapshot as `/var/lib/sunnyland-production/production.sqlite`, with its `media` directory alongside it. The service user must own the state directory, with directory mode 0700 and file mode 0600. Do not run `setup.mjs` or create another Paul account over the migrated database.

**Independent service configuration**

The supplied `sunnyland-production.service` binds to `192.168.0.35:5180`. It requires an existing non-empty state database and has write access only to its own state directory and private temporary directory. It has no mail worker or timer.

The installer configures `SUNNYLAND_ALLOWED_PEERS=127.0.0.1,::1,192.168.0.35,192.168.0.20,192.168.0.50`. This accepts HAProxy and local checks and rejects other actual TCP peers before authentication, including requests with forged forwarding headers. Staff still need to sign in through the HTTPS proxy. Invalid or empty configured peer lists fail startup.

The installer does not edit the host firewall. If a firewall blocks the proxy's direct health check, inspect its current rules and permit TCP 5180 only from HAProxy's verified address (192.168.0.20 or 192.168.0.50). Do not expose this HTTP port publicly or replace existing firewall rules.

**Switch the existing HAProxy backend**

After the new service passes direct health checks from HAProxy, replace only the existing Sunnyland backend's tunnel server line:

First run this in the `slp@deb-proxy-a` session:

```bash
curl --fail --show-error --max-time 10 http://192.168.0.35:5180/health
```

After that returns `{"ok":true,"version":"0.1.0"}`, change the following server line in `backend sunnyland_production`:

```haproxy
server sunnyland_pilot 127.0.0.1:15180 check inter 5s fall 3 rise 2
```

with:

```haproxy
server sunnyland_app 192.168.0.35:5180 check inter 5s fall 3 rise 2
```

The frontend path route, prefix removal and existing HTTPS hostname stay in place. Back up the current configuration, inspect the diff, validate using `haproxy -c`, and reload only after validation succeeds. Do not change the other website backends.

```bash
slp_backend_backup="/etc/haproxy/haproxy.cfg.before-printcrm-backend.$(date +%Y%m%d-%H%M%S)"
sudo cp -p /etc/haproxy/haproxy.cfg "$slp_backend_backup"
sudo nano /etc/haproxy/haproxy.cfg
sudo haproxy -c -f /etc/haproxy/haproxy.cfg && sudo systemctl reload haproxy
```

Test the HTTPS health URL again from the Mac and iPhone. The existing password for `paul@sunnyland.com.au` is retained. The app base address is `https://printcrm.sunnyland.com.au/sunnyland-production`, with no trailing slash.

**Resolve the iPhone 403 separately**

Moving the service removes the tunnel dependency and addresses that source of 503 errors. It does not by itself change the HAProxy rules that rejected the iPhone.

The iPhone has address 192.168.0.114 and DNS 192.168.0.1. Meraki firmware is MX 18.107.13, below the version required for Meraki's built-in local DNS records. Identify the source and destination addresses HAProxy sees for the phone's request before changing any access restriction. Use an internal DNS solution or a narrowly verified LAN route; do not remove both deny rules and silently make the pilot Internet-accessible. Offsite access remains an explicit deployment decision.

If the iPhone still gets 403, refresh its health URL once, then collect just the relevant recent access-log entries on HAProxy:

```bash
sudo tail -n 500 /var/log/haproxy.log | grep -F '/sunnyland-production/' | tail -n 10
```

If that log file is absent, use:

```bash
sudo journalctl -t haproxy --since '10 minutes ago' --grep='/sunnyland-production/' --no-pager -n 10
```

An empty result means the access-log destination or format needs checking. It is not evidence that the phone's request was allowed. Do not relax the access rules merely because the new backend is healthy.

**Validate before retiring the PC connection**

- Verify the new database integrity and the existing manager account without exposing its password hash.
- Verify health from PrintCRM, from HAProxy and over HTTPS from the actual iPhone.
- Sign in as Paul using the existing password; confirm the catalogue loads.
- Confirm unauthenticated stock and media requests remain rejected.
- Check the original PrintCRM and other existing sites still work.
- Restart the Sunnyland service once and verify health and account persistence.
- Only then close the Windows tunnel and retire the old writable instance.

If any new stock or job activity is entered after cutover, reconcile it before any rollback. Do not switch back to an older database and silently lose those changes. Retain the original private snapshot and deployment backup.

Sources: [Node.js downloads](https://nodejs.org/en/download), [SQLite backup API](https://sqlite.org/backup.html), [systemd service isolation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec).
