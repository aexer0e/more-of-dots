// Playback frames in the chunk format of docs/replay-frames.md. Hosts keep each
// chunk as it was written and answer `replay_chunk` with it; the render worker
// inflates and decodes it into the state records the player draws.
export const BINARY_FRAMES = 1,
  JSON_LINES = 2,
  // The big-map engine's live frames (engine/mass-sim: live_lite_chunk), uncompressed.
  LITE_FRAMES = 3;
const MAGIC = "WODFRM1\n",
  STATIC_RECORD = 1,
  CHUNK_RECORD = 2,
  DEATH_WINDOW = 100;
const unitTypes = ["infantry", "tank", "motorised"];
const terrains = ["plain", "forest", "sand", "river", "mountain", "bridge", "hill", "snow", "mud", "city"];
const text = new TextDecoder();

/// Frame numbers and sound cues, readable without inflating the frames.
export function chunkHeader(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
    count = view.getUint32(1, true);
  if (payload.byteLength < 5 + 12 * count) throw new Error("Incomplete replay chunk.");
  const column = (at) => Array.from({ length: count }, (_, i) => view.getUint32(at + 4 * i, true));
  return {
    encoding: payload[0],
    frames: column(5),
    fighting: column(5 + 4 * count),
    produced: column(5 + 8 * count),
    data: 5 + 12 * count,
  };
}

/// Splits the engine's output stream into its static record and chunks, across
/// arbitrary write boundaries.
export class RecordReader {
  constructor(handlers) {
    this.handlers = handlers;
    this.pending = new Uint8Array(0);
    this.started = false;
  }
  push(bytes) {
    if (this.pending.length) {
      const joined = new Uint8Array(this.pending.length + bytes.length);
      joined.set(this.pending);
      joined.set(bytes, this.pending.length);
      bytes = joined;
    }
    let at = 0;
    if (!this.started) {
      if (bytes.length < MAGIC.length) return void (this.pending = bytes);
      if (text.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error("The replay engine wrote an unknown format.");
      this.started = true;
      at = MAGIC.length;
    }
    while (bytes.length - at >= 5) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4).getUint32(0, true);
      if (bytes.length - at - 5 < length) break;
      const kind = bytes[at],
        payload = bytes.slice(at + 5, at + 5 + length);
      at += 5 + length;
      if (kind === STATIC_RECORD) this.handlers.static(JSON.parse(text.decode(payload)));
      else if (kind === CHUNK_RECORD) this.handlers.chunk(payload);
    }
    this.pending = bytes.slice(at);
  }
  // The stream must end on a record boundary.
  finish() {
    if (this.pending.length || !this.started) throw new Error("The replay engine output ended early.");
  }
}

const piped = (bytes, stream) =>
  new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then((buffer) => new Uint8Array(buffer));

/// A chunk of JSONL state records, for replays that were simulated earlier.
export async function jsonChunk(lines, frames, fighting, produced) {
  const body = await piped(lines.join("\n"), new CompressionStream("deflate-raw")),
    count = frames.length,
    payload = new Uint8Array(5 + 12 * count + body.length),
    view = new DataView(payload.buffer);
  payload[0] = JSON_LINES;
  view.setUint32(1, count, true);
  [frames, fighting, produced].forEach((column, c) =>
    column.forEach((value, i) => view.setUint32(5 + 4 * (c * count + i), value, true)),
  );
  payload.set(body, 5 + 12 * count);
  return payload;
}

/// `replay_chunk` answers with the index of the chunk's first frame, then the chunk.
/// `reuse`, kept by the caller between live frames of a big map, keeps one object per
/// unit and updates it in place (with `from`, its position in the previous frame), and
/// keeps the outlines a frame leaves out. Thousands of new objects a frame stall the page.
export async function decodeChunk(buffer, staticRecord, reuse = null) {
  const start = new DataView(buffer).getUint32(0, true),
    payload = new Uint8Array(buffer, 4),
    header = chunkHeader(payload);
  if (header.encoding === LITE_FRAMES) {
    const data = payload.subarray(header.data);
    return { start, frames: [decodeLite(data, header, staticRecord, reuse ?? {})], bytes: data.length };
  }
  const data = await piped(payload.subarray(header.data), new DecompressionStream("deflate-raw"));
  const frames =
    header.encoding === JSON_LINES
      ? text.decode(data).split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : decodeFrames(data, header, staticRecord, reuse);
  if (frames.length !== header.frames.length) throw new Error("Replay chunk frames do not match its index.");
  return { start, frames, bytes: data.length };
}

// Directions in the lite frames are a byte: 256 steps of a turn.
const COS = Float64Array.from({ length: 256 }, (_, i) => Math.cos((i / 256) * 2 * Math.PI)),
  SIN = Float64Array.from({ length: 256 }, (_, i) => Math.sin((i / 256) * 2 * Math.PI));

/// A lite live frame into the objects kept in `reuse` (see decodeChunk): what the frame
/// leaves out (routes, deaths, outlines, core) stays as the previous frames left it.
function decodeLite(bytes, header, staticRecord, reuse) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    cityPositions = staticRecord.static_core?.city_positions || [];
  let at = 0;
  const u8 = () => bytes[at++],
    i8 = () => view.getInt8(at++),
    u16 = () => ((at += 2), view.getUint16(at - 2, true)),
    u32 = () => ((at += 4), view.getUint32(at - 4, true)),
    f32 = () => ((at += 4), view.getFloat32(at - 4, true)),
    f64 = () => ((at += 8), view.getFloat64(at - 8, true));
  const units = (reuse.dots ??= new Map()),
    turns = (reuse.directions ??= new Map()),
    frame = u32(),
    count = u32(),
    dots = new Array(count),
    directions = new Array(count);
  for (let i = 0; i < count; i++) {
    const id = u32(),
      color = u8(),
      type = unitTypes[u8()],
      flags = u8(),
      terrain = terrains[u8()],
      x = f32(),
      y = f32();
    let dot = units.get(id);
    if (!dot) units.set(id, (dot = { id, position: [x, y], from: [x, y], path: [] }));
    dot.from[0] = dot.position[0];
    dot.from[1] = dot.position[1];
    dot.position[0] = x;
    dot.position[1] = y;
    dot.color = color;
    dot.type = type;
    dot.health = f32();
    dot.max_health = f32();
    dot.morale = u8();
    dot.water_timer = u16();
    dot.ship_timer = u16();
    dot.in_city = !!(flags & 2);
    dot.healing = !!(flags & 4);
    dot.zrtyqz = terrain;
    dot.ship = !!(flags & 1);
    let turn = turns.get(id);
    if (!turn) turns.set(id, (turn = { id, facing: [1, 0], first_visual: [1, 0], visual: [1, 0] }));
    const facing = u8(),
      first = u8(),
      visual = u8();
    turn.facing[0] = COS[facing];
    turn.facing[1] = SIN[facing];
    turn.first_visual[0] = COS[first];
    turn.first_visual[1] = SIN[first];
    turn.visual[0] = COS[visual];
    turn.visual[1] = SIN[visual];
    turn.first_vibration = i8() / 40;
    turn.second_vibration = i8() / 40;
    if (flags & 8) {
      const length = u16();
      if (dot.path.length !== length) dot.path = Array.from({ length }, () => [0, 0]);
      for (const point of dot.path) (point[0] = f32()), (point[1] = f32());
    }
    dots[i] = dot;
    directions[i] = turn;
  }
  const deaths = (reuse.deaths ??= []);
  for (let i = 0, n = u16(); i < n; i++)
    deaths.push({ frame: u32(), color: u8(), type: unitTypes[u8()], ship: !!u8(), position: [f32(), f32()] });
  reuse.deaths = deaths.filter((death) => frame - death.frame < DEATH_WINDOW);
  const changes = u8();
  if (changes & 1)
    reuse.contours = Array.from({ length: u8() }, () =>
      Array.from({ length: u16() }, () => Array.from({ length: u32() }, () => [f64(), f64()])),
    );
  if (changes & 2) {
    const length = u32();
    reuse.core = JSON.parse(text.decode(bytes.subarray(at, at + length)));
    at += length;
  }
  if (at !== bytes.length) throw new Error("Replay chunk has unread data.");
  const core = reuse.core;
  if (!core) throw new Error("Replay chunk does not start with a complete frame.");
  if (reuse.coreFor !== core) {
    reuse.coreFor = core;
    reuse.cities = cityPositions.map((position, i) => ({ position, color: core.city_colors[i] }));
  }
  return {
    kind: "state",
    frame,
    audio: [header.fighting[0], header.produced[0]],
    dots,
    core: {
      frame,
      economy: core.economy,
      troop_casualties: core.troop_casualties,
      strength: core.strength,
      capitals: core.capitals,
      city_positions: cityPositions,
      cities: reuse.cities,
      dead_dots: reuse.deaths,
    },
    render: { contours: reuse.contours ?? [], directions },
  };
}

function decodeFrames(bytes, header, staticRecord, reuse) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    cityPositions = staticRecord.static_core?.city_positions || [];
  let at = 0;
  const u8 = () => bytes[at++],
    u16 = () => ((at += 2), view.getUint16(at - 2, true)),
    u32 = () => ((at += 4), view.getUint32(at - 4, true)),
    f32 = () => ((at += 4), view.getFloat32(at - 4, true)),
    f64 = () => ((at += 8), view.getFloat64(at - 8, true)),
    vec = (read) => [read(), read()];
  // Each frame repeats only what changed since the previous one in this chunk.
  const paths = new Map(),
    deaths = [],
    states = [];
  let contours = reuse?.contours ?? [],
    core = null;
  if (reuse) {
    reuse.dots ??= new Map();
    reuse.directions ??= new Map();
  }
  for (let n = 0; n < header.frames.length; n++) {
    const frame = u32(),
      dots = [],
      directions = [];
    for (let i = 0, count = u16(); i < count; i++) {
      const id = u16(),
        color = u8(),
        type = unitTypes[u8()],
        flags = u8(),
        terrain = terrains[u8()],
        water_timer = u16(),
        ship_timer = u16(),
        x = f32(),
        y = f32(),
        health = f64(),
        max_health = f32(),
        morale = f32();
      if (reuse) {
        let direction = reuse.directions.get(id);
        if (!direction) reuse.directions.set(id, (direction = { id, facing: [0, 0], first_visual: [0, 0], visual: [0, 0] }));
        direction.facing[0] = f32(), direction.facing[1] = f32();
        direction.first_visual[0] = f32(), direction.first_visual[1] = f32();
        direction.visual[0] = f32(), direction.visual[1] = f32();
        direction.first_vibration = f32();
        direction.second_vibration = f32();
        directions.push(direction);
        let dot = reuse.dots.get(id);
        if (!dot) reuse.dots.set(id, (dot = { id, position: [x, y], from: [x, y], path: [] }));
        dot.from[0] = dot.position[0], dot.from[1] = dot.position[1];
        dot.position[0] = x, dot.position[1] = y;
        const length = u16();
        if (length !== 0xffff) {
          if (dot.path.length !== length) dot.path = Array.from({ length }, () => [0, 0]);
          for (const point of dot.path) (point[0] = f32()), (point[1] = f32());
        }
        Object.assign(dot, {
          color,
          type,
          health,
          max_health,
          morale,
          water_timer,
          ship_timer,
          in_city: !!(flags & 2),
          healing: !!(flags & 4),
          zrtyqz: terrain,
          ship: !!(flags & 1),
        });
        dots.push(dot);
        continue;
      }
      const position = [x, y];
      directions.push({
        id,
        facing: vec(f32),
        first_visual: vec(f32),
        visual: vec(f32),
        first_vibration: f32(),
        second_vibration: f32(),
      });
      const length = u16();
      if (length !== 0xffff) paths.set(id, Array.from({ length }, () => vec(f32)));
      dots.push({
        id,
        position,
        color,
        type,
        health,
        max_health,
        morale,
        water_timer,
        ship_timer,
        in_city: !!(flags & 2),
        healing: !!(flags & 4),
        zrtyqz: terrain,
        path: paths.get(id) ?? [],
        ship: !!(flags & 1),
      });
    }
    for (let i = 0, count = u16(); i < count; i++)
      deaths.push({ frame: u32(), color: u8(), type: unitTypes[u8()], ship: !!u8(), position: vec(f32) });
    const changes = u8();
    if (changes & 1)
      contours = Array.from({ length: u8() }, () =>
        Array.from({ length: u16() }, () => Array.from({ length: u32() }, () => vec(f64))),
      );
    if (changes & 2) {
      const length = u32();
      core = JSON.parse(text.decode(bytes.subarray(at, at + length)));
      at += length;
    }
    if (!core) throw new Error("Replay chunk does not start with a complete frame.");
    states.push({
      kind: "state",
      frame,
      audio: [header.fighting[n], header.produced[n]],
      dots,
      core: {
        frame,
        economy: core.economy,
        troop_casualties: core.troop_casualties,
        strength: core.strength,
        capitals: core.capitals,
        city_positions: cityPositions,
        cities: cityPositions.map((position, i) => ({ position, color: core.city_colors[i] })),
        dead_dots: deaths.filter((death) => frame - death.frame < DEATH_WINDOW),
      },
      render: { contours, directions },
    });
  }
  if (at !== bytes.length) throw new Error("Replay chunk has unread data.");
  if (reuse) reuse.contours = contours;
  return states;
}
