# RemotePower

Minimal, dependency-free Node.js web app to shut down or sleep your Windows PC from your phone over the LAN.

## Features

- Zero npm dependencies, Node.js built-ins only
- Mobile-first dark/light UI, slide-to-confirm, 30-second cancellable countdown
- Shutdown and Sleep actions, with cancel
- Runs hidden via Windows Task Scheduler, starts at boot and auto-restarts on crash
- mDNS discovery: open `http://remotepower.local:3000` without a fixed IP
- Scrypt password hashing, per-IP rate limiting and lockout
- CSRF tokens, Origin/Host validation, LAN-only access
- Hardcoded commands via execFile, audit logging

## Setup

1. Install Node.js 18+.
2. Clone this repo and open a terminal in the folder.
3. Run `node setup-password.js` to create `config.json` with your password hash.
4. Run `install.ps1` as Administrator to create the firewall rule and scheduled task.
5. Set your Wi-Fi to Private and open `http://remotepower.local:3000` on your phone.

The PC advertises `remotepower.local` through mDNS, so it can receive any DHCP address in the local subnet. No static IP or router DHCP reservation is required.

If your device or browser cannot resolve `.local` names, find the PC address with `ipconfig` and temporarily use `http://<pc-ip>:3000`.

## Security notes

- Never port-forward port 3000 on your router.
- Intended for trusted home networks only.
- Plain HTTP is used by default; HTTPS is optional via a self-signed certificate.
- The firewall rule allows TCP port 3000 only from the local subnet.

## License

MIT
