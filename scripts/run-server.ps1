[CmdletBinding()]
param(
    [string]$HostName = $(if ($env:WOD_HOST) { $env:WOD_HOST } else { '127.0.0.1' }),
    [int]$Port = $(if ($env:WOD_PORT) { [int]$env:WOD_PORT } else { 8787 })
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) {
    throw "Virtual environment missing. Run .\scripts\setup-runtime.ps1 first."
}

& $Python -m uvicorn wod_replay_server.app:app --host $HostName --port $Port
