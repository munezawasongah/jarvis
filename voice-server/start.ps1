# Start the Jarvis voice worker (your cloned voice). Run setup.ps1 once before this.
#
#   powershell -ExecutionPolicy Bypass -File start.ps1
#       Jarvis on this laptop: uses http://localhost:3000 and the token in ..\data\token.txt
#   powershell -ExecutionPolicy Bypass -File start.ps1 -Server https://YOUR-APP.up.railway.app -Token YOUR_JARVIS_TOKEN
#       Jarvis in the cloud: remembered in settings.json, so next time just run start.ps1
#   ... start.ps1 -Autostart      start hidden every time you sign in to Windows (log: worker.log)
#   ... start.ps1 -NoAutostart    remove that again
#   ... start.ps1 -Stop           stop a worker running in the background
param(
  [string]$Server = '',
  [string]$Token = '',
  [switch]$Autostart,
  [switch]$NoAutostart,
  [switch]$Stop,
  [switch]$Background
)
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
$vpy = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$taskName = 'Jarvis Voice Worker'

if (-not (Test-Path $vpy)) {
  Write-Host 'The voice worker is not installed yet. Run: powershell -ExecutionPolicy Bypass -File setup.ps1' -ForegroundColor Yellow
  exit 1
}

function Stop-Worker {
  Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like '*jarvis_voice.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped voice worker (pid $($_.ProcessId))." }
}

if ($Stop) { Stop-Worker; exit 0 }

if ($NoAutostart) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'Autostart removed.'
  exit 0
}

# Save server/token once so later runs (and autostart) need no arguments.
if ($Server -or $Token) {
  $cfg = [ordered]@{ server = 'http://localhost:3000'; token = ''; language = 'english' }
  if (Test-Path 'settings.json') {
    try { $old = Get-Content 'settings.json' -Raw | ConvertFrom-Json; foreach ($p in $old.PSObject.Properties) { $cfg[$p.Name] = $p.Value } } catch {}
  }
  if ($Server) { $cfg['server'] = $Server.Trim() }
  if ($Token) { $cfg['token'] = $Token.Trim() }
  ($cfg | ConvertTo-Json) | Set-Content -Path 'settings.json' -Encoding UTF8
  Write-Host 'Saved the Jarvis address and token in settings.json.'
}

if ($Autostart) {
  $ps = (Get-Command powershell.exe).Source
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Background" -WorkingDirectory $PSScriptRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "Autostart on: the voice worker now starts hidden whenever you sign in. Starting it now..."
  Stop-Worker
  Start-ScheduledTask -TaskName $taskName
  exit 0
}

if ($Background) {
  # Hidden mode used by autostart: write everything to worker.log (kept under ~5 MB).
  $logFile = Join-Path $PSScriptRoot 'worker.log'
  if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 5MB)) { Move-Item $logFile "$logFile.old" -Force }
  & $vpy -u jarvis_voice.py *>> $logFile
  exit $LASTEXITCODE
}

Write-Host 'Starting the Jarvis voice worker. Leave this window open (Ctrl+C stops it).' -ForegroundColor Cyan
& $vpy -u jarvis_voice.py
