// The WebAssembly replay engine (engine/replay-sim-web), for the hosted player and
// for parity checks under Node. `write` receives each piece of output as it is
// written: the chunk stream (docs/replay-frames.md) or JSONL.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function loadEngine(wasm, write) {
  let exports;
  const view = (ptr, len) => new Uint8Array(exports.memory.buffer, ptr, len);
  const { instance } = await WebAssembly.instantiate(wasm, {
    env: { write: (ptr, len) => write(view(ptr, len).slice()) },
  });
  exports = instance.exports;
  // Copies bytes into the module, which takes ownership of them.
  const pass = (bytes) => {
    const ptr = exports.alloc(bytes.length);
    view(ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
  };
  const message = () => decoder.decode(view(exports.message_ptr(), exports.message_len()));
  // A failure inside the module traps; its message is still readable.
  // Only a trap leaves its reason in the message; any other error is its own, and
  // the message may still hold an earlier answer, such as a map's name.
  const call = (action) => {
    try {
      return action();
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) throw new Error(message() || String(error.message));
      throw error;
    }
  };
  return {
    /** Whether this build of the module has live play (an older cached copy may not). */
    live: typeof exports.live_start === "function",
    /** Stores a map where the engine looks for bundled maps. */
    addMap(path, bytes) {
      call(() => exports.add_map(...pass(encoder.encode(path)), ...pass(bytes)));
    },
    /** Reads the replay. Returns the path of an official map the page still has
     * to supply with addMap before calling open again, or null when it is ready. */
    open(bytes) {
      const code = call(() => exports.open(...pass(bytes)));
      if (code === 0) return null;
      if (code === 1) return message();
      throw new Error(message());
    },
    /** Simulates the opened replay; `jsonl` writes the desktop engine's JSONL instead of chunks. */
    run(jsonl = false) {
      if (call(() => exports.run(jsonl ? 1 : 0)) !== 0) throw new Error(message());
    },
    /** Simulates the opened replay, writing only each side's troops as one JSON line. */
    troops() {
      if (call(() => exports.run(2)) !== 0) throw new Error(message());
    },
    // Live play (engine/replay-sim-web/src/live.rs). Each call's output goes to `write`.
    /** Continues the opened replay from `frame`; writes the stream header and static record. */
    liveStart(frame) {
      if (call(() => exports.live_start(frame)) !== 0) throw new Error(message());
    },
    /** Applies one turn's commands (or none) and simulates the next tick. */
    liveStep(commands) {
      const bytes = commands ? encoder.encode(JSON.stringify(commands)) : new Uint8Array(0);
      if (call(() => exports.live_step(...pass(bytes))) !== 0) throw new Error(message());
    },
    /** Writes the current frame as a chunk record. */
    liveFrame() {
      if (call(() => exports.live_frame()) !== 0) throw new Error(message());
    },
    /** Writes the next tick, winner, state digest and territory version as JSON. */
    liveInfo() {
      if (call(() => exports.live_info()) !== 0) throw new Error(message());
    },
    /** Writes the fog of war over a side. */
    liveFog(side) {
      if (call(() => exports.live_fog(side)) !== 0) throw new Error(message());
    },
  };
}
