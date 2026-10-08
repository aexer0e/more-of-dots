// The browser's answer to the desktop player commands: the WebAssembly engine
// simulates in a worker and its frames are kept, compressed, in memory.
const base = new URL(import.meta.env.BASE_URL, location.href).href;
const files = new Map();

export function addFile(file) {
  files.set(file.name, file);
  return file.name;
}
export function chooseReplay() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".rep,.repsim,.jsonl";
    input.onchange = () => resolve(input.files[0] ? addFile(input.files[0]) : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const sounds = {
  music: "music.mp3",
  fighting: "fighting.flac",
  produce_unit: "produce_unit.wav",
  victory: "victory.wav",
  defeat: "defeat.wav",
};
export async function gameAudio() {
  // A build without the sound files plays silently.
  const hosted = await fetch(`${base}audio/${sounds.produce_unit}`, { method: "HEAD" })
    .then((response) => response.ok)
    .catch(() => false);
  return {
    files: hosted
      ? Object.fromEntries(Object.entries(sounds).map(([name, file]) => [name, `${base}audio/${file}`]))
      : null,
    music: null,
    sfx: null,
  };
}

// The desktop engine renders player names with SDL_ttf. This draws the same
// picture: the name in its side's colour over eight black copies as an outline.
const sideColors = ["#0000ff", "#ff0000", "#9c00bb", "#ff8c39"];
function nameLabel(text, side) {
  const canvas = document.createElement("canvas"),
    context = canvas.getContext("2d"),
    font = '60px "Arial Narrow", Arial, sans-serif';
  context.font = font;
  const metrics = context.measureText(text),
    ascent = Math.ceil(metrics.fontBoundingBoxAscent);
  canvas.width = Math.max(1, Math.ceil(metrics.width)) + 3;
  canvas.height = ascent + Math.ceil(metrics.fontBoundingBoxDescent) + 3;
  context.font = font;
  context.fillStyle = "#000";
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]])
    context.fillText(text, Math.trunc(1.5 + dx * 1.5), Math.trunc(1.5 + dy * 1.5) + ascent);
  context.fillStyle = sideColors[side] ?? "#c8c8c8";
  context.fillText(text, 1, 1 + ascent);
  return { text, size: [canvas.width, canvas.height], image: canvas.toDataURL("image/png").split(",")[1] };
}

const piped = (bytes, stream) =>
  new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then((buffer) => new Uint8Array(buffer));

let replay = null;
class Replay {
  constructor(path) {
    this.path = path;
    this.frames = [];
    this.fighting = [];
    this.produced = [];
    // Each block holds consecutive frames as JSON rows; `ends` are their offsets.
    this.blocks = [];
    this.open = [];
    this.complete = false;
    this.error = null;
    this.started = new Promise((resolve) => (this.ready = resolve));
  }
  async start() {
    const file = files.get(this.path) ?? (await this.download());
    if (this.complete) return;
    this.worker = new Worker(new URL("./web-engine.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.worker.onerror = (event) =>
      this.receive({ kind: "done", error: event.message || "The replay engine stopped." });
    this.worker.postMessage({ file, base, simulated: /\.(repsim|jsonl)$/i.test(this.path) });
  }
  async download() {
    const response = await fetch(this.path);
    if (!response.ok) throw new Error(`Cannot download this replay (${response.status}).`);
    return response.blob();
  }
  receive(data) {
    if (data.kind === "static") {
      const record = data.record;
      if (!record.rendered_map_surface && !record.source_map_surface)
        return this.finish("This repsim has no embedded map. Open its original .rep to generate a playable repsim.");
      record.player_labels = (record.player_labels || []).map((team, side) =>
        team.map((label) => (label.image ? label : nameLabel(label.text, side))),
      );
      this.staticRecord = record;
    } else if (data.kind === "frames") {
      if (data.frames[0] <= this.frames.at(-1)) return this.finish("Replay frames must increase.");
      const block = { start: this.frames.length, ends: data.ends, raw: data.buffer, packed: null };
      this.blocks.push(block);
      for (let i = 0; i < data.frames.length; i++) {
        this.frames.push(data.frames[i]);
        this.fighting.push(data.fighting[i]);
        this.produced.push(data.produced[i]);
      }
      // A replay is hundreds of megabytes of JSON; only the blocks in use stay unpacked.
      void piped(block.raw, new CompressionStream("deflate-raw")).then((packed) => {
        block.packed = packed;
        if (!this.open.includes(block)) block.raw = null;
      });
    } else if (data.kind === "done") {
      if (!data.error && !(this.staticRecord && this.frames.length))
        data.error = "This file has no playable frames or map metadata.";
      this.finish(data.error);
    }
    if (this.staticRecord && this.frames.length) this.ready();
  }
  finish(error) {
    if (this.complete) return;
    this.complete = true;
    this.error = error || null;
    this.worker?.terminate();
    this.ready();
  }
  close() {
    this.finish("Player closed.");
    this.blocks = [];
    this.open = [];
  }
  async unpacked(block) {
    const raw = block.raw ?? (block.raw = await piped(block.packed, new DecompressionStream("deflate-raw")));
    this.open = [block, ...this.open.filter((other) => other !== block)];
    for (const other of this.open.splice(4)) if (other.packed) other.raw = null;
    return raw;
  }
  info() {
    if (!(this.staticRecord && this.frames.length)) throw new Error(this.error);
    const available = this.frames.at(-1);
    return {
      path: this.path,
      lastFrame: this.complete ? available : Math.max(this.staticRecord.replay?.end ?? 0, available),
      frameNumbers: [...this.frames],
      fighting: [...this.fighting],
      produced: [...this.produced],
      complete: this.complete,
      staticRecord: this.staticRecord,
    };
  }
  progress(since) {
    return {
      frameNumbers: this.frames.slice(since),
      fighting: this.fighting.slice(since),
      produced: this.produced.slice(since),
      complete: this.complete,
      error: this.error,
    };
  }
  /// Up to `count` rows from `start` as a JSON array, within the playback buffer limit.
  async rows(start, count, limit = 8 << 20) {
    const end = Math.min(start + Math.min(count, 120), this.frames.length),
      parts = [];
    let size = 2;
    for (let index = start; index < end; ) {
      const block = this.blocks.findLast((candidate) => candidate.start <= index);
      if (!block) throw new Error("Open a replay first.");
      const raw = await this.unpacked(block);
      for (let row = index - block.start; row < block.ends.length && index < end; row++, index++) {
        const bytes = raw.subarray(row ? block.ends[row - 1] : 0, block.ends[row]);
        if (bytes.length + 2 > limit) throw new Error("This replay frame exceeds the playback buffer limit.");
        if (size + bytes.length + 1 > limit) {
          index = end;
          break;
        }
        parts.push(bytes);
        size += bytes.length + 1;
      }
    }
    const result = new Uint8Array(parts.reduce((total, bytes) => total + bytes.length + 1, 1) + (parts.length ? 0 : 1));
    let offset = 0;
    result[offset++] = 91;
    parts.forEach((bytes, index) => {
      if (index) result[offset++] = 44;
      result.set(bytes, offset);
      offset += bytes.length;
    });
    result[offset] = 93;
    return result.buffer;
  }
}

export async function invoke(command, args = {}) {
  if (command === "open_replay") {
    replay?.close();
    const opened = (replay = new Replay(args.path));
    await opened.start().catch((error) => opened.finish(String(error?.message ?? error)));
    await opened.started;
    return opened.info();
  }
  if (!replay) throw new Error("Open a replay first.");
  if (command === "replay_progress") return replay.progress(args.since);
  if (command === "replay_frames") return replay.rows(args.start, args.count);
  throw new Error(`${command} is not available in the browser.`);
}
