<#
.SYNOPSIS
Writes the recorder.json update manifest that the desktop app polls.

.DESCRIPTION
The manifest describes one recorder installer: where to fetch it, how large it
is, and how to prove it is ours before running it. Version and compatibility
fields are read back out of the freshly built recorder rather than assumed, so a
mislabelled build fails here instead of on a user's machine.

The URL is pinned to a specific release tag, never to /latest/. Every app
release attaches a manifest even when the recorder did not change, and an
unchanged manifest must keep pointing at the older recorder asset.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$RecorderExe,
    [string]$CapabilitiesPath,
    [string]$SignaturePath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$Installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if (-not $OutputPath) {
    $OutputPath = Join-Path (Split-Path -Parent $Installer) 'recorder.json'
}

# Capabilities come from the recorder itself either way. -CapabilitiesPath takes
# the dump the build already wrote, so the manifest can be produced somewhere that
# cannot run a Windows recorder build, such as a signing job in CI.
if ($CapabilitiesPath) {
    $Capabilities = (Get-Content -LiteralPath (Resolve-Path -LiteralPath $CapabilitiesPath).Path -Raw) | ConvertFrom-Json
} else {
    if (-not $RecorderExe) {
        $RecorderExe = Join-Path $Root 'recorder-dist\more-of-dots-recorder\more-of-dots-recorder.exe'
    }
    $RecorderExe = (Resolve-Path -LiteralPath $RecorderExe).Path
    $CapabilitiesJson = & $RecorderExe --desktop-command recorder-capabilities
    if ($LASTEXITCODE -ne 0) { throw 'The built recorder did not report its capabilities.' }
    $Capabilities = $CapabilitiesJson | ConvertFrom-Json
}

$Version = $Capabilities.version
if (-not $Version) { throw 'The built recorder did not report a version.' }
$ExpectedVersion = (Get-Content -LiteralPath (Join-Path $Root 'wod_replay_server\RECORDER_VERSION') -Raw).Trim()
if ($Version -ne $ExpectedVersion) {
    throw "The built recorder reports $Version but RECORDER_VERSION is $ExpectedVersion."
}
if ($Installer -notlike "*_${Version}_*") {
    throw "Installer $Installer does not carry recorder version $Version."
}

# The .sig file written by `tauri signer sign` already holds base64, exactly as
# latest.json carries it, so it goes in verbatim. Encoding it again would produce
# a manifest that every client rejects.
if (-not $SignaturePath) { $SignaturePath = "$Installer.sig" }
if (-not (Test-Path -LiteralPath $SignaturePath -PathType Leaf)) {
    throw "No minisign signature found at $SignaturePath. The app refuses to run an unsigned installer."
}
$Signature = (Get-Content -LiteralPath $SignaturePath -Raw).Trim()
if (-not $Signature) { throw "The signature at $SignaturePath is empty." }

$Item = Get-Item -LiteralPath $Installer
$Manifest = [ordered]@{
    schema_version    = 1
    recorder_version  = $Version
    protocol_versions = @($Capabilities.protocol_versions)
    game_versions     = @($Capabilities.supported_versions.versions)
    install           = [ordered]@{
        url       = $Url
        size      = $Item.Length
        sha256    = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
        signature = $Signature
    }
}

$Manifest | ConvertTo-Json -Depth 5 | Out-File -LiteralPath $OutputPath -Encoding utf8
Write-Host "Wrote recorder manifest: $OutputPath (recorder $Version, $([Math]::Round($Item.Length / 1MB, 1)) MB)"
