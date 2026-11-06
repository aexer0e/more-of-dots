// Runs a match's simulation: the WebAssembly engine in live mode
// (engine/replay-sim-web/src/live.rs). The page sends one message per tick with
// that tick's commands; the worker answers with the frame to draw.
import { loadEngine } from "../player/wasm-engine.js";
import { RecordReader } from "../player/frames.js";

let engine = null,
  output = [];
const take = () => {
  const total = output.reduce((sum, part) => sum + part.length, 0),
    bytes = new Uint8Array(total);
  let at = 0;
  for (const part of output) bytes.set(part, at), (at += part.length);
  output = [];
  return bytes;
};
const text = new TextDecoder();

async function open(bytes, base) {
  // The engine's address never changes between releases, so the browser checks
  // with the server for a newer copy instead of using one it kept.
  const wasm = await fetch(`${base}engine/replay-sim.wasm`, { cache: "no-cache" });
  if (!wasm.ok) throw new Error("The game engine could not be loaded.");
  engine = await loadEngine(await wasm.arrayBuffer(), (part) => output.push(part));
  if (!engine.live) throw new Error("This page loaded an older game engine. Reload the page to update it.");
  // Official maps are hosted beside the page and fetched only when a replay names one.
  for (let missing, last; (missing = engine.open(bytes)) !== null; last = missing) {
    const name = missing.toLowerCase();
    let map = null;
    if (missing !== last && /^[\w./-]+\.png$/.test(name) && !name.includes(".."))
      for (const url of [name, name.split("/").pop()]) {
        const response = await fetch(`${base}maps/${url}`);
        if (response.ok) {
          map = new Uint8Array(await response.arrayBuffer());
          break;
        }
      }
    if (!map) throw new Error(`This replay uses a map that is not available here (${missing}).`);
    engine.addMap(missing, map);
  }
}

function info() {
  engine.liveInfo();
  return JSON.parse(text.decode(take()));
}

// A chunk record is a kind byte and a length; `decodeChunk` wants the index of the
// chunk's first frame in front of the chunk instead.
function frame() {
  engine.liveFrame();
  const record = take(),
    chunk = new Uint8Array(4 + record.length - 5);
  chunk.set(record.subarray(5), 4);
  return chunk.buffer;
}

let fogVersion = null;
function fog(side, territory, ships) {
  // The fog follows the territory and the side's ships.
  const key = `${territory}:${ships}`;
  if (side === null || key === fogVersion) return null;
  fogVersion = key;
  engine.liveFog(side);
  const bytes = take(),
    view = new DataView(bytes.buffer),
    width = view.getUint32(0, true),
    height = view.getUint32(4, true);
  return {
    width,
    height,
    grid: bytes.slice(8, 8 + width * height),
    outlines: JSON.parse(text.decode(bytes.subarray(8 + width * height))),
  };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.kind === "open") {
      await open(data.replay, data.base);
      engine.liveStart(data.frame);
      let staticRecord = null;
      new RecordReader({ static: (record) => (staticRecord = record), chunk: () => {} }).push(take());
      postMessage({ kind: "opened", staticRecord, info: info() });
    } else if (data.kind === "steps") {
      // Several ticks at once when the page is catching up; only the last is drawn.
      for (const commands of data.steps) engine.liveStep(commands);
      const state = info();
      postMessage(
        {
          kind: "frame",
          info: state,
          chunk: data.draw ? frame() : null,
          fog: data.draw ? fog(data.side, state.territory, data.ships) : null,
        },
      );
    }
  } catch (error) {
    postMessage({ kind: "error", error: String(error?.message ?? error) });
  }
};
