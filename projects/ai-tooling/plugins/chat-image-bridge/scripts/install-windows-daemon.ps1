param([switch]$Uninstall)
$ErrorActionPreference = "Stop"
$taskName = "ChatImageBridge"
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除 ChatImageBridge 登录任务。"
  exit 0
}
$pluginRoot = Split-Path -Parent $PSScriptRoot
$server = Join-Path $pluginRoot "server.mjs"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" }
if (-not (Test-Path -LiteralPath $node)) { throw "找不到 Node.js：$node" }
$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" --daemon' -f $server) -WorkingDirectory $pluginRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Keeps the local Chat Image Bridge HTTP service available for the browser extension." -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "ChatImageBridge 登录任务已注册并启动。"
