# Install dsh-turn-cost into a DSH profile as a plugin bundle.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile custom
#
# The plugin center only lists a package that is a profile dependency AND
# declares `dsh.bundle.patch`. This script installs the package that way:
#   1. pnpm adds the package (a `link:` dependency, so edits stay live);
#   2. the package is appended to `dsh.profile.bundles`;
#   3. the profile's `cordis.patch.yml` only needs config overrides now.
#
# The script is idempotent: an already-selected bundle is left untouched.

param(
  [string]$ProfileDir = $env:DSH_PROFILE_DIR,
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' })
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
  $ProfileDir = Join-Path $HOME ".dsh\profiles\$Profile"
}
if (-not (Test-Path $ProfileDir)) {
  throw "profile directory not found: $ProfileDir"
}
$ProfileDir = (Resolve-Path $ProfileDir).Path

$source = (Resolve-Path $PSScriptRoot).Path
$manifestPath = Join-Path $ProfileDir 'package.json'
$lockPath = Join-Path $ProfileDir 'pnpm-lock.yaml'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'

if (-not (Test-Path $manifestPath)) {
  throw "profile manifest not found: $manifestPath (open DeepSeek Harness once to initialize the profile)"
}

# 1. Read and validate this package before touching the profile.
$plugin = Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
$name = $plugin.name
$bundlePatch = $plugin.dsh.bundle.patch
if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($bundlePatch)) {
  throw "this package must declare name and dsh.bundle.patch in package.json"
}
$bundlePatchPath = Join-Path $source $bundlePatch
if (-not (Test-Path $bundlePatchPath)) {
  throw "declared bundle patch not found: $bundlePatchPath"
}
$bundleText = Get-Content $bundlePatchPath -Raw
if ($bundleText -notmatch "name:\s*$([regex]::Escape($name))") {
  throw "$bundlePatch does not mount '$name'"
}

Write-Host "profile : $ProfileDir"
Write-Host "plugin  : $source ($name)"
Write-Host "bundle  : $bundlePatchPath"

# 2. Install the dependency only when it is not already recorded.
$profileManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$dependencySpec = $profileManifest.dependencies.$name
$alreadySelected = @($profileManifest.dsh.profile.bundles) -contains $name

if ([string]::IsNullOrWhiteSpace($dependencySpec)) {
  # Resolve the Desktop runtime's own pnpm first (the running app ships one);
  # fall back to pnpm on PATH for CLI profiles.
  $desktop = Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dsh-desktop-host' } |
    Select-Object -First 1
  $node = $null
  $pnpm = $null
  if ($null -ne $desktop -and $desktop.ExecutablePath) {
    $root = Split-Path -Parent $desktop.ExecutablePath
    $candidateNode = Join-Path $root 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    $candidatePnpm = Join-Path $root 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
    if ((Test-Path $candidateNode) -and (Test-Path $candidatePnpm)) {
      $node = $candidateNode
      $pnpm = $candidatePnpm
    }
  }
  if ($null -eq $pnpm) {
    $command = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $command) {
      throw "pnpm was not found; install pnpm or run this script from a DSH environment"
    }
    $pnpm = $command.Source
  }

  # A legacy manual install left a junction here; pnpm replaces it with its own link.
  $link = Join-Path $ProfileDir "node_modules\$name"
  if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
      Remove-Item $link -Force
    }
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($file in @($manifestPath, $lockPath)) {
    if (Test-Path $file) {
      Copy-Item -LiteralPath $file -Destination "$file.bak-$name-$stamp"
      Write-Host "backup  : $file.bak-$name-$stamp"
    }
  }

  Write-Host 'install : pnpm add ...'
  Push-Location $ProfileDir
  try {
    if ($null -ne $node) {
      & $node $pnpm add "link:$source"
    } else {
      & $pnpm add "link:$source"
    }
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm add failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "install : dependency already recorded ($dependencySpec); pnpm skipped"
}

# 3. Select the bundle. The plugin manager treats the selected list as enabled.
$profileManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$bundles = @($profileManifest.dsh.profile.bundles)
if (-not ($bundles -contains $name)) {
  if ($null -eq $profileManifest.dsh) { $profileManifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
  if ($null -eq $profileManifest.dsh.profile) { $profileManifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
  if ($null -eq $profileManifest.dsh.profile.bundles) { $profileManifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }
  $profileManifest.dsh.profile.bundles = @($profileManifest.dsh.profile.bundles) + $name
  $json = $profileManifest | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "select  : appended $name to dsh.profile.bundles"
} else {
  Write-Host "select  : $name already in dsh.profile.bundles"
}

# 4. The bundle patch inserts the row; the profile layer only overrides config.
if ((Test-Path $patchPath) -and (Select-String -Path $patchPath -Pattern "id:\s*$([regex]::Escape('turn-cost'))" -Quiet)) {
  Write-Host 'patch   : turn-cost override present; left untouched'
} else {
  Write-Host 'patch   : no config override; bundle defaults apply (OPTIONAL)'
}

Write-Host ''
Write-Host 'Done. The browser half hot-reloads; the host half (price book route) is'
Write-Host 'loaded at profile start, so restart DeepSeek Harness if the next line 404s:'
Write-Host '  http://127.0.0.1:58566/dsh-turn-cost/prices.json'
