$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $root "dist"
$releaseDir = Join-Path $root "release"
$exePath = Join-Path $distDir "sandstorm-qq-bot.exe"
$releaseExePath = Join-Path $releaseDir "sandstorm-qq-bot.exe"

Set-Location $root

if (-not (Test-Path "node_modules")) {
  npm install
}

npm run check
npm run build:exe

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
Copy-Item -Path $exePath -Destination $releaseExePath -Force
Copy-Item -Path (Join-Path $root ".env.example") -Destination (Join-Path $releaseDir ".env.example") -Force
Copy-Item -Path (Join-Path $root "scripts\start-exe.ps1") -Destination (Join-Path $releaseDir "start.ps1") -Force
Copy-Item -Path (Join-Path $root "scripts\stop-exe.ps1") -Destination (Join-Path $releaseDir "stop.ps1") -Force
Copy-Item -Path (Join-Path $root "scripts\install-onebot-napcat.ps1") -Destination (Join-Path $releaseDir "install-onebot-napcat.ps1") -Force
Copy-Item -Path (Join-Path $root "scripts\start-onebot-napcat.ps1") -Destination (Join-Path $releaseDir "start-onebot-napcat.ps1") -Force

$releaseOneBotDir = Join-Path $releaseDir "onebot"
New-Item -ItemType Directory -Path $releaseOneBotDir -Force | Out-Null
Copy-Item -Path (Join-Path $root "onebot\README.md") -Destination (Join-Path $releaseOneBotDir "README.md") -Force

Write-Host "Release package created:"
Write-Host $releaseDir
Write-Host ""
Write-Host "Copy the release directory to the target Windows 10 machine, rename .env.example to .env, then run .\start.ps1."
Write-Host "To install the bundled OneBot client helper, run .\install-onebot-napcat.ps1 on the target machine."
