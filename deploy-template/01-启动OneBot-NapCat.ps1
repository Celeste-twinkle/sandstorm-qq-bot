$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$starter = Join-Path $root "start-onebot-napcat.ps1"

if (-not (Test-Path $starter)) {
  Write-Host "start-onebot-napcat.ps1 was not found."
  exit 1
}

& $starter

Write-Host ""
Write-Host "Next:"
Write-Host "1. Finish QQ login in NapCat."
Write-Host "2. Open NapCat WebUI."
Write-Host "3. Create WebSocket Client:"
Write-Host "   ws://127.0.0.1:6700/onebot/v11/ws"
Write-Host "4. If .env ACCESS_TOKEN is set, use the same token in NapCat."
Write-Host "5. Then run 02-启动Bot服务.ps1."
