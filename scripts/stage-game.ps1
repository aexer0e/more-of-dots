[CmdletBinding()]
param(
    [string]$Source = $(if ($env:WOD_STEAM_GAME_DIR) { $env:WOD_STEAM_GAME_DIR } else { 'C:\Program Files (x86)\Steam\steamapps\common\War of Dots' }),
    [string]$Destination,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) {
    $Python = 'python'
}
if (-not $Destination) {
    $Destination = Join-Path $Root 'runtime\staged-game'
}

$ArgsList = @('-m', 'wod_replay_server.stage_game', '--source', $Source, '--destination', $Destination)
if ($DryRun) {
    $ArgsList += '--dry-run'
}
& $Python @ArgsList
