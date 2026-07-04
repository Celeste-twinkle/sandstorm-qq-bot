param(
  [int]$QrWaitSeconds = 45
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$runtimeDir = Join-Path $root "onebot\napcat\runtime"
$botStarter = Join-Path $root "start.ps1"

function Find-NapCatBat {
  param([string]$RuntimeDir)

  $qqExe = Get-ChildItem $RuntimeDir -Recurse -Filter "QQ.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($qqExe) {
    $bat = Join-Path $qqExe.DirectoryName "napcat.bat"
    if (Test-Path $bat) {
      return $bat
    }

    $quickBat = Join-Path $qqExe.DirectoryName "napcat.quick.bat"
    if (Test-Path $quickBat) {
      return $quickBat
    }
  }

  $batCandidate = Get-ChildItem $RuntimeDir -Recurse -Filter "napcat.bat" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "\\bootmain\\" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($batCandidate) {
    return $batCandidate.FullName
  }

  return $null
}

function Find-LatestQrImage {
  param(
    [string]$RuntimeDir,
    [datetime]$StartedAt
  )

  $images = Get-ChildItem $RuntimeDir -Recurse -Include "*.png", "*.jpg", "*.jpeg" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $StartedAt.AddSeconds(-5) }

  $qrImage = $images |
    Where-Object { $_.Name -match "qr|qrcode|login" -or $_.DirectoryName -match "qr|qrcode|login" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($qrImage) {
    return $qrImage.FullName
  }

  $latestImage = $images |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($latestImage) {
    return $latestImage.FullName
  }

  return $null
}

if (-not (Test-Path $runtimeDir)) {
  Write-Host "NapCat runtime directory was not found:"
  Write-Host $runtimeDir
  exit 1
}

$napcatBat = Find-NapCatBat -RuntimeDir $runtimeDir

if (-not $napcatBat) {
  $installer = Join-Path $runtimeDir "NapCatInstaller.exe"
  if (Test-Path $installer) {
    Write-Host "NapCat shell was not found. Running installer first..."
    Start-Process -FilePath $installer -WorkingDirectory $runtimeDir -Wait
    $napcatBat = Find-NapCatBat -RuntimeDir $runtimeDir
  }
}

if (-not $napcatBat) {
  Write-Host "Could not find the real NapCat napcat.bat."
  Write-Host "Run NapCatInstaller.exe once, then run this script again."
  exit 1
}

$startedAt = Get-Date
Write-Host "Starting NapCat:"
Write-Host $napcatBat
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "`"$napcatBat`"" -WorkingDirectory (Split-Path -Parent $napcatBat)

Write-Host "Looking for QR code image for up to $QrWaitSeconds seconds..."
$openedQr = $false
for ($i = 0; $i -lt $QrWaitSeconds; $i++) {
  Start-Sleep -Seconds 1
  $qrImage = Find-LatestQrImage -RuntimeDir $runtimeDir -StartedAt $startedAt
  if ($qrImage) {
    Write-Host "Opening QR/login image:"
    Write-Host $qrImage
    Start-Process -FilePath $qrImage
    $openedQr = $true
    break
  }
}

if (-not $openedQr) {
  Write-Host "No fresh QR image was found. If QQ is already logged in, this is normal."
  Write-Host "If login is required, check the NapCat command window for the QR code or login prompt."
}

if (-not (Test-Path $botStarter)) {
  Write-Host "Bot starter was not found:"
  Write-Host $botStarter
  exit 1
}

Write-Host "Starting bot service..."
& $botStarter

Write-Host ""
Write-Host "All done. Test in QQ group:"
Write-Host "@bot ins"
