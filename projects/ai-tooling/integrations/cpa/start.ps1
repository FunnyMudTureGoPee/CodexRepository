[CmdletBinding()]
param(
    [switch]$OpenManagement
)

$ErrorActionPreference = 'Stop'
$exePath = Join-Path $PSScriptRoot '.runtime\cli-proxy-api.exe'
$configPath = Join-Path $PSScriptRoot 'config.yaml'

if (-not (Test-Path -LiteralPath $exePath) -or -not (Test-Path -LiteralPath $configPath)) {
    throw 'CPA is not installed. Run .\install.ps1 first.'
}

if ($OpenManagement) {
    Start-Process 'http://127.0.0.1:8317/management.html#/login'
}

& $exePath -config $configPath

