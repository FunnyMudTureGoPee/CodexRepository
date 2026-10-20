<#
.SYNOPSIS
  自动升级 koishi-plugin-chatluna-mail-mcp 到当前项目版本。

.DESCRIPTION
  检测 Koishi 实例目录，校验安装包 SHA256，备份实例配置、锁文件和旧插件代码（含 bak 补丁），
  使用实例现有的 Yarn / pnpm / npm 安装本地 tgz，并验证安装后的版本。
  默认不结束、不重启正在运行的 Koishi；请先退出 Koishi Desktop。

.PARAMETER KoishiDir
  Koishi 实例目录（包含 package.json 的目录）。默认自动检测
  %APPDATA%\Koishi\Desktop\data\instances\default，找不到时搜索同级实例。

.PARAMETER PackagePath
  安装包 tgz 路径。默认使用 dist/<name>-<version>.tgz。

.PARAMETER NodePath
  Node 可执行文件路径。Yarn Berry 需要；默认使用 PATH 中的 node，
  否则使用 Koishi 自带 koishi.exe。

.PARAMETER BackupDir
  备份目录。默认 <实例>\backups\koishi-plugin-chatluna-mail-mcp\<时间>。

.PARAMETER SkipBackup
  跳过 package.json / 锁文件备份。不建议。

.PARAMETER Force
  Koishi 正在运行时仍继续安装。可能出现文件占用或安装失败。

.PARAMETER NoVerifyHash
  跳过 tgz 的 SHA256 校验。不建议。

.PARAMETER DryRun
  只检测并打印将执行的操作，不备份、不安装、不修改文件。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1 -KoishiDir 'D:\Koishi\instances\default'
#>
[CmdletBinding()]
param(
  [string]$KoishiDir,
  [string]$PackagePath,
  [string]$NodePath,
  [string]$BackupDir,
  [switch]$SkipBackup,
  [switch]$Force,
  [switch]$NoVerifyHash,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$pluginName = 'koishi-plugin-chatluna-mail-mcp'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

Write-Step '检查项目和安装包'
$projectMetaPath = Join-Path $projectRoot 'package.json'
if (-not (Test-Path -LiteralPath $projectMetaPath)) { throw "找不到项目 package.json：$projectMetaPath" }
$projectMeta = Get-Content -LiteralPath $projectMetaPath -Raw | ConvertFrom-Json
if ($projectMeta.name -ne $pluginName) { throw "项目 package.json 名称不是 $pluginName" }
$expectedVersion = [string]$projectMeta.version

if (-not $PackagePath) {
  $PackagePath = Join-Path $projectRoot ('dist\' + $pluginName + '-' + $expectedVersion + '.tgz')
}
if (-not (Test-Path -LiteralPath $PackagePath)) {
  throw "找不到目标版本安装包：$PackagePath。请先构建/复制对应版本，不会自动回退到旧包。"
}
$packagePathResolved = (Resolve-Path -LiteralPath $PackagePath).Path
Write-Ok "安装包：$packagePathResolved"

if ($NoVerifyHash) {
  Write-Warn '已跳过 SHA256 校验'
} else {
  $hashFile = $packagePathResolved + '.sha256'
  if (-not (Test-Path -LiteralPath $hashFile)) {
    throw "缺少哈希文件：$hashFile（可用 -NoVerifyHash 跳过，但不建议）"
  }
  $expectedHash = ((Get-Content -LiteralPath $hashFile -Raw).Trim() -split '\s+')[0]
  $actualHash = (Get-FileHash -LiteralPath $packagePathResolved -Algorithm SHA256).Hash
  if ($actualHash.ToLowerInvariant() -ne $expectedHash.ToLowerInvariant()) {
    throw "SHA256 不匹配：期望 $expectedHash，实际 $actualHash"
  }
  Write-Ok "SHA256 校验通过：$actualHash"
}

Write-Step '定位 Koishi 实例'
$instancesRoot = Join-Path $env:APPDATA 'Koishi/Desktop/data/instances'
if ($KoishiDir) {
  if (-not (Test-Path -LiteralPath $KoishiDir)) { throw "指定的 KoishiDir 不存在：$KoishiDir" }
  $instanceDir = (Resolve-Path -LiteralPath $KoishiDir).Path
} else {
  $defaultDir = Join-Path $instancesRoot 'default'
  if (Test-Path -LiteralPath (Join-Path $defaultDir 'package.json')) {
    $instanceDir = $defaultDir
  } else {
    $found = @()
    if (Test-Path -LiteralPath $instancesRoot) {
      $found = @(Get-ChildItem -LiteralPath $instancesRoot -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') } |
        ForEach-Object { $_.FullName })
    }
    if ($found.Count -eq 0) {
      throw '未找到 Koishi 实例。请用 -KoishiDir 指定包含 package.json 的实例目录。'
    }
    if ($found.Count -gt 1) {
      throw ("找到多个 Koishi 实例，请用 -KoishiDir 指定：`n  - " + ($found -join "`n  - "))
    }
    $instanceDir = $found[0]
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $instanceDir 'package.json'))) {
  throw "实例目录缺少 package.json：$instanceDir"
}
Write-Ok "实例目录：$instanceDir"

Write-Step '检查 Koishi 进程'
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*koishi*' })
if ($running.Count -gt 0) {
  $pids = ($running | ForEach-Object { $_.Id }) -join ', '
  $message = "检测到 Koishi 进程（PID: $pids）。安装时可能发生文件占用，请先退出 Koishi Desktop。"
  if ($DryRun) {
    Write-Warn $message
  } elseif (-not $Force) {
    throw ($message + "`n如确认可以强制安装，请加 -Force。")
  } else {
    Write-Warn ($message + ' 已指定 -Force，继续。')
  }
} else {
  Write-Ok '未检测到正在运行的 Koishi 进程'
}

Write-Step '检查 Node 运行时'
if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $NodePath = $nodeCommand.Source
  } else {
    $bundledRuntime = Join-Path $env:ProgramFiles 'Koishi/Desktop/bin/koishi.exe'
    if (Test-Path -LiteralPath $bundledRuntime) { $NodePath = $bundledRuntime }
  }
}
if ($NodePath) { Write-Ok "Node：$NodePath" } else { Write-Warn '未找到 node；Yarn Berry 安装会失败，可用 -NodePath 指定。' }

$installedRoot = Join-Path $instanceDir ('node_modules\' + $pluginName)
$installedPackagePath = Join-Path $installedRoot 'package.json'
$oldVersion = '未安装'
if (Test-Path -LiteralPath $installedPackagePath) {
  try {
    $oldVersion = [string](Get-Content -LiteralPath $installedPackagePath -Raw | ConvertFrom-Json).version
  } catch {
    $oldVersion = '未知'
  }
}
Write-Ok "当前版本：$oldVersion；目标版本：$expectedVersion"
if ($oldVersion -eq $expectedVersion) {
  Write-Warn '当前已安装目标版本，脚本将重新安装并覆盖现有文件。'
}

if (-not $DryRun -and -not $SkipBackup) {
  Write-Step '备份实例配置'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  if (-not $BackupDir) {
    $BackupDir = Join-Path $instanceDir ('backups\' + $pluginName + '\' + $stamp)
  }
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  foreach ($name in @('package.json', 'yarn.lock', 'pnpm-lock.yaml', 'package-lock.json', 'koishi.yml', '.yarnrc.yml')) {
    $source = Join-Path $instanceDir $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $BackupDir $name) -Force
    }
  }
  if (Test-Path -LiteralPath $installedPackagePath) {
    Copy-Item -LiteralPath $installedPackagePath -Destination (Join-Path $BackupDir 'installed-package.json') -Force
    $installedLib = Join-Path $installedRoot 'lib'
    if (Test-Path -LiteralPath $installedLib) {
      Copy-Item -LiteralPath $installedLib -Destination (Join-Path $BackupDir 'installed-lib') -Recurse -Force
      Write-Ok '旧插件 lib（含 bak 文件）已备份'
    }
  }
  @(
    'time=' + (Get-Date).ToString('s'),
    'instance=' + $instanceDir,
    'from=' + $oldVersion,
    'to=' + $expectedVersion,
    'package=' + $packagePathResolved
  ) | Set-Content -LiteralPath (Join-Path $BackupDir 'backup-info.txt') -Encoding UTF8
  Write-Ok "备份目录：$BackupDir"
} elseif ($SkipBackup) {
  Write-Warn '已跳过备份'
}

$dryRunText = if ($DryRun) { '（DryRun，不执行）' } else { '' }
Write-Step ('安装 / 升级插件' + $dryRunText)
$release = $null
$spec = $pluginName + '@file:' + $packagePathResolved.Replace('\', '/')
$installKind = ''
try {
  Push-Location -LiteralPath $instanceDir
  try {
    if (Test-Path -LiteralPath 'yarn.lock') {
      $release = Get-ChildItem -LiteralPath '.yarn/releases' -Filter 'yarn-*.cjs' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
      if ($release) {
        if (-not $NodePath) { throw 'Yarn Berry 需要 Node。请安装 Node 或使用 -NodePath 指定 koishi.exe。' }
        $installKind = 'yarn-berry'
        Write-Host "    执行：`"$NodePath`" `"$($release.FullName)`" add `"$spec`""
      } elseif (Get-Command yarn -ErrorAction SilentlyContinue) {
        $installKind = 'yarn'
        Write-Host "    执行：yarn add `"$spec`""
      } else {
        throw '检测到 yarn.lock，但找不到 Yarn 运行时。'
      }
    } elseif (Test-Path -LiteralPath 'pnpm-lock.yaml') {
      if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw '检测到 pnpm-lock.yaml，但 PATH 中没有 pnpm。' }
      $installKind = 'pnpm'
      Write-Host "    执行：pnpm add `"$packagePathResolved`""
    } else {
      if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw '未检测到 Yarn/pnpm，且 PATH 中没有 npm。' }
      $installKind = 'npm'
      Write-Host "    执行：npm install --no-audit --no-fund `"$packagePathResolved`""
    }

    if (-not $DryRun) {
      if ($installKind -eq 'yarn-berry') {
        & $NodePath $release.FullName add $spec
      } elseif ($installKind -eq 'yarn') {
        & yarn add $spec
      } elseif ($installKind -eq 'pnpm') {
        & pnpm add $packagePathResolved
      } else {
        & npm install --no-audit --no-fund $packagePathResolved
      }
      if ($LASTEXITCODE -ne 0) { throw "安装命令失败，退出码：$LASTEXITCODE" }
    }
  } finally {
    Pop-Location
  }

  if (-not $DryRun) {
    Write-Step '验证安装结果'
    if (-not (Test-Path -LiteralPath $installedPackagePath)) {
      throw "安装后找不到 $installedPackagePath"
    }
    $installedVersion = [string](Get-Content -LiteralPath $installedPackagePath -Raw | ConvertFrom-Json).version
    if ($installedVersion -ne $expectedVersion) {
      throw "安装版本 $installedVersion 与预期 $expectedVersion 不一致"
    }
    foreach ($relative in @('lib\index.cjs', 'console\index.js')) {
      if (-not (Test-Path -LiteralPath (Join-Path $installedRoot $relative))) {
        throw "安装结果缺少 $relative"
      }
    }
    Write-Ok "已安装版本：$installedVersion"
  }
} catch {
  $failure = $_
  if (-not $DryRun -and -not $SkipBackup -and $BackupDir -and (Test-Path -LiteralPath $BackupDir)) {
    Write-Warn '安装失败，正在恢复 package.json 和锁文件...'
    foreach ($name in @('package.json', 'yarn.lock', 'pnpm-lock.yaml', 'package-lock.json', 'koishi.yml', '.yarnrc.yml')) {
      $backupFile = Join-Path $BackupDir $name
      if (Test-Path -LiteralPath $backupFile) {
        Copy-Item -LiteralPath $backupFile -Destination (Join-Path $instanceDir $name) -Force
      }
    }
    Write-Warn "已恢复配置备份。旧版 node_modules 可能已被替换；如仍不可用，请重新安装上一版 tgz。备份：$BackupDir"
  }
  throw $failure
}

if ($DryRun) {
  Write-Host "`nDryRun 完成：未修改任何文件。" -ForegroundColor Cyan
  return
}

Write-Host "`n升级完成：$oldVersion -> $expectedVersion" -ForegroundColor Green
Write-Host '后续步骤：'
Write-Host '  1. 重启 Koishi Desktop，或重新加载邮件插件。'
Write-Host '  2. 刷新浏览器中的 Console 页面。'
Write-Host '  3. 在 ChatLuna 中断开并重新连接邮件 MCP，使 14 个工具声明生效。'
