[CmdletBinding()]
param(
    [int]$TimeoutSeconds = 120,
    [string]$WindowStrategy = $(if ($env:WOD_GAME_WINDOW_STRATEGY) { $env:WOD_GAME_WINDOW_STRATEGY } else { 'offscreen' })
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Runtime = if ($env:WOD_RUNTIME_DIR) { $env:WOD_RUNTIME_DIR } else { Join-Path $Root 'runtime' }
$Runner = Join-Path $PSScriptRoot 'local-runner.ps1'

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Runner `
    -Calibrate `
    -ShareRoot $Runtime `
    -WindowStrategy $WindowStrategy
