$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$envPath = Join-Path $root ".env"
$envExamplePath = Join-Path $root ".env.example"
$starter = Join-Path $root "start.ps1"

if (-not (Test-Path $envPath)) {
  if (Test-Path $envExamplePath) {
    Copy-Item -Path $envExamplePath -Destination $envPath -Force
    Write-Host ".env was created from .env.example. Please edit it if needed."
  } else {
    Write-Host ".env and .env.example were not found."
    exit 1
  }
}

if (-not (Test-Path $starter)) {
  Write-Host "start.ps1 was not found."
  exit 1
}

& $starter

Write-Host ""
Write-Host "Bot service started. Test in the QQ group with:"
Write-Host "@bot ins"
