$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "bot.pid"
$logsDir = Join-Path $root "logs"
$outLog = Join-Path $logsDir "out.log"
$errLog = Join-Path $logsDir "err.log"

New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Host "sandstorm-qq-bot is already running. PID: $oldPid"
    exit 0
  }
}

$process = Start-Process `
  -FilePath "node" `
  -ArgumentList "src/index.js" `
  -WorkingDirectory $root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -Path $pidFile -Value $process.Id
Write-Host "sandstorm-qq-bot started. PID: $($process.Id)"
Write-Host "Logs: $outLog"
