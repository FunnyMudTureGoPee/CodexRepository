$ErrorActionPreference='Stop'
Push-Location (Split-Path $PSScriptRoot)
try {
  pnpm check
  if ($LASTEXITCODE -ne 0) { throw 'Checks failed' }
  New-Item -ItemType Directory -Path dist -Force | Out-Null
  pnpm pack --pack-destination dist
  if ($LASTEXITCODE -ne 0) { throw 'Pack failed' }
} finally { Pop-Location }
