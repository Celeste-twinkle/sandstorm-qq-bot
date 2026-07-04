$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$stopper = Join-Path $root "stop.ps1"

if (-not (Test-Path $stopper)) {
  Write-Host "stop.ps1 was not found."
  exit 1
}

& $stopper
Write-Host "NapCat can be closed from its own window/WebUI if needed."
