import { invoke } from "./worker-ipc.js";
import { FrameBuffer } from "./scheduling.js";
import { prepareMap } from "./map.js";
import { Renderer } from "./local-renderer.js";
import { frontLines } from "./frontline.js";
import {
  displayOptions,
  iconFor,
  drawBars,
  drawProduction,
  drawStats,
} from "./overlays.js";
let canvas,
  renderer,
  onFrame = () => {},
  onStatus = () => {},
  onProgress = () => {};
export function initializeEngine(target, callbacks) {
  canvas = target;
  renderer = new Renderer(canvas);
  onFrame = callbacks.frame;
  onStatus = callbacks.status;
  onProgress = callbacks.progress;
  // Artwork does not depend on the replay, so it loads while the first replay opens.
  void Promise.all(artwork().map(asset)).catch(() => {});
  return renderer;
}
const colors = ["blue", "red", "purple", "orange"];
const unitSprite = (dot) =>
  `${colors[dot.color]}_${dot.ship ? (dot.type === "tank" ? "heavy_ship" : "ship") : `${dot.type}_${dot.health / dot.max_health > 0.5 ? 100 : dot.health / dot.max_health > 0.15 ? 50 : 15}`}`;
const unitSize = (dot) => {
  const scale = dot.ship_timer > 0 ? 1 + Math.sin(dot.ship_timer / 4) / 12 : 1;
  return (dot.ship ? [36, 18] : [24, 24]).map((value) => value * scale);
};
export const player = {
  info: null,
  frame: 0,
  playing: false,
  speed: 1,
  anchor: 0,
  anchorFrame: 0,
  cache: new Map(),
  loading: new Map(),
  map: null,
  mapSize: [1600, 900],
  assets: new Map(),
  pending: 0,
};
player.options = Object.fromEntries(
  displayOptions.map(([name, , enabled]) => [name, enabled]),
);
async function image(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Cannot load replay artwork (${response.status}).`);
  const blob = await response.blob();
  const img = await createImageBitmap(blob);
  img.png = new FileReaderSync().readAsDataURL(blob);
  return img;
}

const buffer = new FrameBuffer(async (start, count) => {
  const bytes = await invoke("replay_frames", { start, count });
  return {
    rows: JSON.parse(new TextDecoder().decode(bytes)),
    bytes: bytes.byteLength,
  };
});
export const bufferStats = () => buffer.stats();

// The simulation may still be writing later frames. Playback stays inside the
// prepared range; other callers (QA captures) wait for the frame to exist.
let loadToken = 0,
  progressWaiters = [],
  sentCues = 0;
const prepared = () => player.info.frameNumbers.at(-1) ?? 0;
// Sound cues reach the UI thread as they are simulated, each one once.
export function takeCues() {
  const cueStart = sentCues;
  sentCues = player.info.fighting.length;
  return {
    cueStart,
    fighting: player.info.fighting.slice(cueStart),
    produced: player.info.produced.slice(cueStart),
  };
}
function publishProgress() {
  onProgress({
    prepared: prepared(),
    complete: player.info.complete,
    lastFrame: player.info.lastFrame,
    error: player.info.error,
    ...takeCues(),
  });
  progressWaiters.splice(0).forEach((resolve) => resolve());
}
async function followSimulation(token) {
  while (token === loadToken && !player.info.complete) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (token !== loadToken) return;
    const update = await invoke("replay_progress", {
      since: player.info.frameNumbers.length,
    });
    if (token !== loadToken) return;
    for (const frame of update.frameNumbers) player.info.frameNumbers.push(frame);
    player.info.fighting.push(...update.fighting);
    player.info.produced.push(...update.produced);
    buffer.extend(player.info.frameNumbers.length);
    if (update.error && update.error !== "Player closed.") {
      // Frames simulated before the failure stay playable.
      player.info.error = update.error;
      player.info.complete = true;
      player.info.lastFrame = prepared();
    } else if (update.complete) {
      player.info.complete = true;
      player.info.lastFrame = prepared();
    }
    publishProgress();
  }
}

export async function frameAt(tick) {
  while (tick > prepared() && !player.info.complete && !player.info.error)
    await new Promise((resolve) => progressWaiters.push(resolve));
  const frames = player.info.frameNumbers;
  let low = 0,
    high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle] <= tick) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  return buffer.get(index);
}

export async function loadReplay(path) {
  const token = ++loadToken;
  player.playing = false;
  player.ready = false;
  player.pending++;
  await renderer.pending.catch(() => {});
  onStatus("Loading replay…");
  try {
    player.info = await invoke("open_replay", { path });
    sentCues = 0;
    buffer.reset(player.info.frameNumbers.length);
    player.frame = 0;
    renderer.forget(
      [...renderer.sources.keys()].filter(
        (name) => name === "map" || name.startsWith("player-"),
      ),
    );
    const metadata = player.info.staticRecord.static_core;
    player.mapSize = metadata.map_size;
    const surface =
      player.info.staticRecord.rendered_map_surface ||
      player.info.staticRecord.source_map_surface;
    if (!surface)
      throw new Error("This replay does not contain an embedded map.");
    const source = await image(
      surface.startsWith("data:")
        ? surface
        : `data:image/png;base64,${surface}`,
    );
    player.map = prepareMap(
      source,
      player.mapSize,
      metadata.city_positions,
      !!player.info.staticRecord.rendered_map_surface,
    );
    renderer.texture("map", player.map);
    player.labels = [];
    for (const [side, team] of (
      player.info.staticRecord.player_labels || []
    ).entries()) {
      for (const [slot, label] of team.entries()) {
        const key = `player-${side}-${slot}`;
        renderer.texture(
          key,
          await image(`data:image/png;base64,${label.image}`),
        );
        // One line per player, teams in order.
        player.labels.push({ key, size: label.size, line: player.labels.length });
      }
    }
    // Changing a layer or crossing a unit-health threshold never stalls on a new image decode.
    await Promise.all(artwork().map(asset));
    onStatus("");
    player.ready = true;
    await paint(0);
    void followSimulation(token).catch((error) => {
      player.info.error = String(error);
      player.info.complete = true;
      player.info.lastFrame = prepared();
      publishProgress();
    });
  } catch (error) {
    player.info = null;
    player.ready = false;
    throw error;
  }
}

// The small, shared artwork set used by every replay.
function artwork() {
  const types = ["infantry", "tank", "motorised"];
  const names = [
    "capital",
    "ship_icon",
    "water_icon",
    "city_icon",
    "healing_icon",
    "forest_icon",
  ];
  for (const color of colors) {
    names.push(`${color}_flag`, `${color}_ship`, `${color}_heavy_ship`);
    for (const type of types)
      for (const health of [100, 50, 15])
        names.push(`${color}_${type}_${health}`);
  }
  // Motorised sprites share infantry artwork with the game's chevron drawn in
  // the stored asset; only filenames present in the maintained artwork are used.
  return names;
}

async function asset(name) {
  if (!player.assets.has(name))
    player.assets.set(
      name,
      image(`/player-assets/${name}.png`).then((img) => {
        renderer.texture(name, img);
        return img;
      }),
    );
  return player.assets.get(name);
}

export async function paint(index) {
  const request = ++player.pending;
  const state = await frameAt(index);
  if (!state || request !== player.pending) return;
  const [worldW, worldH] = player.mapSize;
  const names = state.dots.filter((dot) => dot?.health > 0).map(unitSprite);
  const fading = (state.core.dead_dots || [])
    .map((dot) => ({ ...dot, alpha: 0.75 - (state.frame - dot.frame) * 0.01 }))
    .filter((dot) => dot.alpha > 0);
  names.push(
    ...fading.map((dot) =>
      dot.ship
        ? `${colors[dot.color]}_${dot.type === "tank" ? "heavy_ship" : "ship"}`
        : `${colors[dot.color]}_${dot.type}_15`,
    ),
  );
  const iconNames = player.options.icons
    ? state.dots
        .map(iconFor)
        .filter(Boolean)
        .map((icon) => icon[0])
    : [];
  const flags = player.options.flags
    ? (state.core.cities || []).map((city) => `${colors[city.color]}_flag`)
    : [];
  await Promise.all(
    [...new Set(["capital", ...names, ...iconNames, ...flags])].map(asset),
  );
  if (request !== player.pending) return;
  renderer.begin(player.mapSize);
  renderer.image("map", [worldW / 2, worldH / 2], player.mapSize);
  for (const line of frontLines(
    state.render?.contours || [],
    state.dots,
    player.mapSize,
  ))
    renderer.line(line);
  for (const city of state.core.capitals || [])
    if (city.position)
      renderer.image(
        "capital",
        [city.position[0], city.position[1] - 2],
        [35, 33],
      );
  for (const dot of fading)
    renderer.image(
      dot.ship
        ? `${colors[dot.color]}_${dot.type === "tank" ? "heavy_ship" : "ship"}`
        : `${colors[dot.color]}_${dot.type}_15`,
      dot.position,
      unitSize(dot),
      dot.alpha,
    );
  const directions = new Map(
    (state.render?.directions || []).map((d) => [d.id, d]),
  );
  for (let pass = 0; pass < 2; pass++)
    for (const dot of state.dots) {
      if (!dot || dot.health <= 0) continue;
      const name = unitSprite(dot);
      const visual = directions.get(dot.id),
        vibration =
          (pass === 0 ? visual?.first_vibration : visual?.second_vibration) ||
          0;
      const pos = [
        dot.position[0] + (visual?.facing?.[0] || 0) * vibration,
        dot.position[1] + (visual?.facing?.[1] || 0) * vibration,
      ];
      const direction = (pass === 0
        ? directions.get(dot.id)?.first_visual
        : directions.get(dot.id)?.visual) ||
        directions.get(dot.id)?.visual || [1, 0];
      renderer.image(name, pos, unitSize(dot), 1, direction, false, true);
    }
  if (player.options.orders)
    for (const dot of state.dots) {
      if (!dot || dot.health <= 0 || !dot.path?.length) continue;
      const path = [dot.position, ...dot.path];
      renderer.line(path.slice(0, 2), [0, 0, 0, 0.5], 5, 2);
      if (dot.path.length > 1) renderer.line(dot.path, [0, 0, 0, 0.5], 5, 2);
      const end = path.at(-1),
        previous = path.at(-2),
        dx = previous[0] - end[0],
        dy = previous[1] - end[1],
        length = Math.sqrt(dx * dx + dy * dy) + 0.01,
        ux = dx / length,
        uy = dy / length;
      for (const side of [-1, 1])
        renderer.line(
          [
            end,
            [end[0] + 9 * ux - side * 6 * uy, end[1] + 9 * uy + side * 6 * ux],
            [
              end[0] + 12 * ux - side * 12 * uy,
              end[1] + 12 * uy + side * 12 * ux,
            ],
          ],
          [0, 0, 0, 0.5],
          5,
          2,
        );
    }
  for (const dot of state.dots)
    if (dot?.health > 0) drawBars(renderer, dot, player.options);
  if (player.options.flags)
    for (const city of state.core.cities || [])
      renderer.image(
        `${colors[city.color]}_flag`,
        [city.position[0] + 9, city.position[1] - 13],
        [21, 27],
      );
  if (player.options.icons)
    for (const dot of state.dots) {
      const icon = iconFor(dot);
      if (dot?.health > 0 && icon)
        renderer.image(
          icon[0],
          [dot.position[0] + 20, dot.position[1] - 10],
          icon[1],
        );
    }
  if (player.options.stats) drawStats(renderer, state);
  const viewScale = Math.min(canvas.width / worldW, canvas.height / worldH),
    viewW = worldW * viewScale,
    viewH = worldH * viewScale;
  if (player.options.players)
    for (const label of player.labels || []) {
      const width = (label.size[0] * viewW) / 1920,
        height = (label.size[1] * viewH) / 1080;
      renderer.image(
        label.key,
        [
          (canvas.width - viewW) / 2 + viewW * 0.00313 + width / 2,
          (canvas.height - viewH) / 2 +
            viewH * (1 / 30 + label.line / 18),
        ],
        [width, height],
        1,
        [1, 0],
        true,
      );
    }
  if (player.options.produce) drawProduction(renderer, state);
  await renderer.finish();
  if (request === player.pending)
    onFrame(state.frame);
}
