# Run once in PowerShell as Administrator, from the project folder.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = (Get-Command node).Source
if (-not (Test-Path "$root\config.json")) { & $node "$root\setup-password.js" }
New-Item -ItemType Directory -Force "$root\logs" | Out-Null

# Firewall: local subnet only, regardless of whether Windows marks the network Private or Public
Remove-NetFirewallRule -DisplayName 'RemoteShutdown' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'RemoteShutdown' -Direction Inbound -Protocol TCP -LocalPort 3000 `
  -Action Allow -Profile Any -RemoteAddress LocalSubnet | Out-Null

# Task: start at boot and login, hidden window, restart if it crashes, runs as SYSTEM
$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless `"$node`" `"$root\server.js`"" `
  -WorkingDirectory $root

$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' `
  -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

Register-ScheduledTask -TaskName RemoteShutdown `
  -Action $action `
  -Trigger $triggerBoot, $triggerLogon `
  -Principal $principal `
  -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName RemoteShutdown
Write-Host 'Done. Open http://remotepower.local:3000 from a device on the same LAN.'
