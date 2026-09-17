# More of Dots

[Download More of Dots 1.2.0 for Windows (NSIS installer)](https://github.com/aexer0e/more-of-dots/releases/download/v1.2.0/More.of.Dots_1.2.0_x64-setup.exe)

- Browse, search, and download War of Dots replays
- Back up discovered replays automatically
- Follow global leaderboards, track your progress, and compare players
- Create and edit custom maps, including motorised infantry

## Replay video recorder

Replay video export is provided by the optional **More of Dots Recorder** package. The main app no longer bundles the PowerShell runner, process-injection DLL, Python worker, or FFmpeg, so a recorder quarantine does not remove the replay browser.

The recorder bundles only the immutable War of Dots `1.4.1` build in `%LOCALAPPDATA%\More of Dots Recorder\versions` and copies it into a disposable job runtime. Older replays are normalized to `1.4.1` before launch, including structured player names, an explicit classic game mode, and empty motorised unit lists for older custom maps. Experimental replays retain their mode, units, and orders. Missing or unknown version labels use the same structural fallback when player names and tick orders can be derived. Recordings never launch the user's live Steam `game.exe`.

### Installing and updating from the app

The export dialog installs the recorder itself when one is missing or out of date. The app reads `recorder.json` from the latest release, downloads the installer with resumable HTTP ranges, checks it against the published SHA-256 and a minisign signature made with the keypair in `tauri.conf.json`, then runs it with `/S`. Nothing is executed before both checks pass, a manifest offering an older recorder than the installed one is ignored, and installs are refused while a recording holds the recorder open.

The recorder carries its own `wod_replay_server/RECORDER_VERSION`, independent of the app's `VERSION`. Bump it only when the recorder payload changes; otherwise every app patch would push the full installer again. `command_recorder_capabilities` reports it, and the manifest is generated from what the built recorder says rather than from what the build script assumes.

Releases attach `recorder.json` and `recorder.json.sig` even when the recorder was not rebuilt, carrying the previous pair forward unchanged, so a release without a new recorder keeps offering the last good one. The manifest's download URL is pinned to the tag that produced the installer, never to `latest`.

### Publishing a new recorder

The installer embeds game binaries that are deliberately outside source control, so it is built on a machine that already holds the vault and uploaded to the drafted release by hand. Signing happens in Actions, because the release keypair exists only as a secret there.

```powershell
npm run build:recorder
gh release upload v<app-version> `
  "recorder-dist/More.of.Dots.Recorder_<recorder-version>_x64-setup.exe" `
  "recorder-dist/recorder-capabilities.json"
gh workflow run recorder.yml -f tag=v<app-version>
```

The `Publish recorder assets` workflow signs the installer, generates and signs `recorder.json`, attaches both, and removes the capabilities dump it used as a courier for the version and protocol numbers. Publish the release once those assets are on it.

Build the two release artifacts separately:

```powershell
npm run build
npm run build:recorder
```

`npm run build:recorder` produces `recorder-dist/More.of.Dots.Recorder_<version>_x64-setup.exe`. The per-user NSIS installer registers an uninstaller and Start Menu shortcut while keeping the bundled game build outside the program directory so upgrades and recorder quarantines do not erase the vault.

On upgrade the installer clears `payload` before extracting, because PyInstaller renames files between builds and orphans would otherwise accumulate. It skips re-extracting the game vault when a content hash marker and the build on disk both match, which is most of the install time. Silent installs report `3` when the recorder is running and `4` when files could not be written.

The build requires version `1.4.1` in a populated recorder home. It uses `%LOCALAPPDATA%\More of Dots Recorder` by default; set `WOD_BUNDLED_VERSION_VAULT` to use another source. Packaging verifies `game.exe` against `wod_replay_server/supported_versions.json` and embeds that single build in the NSIS installer.

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

## Leaderboard

The Leaderboard tab replaces Region because servers are now mixed. It reads public Elo and World top-100 snapshots from `wod-nations-map.moreofdots.workers.dev`. The app reads only the username from the local game's compressed settings and highlights that player. If no saved login is available, enter an exact username once. The password is never returned to the UI or sent to the worker.

Search runs locally. Compare up to ten players alongside your own rank and score over 7, 30, 90 days, or all available history. Each player keeps a distinct color. The worker samples six-hour intervals for the week view and daily intervals for longer views. Charts connect missing observations with straight lines; the recorded values table retains missing values. Axis ticks use uniform round intervals.

The app persists the latest snapshot and up to 12 history queries. It combines concurrent requests, waits until the next expected snapshot before fetching again, and revalidates expired entries with ETags. Hidden tabs do not poll the network. Saved snapshots remain visible if a refresh fails. Only player histories requested by the current comparison are downloaded.

## Development examples

Run `npm run dev` to prepare local examples and start the web UI at `http://127.0.0.1:5173`. Startup copies the newest 100 replays at most, filling any remaining slots from the app's replay backups and skipping duplicate content. It also copies recent editor maps, and map layouts from recent replays into ignored `build/dev-data`. It also saves fresh public Elo and World rankings with all available sampled history. All three tabs are populated before Vite starts. Subsequent offline starts can reuse the last saved leaderboard snapshot.

Set `WOD_GAME_DIR` if Steam is installed elsewhere. Backups default to `%APPDATA%\local.more-of-dots\replay-backups`; set `WOD_REPLAY_BACKUP_DIR` to use another backup folder. Only the username is read from game settings; credentials are never copied. Example edits and deletions last for the browser session and do not touch Steam files. Restarting creates fresh copies. Recorder and game-launch actions are unavailable in example mode.

`npm run dev:web` runs the same example workspace. `npm run dev:desktop` opens the native development app with that example UI. Release builds use the real backend.

Replay previews support embedded PNGs, old numeric map IDs, and the new relative PNG paths, including Eronion maps. Only non-vanilla maps receive the Custom badge. Shock units use the game's `motorised` storage key and infantry artwork with an upward chevron.
