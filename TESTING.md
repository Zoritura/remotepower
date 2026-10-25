# Manual acceptance checklist

All boxes below are intentionally unchecked. They describe required checks, not completed tests. Record the commit, Windows and Node versions, browser/device, date and result when testing.

## Safety

- Save all work before testing power actions.
- Use a trusted Private LAN. Do not open router ports.
- A full shutdown test really powers off the PC; plan physical access for restarting it.
- Do not assume a disconnected server means a successful shutdown or sleep.

## Installation

- [ ] Non-elevated installation refuses to run clearly.
- [ ] Fresh password setup accepts matching 10-256 character passwords and hides input.
- [ ] Windows PowerShell 5.1 completes configuration migration without JavaScript quoting errors.
- [ ] Existing password and unrelated configuration fields survive installation.
- [ ] Repeated installation does not duplicate the allowed hostname.
- [ ] config.json.bak is created and ignored by Git.
- [ ] Real Node runtime is recorded, including an NVM installation.
- [ ] Task remains Running as SYSTEM and local status returns HTTP 200.
- [ ] TCP application rule and UDP 5353 rule are restricted to Private/LocalSubnet.

## UI and authentication

- [ ] Login succeeds with the configured password; incorrect password is rejected.
- [ ] Password reset works after server restart.
- [ ] Logout ends the session; server restart requires login again.
- [ ] Light/dark follows system preference initially and manual selection persists when storage is allowed.
- [ ] UI remains usable when browser storage is blocked.
- [ ] No horizontal overflow at 320px, 390px, tablet and desktop widths.
- [ ] Keyboard focus, labels and slider confirmation work.
- [ ] Signal state changes after a server outage; it does not claim measured Wi-Fi strength.

## Power controls

- [ ] Selecting Sleep or Shut down only opens confirmation.
- [ ] Back returns without submitting a power command.
- [ ] Slider requires reaching its endpoint before submission.
- [ ] Countdown reflects pending server state after reload.
- [ ] Cancel before expiry prevents the pending action.
- [ ] Completed Sleep is checked physically; resume restores access.
- [ ] Completed Shutdown is checked physically.
- [ ] Failed or timed-out requests do not falsely claim success.

## Startup and discovery

- [ ] Reboot PC; service is reachable before interactive login.
- [ ] Stop server; signal changes to disconnected; start server and reconnect.
- [ ] Current IP access works from another LAN device.
- [ ] remotepower.local works from each intended phone/browser.
- [ ] Restart router and reconnect PC/client; hostname resolves again.
- [ ] Change the DHCP address without reserving a fixed IP; hostname follows it.
- [ ] Repeat discovery checks with virtual adapters/VPNs present if used.

## Release gate

Do not describe a test as passed without running it. Investigate failures before publishing a stable release. This checklist is not a security audit, automated test suite or guarantee of mDNS compatibility.
