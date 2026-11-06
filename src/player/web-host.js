// The browser's answer to the desktop player commands: the WebAssembly engine
// simulates in a worker and its chunks are kept in memory as the engine wrote them.
import { chunkHeader } from "./frames.js";

const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
const files = new Map();

export function addFile(file) {
  files.set(file.name, file);
  return file.name;
}
/// The file of a replay the page opened, for continuing it as a match (src/play).
export async function replayFile(path) {
  const file = files.get(path);
  if (file) return file;
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Cannot download this replay (${response.status}).`);
  return response.blob();
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

let replay = null;
class Replay {
  constructor(path) {
    this.path = path;
    this.frames = [];
    this.fighting = [];
    this.produced = [];
    // Each chunk is `{ start, payload }`: the index of its first frame and its bytes.
    this.chunks = [];
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
    } else if (data.kind === "chunk") {
      const header = chunkHeader(data.payload);
      if (header.frames[0] <= this.frames.at(-1) || header.frames.some((frame, i) => i && frame <= header.frames[i - 1]))
        return this.finish("Replay frames must increase.");
      this.chunks.push({ start: this.frames.length, payload: data.payload });
      this.frames.push(...header.frames);
      this.fighting.push(...header.fighting);
      this.produced.push(...header.produced);
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
    this.chunks = [];
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
  /// The chunk holding frame `index`, after the index of its first frame.
  chunk(index) {
    let low = 0,
      high = this.chunks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.chunks[middle].start <= index) low = middle + 1;
      else high = middle;
    }
    const chunk = this.chunks[low - 1];
    if (!chunk || index >= this.frames.length) throw new Error("This replay frame is not available yet.");
    const result = new Uint8Array(4 + chunk.payload.length);
    new DataView(result.buffer).setUint32(0, chunk.start, true);
    result.set(chunk.payload, 4);
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
  if (command === "replay_chunk") return replay.chunk(args.index);
  throw new Error(`${command} is not available in the browser.`);
}
