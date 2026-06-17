[CmdletBinding()]
param(
    [string]$SteamGameDir = $env:WOD_STEAM_GAME_DIR,
    [switch]$SkipInstall,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'

if (-not $SteamGameDir) {
    $SteamGameDir = 'C:\Program Files (x86)\Steam\steamapps\common\War of Dots'
}

if (-not (Test-Path $VenvPython)) {
    py -3.13 -m venv (Join-Path $Root '.venv')
}

if (-not $SkipInstall) {
    & $VenvPython -m pip install --upgrade pip
    & $VenvPython -m pip install -e "$Root[dev]"
}

$Runtime = Join-Path $Root 'runtime'
$Jobs = Join-Path $Runtime 'jobs'
$Profiles = Join-Path $Runtime 'address-profiles'
$Secrets = Join-Path $Root 'secrets'
New-Item -ItemType Directory -Force -Path $Runtime, $Jobs, $Profiles, $Secrets | Out-Null

$StageArgs = @(
    '-m', 'wod_replay_server.stage_game',
    '--source', $SteamGameDir,
    '--destination', (Join-Path $Runtime 'staged-game')
)
if ($DryRun) {
    $StageArgs += '--dry-run'
}

& $VenvPython @StageArgs
