import { invoke } from "./host.js";
import { displayOptions } from "./overlays.js";
import { LatestTask } from "./scheduling.js";

export const player = {
  ready: false,
  info: null,
  frame: 0,
  playing: false,
  speed: 1,
  anchor: 0,
  anchorFrame: 0,
  options: Object.fromEntries(
    displayOptions.map(([name, , enabled]) => [name, enabled]),
  ),
};
let worker,
  sequence = 0,
  width = 960,
  height = 540,
  epoch = 0;
const requests = new Map();
let callbacks, ready;
let stopped = false;
function call(kind, data = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    if (stopped) {
      reject(new Error("Replay worker stopped. Reopen this player."));
      return;
    }
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    worker.postMessage({ ...data, kind, id }, transfer);
  });
}
const frames = new LatestTask(async (request) => {
  await ready;
  const result = await call("paint", request);
  renderer.metrics = result;
  return true;
});
export const renderer = {
  metrics: null,
  get pending() {
    return frames.idle();
  },
  resize(w, h) {
    width = w;
    height = h;
    renderer.invalidate();
  },
  invalidate() {
    epoch++;
    frames.cancel();
    worker?.postMessage({ kind: "invalidate" });
  },
  zoomAt(x, y, factor) {
    worker?.postMessage({ kind: "zoom", x, y, factor });
    renderer.invalidate();
  },
  async snapshot(reference = false) {
    await frames.idle();
    return call("snapshot", { reference });
  },
  async drawRequest() {
    await frames.idle();
    return call("draw-request");
  },
};
export function initializeEngine(canvas, handlers) {
  callbacks = handlers;
  worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = ({ data }) => {
    if (data.kind === "invoke") {
      // All large state/pixel payloads are binary and transferred to the worker.
      // The UI does no JSON parsing, PNG encoding or image decoding per frame.
      invoke(data.command, data.args)
        .then((result) => {
          const transfer = result instanceof ArrayBuffer ? [result] : [];
          worker.postMessage(
            { kind: "invoke-reply", id: data.id, result },
            transfer,
          );
        })
        .catch((error) =>
          worker.postMessage({
            kind: "invoke-reply",
            id: data.id,
            error: String(error),
          }),
        );
    } else if (data.kind === "reply") {
      const request = requests.get(data.id);
      if (!request) return;
      requests.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    } else if (data.kind === "status") callbacks.status(data.message);
    else if (data.kind === "progress" && player.info) {
      Object.assign(player.info, {
        prepared: data.prepared,
        complete: data.complete,
        lastFrame: data.lastFrame,
        error: data.error,
      });
      data.fighting.forEach((count, i) => (player.info.fighting[data.cueStart + i] = count));
      data.produced.forEach((sides, i) => (player.info.produced[data.cueStart + i] = sides));
      callbacks.progress?.(player.info);
    }
    else if (data.kind === "frame" && data.epoch === epoch)
      callbacks.frame(data.frame);
  };
  worker.onerror = (event) => {
    stopped = true;
    player.ready = false;
    player.playing = false;
    const error = new Error(
      event.message || "Replay worker stopped. Reopen this player.",
    );
    requests.forEach((request) => request.reject(error));
    requests.clear();
    callbacks.error?.(error);
  };
  const surface = canvas.transferControlToOffscreen();
  // The worker fetches artwork relative to where the app is served.
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  ready = call("init", { canvas: surface, base }, [surface]);
  // Surface startup errors even before a replay is selected.
  ready.catch((error) => callbacks.error?.(error));
  addEventListener("beforeunload", () => {
    stopped = true;
    worker.terminate();
  });
  return renderer;
}
export async function loadReplay(path) {
  player.ready = false;
  renderer.invalidate();
  await frames.idle();
  await ready;
  // The worker draws the first frame while opening, so it needs the real
  // canvas size; otherwise that frame is a stretched 300x150 placeholder.
  player.info = await call("open", { path, options: { ...player.options }, width, height });
  player.ready = true;
  player.frame = 0;
}
export function paint(frame) {
  return frames.submit({
    frame,
    width,
    height,
    epoch,
    options: { ...player.options },
  });
}
