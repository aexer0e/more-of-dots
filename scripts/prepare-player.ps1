[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$engineProject = Join-Path $projectRoot 'engine/repsim/ReplaySim.Standalone.csproj'
$destination = Join-Path $projectRoot 'src-tauri/resources/player'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
dotnet publish $engineProject -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:DebugType=None -o $destination
if ($LASTEXITCODE -ne 0) { throw 'Independent replay engine compilation failed.' }
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'engine/native') -Filter '*.dll' | Copy-Item -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'engine/native/NOTICES.md') -Destination $destination -Force
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'engine/native') -Filter '*LICENSE.txt' | Copy-Item -Destination $destination -Force
# The video converter draws with the same unit artwork as the player.
$artwork = Join-Path $destination 'player-assets'
New-Item -ItemType Directory -Force -Path $artwork | Out-Null
Copy-Item -Path (Join-Path $projectRoot 'public/player-assets/*.png') -Destination $artwork -Force
# Sounds are read from the installed game; remove copies bundled by earlier builds.
$audio = Join-Path $destination 'audio'
if (Test-Path -LiteralPath $audio) { Remove-Item -LiteralPath $audio -Recurse -Force }
# Video export uses the H.264 encoder built into Windows; remove the retired FFmpeg copy.
Get-ChildItem -LiteralPath $destination -Filter 'ffmpeg.exe*' | Remove-Item -Force
$files = Get-ChildItem -LiteralPath $destination -File -Recurse | Where-Object { $_.Name -ne 'manifest.json' } | ForEach-Object {
  $stream = [IO.File]::OpenRead($_.FullName)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  [ordered]@{ path = $_.FullName.Substring($destination.Length + 1).Replace('\','/'); sha256 = $digest }
}
[ordered]@{ engine = 'independent-repsim-v1'; files = @($files) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding utf8
