import {
  initializeEngine,
  player,
  loadReplay,
  paint,
  bufferStats,
  takeCues,
} from "./engine.js";
import { receiveReply } from "./worker-ipc.js";
let canvas,
  renderer,
  activeEpoch = 0;
const reply = (id, result, error) =>
  postMessage({ kind: "reply", id, result, error });
self.onmessage = async ({ data }) => {
  if (data.kind === "invoke-reply") {
    receiveReply(data);
    return;
  }
  if (data.kind === "invalidate") {
    player.pending++;
    if (renderer) renderer.sequence++;
    return;
  }
  try {
    if (data.kind === "init") {
      canvas = data.canvas;
      renderer = initializeEngine(canvas, {
        frame: (frame) =>
          postMessage({ kind: "frame", frame, epoch: activeEpoch }),
        status: (message) => postMessage({ kind: "status", message }),
        progress: (progress) => postMessage({ kind: "progress", ...progress }),
      });
      reply(data.id, true);
    } else if (data.kind === "open") {
      renderer.view = { zoom: 1, x: 0, y: 0 };
      player.options = data.options;
      if (data.width && data.height && (canvas.width !== data.width || canvas.height !== data.height)) {
        canvas.width = data.width;
        canvas.height = data.height;
      }
      await loadReplay(data.path);
      const { path, lastFrame, complete, frameNumbers } = player.info;
      reply(data.id, {
        path,
        lastFrame,
        complete,
        prepared: frameNumbers.at(-1) ?? 0,
        playerNames: player.info.staticRecord.replay?.player_names || [],
        result: player.info.staticRecord.replay?.result ?? null,
        ...takeCues(),
      });
    } else if (data.kind === "zoom") {
      renderer.zoomAt(data.x, data.y, data.factor);
    } else if (data.kind === "paint") {
      activeEpoch = data.epoch;
      player.options = data.options;
      if (canvas.width !== data.width || canvas.height !== data.height) {
        canvas.width = data.width;
        canvas.height = data.height;
      }
      await paint(data.frame);
      reply(data.id, {
        frame: data.frame,
        buffer: bufferStats(),
        renderMs: renderer.renderMs,
      });
    } else if (data.kind === "snapshot") {
      if (data.reference) {
        reply(data.id, await renderer.referenceSnapshot());
        return;
      }
      const blob = await canvas.convertToBlob({ type: "image/png" });
      reply(data.id, new FileReaderSync().readAsDataURL(blob));
    } else if (data.kind === "draw-request") {
      await Promise.all(renderer.uploads);
      reply(data.id, {
        ...renderer.lastRequest,
        textures: [...renderer.textureData.values()],
      });
    }
  } catch (error) {
    reply(data.id, null, String(error));
  }
};
