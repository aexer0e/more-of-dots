[CmdletBinding()]
param(
    [int]$ProcessId = 0,
    [string]$OutputRoot = "",
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$templatePath = Join-Path $repoRoot 'tools\runtime-map\runtime_probe.py'
$probeSource = Join-Path $repoRoot 'tools\python-probe-dll\target\release\wod_python_probe.dll'
$injector = Join-Path $repoRoot 'scripts\invoke-python-probe.ps1'

if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) { throw "Runtime probe template not found: $templatePath" }
if (-not (Test-Path -LiteralPath $probeSource -PathType Leaf)) { throw "Build the Python probe DLL first: $probeSource" }
if (-not (Test-Path -LiteralPath $injector -PathType Leaf)) { throw "Probe injector not found: $injector" }

$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'game.exe'" | Where-Object {
    $_.ProcessId -gt 0 -and $_.ExecutablePath -and $_.ExecutablePath -notmatch '\\staged-game\\|\\jobs\\.*\\game-runtime\\'
})
if ($ProcessId -gt 0) {
    $processes = @($processes | Where-Object { [int]$_.ProcessId -eq $ProcessId })
}
if ($processes.Count -ne 1) {
    throw "Expected exactly one live War of Dots game.exe process, found $($processes.Count). Pass -ProcessId when needed."
}
$gameProcess = $processes[0]
$gamePath = [System.IO.Path]::GetFullPath([string]$gameProcess.ExecutablePath)
$gameRoot = [System.IO.Path]::GetDirectoryName($gamePath)

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot 'docs\runtime-map\snapshots'
}
$resolvedOutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Force -Path $resolvedOutputRoot | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$snapshotRoot = Join-Path $resolvedOutputRoot ("{0}-pid{1}" -f $stamp, $gameProcess.ProcessId)
New-Item -ItemType Directory -Force -Path $snapshotRoot | Out-Null

$probeDll = Join-Path $snapshotRoot ("wod_python_probe_{0}.dll" -f $stamp)
$payloadPath = Join-Path $snapshotRoot 'wod_python_probe_payload.py'
$runtimePath = Join-Path $snapshotRoot 'runtime.json'
$statusPath = Join-Path $snapshotRoot 'wod_python_probe.status.json'
Copy-Item -LiteralPath $probeSource -Destination $probeDll
$escapedRuntimePath = $runtimePath.Replace('\', '\\').Replace('"', '\"')
$payload = (Get-Content -LiteralPath $templatePath -Raw -Encoding UTF8).Replace('__OUTPUT_PATH__', $escapedRuntimePath)
[System.IO.File]::WriteAllText($payloadPath, $payload, [System.Text.UTF8Encoding]::new($false))

$processMetadata = [ordered]@{
    capturedAt = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    processId = [int]$gameProcess.ProcessId
    executablePath = $gamePath
    commandLine = [string]$gameProcess.CommandLine
    creationDate = [string]$gameProcess.CreationDate
    executableVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($gamePath) | Select-Object FileVersion,ProductVersion,FileDescription,ProductName
    executableSha256 = (Get-FileHash -LiteralPath $gamePath -Algorithm SHA256).Hash.ToLowerInvariant()
}
$processMetadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $snapshotRoot 'process.json') -Encoding UTF8

& $injector -ProcessId ([int]$gameProcess.ProcessId) -ProbeDll $probeDll -TimeoutSeconds $TimeoutSeconds | Out-Host
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
    $status = if (Test-Path -LiteralPath $statusPath) { Get-Content -LiteralPath $statusPath -Raw } else { 'no probe status' }
    throw "Runtime probe did not produce runtime.json ($status)"
}
$summaryPath = Join-Path $snapshotRoot 'summary.json'
$summarizer = Join-Path $repoRoot 'tools\runtime-map\summarize_snapshot.py'
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if ($null -eq $pythonCommand) { throw 'python.exe is required to summarize the case-sensitive runtime archive.' }
$metricsText = & $pythonCommand.Source $summarizer $runtimePath $summaryPath
if ($LASTEXITCODE -ne 0) { throw 'Runtime snapshot summarization failed.' }
$metrics = $metricsText | ConvertFrom-Json
$artifactInventory = Join-Path $repoRoot 'tools\runtime-map\inventory_artifacts.py'
& $pythonCommand.Source $artifactInventory $gameRoot (Join-Path $snapshotRoot 'artifacts.json')
if ($LASTEXITCODE -ne 0) { throw 'Game artifact inventory failed.' }

$hashExtensions = @('.exe', '.dll', '.pyd', '.py', '.json', '.txt')
$fileManifest = foreach ($file in Get-ChildItem -LiteralPath $gameRoot -Recurse -File -ErrorAction SilentlyContinue) {
    if (-not $file.FullName.StartsWith($gameRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "File inventory escaped the game root: $($file.FullName)"
    }
    $relative = $file.FullName.Substring($gameRoot.Length).TrimStart('\')
    $shouldHash = $hashExtensions -contains $file.Extension.ToLowerInvariant() -or $relative -like 'assets\zolamare_maps\*'
    [ordered]@{
        path = $relative
        size = $file.Length
        modifiedUtc = $file.LastWriteTimeUtc.ToString('o')
        sha256 = if ($shouldHash) { (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    }
}
$fileManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $snapshotRoot 'game-files.json') -Encoding UTF8

Remove-Item -LiteralPath $probeDll -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue

[ordered]@{
    status = 'captured'
    snapshotRoot = $snapshotRoot
    runtimeBytes = (Get-Item -LiteralPath $runtimePath).Length
    gameFileCount = @($fileManifest).Count
    classCount = $metrics.classCount
    instanceCount = $metrics.instanceCount
    targetClassCount = $metrics.targetClassCount
} | ConvertTo-Json -Depth 8
