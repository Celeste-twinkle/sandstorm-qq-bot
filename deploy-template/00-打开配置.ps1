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
Write-Host "  REQUIRE_AT=true means @bot + keyword is required for server queries"
Write-Host "  AI_PRIMARY_PROVIDER=deepseek uses official DeepSeek by default"
Write-Host "  DEEPSEEK_API_KEY=your official DeepSeek API key"
Write-Host "  DEEPSEEK_BASE_URL=https://api.deepseek.com"
Write-Host "  DEEPSEEK_MODEL=deepseek-flash and DEEPSEEK_VISION_MODEL=deepseek-flash"
Write-Host "  DEEPSEEK_THINKING_ENABLED=false keeps ordinary chat non-thinking"
Write-Host "  WEB_SEARCH_PROVIDER=deepseek-official reuses the DeepSeek key"
Write-Host "  WEB_SEARCH_AUTO_ENABLED=true lets AI choose whether to search"
Write-Host "  DEEPSEEK_SEARCH_BASE_URL=https://api.deepseek.com/anthropic/v1"
Write-Host "  DEEPSEEK_SEARCH_MODEL=deepseek-v4-flash is the Harness auxiliary search model"
Write-Host "  Auxiliary search uses additional model tokens"
Write-Host "  Group context keeps at most 50 chronological messages, including bot replies"
Write-Host "  AMBIENT_CHAT_ENABLED=true lets AI decide whether to join non-@ conversations"
Write-Host "  AMBIENT_CHAT_IDLE_SECONDS controls when to judge an idle conversation"
Write-Host "  AI may remain silent; legacy AMBIENT_CHAT_PROBABILITY is no longer used"
Write-Host "  LOCAL_QWEN_BASE_URL=OpenAI-compatible endpoint ending in /v1"
Write-Host "  LOCAL_QWEN_API_KEY=Bearer API key for the optional Qwen provider"
Write-Host "  LOCAL_QWEN_MODEL=qwen3.6-local"
Write-Host "  LOCAL_QWEN_SYSTEM_PROMPT=persona for the Qwen path"
Write-Host "  DEEPSEEK_SYSTEM_PROMPT=default persona for the DeepSeek path"
Write-Host "  RESPONSE_NEUTRALITY_PROMPT=sensitive-topic restriction shared by both paths"
Write-Host "  ACCESS_TOKEN=optional, keep same in NapCat if set"
Start-Process -FilePath "notepad.exe" -ArgumentList "`"$envPath`""
