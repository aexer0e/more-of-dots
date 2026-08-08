[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [string]$BundledVersionVault = $env:WOD_BUNDLED_VERSION_VAULT
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = Join-Path $Root '.venv\Scripts\python.exe'
# The recorder carries its own version. It ships far less often than the app, and
# its installer bundles a large game vault, so following the app's VERSION would
# force a full re-download for every app patch that left the payload untouched.
$VersionFile = Join-Path $Root 'wod_replay_server\RECORDER_VERSION'
$Version = (Get-Content -LiteralPath $VersionFile -Raw).Trim()
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "wod_replay_server\RECORDER_VERSION must contain a MAJOR.MINOR.PATCH version, found '$Version'."
}

function Invoke-RecorderSigning([string]$Path) {
    $Thumbprint = $env:WOD_SIGNING_CERTIFICATE_SHA1
    if (-not $Thumbprint) { return }
    $SignTool = (Get-Command signtool.exe -ErrorAction Stop).Source
    $TimestampUrl = if ($env:WOD_SIGNING_TIMESTAMP_URL) { $env:WOD_SIGNING_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
    & $SignTool sign /sha1 $Thumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $Path
    if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed for $Path" }
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw 'Virtual environment missing. Run .\scripts\setup-runtime.ps1 first.'
}

if (-not $SkipInstall) {
    & $Python -m pip install -e "$Root[dev]"
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
}

$DependencyRoot = Join-Path $Root 'build\dependencies'
New-Item -ItemType Directory -Force -Path $DependencyRoot | Out-Null

$ProbeManifest = Join-Path $Root 'tools\python-probe-dll\Cargo.toml'
$ProbeDll = Join-Path $Root 'tools\python-probe-dll\target\release\wod_python_probe.dll'
& cargo build --manifest-path $ProbeManifest --release
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ProbeDll -PathType Leaf)) {
    throw 'Rust did not produce the recorder probe DLL.'
}
Invoke-RecorderSigning -Path $ProbeDll

$RecorderOutputRoot = Join-Path $Root 'recorder-dist'
$DistRoot = Join-Path $RecorderOutputRoot 'more-of-dots-recorder'
$AddData = @(
    "$(Join-Path $Root 'scripts\local-runner.ps1');scripts",
    "$(Join-Path $Root 'scripts\invoke-python-probe.ps1');scripts",
    "$ProbeDll;tools\python-probe-dll\target\release",
    "$(Join-Path $Root 'wod_replay_server\supported_versions.json');wod_replay_server",
    "$VersionFile;wod_replay_server"
)
$Arguments = @(
    '--clean',
    '--noconfirm',
    '--noupx',
    '--console',
    '--onedir',
    '--contents-directory',
    'payload',
    '--distpath',
    $RecorderOutputRoot,
    '--optimize',
    '2',
    '--name',
    'more-of-dots-recorder'
)
foreach ($DataPath in $AddData) {
    $Arguments += @('--add-data', $DataPath)
}
$Arguments += @(
    '--hidden-import',
    'wod_replay_server.desktop_cli',
    (Join-Path $Root 'wod_replay_server\sidecar.py')
)
& $Python -m PyInstaller @Arguments
if ($LASTEXITCODE -ne 0) { throw 'Recorder packaging failed.' }

$RecorderExe = Join-Path $DistRoot 'more-of-dots-recorder.exe'
if (-not (Test-Path -LiteralPath $RecorderExe -PathType Leaf)) {
    throw "Recorder executable was not produced: $RecorderExe"
}
Invoke-RecorderSigning -Path $RecorderExe
Copy-Item -LiteralPath (Join-Path $Root 'scripts\recorder-third-party-notices.txt') -Destination (Join-Path $DistRoot 'THIRD-PARTY-NOTICES.txt') -Force

$Ffmpeg = $env:WOD_FFMPEG_PATH
if (-not $Ffmpeg) {
    $FfmpegCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if ($FfmpegCommand) { $Ffmpeg = $FfmpegCommand.Source }
}
if (-not $Ffmpeg) { throw 'FFmpeg is required to build the self-contained recorder.' }
$ResolvedFfmpeg = (Resolve-Path -LiteralPath $Ffmpeg).Path
$ChocolateyBin = if ($env:ChocolateyInstall) { Join-Path $env:ChocolateyInstall 'bin' } else { 'C:\ProgramData\chocolatey\bin' }
if ((Split-Path -Parent $ResolvedFfmpeg) -eq $ChocolateyBin) {
    $ChocolateyFfmpeg = Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $ChocolateyBin) 'lib') -Recurse -File -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -notlike "$ChocolateyBin*" } |
        Sort-Object Length -Descending |
        Select-Object -First 1
    if ($ChocolateyFfmpeg) { $ResolvedFfmpeg = $ChocolateyFfmpeg.FullName }
}
Copy-Item -LiteralPath $ResolvedFfmpeg -Destination (Join-Path $DistRoot 'ffmpeg.exe') -Force
$FfmpegRoot = Split-Path -Parent (Split-Path -Parent $ResolvedFfmpeg)
$FfmpegLicense = Join-Path $FfmpegRoot 'LICENSE'
$FfmpegReadme = Join-Path $FfmpegRoot 'README.txt'
if (Test-Path -LiteralPath $FfmpegLicense -PathType Leaf) {
    Copy-Item -LiteralPath $FfmpegLicense -Destination (Join-Path $DistRoot 'FFMPEG-LICENSE.txt') -Force
}
if (Test-Path -LiteralPath $FfmpegReadme -PathType Leaf) {
    Copy-Item -LiteralPath $FfmpegReadme -Destination (Join-Path $DistRoot 'FFMPEG-README.txt') -Force
}

$MakeNsisCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
    (Join-Path $env:ProgramFiles 'NSIS\makensis.exe')
)
$MakeNsisCommand = Get-Command makensis.exe -ErrorAction SilentlyContinue
if ($MakeNsisCommand) { $MakeNsisCandidates = @($MakeNsisCommand.Source) + $MakeNsisCandidates }
$ElectronBuilderNsis = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis') -File -Recurse -Filter 'makensis.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if ($ElectronBuilderNsis) { $MakeNsisCandidates += $ElectronBuilderNsis }
$MakeNsis = $MakeNsisCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $MakeNsis) {
    throw 'NSIS makensis.exe was not found. Install NSIS or build the main Tauri app once before building the recorder.'
}
$InstallerPath = Join-Path $RecorderOutputRoot "More.of.Dots.Recorder_${Version}_x64-setup.exe"
$NsisArguments = @('/V2', "/DRECORDER_DIR=$DistRoot", "/DOUTPUT_PATH=$InstallerPath", "/DPRODUCT_VERSION=$Version")
if (-not $BundledVersionVault) {
    $BundledVersionVault = Join-Path $env:LOCALAPPDATA 'More of Dots Recorder'
}
$ResolvedBundledVault = (Resolve-Path -LiteralPath $BundledVersionVault).Path
$BundledExportRoot = Join-Path $DependencyRoot "bundled-version-vault-$PID"
& $Python -m wod_replay_server.export_vault --source-home $ResolvedBundledVault --destination-home $BundledExportRoot
if ($LASTEXITCODE -ne 0) { throw 'Bundled game-version export failed.' }
$BundledVersions = Join-Path $BundledExportRoot 'versions'
if (-not (Test-Path -LiteralPath $BundledVersions -PathType Container)) {
    throw 'Bundled game-version export did not produce a versions folder.'
}
$NsisArguments += "/DBUNDLED_VERSIONS_DIR=$BundledVersions"

# The installer skips re-extracting an unchanged vault, which is most of the
# install time. That decision hangs on this identifier, so hash file contents
# rather than names and sizes; a silently stale vault would break recording in a
# way the user could not diagnose.
$VaultFiles = Get-ChildItem -LiteralPath $BundledVersions -File -Recurse | Sort-Object FullName
if (-not $VaultFiles) { throw 'Bundled game-version export produced no files.' }
$VaultDigest = [System.Security.Cryptography.SHA256]::Create()
try {
    $VaultLines = foreach ($File in $VaultFiles) {
        $Relative = $File.FullName.Substring($BundledVersions.Length).TrimStart('\')
        "$Relative`:$((Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
    }
    $VaultBytes = [System.Text.Encoding]::UTF8.GetBytes(($VaultLines -join "`n"))
    $BundledVersionsId = [System.BitConverter]::ToString($VaultDigest.ComputeHash($VaultBytes)).Replace('-', '').ToLowerInvariant()
} finally {
    $VaultDigest.Dispose()
}
$NsisArguments += "/DBUNDLED_VERSIONS_ID=$BundledVersionsId"

# The installer also confirms this build is really on disk before trusting the
# marker, so a hand-deleted vault is repaired instead of skipped.
$BundledProbe = Get-ChildItem -LiteralPath $BundledVersions -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'game\game.exe') -PathType Leaf } |
    Sort-Object Name |
    Select-Object -First 1
if (-not $BundledProbe) { throw 'Bundled game-version export contains no version with game\game.exe.' }
$NsisArguments += "/DBUNDLED_VERSIONS_PROBE=$($BundledProbe.Name)"

$NsisArguments += (Join-Path $Root 'scripts\recorder-installer.nsi')
& $MakeNsis @NsisArguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw 'NSIS did not produce the recorder installer.'
}
Invoke-RecorderSigning -Path $InstallerPath

$PackageBytes = (Get-ChildItem -LiteralPath $DistRoot -File -Recurse | Measure-Object -Property Length -Sum).Sum
$PackageSize = [Math]::Round(($PackageBytes / 1MB), 2)
Write-Host "Built separate recorder package: $DistRoot ($PackageSize MB)"
Write-Host "Built recorder NSIS installer: $InstallerPath"
