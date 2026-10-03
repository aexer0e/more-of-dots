# Independent replay player integration

Implemented on 2 October 2026 in `codex/replay-player-integration`, based on `58c8d16b7ba317dc2ddab1732b720e20ced0645d`.

## Approved interface

Replay cards show each player's Elo rank as a small "RANK n" caption under the name (concept R1), so ranks never widen the matchup line. 3P and 4P matchups wrap after the second player. The library filters are two dropdowns: Mode (1v1, 2v2, 3P, 4P, Experiment, Avalanche) and Map (Vanilla, Custom). Mode comes from each replay's `mode`; free-for-all and older replays without one are classified by their number of sides.

The player window uses the native Windows title bar, titled with the matchup. A floating pill holds play/pause, time, the seek bar, duration, speed and fullscreen. A vertical rail on the right holds the eight layer toggles (shortcuts 1–8). All layers default to on except 7, City connections. Playback and export share these defaults; the v2 preference key applies them once on upgrade and saves subsequent choices. Each appears only while the pointer is over its own edge of the window and hides 0.45 s after it leaves; keyboard actions show the affected control briefly. Seeking keeps the play state (mpv-style): the seek bar shows a time tooltip with the offset from the playhead, scrubbing draws only the newest target, and playback continues from the release point. Arrows seek ±5 s, Up/Down ±60 s, `[`/`]` change speed. Recording is started from the library's Record action; the player then shows REC progress and Stop in the pill.

Playback starts on the first simulated frames. The simulator streams to stdout; frames are indexed as they reach the cache file, and the seek bar hatches the range that is still being simulated. A simulation error ends playback at the last good frame and is reported in the player.

## Source and process boundaries

| Area | Responsibility |
| --- | --- |
| `src/main.ts`, `src/styles.css`, `src/replays/export.ts` | Library, its Play entry point, and the Record setup dialog and export queue |
| `player.html`, `src/player/main.js`, `src/player/player.css` | Dedicated player window, transport and layer rail |
| `src/player/client.js`, `worker.js`, `scheduling.js` | Worker bridge, latest-target scheduling and bounded read-ahead |
| `src/player/engine.js`, `map.js`, `frontline.js`, `overlays.js`, `local-renderer.js`, `native-renderer.js` | Replay presentation, local sprite playback and native export commands |
| `src-tauri/src/player.rs` | Conversion cache, streamed frame indexing and per-window workers |
| `src-tauri/src/export.rs`, `src-tauri/src/video.rs` | Background export queue, Media Foundation H.264 encoder and MP4 fast start |
| `engine/repsim/VideoExport.cs` | Converter: simulate, build the player's draw list (C# port), render offscreen, stream frames |
| `engine/repsim` | Maintained independent simulation and SDL/OpenGL renderer source, plus 48 map surfaces |
| `engine/native`, `public/player-assets` | Graphics dependencies, notices and presentation artwork |
| `scripts/prepare-player.ps1` | Reproducible, trimmed .NET publication and resource hashes |

Conversion executes the internal `ReplaySim.Standalone.exe`. Playback parses frame batches and draws reusable map/unit images in an OffscreenCanvas worker. MP4 export uses the hidden independent SDL/OpenGL worker and sends RGB24 frames to the H.264 encoder in Windows Media Foundation (`src-tauri/src/video.rs`) at 30 fps. Frames are converted to NV12 with BT.709 coefficients and written as a fast-start MP4; no encoder is bundled. No game executable, game runtime, game-version vault or injection payload is part of this path. War of Dots is not launched for playback or recording.

Sessions are keyed by player window. Closing one window terminates only its workers; closing the app terminates all of them. Windows job objects also terminate workers if the host process exits unexpectedly. Completed conversion caches are shared, keyed by replay bytes, staged engine/resource hashes and any resolved external map image. Conversion and exports use temporary files and publish the result only after success. An existing destination survives conversion/encoding failure.

The recorder installer, signed recorder-manifest workflow, native recorder-update module, old player frontend and recorder install/update frontend have been removed. The app release workflow stages the independent player and builds one More of Dots installer. Historical Python comparison tools remain in the repository for development; they are excluded from the application build. Superseded installer tests were retired, and desktop packaging checks enforce the independent resource boundary. Rust behavior tests cover session separation and shutdown.

The library's Record action opens an export dialog (folder, playback speed, bitrate, resolution, simultaneous exports, layers). Each video runs `ReplaySim.Standalone.exe --export-video`, which simulates and renders frames as fast as possible and streams RGB24 to the backend; the encoder converts to NV12 on several cores and writes an H.264 MP4 through Windows Media Foundation, then moves the index to the front. On a 3:50 replay this ran at 124–151 frames per second at 1080p and 219 at 480p. A converter frame was pixel-identical to the player's native reference capture with all eight layers on. No player window opens and nothing plays in real time.

## Sound

The player and video export reproduce the game's replay sounds. The rules were read from the game's `SoundManager` (static analysis of the installed game; nothing is injected or launched) and are implemented twice, in `src/player/sound.js` (Web Audio) and `src-tauri/src/audio.rs` (export mixer):

- music: a match plays `won.wav` on repeat at the music volume and pauses when the game ends;
- fighting: every tick reports the number of units in combat (`set_fighting`). Each frame the count is smoothed, s += 0.03 × (n − s); the loop starts at 0.2 × sfx once s is non-zero and then plays at min(1, √s / 5) / 3 × sfx;
- a side that produced units plays `produce_unit` at the sfx volume;
- at the end the loop stops and victory (any recorded result but 0) or defeat plays at half the sfx volume;
- the mixer has eight channels; a sound with no free channel is dropped.

The simulator adds `"audio":[fighting,producedSides]` to each state record and the replay `result` to the static record; the converter reports the same cues on stderr (`sound frame fighting sides`, `result value`). Nothing is bundled: the sounds are the installed game's own files (`assets/music/won.wav`, `assets/sound_effects/*.wav`, found through the same Steam discovery as the maps). The player loads them through the asset protocol (`game_audio` allows exactly those five files) and streams the 8½-minute music from disk; the export mixer decodes the effects and streams the music, resampling the 44.1/96 kHz effects to 48 kHz. Without the game, the volume button is disabled and videos have no audio track. Exports add a 192 kbit/s AAC track and hold the last frame for two seconds so the end sound finishes. In the desktop app, music and the fighting loop played without a click; a QA run (`--qa-audio`) confirmed the fighting gain, a production sound and the victory sound at the end.

## Avalanche

Avalanche uses the classic rules. From the game's scene setup: the live game rewrites the map (side 1 gets 7-unit clusters where cities were) and the replay stores the result, and every second side (1, 3) starts with 15,000 funds. The stored capital indices no longer name cities; the simulator then lets the side's largest group draw on its funds. That choice is empirical: replays have no native trace, so each recorded order's first waypoint (where the player clicked the unit) is compared with the simulated unit position. Across the seven sample avalanche replays 57–77% of orders start exactly on the unit and no ordered unit is missing, in line with verified classic replays (30–60%); the other funding rules tried scored lower or lost units. This is strong evidence, not proof of parity.

## Validation during integration

| Check | Result |
| --- | --- |
| Existing web checks and TypeScript | 44 tests passed; type check passed |
| Rust library | 36 tests passed, including indexed reads, invalid inputs, separate sessions and cache invalidation |
| Desktop permissions/retired IPC/packaging | Three checks passed |
| Infantry boat approaching shore | All 301 state records matched the validated trace |
| Tank boat approaching shore | All 301 state records matched the validated trace |
| Motorised unit at sea | All 121 state records matched the validated trace |
| Integrated boat renderer, frame 300, all layers, 1920×1200 | Zero changed pixels against the previously validated renderer output |
| Saved 1.4.1 library replay using `mode: 1v1` | Converted and played in the native app |
| MP4 export from that replay | H.264, 1920×1080, 30 fps, 61 frames / 2.033333 seconds |
| Stop during longer export | Valid partial MP4, 127 frames / 4.233333 seconds |
| Native UI | Library Play, loaded thumbnails, two-column menu, setup, REC/Stop, keyboard seeking, fullscreen, layer shortcut and two separate replay windows checked |

Local evidence is in `build/player-qa`: `simulation-checks.json`, the three boat `.repsim` files, `integrated-boat-300.png`, `integrated-boat.mp4`, `integrated-real-300.png`, `integrated-real-complete.mp4` and `integrated-real-stopped.mp4`. Development logs are `build/player-native-check.log` and `build/player-dev3.log`. These generated files are ignored by Git.

The state and pixel comparisons preserve the existing validated implementation through the integration. They do not establish universal 100% parity for every replay. The new saved-replay mode aliases have been exercised for import/playback; this integration did not add a full native-game state comparison for that saved match.

## Supported profile and remaining limits

The converter attempts any version with map data and two to four color sides. It reads a map object or the legacy `custom_map` object, uses nested mode labels when the top-level mode is absent, and accepts string player labels as well as structured names. Classic is the fallback for unknown match labels, including World. Motorised deployments or explicit motorised production select the experimental rules. Source version and mode remain in the output metadata.

Number-only replays resolve through `engine/repsim/maps/deployments.json`, embedded in the engine. The catalog covers Fahero 1–32 and 46–50 in experimental mode, 1–28 and 30–32 in classic mode, and six saved avalanche layouts. 1v1 and 2v2 both resolve the classic deployment; two teammates share each color. Mode and map-ID whitespace and mode casing are normalized before lookup, and simulation uses the same normalized rules selection. Explicit map objects and `custom_map` remain authoritative. Other numeric map/mode combinations still need a matching deployment. External custom PNGs must be available beside the replay, in its `maps` directory, or at the declared path. Official asset paths can resolve through the installed game; bundled surfaces are available without a game installation. The converter does not invent a deployment for a missing map.

The catalog was recovered from the supplied archive on 4 October. `scripts/recover-replay-deployments.py` groups full official-map snapshots by map number and mode and requires their geometry to agree. Classic recovery combines the experimental infantry and motorised positions, using the first recorded orders to restore original unit IDs. Retained infantry preserve their sequence, and a constrained search accepts only a unique ordering. Of 31 recovered classic layouts, 25 have every initial ID observed; six have a total of eight unobserved positions determined uniquely by the remaining sequence. Ambiguous or conflicting orderings remain unresolved. Unit types, IDs and starting positions are mode-specific; simply dropping experimental motorised units would misassign subsequent orders.

Fahero 24 illustrates the original defect: four experimental files contain the same complete layout, while 11 classic files contain only its number. Those classic files agree on all 50 initial ID/position pairs. The catalog restores 18 infantry and seven tanks per classic side, versus 14 infantry, seven tanks and four motorised units per experimental side. The old error incorrectly said numbered-map playback was impossible. The new error identifies an unavailable layout for the specific map/mode. The cache now hashes installed terrain resolved from numeric IDs, and catalog changes invalidate it through the engine manifest.

The numbered-map recheck completed 542 of the previously rejected 661 files through their recorded ends, including all 12 numeric Map 24 files. The remaining 119 have no catalog layout; no unexpected simulation failures occurred. Of the newly accepted files, 45 deferred orders and eight ended with unresolved IDs. Combined archive coverage is now 1,930 of 2,049 files. For each of the 43 saved experimental/avalanche profiles, replacing the explicit map with its number produced byte-identical output through frame 300. The 14 engine tests, six recovery-algorithm tests and 63 native tests passed. Evidence is in `build/replay-audit/map-catalog-results.json`, `deployment-evidence.json` and `catalog-snapshot-comparisons.json`.

Legacy `{rate, ratio}` commands retain their fractional infantry/tank mixture and spending rate. The reconstructed legacy production profile queues the next type after a successful birth and retains it during blocked or underfunded attempts. Ratio 1 selects infantry and ratio 0 selects tanks. Explicit modern `{production_rate, production_type}` commands retain their existing behavior. Legacy movement, combat, prices and supply currently share the 1.4.1 implementation; exact historical balance and random-number ordering have not been validated against older game binaries. The static record marks these conversions with `historical_rules_approximate` and a distinct `simulation_profile` when using the legacy production profile.

An order for a unit that has not yet appeared no longer aborts playback or export. The converter keeps its latest order and applies it when that ID appears. It creates no replacement units. State records expose cumulative `compatibility.deferred_orders` and the remaining `pending_orders`; unreached IDs remain unresolved at the recorded end. This is a best-effort recovery from simulation drift, not evidence that the original match was reconstructed exactly. Invalid production-zone indices are discarded, unknown auxiliary commands are ignored, and version strings alone never block conversion.

The 3 October archive recheck simulated all 1,088 legacy files with map data through their recorded ends, with render state enabled. All completed. Across them, 77 files deferred 1,780 order events; 17 files ended with 237 unresolved unit IDs. The other 1,011 legacy files required no deferred-order recovery, which still does not establish historical parity. The 299 previously accepted modern files had identical final states after excluding the added diagnostics. The World file also completed, for 1,388 completed archive files overall. A separate final-reader check accepted those 1,388 and rejected only the 661 files without map deployments. Two legacy export samples, including the four-player `custom_map` replay, produced four raw video frames each; the final engine produced identical PNG captures. Evidence and the searchable report are in `build/replay-audit`.

MP4 uses lossy H.264 and AAC; pixel comparisons apply to native rendered PNGs, not compressed video. The local preview uses browser fonts and antialiasing, so its pixels can differ from native exports. Full simulation traces can be large, and conversion finishes before playback starts. These changes do not establish universal game parity. Installer generation passed as described below; installation and installed-app playback have not been tested.

## Performance follow-up, 3 October 2026

The UI posts paint requests without waiting inside its animation loop. One paint runs while one latest target may wait; additional seeks replace that target. Recording waits for every frame and never uses playback frame dropping. Preview updates during recording are limited to ten per second. Resizing and seeks invalidate obsolete requests. Artwork is decoded once per replay, and dynamic text images use a 128-entry cache.

Read-ahead requests up to 90 states per batch and keeps at most 540 frames and 24 MiB of encoded JSON. JavaScript object storage adds overhead beyond that encoded-byte budget. Backend responses are capped at 8 MiB and 120 frames; partial batches fall back to fetching the requested row. Binary responses are transferred to the worker, where JSON parsing occurs. Frame indexing skips state properties rather than allocating entire states. Cached conversions bypass the conversion lock, and frame reads use a separate replay-index lock from rendering/encoding. Worker process shutdown is dispatched outside the window event callback.

Native recording reuses RGB readback buffers and resizes its render surface only when dimensions change. It no longer compresses each frame to PNG or sends PNGs through an image decoder before video encoding.

Measurements on this machine at 1920×1080, using warmed runs:

| Check | Result |
| --- | --- |
| Saved match, frames 3000–3300, buffered local playback | 301 frames in 818 ms; median 1.5 ms/frame; p95 9.3 ms |
| UI heartbeat during that run, requested every 10 ms | Maximum observed gap 13.8 ms |
| Saved-match native rendering/transport, 30 repeated frames | PNG baseline mean 69.1 ms; RGB mean 21.4 ms, 3.22× faster |
| Boat native rendering/transport, 30 repeated frames | PNG baseline mean 25.3 ms; RGB mean 4.31 ms, 5.86× faster |
| Native RGB versus baseline PNG, both scenarios | Zero changed pixels |
| Native frame 300 versus saved boat and real-match captures | Zero changed pixels in both |
| New boat MP4 | Valid H.264, 1080p, 30 fps, 61 frames |
| Scheduling/buffering regressions | 8 tests passed, including 200 queued seeks, cancellation, reset races and partial batches |
| Web suite and native suite | 52 web tests plus TypeScript passed; 38 Rust tests passed |

These are presentation and frame-transfer measurements, not full conversion or video-export timing guarantees. The sampled saved match is moderate in size; unusually large states may take longer. The native export checks preserve the previously validated renderer, while preview pixels can differ as described above.

Evidence is under ignored `build/player-perf`: `boat-performance.json`, `real-performance.json`, `native-transport.json`, `real-native-transport.json`, reference/preview PNGs and new MP4s. `scripts/benchmark-player-renderer.py` compares a separately archived baseline with the integrated worker using the exact same drawing request. Development-only `--qa-performance` can save playback timings, buffer counters and drawing requests for another fixture; `--qa-performance-start` selects a later portion of a match.

## Development

### Thumbnail, audio and World replay follow-up, 3 October 2026

Thumbnail duration sits at the top center, with map on the left and mode on the right. 2v2 uses the same two-column sizing and row spacing as 4P, with teammates stacked on their own side. A missing leaderboard rank reserves its line so the opposing names stay aligned. Each name and winner name filters by that individual username. Highlighting uses each button's player index, so regrouping teams cannot put another player's text on a button. The desktop replay index schema is version 5 and rebuilds older summaries that joined teammates into one name; the desktop binary must be rebuilt to include that existing parser change.

Playback audio runs at its natural rate independently of replay speed. Music retains its position on pause/resume and user interaction; an explicit seek still moves it to the requested replay time. The offline export mixer already advances samples at their natural rate.

The supplied `aexer0e-vs-ыывап.rep` declares version `1.4.1`, mode `world`, end tick 4845, and contains an embedded terrain image, deployment and 193 command ticks. Its original blocker was the mode allowlist. The permissive reader now attempts it with Classic rules and marks the rules as approximate. The original file is unchanged. Completion still does not establish World-mode accuracy.

Use `npm ci`, then `npm run dev:desktop` with Node, Rust and .NET SDK 9 installed. The installed application carries the engine runtime and encoder. `npm run check` runs the web checks; `npm run check:native` runs the Rust tests with the Windows test manifest supplied. `npm run check:engine` covers legacy reading, gzip, mode inference, fractional production, queue behavior and deferred orders. `scripts/audit-replay-compatibility.py` runs an existing replay inventory through its recorded ends and can compare modern final states with an archived engine. The desktop boundary checks live in `tests/test_desktop_lifecycle.py`.

Initial integration validation used development compilation and execution. Release packaging was subsequently requested and completed; no release was published or changes pushed.

## Requested packaging check, 3 October 2026

`npm run build` completed with exit code zero using the local GNU Rust toolchain. The first attempt needed Cargo added to the build shell's PATH. A second attempt exposed a target-directory mismatch: Cargo honored `CARGO_BUILD_TARGET`, while Tauri's bundler looked in the default output directory. The version wrapper now passes that configured target to Tauri, while preserving any explicit CLI target. Both new regression tests passed. The size audit now finds target-specific output directories and checks the current version's installers.

Version 1.3.4 outputs are under `src-tauri/target/x86_64-pc-windows-gnu/release/bundle`:

| Artifact | Size |
| --- | --- |
| `nsis/More of Dots_1.3.4_x64-setup.exe` | 46.87 MiB |
| `msi/More of Dots_1.3.4_x64_en-US.msi` | 63.07 MiB |

The generated NSIS file list includes the independent replay engine, encoder, SDL dependencies, notices and WebView2 loader. The production frontend compiled its player worker successfully. Packaging does not establish that installation or installed playback works; those checks remain outstanding.

The subsequent Fahero 13 report exposed a separate match-format bug: numbered maps with `mode: "2v2"` were rejected before simulation even though the simulator already supports two players per color. The resolver now shares classic deployments with 2v2. A local Fahero 13 replay (filius / mykfree vs albaniaempire / yourwall) completed all 9,242 ticks after this correction. Sixteen engine regression checks pass, including classic/experimental/team switching across all 31 classic maps and preservation of teammate labels. This does not establish that every reported 1v1 failure has the same cause.

### Library compatibility gate

The follow-up audit found that the library still computed `playable` solely from whether a replay contained an inline map object. Its Play button rejected every numbered map before calling the engine, even after the engine gained the deployment catalog. The summary field and UI gate are now removed. Compatibility belongs to the engine shared by playback and recording; library summaries do not duplicate its rules. Existing cached `playable: false` fields are ignored on read and omitted on write, so re-importing files or deleting the index is unnecessary.

On 4 October 2026, 2,069 unique local replay files were inventoried from the app backups, desktop uploads, installed game's replays and Downloads. With the installed engine, 1,949 passed initial playback-state generation and first-frame offscreen video rendering; 120 were rejected for absent deployments. Of 664 number-only files, 544 were therefore incorrectly blocked by the library. All 23 Fahero 23 files passed both checks. This startup audit does not claim full-match accuracy. A classic Fahero 23 recording also passed the native export-queue integration check, producing a complete H.264 MP4 with audio. The browser check used a Fahero 23 summary explicitly containing the obsolete false flag and verified its enabled Play button and recording setup.

Evidence: `build/local-replay-audit/installed-results.json`, `recording-queue.log`, `fahero23-play-enabled.png` and `report.html`. The repeatable startup audit is `scripts/audit-local-replay-player.py` and accepts an inventory, engine path and installed game directory.

### Audio cue indexing

The native player previously read audio only when `audio` immediately followed `frame` in each compact state record. Adding compatibility metadata between those fields silently turned fighting and production cues into zeros, even though the simulator and video-export mixer still generated them. The reader now falls back to JSON header deserialization for other field orders and whitespace, including existing packed caches. Newly written states keep audio immediately after the frame number to retain fast indexing. Missing cues in older files remain silent.

Regression coverage checks live and packed records with compatibility metadata, reordered keys, whitespace, nested audio keys and missing cues. An existing cached replay excerpt containing 4,353 frames preserved all 2,162 fighting ticks and three producing-side cues through indexing, compression and reopening. All 64 native tests, 18 player tests and 16 engine tests passed. Playback speed still leaves clip pitch and duration unchanged.
