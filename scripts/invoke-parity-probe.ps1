[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$GameDirectory,
    [Parameter(Mandatory=$true)][string]$WorkDirectory,
    [Parameter(Mandatory=$true)][string]$Payload,
    [Parameter(Mandatory=$true)][string]$Configuration,
    [string]$ProbeDll,
    [int]$StartupWaitSeconds = 5,
    [int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = (Resolve-Path -LiteralPath $GameDirectory).Path
$work = [IO.Path]::GetFullPath($WorkDirectory)
New-Item -ItemType Directory -Force -Path $work | Out-Null
# Every invocation owns the disposable runtime until its game process exits.
$leasePath = Join-Path $work '.runtime-probe.lock'
$leaseDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(3700, $TimeoutSeconds + 100))
$runtimeLease = $null
while (-not $runtimeLease) {
    try { $runtimeLease = [IO.File]::Open($leasePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] {
        if ([DateTime]::UtcNow -ge $leaseDeadline) { throw 'Isolated runtime is still owned by another native capture' }
        Start-Sleep -Milliseconds 250
    }
}
try {
    $runtime = Join-Path $work 'game'
    if (-not (Test-Path -LiteralPath $runtime)) {
        New-Item -ItemType Directory -Force -Path $runtime | Out-Null
        $build = Get-Content -LiteralPath (Join-Path $source 'parity-build.json') -Raw | ConvertFrom-Json
        foreach ($entry in $build.files) {
            $inputPath = [IO.Path]::GetFullPath((Join-Path $source $entry.path))
            $outputPath = [IO.Path]::GetFullPath((Join-Path $runtime $entry.path))
            if (-not $inputPath.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or
                -not $outputPath.StartsWith($runtime + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Build receipt path escaped the isolated runtime'
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputPath) | Out-Null
            Copy-Item -LiteralPath $inputPath -Destination $outputPath
        }
    }
    # This is a disposable, isolated runtime. Never copy the user's login settings.
    $config = [ordered]@{
        login = @{username=$null; password=$null}; welcome=$false
        music_volume=0; sfx_volume=0; last_support_reminder=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        replays=@{saved_replays=@()}; version='1.4.1'
        skin=$null; palette=$null; wallpaper=$null; shader=$null; custom_map=$null
        community_option='map_hub'; campaign_progress=@(); campaign_completed=$false
        autoconfirm_orders=$true
        keybinds=@{withhold_orders=1073742050; confirm_orders=13; clear_selection=99
            stop_units=115; open_control_panel=32; multiselect=1073742049; line_formation=1073742048}
        interface_setup=@{orders=1; health=1; morale=1; flags=1; stats=1
            icons=1; produce=0; players=1; chat=0}
    }
    $text = $config | ConvertTo-Json -Depth 6 -Compress
    $file = [IO.File]::Create((Join-Path $runtime 'config.txt'))
    $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Compress)
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $gzip.Write($bytes, 0, $bytes.Length); $gzip.Dispose(); $file.Dispose()
    $exe = Join-Path $runtime 'game.exe'
    $probeSource = $ProbeDll
    if (-not $probeSource) {
        $probeSource = Join-Path $repo 'tools\python-probe-dll\target\release\wod_python_probe.dll'
        if (-not (Test-Path -LiteralPath $probeSource)) {
            $probeSource = Join-Path $repo 'tools\python-probe-dll\target\x86_64-pc-windows-gnu\release\wod_python_probe.dll'
        }
    }
    $probe = Join-Path $work 'wod_python_probe.dll'
    # Reuse identical probe bytes. Windows may retain a mapped DLL briefly
    # after a completed game process, so replacing it needlessly can fail.
    $copyProbe = -not (Test-Path -LiteralPath $probe)
    if (-not $copyProbe) {
        $copyProbe = (Get-FileHash -LiteralPath $probeSource -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $probe -Algorithm SHA256).Hash
    }
    if ($copyProbe) { Copy-Item -LiteralPath $probeSource -Destination $probe -Force }
    $payloadPath = (Resolve-Path -LiteralPath $Payload).Path.Replace('\','/')
    $configurationPath = (Resolve-Path -LiteralPath $Configuration).Path.Replace('\','/')
    $wrapper = "exec(compile(open('$payloadPath',encoding='utf-8').read(),'$payloadPath','exec'),{'PARITY_CONFIG':'$configurationPath','__name__':'__parity_probe__'})"
    Set-Content -LiteralPath (Join-Path $work 'wod_python_probe_payload.py') -Value $wrapper -Encoding utf8
    $statusPath = Join-Path $work 'wod_python_probe.status.json'
    if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath -Force }
    $process = Start-Process -FilePath $exe -WorkingDirectory $runtime -WindowStyle Hidden -PassThru
    @{pid=$process.Id; executable=$exe; started=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $work 'process.json')
    try {
        Start-Sleep -Seconds $StartupWaitSeconds
        if ($process.HasExited) { throw "Game exited before probe injection: $($process.ExitCode)" }
        & (Join-Path $PSScriptRoot 'invoke-python-probe.ps1') -ProcessId $process.Id -ProbeDll $probe -TimeoutSeconds 30
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $statusPath) {
                try { $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { $status=$null }
                if ($status) {
                    $status | ConvertTo-Json
                    if ($status.status -ne 'succeeded') { throw $status.detail }
                    return
                }
            }
            if ($process.HasExited) { throw "Game exited during capture: $($process.ExitCode)" }
            Start-Sleep -Milliseconds 500
        }
        throw 'Native parity probe timed out'
    } finally {
        if (-not $process.HasExited -and $process.Path -eq $exe) {
            Stop-Process -Id $process.Id -Force
            if (-not $process.WaitForExit(10000)) { throw 'Owned native game process did not exit' }
        }
    }

} finally { $runtimeLease.Dispose() }
