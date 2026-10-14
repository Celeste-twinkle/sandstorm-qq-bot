$ErrorActionPreference = "Stop"
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$packagePath = (Resolve-Path -LiteralPath (Join-Path $workspacePath "deploy\SandstormQQBot-Deploy")).Path
$packagePrefix = $packagePath.TrimEnd('\') + '\'
$archivePath = Join-Path $workspacePath "deploy\SandstormQQBot-Deploy.zip"
$manifest = @()
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($entry in $archive.Entries) {
    $entryPath = $entry.FullName.Replace('\', '/')
    if ($entryPath.EndsWith('/')) { continue }
    if (-not $entryPath.StartsWith('SandstormQQBot-Deploy/')) { throw "Unexpected archive root" }
    $relative = $entryPath.Substring('SandstormQQBot-Deploy/'.Length)
    if ($relative -match '(^|/)(\.env|persona-selections\.json)$|(^|/)(data|logs)/|\.pid$') { throw "Live state in archive" }
    $filePath = [System.IO.Path]::GetFullPath((Join-Path $packagePath $relative))
    if (-not $filePath.StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Archive path escaped package" }
    $stream = $entry.Open()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $archiveHash = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    $localHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveHash -ne $localHash) { throw "Archive file differs: $relative" }
    $manifest += [ordered]@{ path = $relative; bytes = $entry.Length; sha256 = $localHash }
  }
} finally { $archive.Dispose() }
$localFiles = @(Get-ChildItem -LiteralPath $packagePath -Recurse -Force -File)
if ($localFiles.Count -ne $manifest.Count) { throw "File count mismatch" }
Set-Location -LiteralPath $workspacePath
$credentialCheck = @'
const fs = require('fs'), path = require('path');
const values = Object.entries(require('dotenv').parse(fs.readFileSync('.env')))
  .filter(([key, value]) => /(API_KEY|ACCESS_TOKEN|PASSWORD|SECRET)$/.test(key) && value.length >= 8)
  .map(([, value]) => Buffer.from(value));
let checkedFiles = 0;
function scan(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isSymbolicLink()) throw Error('Unexpected symlink');
    if (item.isDirectory()) scan(file);
    else { const content = fs.readFileSync(file); checkedFiles++;
      if (values.some(value => content.includes(value))) throw Error('Live credential found in package'); }
  }
}
scan('deploy/SandstormQQBot-Deploy');
console.log(JSON.stringify({ noLiveCredential: true, checkedFiles }));
'@ | node
if ($LASTEXITCODE -ne 0) { throw "Credential check failed" }
$credentialResult = $credentialCheck | ConvertFrom-Json
$report = [ordered]@{
  checkedAt = [DateTime]::UtcNow.ToString('o')
  zipContentsMatch = $true
  noLiveState = $true
  noLiveCredential = $credentialResult.noLiveCredential
  files = $manifest.Count
  zipBytes = (Get-Item -LiteralPath $archivePath).Length
  zipSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  manifest = $manifest
}
$json = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'archive-verification.json'), $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
[ordered]@{ files = $report.files; zipBytes = $report.zipBytes; zipContentsMatch = $true; noLiveCredential = $report.noLiveCredential } | ConvertTo-Json
