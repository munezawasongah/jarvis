# Jarvis voice worker: one-time setup on Windows.
# Installs Python (if needed), Pocket TTS, logs you in to Hugging Face (free, needed once to unlock
# voice cloning), learns your voice and plays a test sentence in it.
#   powershell -ExecutionPolicy Bypass -File setup.ps1
# 'Continue' on purpose: Windows PowerShell 5.1 turns harmless stderr output of pip/python into errors under 'Stop'.
# Every step checks its own exit code instead.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

function Say($text, $color = 'Cyan') { Write-Host "`n== $text" -ForegroundColor $color }

# ---------- 1. Python 3.10 - 3.13 ----------
function Find-Python {
  foreach ($v in '3.12', '3.13', '3.11', '3.10') {
    try { $exe = (& py "-$v" -c "import sys; print(sys.executable)" 2>$null); if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() } } catch {}
  }
  foreach ($p in @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe")) {
    if (Test-Path $p) { return $p }
  }
  try {
    $exe = (& python -c "import sys; assert (3,10) <= sys.version_info[:2] <= (3,13); print(sys.executable)" 2>$null)
    if ($LASTEXITCODE -eq 0 -and $exe -and ($exe -notmatch 'WindowsApps')) { return $exe.Trim() }
  } catch {}
  return $null
}

Say 'Checking Python'
$py = Find-Python
if (-not $py) {
  Say 'Installing Python 3.12 (one time, about 30 MB)' 'Yellow'
  winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Host
  $py = Find-Python
  if (-not $py) { throw 'Python could not be installed automatically. Install Python 3.12 from python.org, then run this again.' }
}
Write-Host "Using $py"

# ---------- 2. Virtual environment + packages ----------
if (-not (Test-Path '.venv\Scripts\python.exe')) {
  Say 'Creating the voice environment (.venv)'
  & $py -m venv .venv
}
$vpy = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
Say 'Installing Pocket TTS (first time: about 300 MB, a few minutes)'
& $vpy -m pip install --upgrade pip --quiet --disable-pip-version-check
& $vpy -m pip install -r requirements.txt --quiet --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'Package install failed. Check your internet connection and run setup.ps1 again.' }

# ---------- 3. Hugging Face login (unlocks voice cloning; free) ----------
$hf = Join-Path $PSScriptRoot '.venv\Scripts\hf.exe'
$loggedIn = $false
try { & $hf auth whoami *> $null; $loggedIn = ($LASTEXITCODE -eq 0) } catch {}
if (-not $loggedIn) {
  Say 'One-time unlock of voice cloning (free Hugging Face account)' 'Yellow'
  Write-Host '1. Sign in or create a free account, then click "Agree and access repository" on the page that opens.'
  Write-Host '2. On the second page, create a token of type "Read" and copy it.'
  Start-Process 'https://huggingface.co/kyutai/pocket-tts'
  Start-Sleep -Seconds 2
  Start-Process 'https://huggingface.co/settings/tokens/new?tokenType=read'
  $sec = Read-Host -AsSecureString 'Paste the Hugging Face token here and press Enter'
  $tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  & $hf auth login --token $tok
  if ($LASTEXITCODE -ne 0) { throw 'That token did not work. Run setup.ps1 again and paste a Read token.' }
}

# ---------- 4. Learn your voice and play a test ----------
if (-not (Test-Path 'voices\my-voice.wav')) {
  Say 'No voice sample yet' 'Yellow'
  Write-Host 'Put a WAV of you speaking at voices\my-voice.wav, or record one in Jarvis > Settings > Record my voice.'
  Write-Host 'The worker still installs; it learns your voice as soon as it gets a sample.'
  exit 0
}
Say 'Learning your voice and saying a test sentence (first run downloads the model, about 400 MB)'
& $vpy jarvis_voice.py --say 'Good evening. This is Jarvis, speaking in your voice. Everything is working.'
if ($LASTEXITCODE -ne 0) {
  Say 'Voice test failed - see the message above.' 'Red'
  Write-Host 'If it says voice cloning is locked: open https://huggingface.co/kyutai/pocket-tts, click Agree, then run setup.ps1 again.'
  exit 1
}
Say 'Done. Your voice is ready. Next: start.ps1 connects it to Jarvis.' 'Green'
