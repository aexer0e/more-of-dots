# Hosted replay player

The desktop replay player also runs as a static site, published from `aexer0e/wod-replay-player` to https://aexer0e.dev/wod-replay-player/. It uses the same player code and the same simulation engine as the desktop app.

## One source of truth

All code lives in this repository. The site repository holds a deploy workflow, a README and the game's sound files. On each deploy it checks out this repository, compiles `engine/repsim` to WebAssembly, builds the player page and publishes the result to GitHub Pages. No build output is committed anywhere.

## Parts

| Path | Role |
|---|---|
| `engine/web/ReplaySim.Web.csproj` | Compiles the `engine/repsim` sources for `browser-wasm`, without the SDL renderer, SDL text and video export |
| `engine/web/Exports.cs` | `Open`, `AddMap` and `Run`, the entry points called from JavaScript |
| `src/player/host.js` | Chooses the backend: Tauri commands on the desktop, `web-host.js` in a browser |
| `src/player/web-host.js` | Answers `open_replay`, `replay_progress` and `replay_frames` in the browser and keeps frames compressed in memory |
| `src/player/web-engine.js` | Worker that runs the WebAssembly engine and posts frames in blocks |
| `site.html`, `vite.site.config.ts` | The site's page and its Vite build |
| `scripts/build-site.mjs` | Builds everything into `build/site` |
| `.github/workflows/notify-site.yml` | Asks the site repository to rebuild when `VERSION` changes |

The engine sources carry three `#if BROWSER` guards in `Program.cs`. Everything else in `engine/repsim` is compiled unchanged.

## How the browser backend differs

- **Simulation** runs in a worker. It is one long synchronous call, so opening another replay terminates the worker and starts a new one.
- **Frames** arrive as JSONL, the same stream the desktop player reads from the engine's standard output. They are grouped into blocks of 60 frames and compressed with the browser's `CompressionStream`. A replay that is 240 MB as JSON takes about 6 MB.
- **Official maps** are published under `maps/` and fetched only when a replay names one. Replays with an embedded map need nothing.
- **Player names** are drawn on a canvas by `web-host.js`, because the desktop engine renders them with SDL_ttf. They can differ by a pixel from the desktop labels.
- **Sound** is served from `audio/` in the site repository. A build without those files plays silently.
- **Not available**: video export, reference snapshots and the QA capture options, which use the native renderer.

## Building locally

Requires .NET SDK 9 with the `wasm-tools` workload (`dotnet workload install wasm-tools`).

```bash
npm run build:site
```

The output is `build/site`. Pass `-- --audio <folder>` to include sound files and `-- --skip-engine` to reuse the last engine build. Set `DOTNET` to use a specific `dotnet` executable.

## Checking parity

`scripts/web-engine.mjs` runs the WebAssembly engine under Node and writes a `.repsim`. `scripts/compare-web-engine.mjs` compares two `.repsim` files record by record.

On 8 October 2026, 11 replays from 1,095 to 43,350 ticks produced output identical to the desktop engine in every frame. All 11 were version 1.4.1 experiment-mode replays; other modes and older versions have not been compared yet.

The WebAssembly engine simulated at roughly 250 to 300 ticks per second on the development machine, against about 820 for the desktop engine. Playback starts after the first frame, about two seconds after opening.

## Deployment

`notify-site.yml` runs on a push to `main` that changes `VERSION` and sends a `repository_dispatch` event to the site repository. It needs the secret `SITE_DISPATCH_TOKEN`: a fine-grained personal access token limited to `aexer0e/wod-replay-player` with read and write access to Contents.

The site repository's **Deploy site** workflow can also be run by hand against any branch, tag or commit of this repository. The published `version.json` records the version and commit that were built.
