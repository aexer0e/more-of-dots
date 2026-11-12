// The test match's simulation: the WebAssembly engine in live mode, as the play
// page's engine worker runs it (src/play/engine-worker.js), without fog of war
// and without the computer opponent.
import { loadEngine } from "../../player/wasm-engine.js";
import { RecordReader } from "../../player/frames.js";

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

function info() {
  engine.liveInfo();
  return JSON.parse(text.decode(take()));
}

function frame() {
  engine.liveFrame();
  const record = take(),
    chunk = new Uint8Array(4 + record.length - 5);
  chunk.set(record.subarray(5), 4);
  return chunk.buffer;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.kind === "open") {
      const wasm = await fetch(`${data.base}engine/replay-sim.wasm`);
      if (!wasm.ok) throw new Error("The game engine could not be loaded.");
      engine = await loadEngine(await wasm.arrayBuffer(), (part) => output.push(part));
      if (!engine.live) throw new Error("This copy of the game engine cannot run matches.");
      if (engine.open(data.replay) !== null) throw new Error("The map could not be opened.");
      engine.liveStart(0);
      let staticRecord = null;
      new RecordReader({ static: (record) => (staticRecord = record), chunk: () => {} }).push(take());
      // Territory, and so the front lines, exist from the first tick on.
      engine.liveStep(null);
      take();
      postMessage({ kind: "opened", staticRecord, info: info() });
    } else if (data.kind === "steps") {
      for (const commands of data.steps) engine.liveStep(commands);
      postMessage({ kind: "frame", info: info(), chunk: data.draw ? frame() : null, fog: null });
    }
  } catch (error) {
    postMessage({ kind: "error", error: String(error?.message ?? error) });
  }
};
