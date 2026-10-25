# Writes the built-in map table of a running War of Dots to a JSON file, for
# import-game-maps.py. Start the game and wait for its main menu first.
[CmdletBinding()]
param(
    [string]$Output,
    [int]$TimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Output) { $Output = Join-Path $repo 'build\game-maps.json' }

$game = Get-Process -Name game -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\War of Dots\game.exe' } | Select-Object -First 1
if (-not $game) { throw 'War of Dots is not running. Start it and wait for the main menu.' }

$probe = Join-Path $repo 'tools\python-probe-dll\target\release\wod_python_probe.dll'
if (-not (Test-Path -LiteralPath $probe)) {
    & cargo build --release --quiet --manifest-path (Join-Path $repo 'tools\python-probe-dll\Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw 'The probe did not build.' }
}

# The probe runs the payload beside its own copy; Windows loads a path only once per process.
$work = Join-Path ([IO.Path]::GetTempPath()) ("mod-game-maps-" + [DateTime]::UtcNow.Ticks)
New-Item -ItemType Directory -Force -Path $work | Out-Null
$dll = Join-Path $work ("wod_python_probe_" + [DateTime]::UtcNow.Ticks + ".dll")
Copy-Item -LiteralPath $probe -Destination $dll
$result = Join-Path $work 'game-maps.json'
$payload = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dump-game-maps-payload.py') -Raw).Replace('__OUTPUT_PATH__', $result)
Set-Content -LiteralPath (Join-Path $work 'wod_python_probe_payload.py') -Value $payload -Encoding utf8

& (Join-Path $PSScriptRoot 'invoke-python-probe.ps1') -ProcessId $game.Id -ProbeDll $dll -TimeoutSeconds 30

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $result) -and -not (Test-Path -LiteralPath "$result.error.txt")) { Start-Sleep -Milliseconds 250 }
if (Test-Path -LiteralPath "$result.error.txt") { throw (Get-Content -LiteralPath "$result.error.txt" -Raw) }
if (-not (Test-Path -LiteralPath $result)) {
    $status = Join-Path $work 'wod_python_probe.status.json'
    throw ('The game did not answer. ' + $(if (Test-Path -LiteralPath $status) { Get-Content -LiteralPath $status -Raw } else { '' }))
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
Copy-Item -LiteralPath $result -Destination $Output -Force
Write-Host "Wrote $Output"
