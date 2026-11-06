# Play from here

The hosted player can continue a replay as a live match. Pause on a frame and choose **Play from here**: a room opens at once and shows its link. Whoever opens the link takes the first side nobody has. The host can start once every side has a player, and the match continues from that frame with fog of war and the game's controls. Players are named Player 1, Player 2 and so on in the order they join, and can change their name in the lobby. A changed name is kept for that room in that browser tab only.

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

Inferred rather than measured: when a dragged loop selects instead of drawing a route (a loop that comes back near its start, or any drag with nothing selected), the slot for a single-unit formation (the middle of the line), and the production widget's layout outside the measured knob and button positions. Middle-drag panning is an addition.

## Fog of war

As in the game: every 10-pixel cell outside the side's territory is fogged, except under its ships, and the fog then shrinks by seven cells. Its outlines are smoothed with a five-point moving average and drawn in black at half opacity. Another side's unit shows when not all four cells around it are fogged. Spectators and finished matches see everything.

Every page simulates the whole match, so the fog hides units only on screen.

## End of a match

A side wins by the game's rule (capitals and 80% of the cities), when every other side has surrendered, or the match ends in peace when every remaining side offers it within 1800 ticks. **Download replay** saves the match: the original's commands up to the frame, then the players' commands. Simulating the saved replay ends in the same state as the match.

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
