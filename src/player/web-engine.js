// Runs the WebAssembly replay engine in its own worker and posts its JSONL output
// in blocks of whole frames. The simulation is one long synchronous call, so a
// replay is cancelled by terminating this worker.
const STATE = new TextEncoder().encode('{"kind":"state","frame":');
const AUDIO = new TextEncoder().encode(',"audio":[');
const decoder = new TextDecoder();
const startsWith = (bytes, at, prefix) => {
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
};

let pending = [],
  rows = [],
  frames = [],
  fighting = [],
  produced = [],
  size = 0,
  sent = false;
function flush() {
  if (!rows.length) return;
  const buffer = new Uint8Array(size),
    ends = [];
  let offset = 0;
  for (const row of rows) {
    buffer.set(row, offset);
    ends.push((offset += row.length));
  }
  postMessage({ kind: "frames", buffer, ends, frames, fighting, produced }, [buffer.buffer]);
  (rows = []), (frames = []), (fighting = []), (produced = []), (size = 0), (sent = true);
}
function record(line) {
  if (!line.length) return;
  if (!startsWith(line, 0, STATE)) {
    const row = JSON.parse(decoder.decode(line));
    if (row.kind === "static") postMessage({ kind: "static", record: row });
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
  rows.push(line);
  size += line.length;
  // The first frame goes out at once so playback can start.
  if (!sent || rows.length >= 60 || size >= 4 << 20) flush();
}
function write(chunk) {
  let start = 0;
  for (let end; (end = chunk.indexOf(10, start)) >= 0; start = end + 1) {
    let line = chunk.subarray(start, end);
    if (pending.length) {
      const whole = new Uint8Array(pending.reduce((total, part) => total + part.length, line.length));
      let offset = 0;
      for (const part of [...pending, line]) whole.set(part, offset), (offset += part.length);
      (line = whole), (pending = []);
    }
    record(line);
  }
  if (start < chunk.length) pending.push(chunk.subarray(start));
}

async function simulate(bytes, base) {
  const { dotnet } = await import(/* @vite-ignore */ `${base}engine/_framework/dotnet.js`);
  const { setModuleImports, getAssemblyExports, getConfig } = await dotnet.create();
  setModuleImports("replay-host", { write: (view) => write(view.slice()) });
  const engine = (await getAssemblyExports(getConfig().mainAssemblyName)).ReplaySim.Standalone.WebEngine;
  // Official maps are hosted beside the page and fetched only when a replay names one.
  for (let missing, last; (missing = engine.Open(bytes)) !== null; last = missing) {
    const name = missing.toLowerCase();
    let map = null;
    if (missing !== last && /^[\w./-]+\.png$/.test(name) && !name.includes(".."))
      for (const url of [name, name.split("/").pop()]) {
        const response = await fetch(`${base}maps/${url}`);
        if (response.ok) { map = new Uint8Array(await response.arrayBuffer()); break; }
      }
    if (!map) throw new Error(`This replay uses a map that is not available here (${missing}).`);
    engine.AddMap(missing, map);
  }
  engine.Run();
}
// A .repsim or .jsonl file already holds the simulated frames.
async function read(file) {
  for (const reader = file.stream().getReader(); ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    write(value);
  }
}
// The .NET runtime never finishes starting in a worker that has `onmessage` set.
self.addEventListener("message", async ({ data }) => {
  try {
    if (data.simulated) await read(data.file);
    else await simulate(new Uint8Array(await data.file.arrayBuffer()), data.base);
    if (pending.length) write(new Uint8Array([10]));
    flush();
    postMessage({ kind: "done" });
  } catch (error) {
    flush();
    postMessage({ kind: "done", error: String(error?.message ?? error) });
  }
});
