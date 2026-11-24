param(
    [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$projectRoot = [IO.Path]::GetFullPath($projectDirectory).TrimEnd('\') + '\'
$outputPath = [IO.Path]::GetFullPath((Join-Path $projectDirectory $OutputDirectory))
if (-not ($outputPath + '\').StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must stay inside the plugin project: $outputPath"
}

Push-Location $projectDirectory
try {
    if (Test-Path -LiteralPath "pnpm-lock.yaml") {
        pnpm install --frozen-lockfile
        pnpm check
        $packTool = "pnpm"
    } elseif (Test-Path -LiteralPath "yarn.lock") {
        yarn install --immutable
        yarn check
        $packTool = "npm"
    } else {
        npm install
        npm run check
        $packTool = "npm"
    }

    if (Test-Path -LiteralPath $outputPath) {
        Remove-Item -LiteralPath $outputPath -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
    if ($packTool -eq "pnpm") {
        pnpm pack --pack-destination $outputPath
    } else {
        npm pack --pack-destination $outputPath
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install.ps1") -Destination $outputPath -Force
    Copy-Item -LiteralPath (Join-Path $projectDirectory "examples\lyrics.csv") -Destination $outputPath -Force
    Copy-Item -LiteralPath (Join-Path $projectDirectory "examples\chatluna-mcp.json") -Destination $outputPath -Force
} finally {
    Pop-Location
}
