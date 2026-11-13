# Play from here

The hosted player can continue a replay as a live match. Pause on a frame and choose **Play from here**: a room opens at once and shows its link. Whoever opens the link takes the first side nobody has. The host can start once every side has a player, and the match continues from that frame with fog of war and the game's controls. Whoever opens the link after the start sees the lobby over the match: they set their name, see who is on each side, and choose to watch or ask to join a side. The host sees the request over the battlefield and accepts or declines it. A watcher can open the lobby again with **Join...**. A side can have several players. Players are named Player 1, Player 2 and so on in the order they join, and can change their name in the lobby. A changed name is kept for that room in that browser tab only.

## Parts

| Path | Role |
|---|---|
| `engine/replay-sim-web/src/live.rs` | Live mode of the WebAssembly engine: simulates the replay up to the frame, drops the commands recorded after it, then applies the players' commands one tick at a time. Also computes the fog of war. |
| `engine/replay-sim/src/sim.rs` | `live_tick`, `queue_order`, `queue_production`, `drop_commands_from` and `state_hash` |
| `share/src/match.js` | The `MatchRoom` Durable Object: one room per match, at `/matches/new` and `/matches/<code>` on the share worker. Codes are four digits. |
| `play.html`, `src/play/`, `public/play-assets/` | The play page at `play?room=1234`: lobby, simulation worker, battlefield, controls, sounds. The share worker serves it at `play`; GitHub Pages serves `play.html` at that address too. |
| `src/play/handoff.js` | Passes the replay and frame from the player to the play page through IndexedDB |
| `src/play/replay-file.js` | Saves a finished match as a `.rep` |
| `scripts/play-orders.test.mjs` | Tests for the order rules |

## Turns

The room runs no simulation. Every 15 ticks (half a second at the game's 30 ticks a second) it sends each page the commands received since the previous turn, in arrival order. Every page simulates the same commands in the same order with the same engine, so all pages stay identical. A command takes effect at the start of the turn that carries it, as orders do in the game's replays, where every command frame is a multiple of 15.

Each page reports a digest of its state at every turn. The room compares them and tells the pages when they differ. The room keeps every turn, so a page that reloads replays them and catches up; its seat is kept by a token in the tab's session storage.

A player commands only their own side's units and cities. The engine ignores anything else, the same way on every page.

## Controls

The game's interface code was not available. The controls follow the game's help text and settings (left click, loop, Shift, Ctrl, Alt, Enter or right click, C, S, Space, I, wheel) and the orders recorded in the 1.4.1 replays of the published tournaments:

- An order is the unit's position followed by its waypoints, in whole pixels. An empty order stops the unit.
- A drawn route gains a waypoint each time the pointer is 24 pixels from the previous one. Each selected unit follows the route moved by its own offset from the point where the drag began. In the recorded replays every route's first leg is at least 24 pixels, also for groups, which rules out an offset from the group's centre.
- A click sends each selected unit by the click's offset from the group's centre, so the group keeps its shape.
- Alt+click sends every selected unit to the clicked point. Orders made while Alt is held are drawn in black and go out when Alt is released, or on Enter or right click.
- A formation spreads the units evenly along the drawn line, ends included, and gives each slot to a unit so that the total distance is as small as possible. This matches 322 of 325 recorded formations.
- Zoom steps by 1.2 between 1 and 3 about the pointer, as observed in the game.

Inferred rather than measured: when a dragged loop selects instead of drawing a route (a loop that comes back near its start, or any drag with nothing selected), the slot for a single-unit formation (the middle of the line), and the production widget's layout outside the measured knob and button positions. Panning by dragging with the middle or right button is an addition; a right click that moves less than 5 pixels still confirms withheld orders, on release.

## Fog of war

As in the game: every 10-pixel cell outside the side's territory is fogged, except under its ships, and the fog then shrinks by seven cells. Its outlines are smoothed with a five-point moving average and drawn in black at half opacity. Another side's unit shows when not all four cells around it are fogged. Spectators and finished matches see everything.

Every page simulates the whole match, so the fog hides units only on screen.

## End of a match

A side wins by the game's rule (capitals and 80% of the cities), when every other side has surrendered, or the match ends in peace when every remaining side offers it within 1800 ticks. **Download replay** saves the match: the original's commands up to the frame, then the players' commands. Simulating the saved replay ends in the same state as the match.

## Big maps

Big maps are played 1v1 from the first frame. They are not listed on the site yet: a faint globe at the foot of the home page hands the layout to the play page as **Play from here** does, so it opens a room with a link to share. For now there is one: the game's 9600×5400 Zolamare world map, played a battlefield pixel a map pixel as the game plays a 1920×1080 map, with 2000 units a side.

### The engine for big maps

`engine/mass-sim` is a copy of `engine/replay-sim` made fast for thousands of units, and `engine/mass-sim-web` its WebAssembly module, published as `engine/mass-sim.wasm`. A replay whose map names its own battlefield size runs on it (`engineFile` in `src/player/wasm-engine.js`, used by the play page and the player); every other replay keeps `replay-sim`, which matches the game's recorded replays. Its changes are marked `mass-sim:` in the source:

- A map may name its battlefield as `size: [width, height]`, up to 16000×9000. A battlefield larger than twice the game's largest keeps its terrain at the picture's own resolution and looks it up scaled (`rasterize_scaled` in `surface.rs`).
- Territory keeps each side's influence as exact fixed-point sums that a unit changes only when it enters another 10-pixel cell, instead of summing every unit again for every changed cell, and a unit's influence reaches 6 cells instead of 12 (past 6 it is under 0.02% of its peak) (`territory.rs`). Supply regions are the grid's connected areas, labelled once a payment, instead of every unit tested against every outline. The outlines, which are only drawn, are traced at most every 15 ticks.
- Movement finds the enemies a retreating unit backs away from, and the friends at a blocked unit's waypoint, from a grid instead of every unit; skips the mountain-edge test away from mountains; leaves out the collisions of units that are not moving; and draws a retreat roll only for a unit that can retreat (`movement.rs`). Combat finds targets and the enemies that stop healing in each side's own grid, and checks healing only for units that can heal (`sim.rs`).
- Positions, health, morale and damage keep full precision instead of the game's rounding to hundredths and thousandths, which costs 128-bit arithmetic in the browser for every unit every tick.
- A live frame is written in its own encoding (`live_lite_chunk` in `output.rs`, read by `decodeLite` in `src/player/frames.js`): uncompressed, about 32 bytes a unit (directions as a byte each, health and morale coarser), and a unit's route, the deaths, the outlines and the core only when they changed since the previous live frame.

These keep every page of a match the same, which is what a match needs, but not the game's exact rules. `mass-bench <replay> [ticks] [groups]` times a tick by part, with every unit ordered towards the enemy capital or, with `groups`, 400 units a side ordered each turn as in a match. On the world map in a match like that, a tick takes about 6 ms natively and 7 ms in WebAssembly (a quarter of a core at 30 ticks a second), a frame 2 ms to write and 372 KB, and the page decodes it in about 3 ms. With all 10,000 units on the move at once a tick takes about 17 ms natively (133 ms on `replay-sim`).

The page, on a big map:

- keeps one object per unit between frames and updates it in place, and keeps what a frame leaves out;
- draws units at a clock that runs at 30 ticks a second a tick and a half behind the newest frame, between where the frames on either side of it had them, so they move at an even pace however unevenly the frames come;
- draws in layers, each a canvas element of its own that the browser stacks (`layer` and `drawLayers` in `src/play/game.js`), drawn again only when what it shows or the view changes: the map, front lines and capitals; the units; the fog and city flags; the status icons, production links and routes (one repaint after a new frame, so their work does not fall on the same repaint); and, on every repaint, the order being drawn and the text;
- draws the units and their bars with WebGL 2 at every zoom (`src/play/gl-units.js`), with the same sprites, order and bars as the canvas. The units go to the GPU only when a frame arrives, with where the previous frame had them, and the GPU moves them between the two on every repaint: a repaint between frames is one draw call. A unit whose two draws (the game draws every unit twice) look the same is one instance drawn twice over in the shader, which composites exactly as two draws; a unit's bars are one instance, with edges smoothed in the shader. The sprites are a mipmapped texture array and there is no multisampling, which keeps it light on integrated graphics;
- without WebGL 2, draws each sprite once at its size on screen and angle into a small canvas and every unit as one unscaled drawImage at a whole pixel (`src/play/sprites.js`), on the one canvas as before;
- draws all route arrows of a colour as one path, from one flat array of points, with arrowheads under 8 pixels on screen left unsmoothed (they look the same) and two-point routes drawn as their two points (smoothing a straight line adds points on it); darkens a selected unit's sprite once rather than with a canvas filter on every draw; and draws unturned images (flags, icons) without saving the canvas's state;
- works out the player's units once a frame, the orders a held gesture would give once a frame and gesture, and a drawn loop's units by its bounding box first;
- works out the front lines in a worker of their own (`src/play/lines-worker.js`) when the outlines change, from a grid of the units and an index of the outlines' vertices (`src/player/frontline.js`, faster on every map, with the same lines);
- gives a formation of more than 150 units its slots in their order along the line, instead of the exact assignment, whose time grows with the cube of the units (`src/play/orders.js`);
- draws the map from a picture at most 4800 pixels wide (`src/player/map.js`), draws front lines as wide beside the units as on a 1920 map, zooms up to the units' size at zoom 3 on a 1080p map (`zoomAt` in `src/play/game.js`), and recomputes a fog grid larger than any game map's at most once a turn (`src/play/engine-worker.js`).

**Orders for thousands of units.** On a big map a route's or a click's waypoints are each unit's whole position plus the same whole offsets (`routeOrders` and `clickOrders` with `shared`), at most a pixel from the game's rounding. `packOrders` then sends units with the same offsets, or the same waypoints, as one group, `{ r: offsets or a: waypoints, u: [id, x, y, ...] }`: a click for 5000 units is a 73 KB message. Every page turns groups back into orders as the turn arrives (`addTurn`), so the simulation, the inflight orders and the saved replay see ordinary orders. The room (`share/src/match.js`) passes groups on and takes messages of up to 1 MB and 10,000 orders; before, it took 64 KB and kept the first 512 orders.

In headless Chrome, with 2000 units a side drawn as sprites at every zoom, the world map's match page draws at about 240 frames a second (the headless limit) zoomed out or in, idle, with all of a side selected, and with thousands of units marching, both on a graphics card and in software rendering; selecting a whole side with a loop takes about a third of a second and ordering it a few milliseconds. With the CPU slowed four times, as a stand-in for a laptop, it draws about 150 frames a second zoomed out with thousands marching (95% of frames within 17 ms). Without WebGL 2 the canvas fallback draws about 65 frames a second zoomed out. Before these changes, with 5000 units a side drawn as squares zoomed out, it drew 2 frames a second, and an order for more than 512 units lost the rest or closed the room.

### The layout

`scripts/big-maps.py` writes it into `public/play-assets/maps`: the `.rep` at frame 0 with the 9600×5400 map embedded at 4800×2700 (a match room takes 1 MB at most), a `.webp` picture of it, and `index.json`, which the home page lists. It needs the installed game (`--game`, by default the Steam folder), Python with NumPy, SciPy and Pillow, and builds `mass-patches` from `engine/mass-sim` if it is missing. The layout is fixed by its seed, so running it again writes the same files.

- **Provinces.** The land is cut into 30 provinces by walking time (water is slow to wade, mountains impassable) from points spread loosely over it, and the provinces are dealt to the sides for the longest front between them while both hold close to the same area and terrain.
- **Density.** 2000 units a side (1500 infantry, 500 tanks) and 400 cities a side.
- **Supply.** Income is paid for each connected region of a side's territory, 5 per city minus 1 per unit outside a city, and a region cut off from the capital pays from nothing, so its units decay as soon as it holds more than five units a city. `mass-patches` reports each region's units and cities at the first payment, and whole packs move from regions with more (two of a five where that is what adds up, leaving a three) to new packs near the cities of regions with fewer, or turn its packs of three into fives, until every region holds exactly five units a city. Income starts at zero everywhere, and after a minute standing still every unit has full health.
- **Cities.** Of 40 even spreads on each side, the pair with the closest numbers of cities in each fifth of distance from the front is kept. Capitals are on each side's main land mass at the same distance behind the front.
- **Units.** As on the game's own maps, where the opposing lines start about 41 pixels apart with units 30 apart along them: a line 21 pixels from the enemy's land along every front, 27 apart, and the rest in packs of three and five behind it, most near the front or a city and at least 110 pixels apart, each on a hexagonal grid 26 apart that bends around obstacles. About a quarter of the lines are tanks, and the rest of the tanks make up whole packs. No unit stands within 60 pixels of an enemy city, and a city that would still start nearer an enemy unit than its own (the engine gives it to the nearest) gets the nearest spare line unit beside it, so packs stay whole. Units fight within 36 pixels.

The script prints each side's supply regions, land, cities by distance from the front, terrain, line units and packs.

## Running it locally

Build the engine and the site against a local share worker, then serve both:

```bash
cargo build --release --manifest-path engine/Cargo.toml -p replay-sim-web --target wasm32-unknown-unknown
```

```bash
VITE_SHARE_API=http://127.0.0.1:8788 npx vite build --config vite.site.config.ts --outDir build/play-site
```

Rename `build/play-site/site.html` to `index.html`, and copy `engine/replay-sim.wasm` and the `maps`, `audio` and `tournaments` folders of a full site build into it. `.claude/launch.json` has `play-site` (the files on port 4176, served by `scripts/serve-site.mjs`, which answers `play` with `play.html` as the hosted site does) and `play-rooms` (`wrangler dev` of the share worker on port 8788).

Deploying needs the share worker deployed with its `MatchRoom` Durable Object (`wrangler.jsonc` declares it).
