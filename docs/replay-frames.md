# Replay frame chunks

The player reads simulated frames in chunks. The engine writes them with `--format binary` (the desktop app) or the WebAssembly module's `run` (the hosted player). Both hosts keep the chunks in memory exactly as written and pass one to the player when asked. Nothing is written to disk.

JSONL output (`--render-state`, the default format) is unchanged. It is used by the parity tools, and the player still opens `.repsim` and `.jsonl` files: their hosts group the records into chunks of JSON lines.

| Part | Reads and writes it |
|---|---|
| `engine/replay-sim/src/output.rs` | Writes the stream |
| `src-tauri/src/player.rs` | Desktop host: reads the stream, or a JSONL file |
| `src/player/web-engine.js`, `src/player/web-host.js` | Browser host: the same |
| `src/player/frames.js` | Reads the stream and the chunk header, decodes frames |

## Stream

All numbers are little-endian.

1. The 8 bytes `WODFRM1\n`.
2. Records: a `u8` kind, a `u32` payload length, then the payload.
   - Kind 1: the static record, as UTF-8 JSON. It is the first line of the JSONL output.
   - Kind 2: a chunk.

The first chunk holds frame 0 alone, so playback can start at once. Later chunks hold up to 60 frames. If the simulation fails, the frames before the failure are still written.

## Chunk

| Field | Type |
|---|---|
| Encoding | `u8`: 1 binary frames, 2 JSON lines |
| Frame count `n` | `u32` |
| Frame numbers | `n` × `u32` |
| Units in combat (sound cue) | `n` × `u32` |
| Sides that produced a unit (sound cue, bit per side) | `n` × `u32` |
| Frames | raw deflate, to the end of the payload |

Hosts index the header and never inflate the frames. `replay_chunk { index }` returns the chunk that holds frame `index`, preceded by a `u32` with the index of its first frame.

JSON lines are the JSONL state records separated by `\n`.

## Binary frames

The first frame of a chunk is complete. Each later frame stores paths, contours and the economy only when they differ from the previous frame of the same chunk, so a chunk is always decoded from its start.

Each frame:

| Field | Type |
|---|---|
| Frame number | `u32` |
| Unit count | `u16`, living units only |
| Units | see below |
| Death count | `u16` |
| Deaths | `u32` frame, `u8` color, `u8` type, `u8` ship, `f32` x, `f32` y |
| Changes | `u8`: 1 contours follow, 2 core follows |
| Contours | `u8` sides; per side `u16` polygons; per polygon `u32` points of `f64` x, y |
| Core | `u32` length, UTF-8 JSON |

A unit is `u16` id, `u8` color, `u8` type, `u8` flags (1 ship, 2 in city, 4 healing), `u8` terrain, `u16` water timer, `u16` ship timer, `f32` x and y, `f64` health, `f32` maximum health, `f32` morale, `f32` pairs for facing, first visual direction and visual direction, `f32` first and second vibration. Then `u16` path length followed by `f32` x, y pairs, or `0xFFFF` when the path is the one written for that unit earlier in the chunk.

Types are `infantry`, `tank`, `motorised`. Terrains are `plain`, `forest`, `sand`, `river`, `mountain`, `bridge`, `hill`, `snow`, `mud`, `city`.

Health and contour points keep full precision: health picks a unit's sprite at exact thresholds, and front lines match contour vertices shared by neighbouring sides. Everything else only positions drawings and is stored as `f32`.

The complete frame of a chunk lists the deaths of the last 100 frames. Later frames list only new deaths. The player draws a death for 75 frames.

The core JSON holds `economy.fields` (`zrtyz`, `zasdxz`, `industrial_zone`, `city_enc`), `troop_casualties`, `strength`, `capitals` and `city_colors`. City positions come from the static record.

`decodeChunk` in `src/player/frames.js` rebuilds the same state records as the JSONL output, limited to the fields the player draws.

## Measurements

On 20 October 2026, on the development machine, with a 43,350-frame replay:

| | JSONL | Chunks |
|---|---|---|
| Output | 1,233 MB | 36 MB |
| Desktop engine | 15.6 s (34.4 s before the territory and contour caches) | 7.9 s |
| WebAssembly engine under Node | 53 s (163 s before) | 24.7 s |

Across 90 dev replays the chunks took 842 MB against 22.9 GB of JSONL. For each of those replays, every field listed above matched the JSONL output of the same build after decoding. Positions, morale and directions match to float32 precision. Front lines moved by less than 0.001 px.

## Troop lines

Replay cards draw each side's troops over the whole match. The desktop app gets them from `--format troops`, which runs the simulation without render state and writes one JSON line: `{"frames": end, "every": 30, "strength": [[...], ...]}`. Each series holds a side's `strength` (troops in hundreds) at every 30th frame. The app averages each series into at most 30 points and appends them to `media-cache/replay-troops/lines.jsonl`, one `{"h": sha256, "s": sides}` per line. The library reads that file whole before building the first cards, so lines are there as cards scroll in. Replays missing from it are simulated when their cards appear, then the rest of the library, two replays at a time at below normal priority.
