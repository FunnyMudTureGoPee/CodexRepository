[CmdletBinding()]
param(
    [string]$Model = 'gpt-5.6-sol',
    [ValidateSet('low', 'medium', 'high', 'xhigh')]
    [string]$ReasoningEffort = 'medium'
)

$ErrorActionPreference = 'Stop'
$secretsPath = Join-Path $PSScriptRoot '.secrets.json'
if (-not (Test-Path -LiteralPath $secretsPath)) {
    throw 'Secrets are missing. Run .\install.ps1 first.'
}
$apiKey = (Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json).api_key
$codexDir = Join-Path $env:USERPROFILE '.codex'
$configPath = Join-Path $codexDir 'config.toml'
$authPath = Join-Path $codexDir 'auth.json'
$backupDir = Join-Path $PSScriptRoot '.runtime\codex-backup'

New-Item -ItemType Directory -Path $codexDir -Force | Out-Null
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupDir "config-$stamp.toml") }
if (Test-Path -LiteralPath $authPath) { Copy-Item -LiteralPath $authPath -Destination (Join-Path $backupDir "auth-$stamp.json") }

@"
model_provider = "cpa_local"
model = "$Model"
model_reasoning_effort = "$ReasoningEffort"

[model_providers.cpa_local]
name = "Local CLIProxyAPI"
base_url = "http://127.0.0.1:8317/v1"
env_key = "CPA_API_KEY"
wire_api = "responses"
"@ | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM

[Environment]::SetEnvironmentVariable('CPA_API_KEY', $apiKey, 'User')
$env:CPA_API_KEY = $apiKey

Write-Host "Codex now uses local CPA at http://127.0.0.1:8317/v1"
Write-Host "Previous files, when present, were backed up under $backupDir"
Write-Host 'Open a new terminal before launching Codex so it receives CPA_API_KEY.'

