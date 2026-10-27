$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $root "dist"
$releaseDir = Join-Path $root "release"
$exePath = Join-Path $distDir "sandstorm-qq-bot.exe"
$releaseExePath = Join-Path $releaseDir "sandstorm-qq-bot.exe"

Set-Location $root

$workspacePrefix = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
$resolvedRelease = [System.IO.Path]::GetFullPath($releaseDir)
if (-not $resolvedRelease.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    [System.IO.Path]::GetFileName($resolvedRelease) -ne 'release') { throw 'Release target escaped the workspace' }
if (Test-Path -LiteralPath $releaseDir) {
  if ((Get-Item -LiteralPath $releaseDir -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Release target must not be a link' }
  foreach ($livePath in @('.env', 'data', 'logs', 'bot.pid')) {
    if (Test-Path -LiteralPath (Join-Path $releaseDir $livePath)) { throw "Release contains live state ($livePath); preserve it before rebuilding" }
  }
}

if (-not (Test-Path "node_modules")) {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

npm run check
if ($LASTEXITCODE -ne 0) { throw "Source syntax check failed" }
npm run build:exe
if ($LASTEXITCODE -ne 0) { throw "EXE build failed; release was not replaced" }

if (Test-Path $releaseDir) {
  Remove-Item -LiteralPath $releaseDir -Recurse -Force
}

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
Copy-Item -Path $exePath -Destination $releaseExePath -Force
Copy-Item -Path (Join-Path $root ".env.example") -Destination (Join-Path $releaseDir ".env.example") -Force
Copy-Item -Path (Join-Path $root "scripts\start-exe.ps1") -Destination (Join-Path $releaseDir "start.ps1") -Force
Copy-Item -Path (Join-Path $root "scripts\stop-exe.ps1") -Destination (Join-Path $releaseDir "stop.ps1") -Force
Copy-Item -Path (Join-Path $root "scripts\install-onebot-napcat.ps1") -Destination (Join-Path $releaseDir "install-onebot-napcat.ps1") -Force
Copy-Item -Path (Join-Path $root "scripts\start-onebot-napcat.ps1") -Destination (Join-Path $releaseDir "start-onebot-napcat.ps1") -Force
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $releaseDir "README.md") -Force
$releaseScriptsDir = Join-Path $releaseDir "scripts"
New-Item -ItemType Directory -Path $releaseScriptsDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "scripts\serve-memory-embeddings.py") -Destination $releaseScriptsDir -Force

$releaseOneBotDir = Join-Path $releaseDir "onebot"
New-Item -ItemType Directory -Path $releaseOneBotDir -Force | Out-Null
Copy-Item -Path (Join-Path $root "onebot\README.md") -Destination (Join-Path $releaseOneBotDir "README.md") -Force

Write-Host "Release package created:"
Write-Host $releaseDir
Write-Host ""
Write-Host "Copy the release directory to the target Windows 10 machine, rename .env.example to .env, then run .\start.ps1."
Write-Host "To install the bundled OneBot client helper, run .\install-onebot-napcat.ps1 on the target machine."
