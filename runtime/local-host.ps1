param([ValidateSet('Start','Stop','Status')][string]$Action='Status')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$processRecord=Join-Path $PSScriptRoot 'data/host-processes.json'
if($Action -eq 'Start'){
 if(Test-Path -LiteralPath $processRecord){
  $record=Get-Content -LiteralPath $processRecord -Raw | ConvertFrom-Json
  $running=Get-CimInstance Win32_Process -Filter "ProcessId = $($record.supervisor)" -ErrorAction SilentlyContinue
  if($running -and $running.CommandLine.Contains((Join-Path $PSScriptRoot 'supervisor.mjs'))){Write-Output 'The shared controller is already running.';exit}
 }
 $nodePath=(Get-Command node).Source
 Start-Process -FilePath $nodePath -ArgumentList ('"'+(Join-Path $PSScriptRoot 'supervisor.mjs')+'"') -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
 Write-Output 'Started the shared controller in the background.'
}elseif($Action -eq 'Stop'){
 New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'data') | Out-Null
 Set-Content -LiteralPath (Join-Path $PSScriptRoot 'data/stop-host') -Value 'stop'
 Write-Output 'Requested a stop of the shared controller.'
}else{
 try{Invoke-RestMethod -Uri 'http://127.0.0.1:4388/healthz' -TimeoutSec 3 | ConvertTo-Json}catch{Write-Output 'The shared controller is offline.'}
}
