$ErrorActionPreference = 'Stop'
$pidPath = Join-Path $PSScriptRoot '.runtime\cpa.pid'
$secretsPath = Join-Path $PSScriptRoot '.secrets.json'

$pidValue = if (Test-Path -LiteralPath $pidPath) { Get-Content -LiteralPath $pidPath } else { $null }
$process = if ($pidValue) { Get-Process -Id $pidValue -ErrorAction SilentlyContinue } else { $null }
$health = $null
if ($process -and (Test-Path -LiteralPath $secretsPath)) {
    $key = (Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json).api_key
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8317/v1/models' -Headers @{ Authorization = "Bearer $key" } -UseBasicParsing -TimeoutSec 5
        $health = "HTTP $($response.StatusCode)"
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        $health = if ($statusCode) { "HTTP $statusCode" } else { $_.Exception.Message }
    }
}

[pscustomobject]@{
    Running = [bool]$process
    PID = if ($process) { $process.Id } else { $null }
    API = $health
    ManagementUrl = 'http://127.0.0.1:8317/management.html#/login'
} | Format-List

