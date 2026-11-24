$ErrorActionPreference = 'Stop'
$pidPath = Join-Path $PSScriptRoot '.runtime\cpa.pid'
$exePath = (Resolve-Path (Join-Path $PSScriptRoot '.runtime\cli-proxy-api.exe')).Path

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Host 'CPA is not running (no PID file).'
    exit 0
}
$cpaPid = Get-Content -LiteralPath $pidPath
$process = Get-Process -Id $cpaPid -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidPath
    Write-Host 'Removed a stale PID file.'
    exit 0
}
if ($process.Path -ne $exePath) {
    throw "PID $cpaPid does not belong to this CPA installation; refusing to stop it."
}
Stop-Process -Id $cpaPid
Remove-Item -LiteralPath $pidPath
Write-Host 'CPA stopped.'

