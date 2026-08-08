# More of Dots

[Download More of Dots 1.2.0 for Windows (NSIS installer)](https://github.com/aexer0e/more-of-dots/releases/download/v1.2.0/More.of.Dots_1.2.0_x64-setup.exe)

- Browse, search, and download War of Dots replays
- Back up discovered replays automatically
- Switch game regions without the need for a VPN
- Create and edit custom maps

## Replay video recorder

Replay video export is provided by the optional **More of Dots Recorder** package. The main app no longer bundles the PowerShell runner, process-injection DLL, Python worker, or FFmpeg, so a recorder quarantine does not remove the replay browser.

The recorder bundles only the immutable War of Dots `1.3.4` build in `%LOCALAPPDATA%\More of Dots Recorder\versions` and copies it into a disposable job runtime. Replay `1.2.23` uses the same movement/production/message schema and is normalized to `1.3.4` before launch. Missing or unknown version labels use the same structural fallback when player names and tick orders can be derived. Recordings never launch the user's live Steam `game.exe`.

### Installing and updating from the app

The export dialog installs the recorder itself when one is missing or out of date. The app reads `recorder.json` from the latest release, downloads the installer with resumable HTTP ranges, checks it against the published SHA-256 and a minisign signature made with the keypair in `tauri.conf.json`, then runs it with `/S`. Nothing is executed before both checks pass, a manifest offering an older recorder than the installed one is ignored, and installs are refused while a recording holds the recorder open.

The recorder carries its own `wod_replay_server/RECORDER_VERSION`, independent of the app's `VERSION`. Bump it only when the recorder payload changes; otherwise every app patch would push the full installer again. `command_recorder_capabilities` reports it, and the manifest is generated from what the built recorder says rather than from what the build script assumes.

Releases attach `recorder.json` and `recorder.json.sig` even when the recorder was not rebuilt, carrying the previous pair forward unchanged. The manifest's download URL is pinned to the tag that produced the installer, never to `latest`.

Build the two release artifacts separately:

```powershell
npm run build
npm run build:recorder
```

`npm run build:recorder` produces `recorder-dist/More.of.Dots.Recorder_<version>_x64-setup.exe`. The per-user NSIS installer registers an uninstaller and Start Menu shortcut while keeping the bundled game build outside the program directory so upgrades and recorder quarantines do not erase the vault.

On upgrade the installer clears `payload` before extracting, because PyInstaller renames files between builds and orphans would otherwise accumulate. It skips re-extracting the game vault when a content hash marker and the build on disk both match, which is most of the install time. Silent installs report `3` when the recorder is running and `4` when files could not be written.

The build requires version `1.3.4` in a populated recorder home. It uses `%LOCALAPPDATA%\More of Dots Recorder` by default; set `WOD_BUNDLED_VERSION_VAULT` to use another source. Packaging verifies `game.exe` against `wod_replay_server/supported_versions.json` and embeds that single build in the NSIS installer.

Automated releases build the recorder only when the repository variables `WOD_RECORDER_VAULT_URL` and `WOD_RECORDER_VAULT_SHA256` identify an authorized ZIP whose root contains the `versions` folder. This keeps the game binaries outside source control without adding a downloader to the installed recorder.

The recorder includes FFmpeg and one game build. It does not include DepotDownloader, SteamCMD, Steam authentication, or any game-version network downloader. Users do not need Python or FFmpeg installed.

Set `WOD_RECORDER_PATH` to the standalone recorder executable for development. The catalog describes bundled game builds, while replay compatibility is inferred from player and order schemas. A version label alone does not reject a replay.

For production releases, set `WOD_SIGNING_CERTIFICATE_SHA1` to an Authenticode certificate installed in the build account's certificate store. The build signs both the recorder executable and its probe DLL, and fails if configured signing does not succeed.

Set `WOD_FFMPEG_PATH` during packaging to place the vetted FFmpeg build inside the recorder package. Keep the corresponding FFmpeg license and source-offer obligations with the distributed artifact.

The packaged recorder remains inspectable from a terminal:

```powershell
more-of-dots-recorder.exe --desktop-command recorder-capabilities
more-of-dots-recorder.exe --desktop-command list-game-versions
```

### Recording status protocol

`record-replay` atomically rewrites the JSON file passed with `--status-path`. A client can poll it while the recorder process is running. `protocol_version` is currently `1`, and `step` is one of:

- `waiting-for-game-slot`
- `opening-game`
- `starting-replay`
- `recording`
- `exporting`
- `completed`, `cancelled`, or `failed`

During recording, the status includes replay-time progress independently of export speed:

```json
{
  "protocol_version": 1,
  "status": "recording",
  "step": "recording",
  "current_seconds": 50.0,
  "total_seconds": 180.0,
  "progress_percent": 27.78,
  "tick": 1500,
  "end_tick": 5400,
  "frame_count": 150
}
```

`waiting-in-queue` is an orchestration state exposed by More of Dots before a recorder process is assigned to that replay. The app emits `replay-recording-progress` events containing `sourcePath`, `queueIndex`, `step`, aggregate queue counts, and the raw recorder status under `encoder`. This lets every replay retain its own state when several recordings run concurrently.

More of Dots remembers the last video destination and uses the Windows Videos folder on first use. Opening replay export never launches a folder picker; the destination can be changed from the export page. The default preset is 1080p, with 480p and 720p also available. Once submitted, selection is cleared and recording progress moves to a compact bottom-left queue so the replay browser remains interactive.
