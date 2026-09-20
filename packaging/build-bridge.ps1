$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $projectRoot 'desktop\src-tauri'
$resourceRoot = Join-Path $tauriRoot 'resources\bridge'
$workRoot = Join-Path $tauriRoot 'target\pyinstaller'
$distRoot = Join-Path $workRoot 'dist'
$entryPoint = Join-Path $PSScriptRoot 'bridge_entry.py'
$builtBridge = Join-Path $distRoot 'benchcat-bridge'
$resourceRoot = [System.IO.Path]::GetFullPath($resourceRoot)
$expectedResourceParent = [System.IO.Path]::GetFullPath((Join-Path $tauriRoot 'resources'))
if (-not $resourceRoot.StartsWith("$expectedResourceParent\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a path outside the project resource directory: $resourceRoot"
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python 3.11 or newer is required to build the bridge.'
}

python -c "import PyInstaller; from importlib.metadata import version; assert version('pysoem') == '1.1.13'"
if ($LASTEXITCODE -ne 0) {
    throw 'PyInstaller is missing or pysoem is not version 1.1.13. Run: python -m pip install -e ".[dev]"'
}

New-Item -ItemType Directory -Force -Path $workRoot, $distRoot | Out-Null

python -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --name benchcat-bridge `
    --distpath $distRoot `
    --workpath (Join-Path $workRoot 'work') `
    --specpath $workRoot `
    --paths (Join-Path $projectRoot 'src') `
    --collect-data ethercat_debug_tool `
    --hidden-import pysoem `
    $entryPoint

if ($LASTEXITCODE -ne 0) {
    throw "Python bridge build failed with exit code $LASTEXITCODE."
}

if (Test-Path -LiteralPath $resourceRoot) {
    Remove-Item -LiteralPath $resourceRoot -Recurse -Force
}
Copy-Item -LiteralPath $builtBridge -Destination $resourceRoot -Recurse
New-Item -ItemType File -Force -Path (Join-Path $resourceRoot '.gitkeep') | Out-Null
Write-Host "Bridge onedir resource: $resourceRoot" -ForegroundColor Green
