[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

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

Get-ChildItem -LiteralPath (Join-Path $Root 'src-tauri\binaries') -Filter 'wod-replay-server-*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1 |
    ForEach-Object { $entries += New-SizeEntry 'sidecar' $_.FullName }

$entries += New-SizeEntry 'tauri-exe' (Join-Path $Root 'src-tauri\target\release\more-of-dots.exe')

Get-ChildItem -LiteralPath (Join-Path $Root 'src-tauri\target\release\bundle\nsis') -Filter '*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1 |
    ForEach-Object { $entries += New-SizeEntry 'nsis-installer' $_.FullName }

Get-ChildItem -LiteralPath (Join-Path $Root 'src-tauri\target\release\bundle\msi') -Filter '*.msi' -ErrorAction SilentlyContinue |
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
