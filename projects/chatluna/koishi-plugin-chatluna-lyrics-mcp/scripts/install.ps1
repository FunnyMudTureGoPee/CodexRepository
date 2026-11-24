param(
    [Parameter(Mandatory = $true)]
    [string]$KoishiDir,
    [string]$PackagePath
)

$ErrorActionPreference = "Stop"
$target = (Resolve-Path -LiteralPath $KoishiDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $target "package.json"))) {
    throw "KoishiDir must contain package.json: $target"
}

if (-not $PackagePath) {
    $packages = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "koishi-plugin-chatluna-lyrics-mcp-*.tgz"
    if ($packages.Count -ne 1) {
        throw "Place exactly one plugin .tgz beside install.ps1 or pass -PackagePath."
    }
    $PackagePath = $packages[0].FullName
}
$package = (Resolve-Path -LiteralPath $PackagePath).Path

Push-Location $target
try {
    if (Test-Path -LiteralPath "pnpm-lock.yaml") {
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $pnpm) {
            throw "This Koishi instance uses pnpm, but pnpm is not available in PATH. Install pnpm first or run Corepack."
        }
        & $pnpm.Source add $package
    } elseif (Test-Path -LiteralPath "yarn.lock") {
        $bundledYarn = Get-ChildItem -LiteralPath (Join-Path $target ".yarn\releases") -Filter "yarn-*.cjs" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            Select-Object -First 1
        if ($bundledYarn) {
            $node = Get-Command node -ErrorAction SilentlyContinue
            if (-not $node) {
                throw "This Koishi instance includes Yarn, but node is not available in PATH. Run this script from Koishi's Node environment."
            }
            & $node.Source $bundledYarn.FullName add $package
        } else {
            $yarn = Get-Command yarn -ErrorAction SilentlyContinue
            if (-not $yarn) {
                throw "This Koishi instance uses Yarn, but neither bundled Yarn nor yarn in PATH was found."
            }
            & $yarn.Source add $package
        }
    } else {
        $npm = Get-Command npm -ErrorAction SilentlyContinue
        if (-not $npm) {
            throw "npm is not available in PATH. Install Node.js or run this script from Koishi's Node environment."
        }
        & $npm.Source install $package
    }
    if ($LASTEXITCODE -ne 0) { throw "Package manager exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}

Write-Host "Installed koishi-plugin-chatluna-lyrics-mcp. Enable it in the Koishi console; existing configuration was not modified."
