[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$exePath = (Resolve-Path (Join-Path $PSScriptRoot '.runtime\cli-proxy-api.exe')).Path
$configPath = (Resolve-Path (Join-Path $PSScriptRoot 'config.yaml')).Path
$pidPath = Join-Path $PSScriptRoot '.runtime\cpa.pid'

if (Test-Path -LiteralPath $pidPath) {
    $oldPid = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue
    $oldProcess = if ($oldPid) { Get-Process -Id $oldPid -ErrorAction SilentlyContinue }
    if ($oldProcess -and $oldProcess.Path -eq $exePath) {
        Write-Host "CPA is already running (PID $oldPid)."
        exit 0
    }
}

$process = Start-Process -FilePath $exePath -ArgumentList @('-config', $configPath) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath $pidPath -Encoding ascii
Start-Sleep -Seconds 2
if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    throw 'CPA exited during startup. Check auths/logs/main.log.'
}
Write-Host "CPA started in background (PID $($process.Id))."
Write-Host 'Management URL: http://127.0.0.1:8317/management.html#/login'

