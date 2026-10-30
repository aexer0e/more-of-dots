// Runs the WebAssembly replay engine in its own worker and posts its output as
// chunks (docs/replay-frames.md). The simulation is one long synchronous call, so a
// replay is cancelled by terminating this worker.
import { RecordReader, jsonChunk } from "./frames.js";
import { loadEngine } from "./wasm-engine.js";

const post = {
  static: (record) => postMessage({ kind: "static", record }),
  chunk: (payload) => postMessage({ kind: "chunk", payload }, [payload.buffer]),
};

async function simulate(bytes, base) {
  const reader = new RecordReader(post);
  const wasm = await fetch(`${base}engine/replay-sim.wasm`);
  if (!wasm.ok) throw new Error("The replay engine could not be loaded.");
  const engine = await loadEngine(await wasm.arrayBuffer(), (bytes) => reader.push(bytes));
  // Official maps are hosted beside the page and fetched only when a replay names one.
  for (let missing, last; (missing = engine.open(bytes)) !== null; last = missing) {
    const name = missing.toLowerCase();
    let map = null;
    if (missing !== last && /^[\w./-]+\.png$/.test(name) && !name.includes(".."))
      for (const url of [name, name.split("/").pop()]) {
        // GitHub Pages lets browsers keep a "not found" for hours, so a map added
        // since is asked for again past the browser's cache.
        let response = await fetch(`${base}maps/${url}`);
        if (!response.ok) response = await fetch(`${base}maps/${url}`, { cache: "reload" });
        if (response.ok) { map = new Uint8Array(await response.arrayBuffer()); break; }
      }
    if (!map) throw new Error(`This replay uses a map that is not available here (${missing}).`);
    engine.addMap(missing, map);
  }
  engine.run();
  reader.finish();
}

// A .repsim or .jsonl file already holds the simulated frames: its state records
// become chunks of JSON lines.
const STATE = new TextEncoder().encode('{"kind":"state","frame":');
const AUDIO = new TextEncoder().encode(',"audio":[');
const decoder = new TextDecoder();
const startsWith = (bytes, at, prefix) => {
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
};
const concat = (parts) => {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) whole.set(part, offset), (offset += part.length);
  return whole;
};
async function read(file) {
  let pending = [],
    rows = [],
    frames = [],
    fighting = [],
    produced = [],
    sent = false;
  const flush = async () => {
    if (!rows.length) return;
    const chunk = await jsonChunk(rows, frames, fighting, produced);
    (rows = []), (frames = []), (fighting = []), (produced = []), (sent = true);
    post.chunk(chunk);
  };
  const record = async (line) => {
    if (!line.length) return;
    if (!startsWith(line, 0, STATE)) {
      const row = JSON.parse(decoder.decode(line));
      if (row.kind === "static") post.static(row);
      if (row.kind !== "state") return;
      frames.push(row.frame), fighting.push(row.audio?.[0] ?? 0), produced.push(row.audio?.[1] ?? 0);
    } else {
      let at = STATE.length,
        frame = 0;
      while (line[at] >= 48 && line[at] <= 57) frame = frame * 10 + line[at++] - 48;
      // New frames keep their sound cues beside the frame number; older files may not.
      let cues = startsWith(line, at, AUDIO)
        ? decoder.decode(line.subarray(at + AUDIO.length, line.indexOf(93, at))).split(",").map(Number)
        : JSON.parse(decoder.decode(line)).audio;
      if (cues?.length !== 2 || cues.some(Number.isNaN)) cues = [0, 0];
      frames.push(frame), fighting.push(cues[0]), produced.push(cues[1]);
    }
    rows.push(decoder.decode(line));
    // The first frame goes out at once so playback can start.
    if (!sent || rows.length >= 60) await flush();
  };
  for (const reader = file.stream().getReader(); ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    let start = 0;
    for (let end; (end = value.indexOf(10, start)) >= 0; start = end + 1) {
      let line = value.subarray(start, end);
      if (pending.length) (line = concat([...pending, line])), (pending = []);
      await record(line);
    }
    if (start < value.length) pending.push(value.slice(start));
  }
  if (pending.length) await record(concat(pending));
  await flush();
}

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.simulated) await read(data.file);
    else await simulate(new Uint8Array(await data.file.arrayBuffer()), data.base);
    postMessage({ kind: "done" });
  } catch (error) {
    postMessage({ kind: "done", error: String(error?.message ?? error) });
  }
});
