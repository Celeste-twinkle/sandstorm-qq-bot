param(
  [string]$Version = "latest",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$root = if (Test-Path (Join-Path $PSScriptRoot "sandstorm-qq-bot.exe")) {
  $PSScriptRoot
} else {
  Split-Path -Parent $PSScriptRoot
}

$onebotDir = Join-Path $root "onebot"
$napcatDir = Join-Path $onebotDir "napcat"
$runtimeDir = Join-Path $napcatDir "runtime"
$downloadDir = Join-Path $napcatDir "downloads"
$zipPath = Join-Path $downloadDir "NapCat.Shell.Windows.OneKey.zip"
$versionPath = Join-Path $napcatDir "VERSION.txt"

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null

if ((Test-Path (Join-Path $runtimeDir "NapCatInstaller.exe")) -and -not $Force) {
  Write-Host "NapCat OneKey already exists:"
  Write-Host $runtimeDir
  Write-Host "Use -Force to reinstall."
  exit 0
}

$headers = @{
  "User-Agent" = "sandstorm-qq-bot-onebot-installer"
}

if ($Version -eq "latest") {
  $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest"
} else {
  $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/NapNeko/NapCatQQ/releases/tags/$Version"
}

$asset = $release.assets | Where-Object { $_.name -eq "NapCat.Shell.Windows.OneKey.zip" } | Select-Object -First 1
if (-not $asset) {
  throw "NapCat.Shell.Windows.OneKey.zip was not found in release $($release.tag_name)."
}

Write-Host "Downloading NapCat $($release.tag_name):"
Write-Host $asset.browser_download_url
Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zipPath

if ($Force -and (Test-Path $runtimeDir)) {
  Remove-Item $runtimeDir -Recurse -Force
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
}

Expand-Archive -Path $zipPath -DestinationPath $runtimeDir -Force
Set-Content -Path $versionPath -Value $release.tag_name -Encoding UTF8

Write-Host "NapCat OneBot client helper installed:"
Write-Host $runtimeDir
Write-Host ""
Write-Host "Start it with:"
Write-Host ".\scripts\start-onebot-napcat.ps1"
Write-Host ""
Write-Host "In a release directory, use:"
Write-Host ".\start-onebot-napcat.ps1"
