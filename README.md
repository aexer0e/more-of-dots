# More of Dots

[Download More of Dots 2.0.0 for Windows (NSIS installer)](https://github.com/aexer0e/more-of-dots/releases/download/v2.0.0/More.of.Dots_2.0.0_x64-setup.exe)

Version 2.0.0 includes an independent replay player and video exporter in the desktop app.

- Browse, search, download and play War of Dots replays
- Save independent replay simulations and export MP4 videos
- Back up discovered replays automatically
- Follow global leaderboards, track your progress, and compare players
- Create and edit custom maps, including motorised infantry

## Custom maps

New maps and **Save draft** stay in More of Dots under `%APPDATA%\local.more-of-dots\map-drafts`. **Save to game** checks the map before publishing it to War of Dots. Each team needs at least one unit. Saving unfinished edits as a draft leaves the last published copy intact.

If an older custom map is blocking lobbies, use **Delete** beside Edit in the map library. This permanently deletes the installed map and its companion PNG without keeping a backup. Deleting a draft keeps any published copy. Unreadable maps appear with an error and can also be deleted.

## Replay player

The library filters replays by **Mode** (1v1, 2v2, 3P, 4P, Experiment, Avalanche) and **Map** (Vanilla or Custom).

2v2 cards place each team on one side with teammates stacked individually. Clicking a name filters to that player. The duration sits at the top centre between the map and mode labels. Player colours follow the game: blue, red, purple, orange.

Hover a replay card to replace its played time and date with a Play pill. Player names and winners stay visible. Double-click or drag over a name to select it for copying; a single click still filters by that player. Click Play to open the replay. The replay opens in its own window and starts within a second, while the rest of the replay is simulated in the background. Hovering the bottom of the window shows the playback pill; hovering the right edge shows the layer rail. Scrolling over the map zooms toward the pointer; scroll out to restore the full map. Drag the map to move the player window. Seeking keeps the current play state and silences audio until scrubbing ends. Space pauses, left/right seek five seconds, up/down seek a minute, `[` and `]` change speed, keys 1 through 8 toggle the layers, and F or double-click toggles fullscreen.

Replays sound like the game: its match music, the fighting loop that swells with the number of units in combat, the unit-produced sound and the victory or defeat sound at the end. The speaker button in the pill has **Music** and **SFX** sliders; they start at the volumes saved in the game's settings. Playback speed changes when effects are triggered, while music and effects keep their normal pitch and duration. Seeking resets the audio to the selected replay position. The sounds are read from the installed game (Steam), so the app bundles no audio; without War of Dots installed, replays and videos are silent.

To export videos, select replays and choose **Record**. Pick the export folder, playback speed (1–30×), bitrate, resolution (480p, 720p or 1080p), how many videos to convert at once, which layers to show, and the music and SFX volumes. Videos are converted in the background, without opening a player, much faster than real time: about 120–150 frames per second at 1080p, so a 10-minute game at 1× takes roughly two minutes, and less at higher speeds. A floating panel shows progress; **Stop** cancels unfinished videos and removes their partial files. Videos are H.264 MP4 with the game's sounds as AAC audio (set both volumes to 0 for a silent video), encoded by Windows Media Foundation. With audio, the last frame stays on screen for two seconds while the end sound plays.

Its internal C# engine simulates replays for playback and renders video exports with the same drawing rules as the player. Playback draws decoded map and unit images in a worker-owned canvas, with frame parsing and read-ahead outside the UI thread. No game executable is launched or loaded. A content-addressed cache reuses completed conversions; each player window has its own frame index and renderer. Internal simulations are saved in independently compressed chunks, so seeking does not require decompressing the entire replay.

The fast preview uses browser text and antialiasing, which can look slightly different from the maintained native renderer. Video exports and reference snapshots use the native drawing path. Simulation states are shared by both.

The imported engine preserves the validated War of Dots 1.4.1 behavior. Its existing offline corpus covers built-in maps, custom maps, classic/experimental modes, boats, combat and production. Avalanche replays are supported too. The reader also attempts older and unfamiliar versions, including legacy custom maps, string player names and mixed infantry/tank production. Historical playback uses reconstructed production rules and the shared simulation, so it is approximate. Orders for units that have not appeared are deferred instead of stopping playback or recording. Number-only replays use a bundled deployment catalog covering 31 classic, 37 experimental and six avalanche layouts. Other map/mode combinations still need a matching starting layout; an available terrain image alone does not specify unit IDs. See [integration notes](docs/replay-player-integration.md) for validation and limitations.

Simulated replay caches have no size limit, so conversion and playback never stop for storage. The app keeps only the most recently opened simulation, plus any that an open player is still using; opening another replay deletes the rest, and a 10-second sweep catches anything left over. Disposable WebView2 caches are trimmed to 50 MB. Startup removes the old uncompressed simulation cache and abandoned conversion files. Original replay backups, map drafts and saved browser preferences are preserved.

### Developing the Windows player

Install Node, Rust and .NET SDK 9, then run `npm ci` and `npm run dev:desktop`. The preparation script compiles the maintained source in `engine/repsim`, stages the map and unit artwork and public graphics libraries, and writes a SHA-256 manifest for the staged resources. Video encoding uses Windows Media Foundation, so no encoder is bundled. The installed app does not need the .NET SDK.

`npm run check` checks the existing web modules. `npm run check:native` checks the Rust library and supplies the Windows manifest needed by native dialog imports in the test executable. `npm run build` packages the More of Dots app with the independent player resources. The draft release workflow uses .NET 9 and packages one app installer; it does not fetch a game-version vault or produce a recorder installer.

## Leaderboard

The Leaderboard tab replaces Region because servers are now mixed. It reads public Elo and World top-100 snapshots from `wod-nations-map.moreofdots.workers.dev`. The app reads only the username from the local game's compressed settings and highlights that player. If no saved login is available, enter an exact username once. The password is never returned to the UI or sent to the worker.

Search runs locally. Compare up to ten players alongside your own rank and score over 24 hours, 7 days, 30 days, or all available history. The selected period is remembered across refreshes and restarts. Each player keeps a distinct color. The worker returns every two-minute observation where a selected player's rank or score changed and omits consecutive unchanged observations. Charts draw discrete steps at each change and extend the latest value to the end of the selected range. Axis ticks use uniform round intervals.

The app persists the latest snapshot and up to 12 history queries. It combines concurrent requests, uses the server's published refresh interval to wait for the next expected snapshot, and revalidates expired entries with ETags. Hidden tabs do not poll the network. Saved snapshots remain visible if a refresh fails. Only player histories requested by the current comparison are downloaded.

## Development examples

Run `npm run dev` to prepare local examples and start the web UI at `http://127.0.0.1:5173`. Startup copies the newest 100 replays at most, filling any remaining slots from the app's replay backups and skipping duplicate content. It also copies recent editor maps, and map layouts from recent replays into ignored `build/dev-data`. It also saves fresh public Elo and World rankings with available change-only history. All three tabs are populated before Vite starts. Subsequent offline starts can reuse the last saved leaderboard snapshot.

Set `WOD_GAME_DIR` if Steam is installed elsewhere. Backups default to `%APPDATA%\local.more-of-dots\replay-backups`; set `WOD_REPLAY_BACKUP_DIR` to use another backup folder. Only the username is read from game settings; credentials are never copied. Example edits and deletions last for the browser session and do not touch Steam files. Restarting creates fresh copies. Native playback is unavailable in the browser example workspace.

`npm run dev:web` runs the example workspace. `npm run dev:desktop` opens the native development app with the real backend, including replay conversion and playback.

Replay previews support embedded PNGs, old numeric map IDs, and the new relative PNG paths, including Eronion maps. The Custom badge checks the official `assets/fahero_maps`, `assets/zolamare_maps`, and `assets/eronion_maps` folders in discovered Steam installations. Embedded PNGs are compared with the installed images; legacy numeric map IDs remain vanilla. The Custom badge uses the installed assets rather than a bundled map list or image hashes. Each replay listing refreshes the check, including cached replays, so new Steam maps are recognized automatically. Maps absent from the local installation cannot be recognized by path or image. Shock units use the game's `motorised` storage key and infantry artwork with an upward chevron.

The leaderboard uses `/v1/leaderboard/refresh` to retrieve current rankings, exact last observed score changes, and selected player history in one request. Subsequent refreshes replace the overlap at the previous capture and append only changed points. Selection caches persist separately; changing players or range loads that selection once. The server publishes the refresh interval, currently two minutes. Older public endpoints remain supported by the API for previous app releases.
