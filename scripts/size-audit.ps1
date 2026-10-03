[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -Raw).Trim()

function New-SizeEntry([string]$Kind, [string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return [ordered]@{
            kind = $Kind
            path = $Path
            exists = $false
            bytes = $null
            mb = $null
        }
    }
    $item = Get-Item -LiteralPath $Path
    return [ordered]@{
        kind = $Kind
        path = $item.FullName
        exists = $true
        bytes = $item.Length
        mb = [Math]::Round(($item.Length / 1MB), 2)
    }
}

$entries = @()

$entries += New-SizeEntry 'replay-engine' (Join-Path $Root 'src-tauri\resources\player\ReplaySim.Standalone.exe')

$targetRoot = Join-Path $Root 'src-tauri\target'
if ($env:CARGO_TARGET_DIR) {
    $targetRoot = [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
}
# Cargo uses target/<triple>/release when an explicit target is selected.
# Inspect the existing outputs so a configured cross-target build is audited too.
$releaseDirectories = @((Join-Path $targetRoot 'release'))
if (Test-Path -LiteralPath $targetRoot) {
    $releaseDirectories += @(Get-ChildItem -LiteralPath $targetRoot -Directory |
        ForEach-Object { Join-Path $_.FullName 'release' })
}
$executable = $releaseDirectories |
    ForEach-Object { Join-Path $_ 'more-of-dots.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Get-Item |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $executable) { throw 'The build produced no More of Dots executable to audit.' }
$releaseDirectory = $executable.DirectoryName
$entries += New-SizeEntry 'tauri-exe' $executable.FullName

Get-ChildItem -LiteralPath (Join-Path $releaseDirectory 'bundle\nsis') -Filter "*${Version}*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1 |
    ForEach-Object { $entries += New-SizeEntry 'nsis-installer' $_.FullName }

Get-ChildItem -LiteralPath (Join-Path $releaseDirectory 'bundle\msi') -Filter "*${Version}*.msi" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1 |
    ForEach-Object { $entries += New-SizeEntry 'msi-installer' $_.FullName }

if (-not $entries) {
    $entries += [ordered]@{
        kind = 'none'
        path = ''
        exists = $false
        bytes = $null
        mb = $null
    }
}

$audit = [ordered]@{
    generated_at_utc = [DateTime]::UtcNow.ToString('o')
    entries = $entries
}

$buildDir = Join-Path $Root 'build'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
$auditPath = Join-Path $buildDir 'size-audit.json'
$audit | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $auditPath -Encoding UTF8

Write-Host 'Size audit:'
$entries |
    ForEach-Object { [PSCustomObject]$_ } |
    Format-Table -AutoSize kind, mb, exists, path
Write-Host "Wrote $auditPath"

exit 0
