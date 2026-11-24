param([switch]$Browser)

$ErrorActionPreference = 'Stop'
$bundled = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$node = @($env:CODEX_MCP_NODE_PATH, $bundled, (Get-Command node.exe -ErrorAction SilentlyContinue).Source) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1

if (-not $node) {
    [Console]::Error.WriteLine('Node.js 22+ was not found. Install Node.js or configure CODEX_MCP_NODE_PATH.')
    exit 1
}

$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $node
$start.Arguments = '"' + (Join-Path $PSScriptRoot 'server.mjs') + '"'
if ($Browser) { $start.Arguments += ' --browser' }
$start.UseShellExecute = $false
$process = [System.Diagnostics.Process]::Start($start)
$process.WaitForExit()
exit $process.ExitCode
