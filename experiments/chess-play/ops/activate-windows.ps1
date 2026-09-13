#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Status')][string]$Action)
$ErrorActionPreference = 'Stop'
$root = 'C:\ZebrafishNeuralPlay'
$taskName = 'ZebrafishNeuralPlay'
$gate = Join-Path $root 'ops\production.enabled'
$configPath = Join-Path $root 'ops\service.json'
$ownerPath = Join-Path $root 'runtime\owner.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Run preparation first.' }
$task = Get-ScheduledTask -TaskName $taskName
if ($Action -eq 'Start') {
    if ($task.State -eq 'Running') { throw 'The task is already running. Use Status; do not start another instance.' }
    if (Get-NetTCPConnection -State Listen -LocalPort 4200 -ErrorAction SilentlyContinue) { throw 'Port 4200 is occupied; identify the owner before activating.' }
    [ordered]@{enabledAt=[DateTime]::UtcNow.ToString('o');service='chess-play';dataDir=(Join-Path $root 'data')} | ConvertTo-Json | Set-Content -LiteralPath $gate -Encoding UTF8
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $healthy=$false
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Seconds 1
        try { $health=Invoke-RestMethod -Uri 'http://127.0.0.1:4200/healthz' -TimeoutSec 2; if ($health.ok -and $health.service -eq 'chess-play') { $healthy=$true; break } } catch {}
    }
    if (-not $healthy) { throw 'Activation has not reached healthy status. Inspect play logs and task result; public readiness remains pending. Use Stop to disable.' }
}
if ($Action -eq 'Stop') {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    if (Test-Path -LiteralPath $gate) { Remove-Item -LiteralPath $gate }
    # Runner observes the removed gate within one second and closes its backend.
    # No broad process kill, port-based kill, or other project task is used.
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running' -and -not (Test-Path -LiteralPath $ownerPath)) { break }
        Start-Sleep -Seconds 1
    }
    if (Test-Path -LiteralPath $ownerPath) { throw 'Supervisor did not finish stopping. Inspect its exact owner.json PIDs and command lines; do not kill unrelated Node processes.' }
    if (Get-NetTCPConnection -State Listen -LocalPort 4200 -ErrorAction SilentlyContinue) { throw 'A listener remains on 4200; identify it before declaring the service stopped.' }
}
$health=$null
try { $health=Invoke-RestMethod -Uri 'http://127.0.0.1:4200/healthz' -TimeoutSec 2 } catch {}
[ordered]@{taskState=(Get-ScheduledTask -TaskName $taskName).State.ToString();gatePresent=(Test-Path -LiteralPath $gate);health=$health;ownerRecordPresent=(Test-Path -LiteralPath $ownerPath);rebootTest='NOT_ASSERTED_BY_THIS_SCRIPT'} | ConvertTo-Json -Depth 5
