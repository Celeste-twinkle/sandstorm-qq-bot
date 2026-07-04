$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$pidFile = Join-Path $root "bot.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "sandstorm-qq-bot is not running."
  exit 0
}

$botPid = Get-Content $pidFile -ErrorAction SilentlyContinue
$process = if ($botPid) { Get-Process -Id $botPid -ErrorAction SilentlyContinue } else { $null }

if ($process) {
  Stop-Process -Id $botPid -Force
  Write-Host "sandstorm-qq-bot stopped. PID: $botPid"
} else {
  Write-Host "stale pid file removed."
}

Remove-Item $pidFile -Force
