# War of Dots Replay

Local Windows replay desktop app for War of Dots. The installed Tauri app validates `.rep` files, launches the staged game on a private Windows desktop, injects the local Python probe, captures live gamestate from the game's replay scene, and returns stats plus a synthesized replay artifact. Normal capture fails closed if it cannot produce game-backed samples.

The desktop target is a single Tauri app with a bundled backend command executable. The UI talks to Tauri commands, not a localhost web API, so normal app use does not start a persistent server or bind a port. The packaged sidecar is command-mode only.

## Quick Start

```powershell
npm install
npm run build
```

The Tauri NSIS installer is emitted under `src-tauri\target\release\bundle\nsis`.
The build also writes a non-failing size report to `build\size-audit.json`.

## Desktop App

Install Node/Rust dependencies, build the Python backend command executable, then build the Tauri installer:

```powershell
npm install
npm run build
```

Open the installed app, click `Stage`, choose a `.rep`, then click `Simulate`.

## Runtime Layout

- `runtime\staged-game`: sanitized copy of the War of Dots install.
- `runtime\jobs`: uploaded replay jobs and outputs.
- `runtime\address-profiles`: enabled memory profiles by `game.exe` hash.

The staging process intentionally excludes personal and mutable Steam files:

- `config.txt`
- `replays/`
- `*.log`
- `out.txt`
- `err.txt`
- `*.bak`
- `*.rep`

## Local Runner

By default capture uses `WOD_CAPTURE_SOURCE=auto`. In `auto` mode the server tries the live Python capture path first. If that fails and a matching enabled memory profile exists, it tries memory capture. If neither authoritative path works, the job fails with a clear blocker.

Supported values:

- `auto`: prefer live hidden-game Python capture, then verified memory capture, otherwise fail.
- `game-live-python`: launch the staged game on the private automation desktop, inject the local CPython probe, enter the real replay scene, and sample the live game core.
- `memory`: require a matching enabled address profile and use the local game runner.

The game runner runs inside the current logged-in Windows session. This is intentional: the game client needs a real desktop/GPU context even when the app is trying to keep it out of sight.

By default the worker launches the game on a private Windows desktop inside the same logged-in session:

```powershell
WOD_GAME_DESKTOP_STRATEGY=automation-desktop
WOD_GAME_WINDOW_STRATEGY=offscreen
```

`automation-desktop` keeps the game away from the user's active screen without using a VM. `current-desktop` exists only for manual debugging. The old foreground mouse/screenshot path is disabled unless the runner is explicitly called with `-AllowInteractiveInput`.

Window strategy is still applied after a window handle is found. Supported values are `offscreen`, `minimize`, `hide`, and `none`.

For the current War of Dots build, `game-live-python` is the practical hidden-game path. It does not open a visible game window and it does not need a VM, but it still requires a logged-in Windows session because the game client expects a desktop/GPU context.

Normal live capture runs until the replay end tick is reached. `WOD_LIVE_CAPTURE_SECONDS` is only honored for diagnostic windowed captures when `WOD_LIVE_CAPTURE_MODE` is set to `window`, `sample`, `samples`, or `fixed`; otherwise the app refuses partial playback. Hidden game capture targets `WOD_LIVE_TARGET_GAME_SECONDS_PER_SECOND=8`, bypassing the visible replay UI's 10x keyboard cap. Full capture defaults to direct game-core component stepping with `WOD_LIVE_FAST_FORWARD_STEP_METHOD=components` and `WOD_LIVE_FAST_FORWARD_CONTROLLER=false`; this still applies replay payloads to the live game object, but avoids the slower per-frame scene/controller path. `WOD_LIVE_REPLAY_SAMPLE_HZ=4` keeps polling at four samples per capture second, while `WOD_LIVE_MAX_FAST_FORWARD_FRAMES_PER_SAMPLE=60` keeps each poll to about two in-game seconds at the default target pace. Per-unit projection-field scraping and scene projection-line scraping are off by default because the app already has replay path payloads and generated power projection, and those introspection passes are expensive. Capture artifacts include timing buckets under `timing_summary` so slow stages can be targeted directly.

## Capture R&D Commands

The desktop backend exposes probe commands for continuing gamestate discovery:

```powershell
.\.venv\Scripts\python.exe -m wod_replay_server.desktop_cli --desktop-command probe-runtime
.\.venv\Scripts\python.exe -m wod_replay_server.desktop_cli --desktop-command probe-replay-state --input path\to\match.rep
.\.venv\Scripts\python.exe -m wod_replay_server.desktop_cli --desktop-command sample-live-state --input path\to\match.rep
.\.venv\Scripts\python.exe -m wod_replay_server.desktop_cli --desktop-command capture-live-replay --input path\to\match.rep
```

Probe artifacts are written under `runtime\probes\` or the job folder. Each run restores the staged replay slot and closes the automation desktop.

## Desktop Backend

The Tauri frontend invokes backend commands directly:

- `backend_status`
- `stage_game`
- `capture_replay`
- `list_jobs`
- `get_job`
- `capture_sample_delta`
- `capture_progress`
- `unit_assets`

## Memory Calibration

Memory capture requires a matching enabled address profile under `runtime\address-profiles`.

```powershell
.\scripts\calibrate-memory.ps1
```

The calibration command creates a disabled candidate profile and report for the staged `game.exe` hash. Fill the verified pointer paths/layout, set `enabled` to `true`, then rerun capture.

## Configuration

Copy `.env.example` to `.env` for local overrides. Important values:

- `WOD_RUNTIME_DIR`
- `WOD_STEAM_GAME_DIR`
- `WOD_ADDRESS_PROFILE_DIR`
- `WOD_CAPTURE_SOURCE`
- `WOD_LOCAL_RUNNER_SCRIPT`
- `WOD_GAME_WINDOW_TITLE`
- `WOD_GAME_DESKTOP_STRATEGY`
- `WOD_GAME_WINDOW_STRATEGY`

Do not commit `runtime/`, `.env`, `secrets/`, staged game files, replay uploads, or build outputs.
