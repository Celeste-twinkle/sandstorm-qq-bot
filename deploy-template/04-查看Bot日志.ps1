$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$outLog = Join-Path $root "logs\out.log"
$errLog = Join-Path $root "logs\err.log"

Write-Host "=== out.log ==="
if (Test-Path $outLog) {
  Get-Content $outLog -Tail 80
} else {
  Write-Host "No out.log yet."
}

Write-Host ""
Write-Host "=== err.log ==="
if (Test-Path $errLog) {
  Get-Content $errLog -Tail 80
} else {
  Write-Host "No err.log yet."
}

Write-Host ""
Write-Host "Press Enter to close."
Read-Host | Out-Null
