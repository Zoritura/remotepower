# Run from an elevated PowerShell window.
param([string]$NodePath = '')
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$resolved = & $NodePath -p 'process.execPath'
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the actual Node runtime. Supply -NodePath with a real node.exe path.' }
$node = ([string]($resolved | Select-Object -Last 1)).Trim()
if (-not (Test-Path -LiteralPath $node)) { throw "Node runtime not found: $node" }
& $node --version
if ($LASTEXITCODE -ne 0) { throw 'Node runtime verification failed.' }
if (-not (Test-Path "$root\config.json")) {
    & $node "$root\setup-password.js"
    if ($LASTEXITCODE -ne 0) { throw 'Password setup failed.' }
}
# Preserve the password and other settings; add only the discovery hostname.
& $node -e 'const fs=require("fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8").replace(/^\uFEFF/,""));c.allowedHosts=[...new Set([...(c.allowedHosts||[]),"remotepower.local"])];fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");' "$root\config.json"
if ($LASTEXITCODE -ne 0) { throw 'Configuration update failed.' }
$cfg = Get-Content -Raw "$root\config.json" | ConvertFrom-Json
$port = 3000
if ($cfg.port) { $port = [int]$cfg.port }
New-Item -ItemType Directory -Force "$root\logs" | Out-Null
Stop-ScheduledTask -TaskName RemoteShutdown -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
foreach ($name in @('RemoteShutdown', 'RemoteShutdown-mDNS')) {
    Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
}
# Public networks remain blocked: mark your trusted home network Private.
New-NetFirewallRule -DisplayName 'RemoteShutdown' -Direction Inbound -Protocol TCP -LocalPort $port -Program $node -Action Allow -Profile Private -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName 'RemoteShutdown-mDNS' -Direction Inbound -Protocol UDP -LocalPort 5353 -Program $node -Action Allow -Profile Private -RemoteAddress LocalSubnet | Out-Null
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\server.js`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName RemoteShutdown -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName RemoteShutdown
$healthy = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $scheme = 'http'
        if ($cfg.https.enabled) { $scheme = 'https' }
        $r = Invoke-RestMethod -Uri "${scheme}://localhost:$port/api/status" -TimeoutSec 2
        if ($null -ne $r.authed) { $healthy = $true; break }
    } catch {}
}
$state = (Get-ScheduledTask -TaskName RemoteShutdown).State
if (-not $healthy -or $state -ne 'Running') {
    Get-ScheduledTaskInfo -TaskName RemoteShutdown | Format-List
    throw 'Startup not verified. Check logs/audit.log and run the resolved Node executable manually. Self-signed HTTPS can also fail the health check.'
}
Write-Host "Server verified. Node runtime: $node"
Write-Host "On your trusted Private LAN, test ${scheme}://remotepower.local:$port"
Write-Host 'Hostname resolution must be tested separately on your phone. No fixed IP is required.'
