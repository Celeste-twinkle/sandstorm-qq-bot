$ErrorActionPreference = "Stop"

$root = if (Test-Path (Join-Path $PSScriptRoot "sandstorm-qq-bot.exe")) {
  $PSScriptRoot
} else {
  Split-Path -Parent $PSScriptRoot
}

$runtimeDir = Join-Path $root "onebot\napcat\runtime"
$installer = Join-Path $runtimeDir "NapCatInstaller.exe"
$bootBat = Join-Path $runtimeDir "bootmain\napcat.bat"

if (Test-Path $installer) {
  Write-Host "Starting NapCat OneKey installer/launcher..."
  Start-Process -FilePath $installer -WorkingDirectory $runtimeDir
  exit 0
}

if (Test-Path $bootBat) {
  Write-Host "Starting NapCat boot script..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$bootBat`"" -WorkingDirectory (Split-Path -Parent $bootBat)
  exit 0
}

Write-Host "NapCat OneKey was not found."
Write-Host "Install it first:"
Write-Host ".\scripts\install-onebot-napcat.ps1"
Write-Host ""
Write-Host "In a release directory, use:"
Write-Host ".\install-onebot-napcat.ps1"
exit 1
