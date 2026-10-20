param(
  [string]$KoishiDir = (Join-Path $env:APPDATA 'Koishi/Desktop/data/instances/default'),
  [string]$PackagePath,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$target = (Resolve-Path -LiteralPath $KoishiDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $target 'package.json'))) {
  throw 'KoishiDir must be the instance directory containing package.json, not the application install directory.'
}
if (-not $PackagePath) {
  $meta = Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot) 'package.json') -Raw | ConvertFrom-Json
  $PackagePath = Join-Path (Split-Path $PSScriptRoot) ('dist/' + $meta.name + '-' + $meta.version + '.tgz')
}
$package = (Resolve-Path -LiteralPath $PackagePath).Path
if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodePath = $nodeCommand.Source }
  else {
    $bundledRuntime = Join-Path $env:ProgramFiles 'Koishi/Desktop/bin/koishi.exe'
    if (Test-Path -LiteralPath $bundledRuntime) { $NodePath = $bundledRuntime }
  }
}
Push-Location $target
try {
  if (Test-Path -LiteralPath 'yarn.lock') {
    $release = Get-ChildItem -LiteralPath '.yarn/releases' -Filter 'yarn-*.cjs' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    $spec = 'koishi-plugin-chatluna-mail-mcp@file:' + $package.Replace('\','/')
    if ($release) {
      if (-not $NodePath) { throw 'Node was not found. Pass -NodePath with the Koishi bundled koishi.exe path.' }
      & $NodePath $release.FullName add $spec
    } else { yarn add $spec }
  } elseif (Test-Path -LiteralPath 'pnpm-lock.yaml') { pnpm add $package }
  else { npm install $package }
  if ($LASTEXITCODE -ne 0) { throw 'Package installation failed' }
} finally { Pop-Location }
Write-Host 'Package installed. Existing configuration/data retained. Reload Koishi to use the new version.'
