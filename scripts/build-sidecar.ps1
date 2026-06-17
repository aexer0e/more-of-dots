[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) {
    throw "Virtual environment missing. Run .\scripts\setup-runtime.ps1 first."
}

if (-not $SkipInstall) {
    & $Python -m pip install -e "$Root[dev]"
}

$TargetTriple = (& rustc --print host-tuple).Trim()
if (-not $TargetTriple) {
    throw 'Could not determine Rust target triple.'
}

$ProbeManifest = Join-Path $Root 'tools\python-probe-dll\Cargo.toml'
$ProbeDll = Join-Path $Root 'tools\python-probe-dll\target\release\wod_python_probe.dll'
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Cargo is required to build the Python probe DLL.'
}
& cargo build --manifest-path $ProbeManifest --release
if (-not (Test-Path $ProbeDll)) {
    throw "Rust build did not produce $ProbeDll"
}

$BinaryDir = Join-Path $Root 'src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $BinaryDir | Out-Null

$AddData = @(
    "$(Join-Path $Root 'scripts\local-runner.ps1');scripts",
    "$(Join-Path $Root 'scripts\invoke-python-probe.ps1');scripts",
    "$ProbeDll;tools\python-probe-dll\target\release"
)
$PyInstallerArgs = @(
    '--clean',
    '--noconfirm',
    '--noupx',
    '--onefile',
    '--name',
    'wod-replay-server'
)
foreach ($DataPath in $AddData) {
    $PyInstallerArgs += @('--add-data', $DataPath)
}
$PyInstallerArgs += @(
    '--hidden-import',
    'wod_replay_server.app',
    '--hidden-import',
    'wod_replay_server.desktop_cli',
    (Join-Path $Root 'wod_replay_server\sidecar.py')
)
& $Python -m PyInstaller @PyInstallerArgs

$BuiltExe = Join-Path $Root 'dist\wod-replay-server.exe'
if (-not (Test-Path $BuiltExe)) {
    throw "PyInstaller did not produce $BuiltExe"
}

$TauriExe = Join-Path $BinaryDir "wod-replay-server-$TargetTriple.exe"
Copy-Item -LiteralPath $BuiltExe -Destination $TauriExe -Force
Write-Host "Built Tauri sidecar: $TauriExe"
