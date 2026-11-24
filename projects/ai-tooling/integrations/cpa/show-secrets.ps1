$ErrorActionPreference = 'Stop'
$secretsPath = Join-Path $PSScriptRoot '.secrets.json'
if (-not (Test-Path -LiteralPath $secretsPath)) {
    throw 'Secrets are missing. Run .\install.ps1 first.'
}
$secrets = Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json
Write-Host "Management URL: http://127.0.0.1:8317/management.html#/login"
Write-Host "Management key: $($secrets.management_key)"
Write-Host "Local API key: $($secrets.api_key)"

