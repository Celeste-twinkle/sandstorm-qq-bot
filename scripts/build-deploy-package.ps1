$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $root "deploy"
$packageDir = Join-Path $packageRoot "SandstormQQBot-Deploy"
$packageZip = Join-Path $packageRoot "SandstormQQBot-Deploy.zip"
$napcatRuntime = Join-Path $root "onebot\napcat\runtime"

Set-Location $root

if (-not (Test-Path $napcatRuntime)) {
  Write-Host "NapCat runtime was not found. Installing NapCat first..."
  & (Join-Path $root "scripts\install-onebot-napcat.ps1")
}

npm run release

if (Test-Path $packageDir) {
  Remove-Item $packageDir -Recurse -Force
}

if (Test-Path $packageZip) {
  Remove-Item $packageZip -Force
}

New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
Copy-Item -Path (Join-Path $root "release\*") -Destination $packageDir -Recurse -Force
Copy-Item -Path (Join-Path $root "deploy-template\*") -Destination $packageDir -Force

$packageNapcatDir = Join-Path $packageDir "onebot\napcat"
New-Item -ItemType Directory -Path $packageNapcatDir -Force | Out-Null
Copy-Item -Path $napcatRuntime -Destination $packageNapcatDir -Recurse -Force

$versionPath = Join-Path $root "onebot\napcat\VERSION.txt"
if (Test-Path $versionPath) {
  Copy-Item -Path $versionPath -Destination (Join-Path $packageNapcatDir "VERSION.txt") -Force
}

Compress-Archive -Path $packageDir -DestinationPath $packageZip -Force

Write-Host "Preset deploy package created:"
Write-Host $packageDir
Write-Host $packageZip
Write-Host ""
Write-Host "Copy this directory to the Windows 10 server and run scripts in numeric order."
