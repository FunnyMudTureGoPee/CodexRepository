[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.runtime'
$secretsPath = Join-Path $projectRoot '.secrets.json'
$configPath = Join-Path $projectRoot 'config.yaml'
$templatePath = Join-Path $projectRoot 'config.template.yaml'

function New-RandomSecret([int]$ByteCount = 32) {
    $bytes = New-Object byte[] $ByteCount
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

if (-not (Test-Path -LiteralPath $runtimeDir)) {
    New-Item -ItemType Directory -Path $runtimeDir | Out-Null
}

if ((Test-Path -LiteralPath $secretsPath) -and -not $Force) {
    $secrets = Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json
} else {
    $secrets = [ordered]@{
        management_key = New-RandomSecret
        api_key = New-RandomSecret
    }
    $secrets | ConvertTo-Json | Set-Content -LiteralPath $secretsPath -Encoding utf8NoBOM
}

if ($Force -or -not (Test-Path -LiteralPath $configPath)) {
    $template = Get-Content -LiteralPath $templatePath -Raw
    $rendered = $template.Replace('__MANAGEMENT_KEY__', $secrets.management_key).Replace('__API_KEY__', $secrets.api_key)
    $rendered | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
}

$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest' -Headers @{ 'User-Agent' = 'CPA-local-installer' }
$archPattern = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'windows_arm64\.zip$' } else { 'windows_amd64\.zip$' }
$asset = $release.assets | Where-Object { $_.name -match $archPattern } | Select-Object -First 1
if (-not $asset) {
    throw "No Windows release asset matching $archPattern was found in $($release.tag_name)."
}

$zipPath = Join-Path $runtimeDir $asset.name
$exePath = Join-Path $runtimeDir 'cli-proxy-api.exe'
if ($Force -or -not (Test-Path -LiteralPath $exePath)) {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers @{ 'User-Agent' = 'CPA-local-installer' }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeDir -Force
    Remove-Item -LiteralPath $zipPath
}

$downloadedExe = Get-ChildItem -LiteralPath $runtimeDir -Filter '*.exe' -Recurse |
    Where-Object { $_.Name -match 'cli-proxy-api' } |
    Select-Object -First 1
if (-not $downloadedExe) {
    throw 'CLIProxyAPI executable was not found after extraction.'
}
if ($downloadedExe.FullName -ne $exePath) {
    Copy-Item -LiteralPath $downloadedExe.FullName -Destination $exePath -Force
}

$hash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
[ordered]@{
    version = $release.tag_name
    asset = $asset.name
    sha256 = $hash
    installed_at = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'install-manifest.json') -Encoding utf8NoBOM

Write-Host "Installed CLIProxyAPI $($release.tag_name)"
Write-Host "Management URL: http://127.0.0.1:8317/management.html#/login"
Write-Host 'Run .\show-secrets.ps1 when you need the management or API key.'
Write-Host "Next: run .\start.ps1, then add your own Codex account through OAuth in the management page."

