#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$RootDirectory = 'C:\ZebrafishNeuralPlay',
    [string]$NodeExecutable = 'C:\Program Files\nodejs\node.exe',
    [Parameter(Mandatory=$true)][PSCredential]$ServiceCredential
)
$ErrorActionPreference = 'Stop'
$taskName = 'ZebrafishNeuralPlay'
$accountName = 'ZebraPlayService'
$root = [IO.Path]::GetFullPath($RootDirectory).TrimEnd('\')
if ($root -ne 'C:\ZebrafishNeuralPlay') { throw 'Use the isolated C:\ZebrafishNeuralPlay installation; this script does not alter another root.' }
if ((Get-Item -LiteralPath $root -ErrorAction SilentlyContinue).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The isolated root cannot be a junction or symbolic link.' }
if (($ServiceCredential.UserName -split '\\')[-1] -ne $accountName) { throw 'Supply the dedicated ZebraPlayService account credential.' }
$app = Join-Path $root 'app'
$entry = Join-Path $app 'experiments\chess-play\server.mjs'
$supervisor = Join-Path $app 'experiments\chess-play\ops\host-service.mjs'
if ((Get-Item -LiteralPath $app -ErrorAction SilentlyContinue).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The app directory cannot be a junction or symbolic link.' }
foreach ($path in @($NodeExecutable,$entry,$supervisor,(Join-Path $app 'package-lock.json'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required installed file missing: $path" }
}
$version = & $NodeExecutable --version
if ($LASTEXITCODE -ne 0 -or [int]($version.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22 or newer is required.' }
$gate = Join-Path $root 'ops\production.enabled'
if (Test-Path -LiteralPath $gate) { throw 'Production is enabled. Use the activation script to stop it before changing its task/configuration.' }
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') { throw 'Existing play task is running; preparation cannot replace it.' }
if (Get-NetTCPConnection -State Listen -LocalPort 4200 -ErrorAction SilentlyContinue) { throw 'Port 4200 is occupied; identify its owner before proceeding.' }
foreach ($relative in @('ops','data','logs','runtime')) { New-Item -ItemType Directory -Path (Join-Path $root $relative) -Force | Out-Null }
if (-not (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue)) {
    New-LocalUser -Name $accountName -Password $ServiceCredential.Password -AccountNeverExpires -PasswordNeverExpires -Description 'Isolated human-vs-fish chess service' | Out-Null
}
$account = "$env:COMPUTERNAME\$accountName"
$accountSid = (Get-LocalUser -Name $accountName).SID.Value
if (Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $accountSid }) { throw 'ZebraPlayService must not be a member of Administrators.' }

# The service can read installed code/configuration; only its own state/log/runtime
# directories are writable. Existing project directories are never traversed.
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "${account}:(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to set the isolated root ACL.' }
foreach ($relative in @('data','logs','runtime')) {
    & icacls.exe (Join-Path $root $relative) /grant:r "${account}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to set the $relative ACL." }
}
$configuration = [ordered]@{
    root=$root; entrypoint=$entry; nodeExecutable=$NodeExecutable
    dataDir=(Join-Path $root 'data'); logsDir=(Join-Path $root 'logs'); runtimeDir=(Join-Path $root 'runtime')
    port=4200; origins=@('https://zebraneural.com'); trustProxy='loopback'
}
$configPath = Join-Path $root 'ops\service.json'
$configuration | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
$action = New-ScheduledTaskAction -Execute $NodeExecutable -Argument ('"{0}" "{1}"' -f $supervisor,$configPath) -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -Disable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Password -RunLevel Limited
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Private per-player fish chess. Requires the isolated production gate.'
# Password is supplied directly to Task Scheduler. It is never written to a file,
# command line, report, transcript message, or environment variable.
Register-ScheduledTask -TaskName $taskName -InputObject $definition -User $account -Password $ServiceCredential.GetNetworkCredential().Password -Force | Out-Null
Disable-ScheduledTask -TaskName $taskName | Out-Null

$ruleName = 'ZebrafishNeuralPlay-Block-Raw-4200'
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'Zebrafish Neural Play: block raw port 4200' -Direction Inbound -Action Block -Protocol TCP -LocalPort 4200 -Profile Any | Out-Null
}
$rawRule = Get-NetFirewallRule -Name $ruleName
$rawFilter = $rawRule | Get-NetFirewallPortFilter
if ($rawRule.Enabled -ne 'True' -or $rawRule.Direction -ne 'Inbound' -or $rawRule.Action -ne 'Block' -or $rawFilter.LocalPort -ne '4200' -or $rawFilter.Protocol -ne 'TCP') { throw 'The existing raw-port rule does not match the required enabled inbound TCP 4200 block.' }
& $NodeExecutable $supervisor $configPath
if ($LASTEXITCODE -ne 0) { throw 'Missing-gate supervisor check failed.' }
if (Get-NetTCPConnection -State Listen -LocalPort 4200 -ErrorAction SilentlyContinue) { throw 'Unexpected listener after the missing-gate check.' }
$task = Get-ScheduledTask -TaskName $taskName
if ($task.State -ne 'Disabled') { throw 'Preparation failed to leave the task disabled.' }
[pscustomobject]@{status='PREPARED_NOT_ACTIVE';task=$taskName;account=$account;gatePresent=(Test-Path -LiteralPath $gate);node=$version;root=$root;rebootTest='NOT_PERFORMED';publicConnectivity='NOT_VERIFIED'} | ConvertTo-Json
