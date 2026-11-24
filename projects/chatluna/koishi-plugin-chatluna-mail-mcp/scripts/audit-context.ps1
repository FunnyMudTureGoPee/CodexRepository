[CmdletBinding()]
param(
  [uri]$Endpoint = 'http://127.0.0.1:5140/mcp/mail',
  [string[]]$TaskIds = @('daily-diary','morning-note','tiandian-report','sunday-playlist','var-test'),
  [Security.SecureString]$Token,
  [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
if (-not $Endpoint.IsLoopback -or $Endpoint.Scheme -notin @('http','https') -or $Endpoint.UserInfo -or $Endpoint.Query -or $Endpoint.Fragment) { throw 'Endpoint must be a loopback HTTP(S) MCP URL without credentials or query.' }
if ($TaskIds.Count -lt 1 -or $TaskIds.Count -gt 50) { throw 'Provide 1-50 task IDs.' }
if (-not $OutputPath) { $OutputPath = Join-Path (Get-Location) ('context-audit-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json') }
if (Test-Path -LiteralPath $OutputPath) { throw 'Output already exists; choose a new file to preserve evidence.' }
if (-not $Token) { $Token = Read-Host 'MCP token (hidden; never written to report)' -AsSecureString }
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
$headers = @{}
try {
  $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ($plainToken -notmatch '^[\x21-\x7e]{24,256}$') { throw 'Token must be 24-256 printable ASCII characters without spaces.' }
  $headers = @{ Authorization = 'Bearer ' + $plainToken; Accept = 'application/json, text/event-stream' }
  $initialize = @{jsonrpc='2.0';id=1;method='initialize';params=@{protocolVersion='2025-03-26';capabilities=@{};clientInfo=@{name='mail-context-storage-audit';version='0.7.2'}}} | ConvertTo-Json -Depth 8 -Compress
  try { $init = Invoke-RestMethod -Uri $Endpoint -Method Post -Headers $headers -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($initialize)) }
  catch { throw 'MCP initialize failed; check endpoint, token and local service. No response body logged.' }
  if ($init.error -or -not $init.result.serverInfo.version) { throw 'Invalid MCP initialization response.' }
  if ([version]$init.result.serverInfo.version -lt [version]'0.7.2') { throw 'Install 0.7.2 or newer first: older diagnostics do not support storageOnly.' }
  $headers['MCP-Protocol-Version'] = $init.result.protocolVersion
  $notice = @{jsonrpc='2.0';method='notifications/initialized'} | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri $Endpoint -Method Post -Headers $headers -ContentType 'application/json' -Body $notice | Out-Null
  $results = @(); $requestId = 1
  foreach ($taskId in $TaskIds) {
    $requestId++
    $request = @{jsonrpc='2.0';id=$requestId;method='tools/call';params=@{name='get_mail_task_diagnostics';arguments=@{taskId=$taskId;storageOnly=$true}}} | ConvertTo-Json -Depth 8 -Compress
    try {
      $response = Invoke-RestMethod -Uri $Endpoint -Method Post -Headers $headers -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($request))
      if ($response.error) { $results += @{taskId=$taskId;errorCode='MCP_REQUEST_FAILED'}; continue }
      $value = ($response.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text | ConvertFrom-Json
      if ($response.result.isError) { $results += @{taskId=$taskId;errorCode=$value.errorCode}; continue }
      if ($value.decoded -ne $false -or $value.modelInvoked -ne $false) { throw 'Unexpected diagnostic mode.' }
      $results += $value
    } catch { $results += @{taskId=$taskId;errorCode='AUDIT_REQUEST_FAILED'} }
  }
  $report = @{version='0.7.2';generatedAt=(Get-Date).ToUniversalTime().ToString('o');mode='storage-metadata-only';tasks=$results}
  $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  Write-Host ('Saved metadata report: ' + [IO.Path]::GetFullPath($OutputPath))
  Write-Host 'No model, tools workflow, image generation or sending was requested. Database backup is a separate prerequisite.'
} finally {
  $headers.Clear(); $plainToken = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
