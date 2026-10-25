# RemotePower

A small, self-hosted Node.js app for putting a Windows PC to sleep or shutting it down from a browser on the same trusted LAN. No npm packages are required.

## Features

- Responsive handheld-style controls with light/dark toggle.
- Theme follows the system initially; manual selection is saved when browser storage is available.
- Signal bars indicate whether the server responds, not measured Wi-Fi strength.
- Password login, slide-to-confirm, and a 30-second cancellation window.
- Sleep, shutdown, and an additional control to abort a Windows shutdown.
- Windows Task Scheduler startup at boot, with restart-on-failure settings.
- IPv4 mDNS hostname: `remotepower.local`; no DHCP reservation required by the design.
- Scrypt password hashing, session cookies, CSRF checks, request limits and audit logging.

## Requirements

- Windows PC with Node.js 18 or newer. Prefer a currently supported Node.js release.
- Administrator PowerShell for installation.
- Phone or other client on the same trusted local network.
- The Windows home-network profile must be Private. Do not mark an untrusted network Private.

## Install

Clone this repository and open Administrator PowerShell in the project folder.

```powershell
node .\setup-password.js
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Choose a password of 10-256 characters and enter it twice. Input is hidden. If configuration is absent, the installer also invokes password setup. There is no default password.

The installer resolves the actual Node runtime, adds the discovery hostname to the existing configuration without resetting the password, creates a configuration backup, replaces the `RemoteShutdown` task, and creates program-scoped inbound rules:

| Protocol | Port | Scope |
| --- | --- | --- |
| TCP | Configured HTTP port, default 3000 | LocalSubnet, Private profile |
| UDP | 5353 for mDNS | LocalSubnet, Private profile |

The task runs as SYSTEM at boot. It does not require an interactive user login. Treat the project folder as privileged code: SYSTEM executes its contents. Restrict write access to trusted users.

A successful installer run prints `Server verified` only after a local status check and a Running task state. This does not verify discovery from a phone.

Open from a device on the same LAN:

```text
http://remotepower.local:3000
```

The PC must be awake. This project does not provide Wake-on-LAN.

## Password reset

The original password cannot be read from `config.json`; only its hash is stored. In the project folder, run:

```powershell
node .\setup-password.js
Stop-ScheduledTask -TaskName RemoteShutdown
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName RemoteShutdown
```

Use an Administrator terminal for task management. Password setup preserves the other configuration fields. Never commit `config.json` or `config.json.bak`. Both are ignored by Git.

## Updating

```powershell
git pull --ff-only
Stop-ScheduledTask -TaskName RemoteShutdown
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName RemoteShutdown
```

The server loads static UI assets at startup, so restart it after UI updates too. Rerun `install.ps1` when installer, runtime-path, firewall or task configuration changes. Do not run a manual server and the scheduled server on the same port.

If Git reports local changes, inspect `git status` and `git diff` first. Preserve intentional edits before pulling; do not discard them blindly.

## Configuration

`config.example.json` documents available settings. The live file is `config.json` in the project folder.

- `host`: default `0.0.0.0`, listening on IPv4 interfaces.
- `port`: default `3000`. Rerun installation after changing it.
- `allowedHosts`: include `remotepower.local` and any additional trusted hostname you use, without scheme or port.
- `https`: optional certificate/key configuration. Default HTTP does not encrypt passwords or sessions in transit.
- `logFile`: default `logs/audit.log`.
- `sessionIdleMinutes`, `maxFailures`, `lockoutMinutes`: session and login settings.

The server supports `RS_CONFIG`, `RS_HOST` and `RS_PORT` environment overrides. The installer reads the project `config.json`, so custom environment-based deployments need matching task and firewall configuration.

## Troubleshooting

### NVM: no active Node.js version under SYSTEM

The scheduled task cannot depend on your interactive user's version-manager state. The installer resolves `process.execPath` and records the real executable. You can specify it explicitly:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -NodePath 'C:\path\to\actual\node.exe'
```

Use an installed executable, not a version-manager launcher. Removing or moving that Node version requires reinstalling the task with a valid runtime path.

### Access is denied

Open PowerShell using Run as administrator, then change to the full project path. ExecutionPolicy Bypass does not grant administrator rights.

### Nothing opens

Separate server startup from hostname discovery:

```powershell
curl.exe -i http://localhost:3000/api/status
Get-ScheduledTask -TaskName RemoteShutdown
Get-ScheduledTaskInfo -TaskName RemoteShutdown
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

Use your configured port/scheme if different. A normal unauthenticated status response is HTTP 200 with `authed: false`. Ready is not the same as Running. A listening port alone does not identify which process owns it.

If startup fails, stop the scheduled task and run the real Node executable with `server.js` in an interactive terminal to inspect output. Review `logs/audit.log` too. Stop the manual instance before starting the task again.

### Localhost works but remotepower.local does not

Try `http://<current-pc-ip>:3000` using the active adapter address from `ipconfig`. This is a diagnostic fallback, not a fixed-IP requirement. If IP access works, investigate mDNS resolution, UDP 5353, client support, VPNs, network isolation and the Private network profile. A server Host rejection can also mean the hostname is missing from `allowedHosts`.

The responder uses IPv4 multicast on each detected non-loopback interface, checks address changes every 5 seconds and renews memberships every 30 seconds. Multicast may be filtered by routers, guest networks or clients. It is not guaranteed across VLANs or routed networks. One fixed hostname is used; multiple RemotePower PCs can conflict. It is not a complete DNS-SD service browser or a Wi-Fi signal monitor.

After a router restart, allow the PC to reconnect, then retry. Router-restart recovery and phone resolution must be tested on your own network.

### HTTPS health check fails

A self-signed or untrusted certificate can fail the installer's local HTTPS health check even if the server runs. Configure appropriate trust rather than disabling certificate validation globally.

## Security and limitations

- Do not port-forward the application. It is intended for a trusted LAN only.
- Private IP checks and firewall scope are not substitutes for encryption or network trust.
- SYSTEM execution increases the impact of a server compromise or writable project files.
- Configuration backups also contain the password hash. Protect them like the live configuration.
- Sleep/shutdown disconnects the server; losing contact does not prove which power state the PC entered.
- Session state is in memory; restarting the server logs clients out.
- Installation and discovery improvements are not a substitute for end-to-end testing or a security audit.

See [TESTING.md](TESTING.md) for the manual release checklist. No stable v2 release is implied by this documentation.

## License

MIT. See [LICENSE](LICENSE).
