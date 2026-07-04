$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$envPath = Join-Path $root ".env"
$envExamplePath = Join-Path $root ".env.example"

if (-not (Test-Path $envPath)) {
  if (-not (Test-Path $envExamplePath)) {
    Write-Host ".env.example was not found."
    exit 1
  }

  Copy-Item -Path $envExamplePath -Destination $envPath -Force
}

Write-Host "Opening .env. Fill these fields before starting the bot:"
Write-Host "  SANDSTORM_HOST=127.0.0.1"
Write-Host "  SANDSTORM_PORT=27015"
Write-Host "  ALLOWED_GROUP_IDS=your QQ group id, or empty for all groups"
Write-Host "  REQUIRE_AT=true means @bot + keyword is required"
Write-Host "  AMBIENT_CHAT_PROBABILITY controls random non-@ casual replies"
Write-Host "  AMBIENT_CHAT_IDLE_SECONDS controls guaranteed idle replies"
Write-Host "  AMBIENT_CHAT_CONTEXT_SECONDS controls idle reply context window"
Write-Host "  ACCESS_TOKEN=optional, keep same in NapCat if set"
Start-Process -FilePath "notepad.exe" -ArgumentList "`"$envPath`""
