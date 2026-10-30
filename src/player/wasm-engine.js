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
  const call = (action) => {
    try {
      return action();
    } catch (error) {
      throw new Error(message() || String(error?.message ?? error));
    }
  };
  return {
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
  };
}
