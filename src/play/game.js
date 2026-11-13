// A match continued from a replay: the simulation (engine-worker.js), the
// battlefield as the replay player draws it, the fog of war, and the game's
// controls. Turns come from the match room every 15 ticks; the page simulates at
// the game's 30 ticks a second and waits when the next turn has not arrived.
import { decodeChunk } from "../player/frames.js";
import { prepareMap } from "../player/map.js";
import { frontLines } from "../player/frontline.js";
import { Renderer } from "../player/local-renderer.js";
import { iconFor, drawBars, barRects, drawStats } from "../player/overlays.js";
import {
  PICK_RADIUS,
  clickOrders,
  packOrders,
  unpackGroups,
  extendGesture,
  formationOrders,
  gatherOrders,
  inside,
  isLoop,
  routeOrders,
  stopOrders,
} from "./orders.js";
import { MatchSound } from "./sound.js";
import { SpriteBatch, SpriteCache } from "./sprites.js";
import { UnitLayer, FLIP, DARK, TWICE, HEALTH, MORALE } from "./gl-units.js";

export const TURN_TICKS = 15;
const TICK_MS = 1000 / 30;
// The game's peace offer waits this many ticks before it can be made again.
const PEACE_COOLDOWN = 1800;
// A press on a unit that moves this many screen pixels draws an arrow, even one
// shorter than the spacing between waypoints; less is a click that selects.
const ARROW_DRAG_PX = 4;
// A right press that moves less than this is a click (confirm), not a pan.
const RIGHT_CLICK_PX = 5;
export const colors = ["blue", "red", "purple", "orange"];
export const sideRgb = [
  [0, 0, 255],
  [255, 0, 0],
  [156, 0, 187],
  [255, 140, 57],
];
const css = (rgb, alpha = 1) => `rgba(${rgb.join(",")},${alpha})`;
const unitSprite = (dot) =>
  `${colors[dot.color]}_${dot.ship ? (dot.type === "tank" ? "heavy_ship" : "ship") : `${dot.type}_${dot.health / dot.max_health > 0.5 ? 100 : dot.health / dot.max_health > 0.15 ? 50 : 15}`}`;
const unitSize = (dot) => {
  const scale = dot.ship_timer > 0 ? 1 + Math.sin(dot.ship_timer / 4) / 12 : 1;
  return (dot.ship ? [36, 18] : [24, 24]).map((value) => value * scale);
};
// The sprites a unit or a dead unit can have, in the order of `unitArt`'s indices.
const unitArt = colors.flatMap((color) => [
  `${color}_ship`,
  `${color}_heavy_ship`,
  ...["infantry", "tank", "motorised"].flatMap((type) => [100, 50, 15].map((health) => `${color}_${type}_${health}`)),
]);
const unitArtIndex = new Map(unitArt.map((name, i) => [name, i]));
const deadSprite = (dot) => (dot.ship ? `${colors[dot.color]}_${dot.type === "tank" ? "heavy_ship" : "ship"}` : `${colors[dot.color]}_${dot.type}_15`);
const unitTypes = { infantry: 0, tank: 1, motorised: 2 };
/** A unit's sprite as an index into `unitArt`: what `unitSprite` names. */
const unitLayer = (dot) => {
  const base = dot.color * 11;
  if (dot.ship) return base + (dot.type === "tank" ? 1 : 0);
  const type = unitTypes[dot.type],
    health = dot.health / dot.max_health;
  return type === undefined ? -1 : base + 2 + type * 3 + (health > 0.5 ? 0 : health > 0.15 ? 1 : 2);
};
const artwork = () => {
  const names = ["capital", "ship_icon", "water_icon", "city_icon", "healing_icon", "forest_icon"];
  for (const color of colors) {
    names.push(`${color}_flag`, `${color}_ship`, `${color}_heavy_ship`);
    for (const type of ["infantry", "tank", "motorised"]) for (const health of [100, 50, 15]) names.push(`${color}_${type}_${health}`);
  }
  return names;
};
const panelArt = [
  "surrender_button",
  "surrender_button_pressed",
  "peace_button",
  "peace_button_pressed",
];
// The control panel's switches, in the order of their number keys.
const switches = [
  ["orders", "ORDERS"],
  ["health", "HEALTH"],
  ["morale", "MORALE"],
  ["flags", "FLAGS"],
  ["stats", "STATS"],
  ["icons", "ICONS"],
  ["produce", "PRODUCE"],
  ["players", "PLAYERS"],
  ["chat", "CHAT"],
];
export const helpLines = [
  "Click a unit to select it",
  "Draw a loop to select multiple units",
  "Hold SHIFT to select multiple units",
  "Click a location to move units",
  "Click + drag to draw a movement path",
  "Ctrl + drag to move units in formation",
  "C clears orders    S stops selected units instantly",
  "ENTER or RIGHT-click confirms orders",
  "ALT + click sends all selected units to one spot",
  "Orders made while holding ALT go out when it is released",
  "SPACE shows the Options Panel in-game",
  "Zoom with mouse wheel or touchpad",
];
// Production widget geometry at the 1920×1080 reference size.
// The mobilization slider's knob runs along the top of its wedge.
const RATE_BEGIN = [70, 1040],
  RATE_END = [384, 879];
const unitPrices = { infantry: 200, tank: 400, motorised: 400 },
  unitLabels = { infantry: "Light", tank: "Heavy", motorised: "Shock" };
/** The production rows: their unit type and the top and height of each. */
function productionRows(types) {
  const height = types.length > 2 ? 50 : 67;
  return types.map((type, i) => ({ type, top: 1053 - (types.length - i) * height, height }));
}

async function bitmap(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cannot load ${url} (${response.status}).`);
  return createImageBitmap(await response.blob());
}

// The replay player's canvas renderer, drawing on the page instead of a worker,
// with the fog of war and darkened selected units.
class PlayRenderer extends Renderer {
  constructor(canvas) {
    super(canvas);
    this.baseContext = this.context;
  }
  /** The big maps' units on the GPU, in a canvas of their own (see gl-units.js), or
   * false where WebGL 2 is missing. */
  get units() {
    if (this.unitGl === undefined) {
      const element = this.element("units");
      this.unitGl = UnitLayer.create(element, unitArt) || false;
      if (!this.unitGl) this.removeLayers();
    }
    return this.unitGl;
  }
  /** Starts a layer of its own (the big maps): what is drawn from here to the next layer
   * goes into a canvas element stacked over the page's canvas, which the browser puts
   * together. A layer is drawn again only when `version` (a list, compared item by
   * item) or the view changed, or on every frame when `version` is null. The first
   * layer is the page's canvas. Returns whether the layer is drawn this frame. */
  layer(name, version) {
    this.layerState ??= new Map();
    const { vw, vh, ox, oy } = this.frame,
      { zoom, x, y } = this.view,
      stamp = [this.canvas.width, this.canvas.height, vw, vh, ox, oy, zoom, x, y].join(),
      last = this.layerState.get(name),
      same = !!version && !!last?.version && last.stamp === stamp && last.version.length === version.length && last.version.every((item, i) => item === version[i]);
    if (!same) this.layerState.set(name, { stamp, version });
    this.draws.push({ type: "layer", name, skip: same });
    return !same;
  }
  /** The canvas element of the layer `name`, stacked above the layers made before it. */
  element(name) {
    this.elements ??= new Map();
    let element = this.elements.get(name);
    if (!element) {
      element = document.createElement("canvas");
      element.className = "game-layer";
      element.setAttribute("aria-hidden", "true");
      (this.lastElement ?? this.canvas).after(element);
      this.lastElement = element;
      this.elements.set(name, element);
    }
    if (element.width !== this.canvas.width || element.height !== this.canvas.height) {
      element.width = this.canvas.width;
      element.height = this.canvas.height;
    }
    return element;
  }
  removeLayers() {
    for (const element of this.elements?.values() || []) element.remove();
    this.elements = this.lastElement = this.layerState = null;
  }
  texture(name, source) {
    this.sources.set(name, source);
    this.textures.set(name, true);
  }
  fog(polygons) {
    this.draws.push({ type: "fog", polygons });
  }
  /** Many lines of one colour and width, stroked as one path: `entries` holds
   * `[points, smooth]` as `line` takes them. */
  lines(polylines, color, width) {
    if (polylines.starts.length) this.draws.push({ type: "lines", xy: polylines.xy, length: polylines.length, starts: polylines.starts, color, width });
  }
  /** A sprite at half brightness, made once (a canvas filter on every draw is slow). */
  darkened(name) {
    this.dark ??= new Map();
    if (!this.dark.has(name)) {
      const source = this.sources.get(name);
      if (!source) return null;
      const canvas = new OffscreenCanvas(source.width, source.height),
        context = canvas.getContext("2d");
      context.filter = "brightness(50%)";
      context.drawImage(source, 0, 0);
      this.dark.set(name, canvas);
    }
    return this.dark.get(name);
  }
  /** The cache of units' sprites at their size on screen (see sprites.js). */
  get spriteCache() {
    return (this.unitCache ??= new SpriteCache(unitArt, barRects));
  }
  /** Units and bars drawn through the sprite cache. */
  sprites(batch) {
    this.draws.push({ type: "sprites", batch });
  }
  /** Draws each layer (see `layer`) that changed into its own canvas. Leaves `context`
   * on the last, for what is drawn over everything. */
  drawLayers() {
    const [mw, mh] = this.mapSize,
      { ox, oy, vw, vh } = this.frame,
      { zoom, x, y } = this.view,
      view = { mw, mh, ox, oy, vw, vh, zoom, x, y },
      draws = this.draws;
    for (let i = 0; i < draws.length; ) {
      const marker = draws[i++];
      let end = i;
      while (end < draws.length && draws[end].type !== "layer") end++;
      const from = i;
      i = end;
      if (marker.name === "units") {
        if (marker.skip) continue;
        const draw = draws.slice(from, end).find((d) => d.type === "units");
        this.units.draw(this.sources, (vw / mw) * zoom, ox + x * vw, oy + y * vh, draw?.between ?? 1, [ox, oy, vw, vh]);
        continue;
      }
      const ctx = marker.name === "ground" ? this.baseContext : this.element(marker.name).getContext("2d");
      this.context = ctx;
      if (marker.skip) continue;
      ctx.resetTransform();
      ctx.globalAlpha = 1;
      if (ctx === this.baseContext) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      } else ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, vw, vh);
      ctx.clip();
      ctx.setTransform((vw / mw) * zoom, 0, 0, (vh / mh) * zoom, ox + x * vw, oy + y * vh);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      for (let k = from; k < end; k++) {
        const draw = draws[k];
        if (draw.type === "text") this.drawText(draw, ox, oy, vw, vh);
        else if (draw.type === "cached") this.drawCached(ctx, draw, view);
        else this.drawWorld(ctx, draw, view);
      }
      ctx.restore();
    }
  }

  /** A layer drawn into a canvas of its own and copied in, drawn again only when its
   * content or the view changes (see `cached`). */
  drawCached(ctx, draw, view) {
    const { vw, vh, ox, oy } = view,
      layer = this.layers.get(draw.key);
    if (draw.draws) {
      layer.canvas.width = vw;
      layer.canvas.height = vh;
      const context = layer.canvas.getContext("2d");
      context.setTransform((vw / view.mw) * view.zoom, 0, 0, (vh / view.mh) * view.zoom, view.x * vw, view.y * vh);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "low";
      for (const inner of draw.draws) this.drawWorld(context, inner, view);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer.canvas, ox, oy);
    ctx.restore();
  }

  /** Draws a layer whose content is `version` (any object: the same object, the same
   * content) through a canvas of its own: `build` adds its draws, and runs only when the
   * content or the view changed since the layer was last drawn. */
  cached(key, version, build) {
    this.layers ??= new Map();
    const { vw, vh } = this.frame,
      { zoom, x, y } = this.view,
      stamp = [vw, vh, zoom, x, y].join();
    let layer = this.layers.get(key);
    if (!layer) this.layers.set(key, (layer = { canvas: new OffscreenCanvas(1, 1), version: null, stamp: null, draws: [] }));
    if (layer.version === version && layer.stamp === stamp) {
      this.draws.push({ type: "cached", key, draws: null });
      return;
    }
    // The draws are kept until the content changes; a new view only draws them again.
    if (layer.version !== version) {
      const start = this.draws.length;
      build();
      layer.draws = this.draws.splice(start);
      layer.version = version;
    }
    layer.stamp = stamp;
    this.draws.push({ type: "cached", key, draws: layer.draws });
  }

  /** One draw in map coordinates, on `ctx` with the view's transform set. */
  drawWorld(ctx, draw, view) {
    const { mw, ox, oy, vw, vh, zoom, x, y } = view;
    if (draw.type === "image") {
      const image = draw.dark ? this.darkened(draw.name) : this.sources.get(draw.name);
      if (!image) return;
      const [dx, dy] = draw.direction || [1, 0];
      if (dx === 1 && dy === 0 && !draw.flipY && draw.name !== "map") {
        // Not turned (flags, icons): the same as below without saving the state.
        const alpha = draw.alpha ?? 1,
          [width, height] = draw.size;
        if (alpha !== 1) ctx.globalAlpha = alpha;
        ctx.drawImage(image, draw.position[0] - width / 2, draw.position[1] - height / 2, width, height);
        if (alpha !== 1) ctx.globalAlpha = 1;
        return;
      }
      ctx.save();
      ctx.translate(...draw.position);
      ctx.transform(dx, dy, -dy, dx, 0, 0);
      if (draw.flipY) ctx.scale(1, -1);
      ctx.globalAlpha = draw.alpha ?? 1;
      ctx.imageSmoothingEnabled = draw.name !== "map";
      ctx.drawImage(image, -draw.size[0] / 2, -draw.size[1] / 2, ...draw.size);
      ctx.restore();
    } else if (draw.type === "sprites") {
      const transform = ctx.getTransform(),
        source = (index, dark) => (dark ? this.darkened(unitArt[index]) : this.sources.get(unitArt[index]));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.spriteCache.draw(ctx, draw.batch, source, transform.a, transform.d, transform.e, transform.f);
      ctx.setTransform(transform);
    } else if (draw.type === "lines") {
      const [r, g, b, a] = draw.color;
      ctx.strokeStyle = `rgba(${r * 255},${g * 255},${b * 255},${a})`;
      ctx.lineWidth = (Math.max(draw.width, 1) * Math.min(mw, 1920)) / 1920;
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      const { xy, starts } = draw;
      for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : draw.length;
        ctx.moveTo(xy[starts[i]], xy[starts[i] + 1]);
        for (let k = starts[i] + 2; k < end; k += 2) ctx.lineTo(xy[k], xy[k + 1]);
      }
      ctx.stroke();
    } else if (draw.type === "fog") {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      for (const polygon of draw.polygons) {
        polygon.forEach((point, index) => (index ? ctx.lineTo(...point) : ctx.moveTo(...point)));
        ctx.closePath();
      }
      ctx.fill("evenodd");
    } else {
      const [r, g, b, a] = draw.color;
      ctx.fillStyle = ctx.strokeStyle = `rgba(${r * 255},${g * 255},${b * 255},${a})`;
      ctx.beginPath();
      if (draw.type === "circle") {
        ctx.arc(...draw.position, draw.radius, 0, Math.PI * 2);
        if (draw.ring) {
          ctx.lineWidth = draw.ring;
          ctx.stroke();
        } else ctx.fill();
      } else {
        draw.points.forEach((point, index) => (index ? ctx.lineTo(...point) : ctx.moveTo(...point)));
        if (draw.type === "polygon") {
          ctx.closePath();
          ctx.fill();
        } else {
          // Widths use a 1920-pixel reference; a larger map (the site's big maps) keeps
          // the lines' width beside the units as on a 1920 map.
          ctx.lineWidth = (Math.max(draw.width, 1) * Math.min(mw, 1920)) / 1920;
          ctx.lineJoin = ctx.lineCap = "round";
          ctx.stroke();
        }
      }
    }
  }

  drawLocal() {
    if (this.draws[0]?.type === "layer") return this.drawLayers();
    this.context = this.baseContext;
    const ctx = this.context,
      [mw, mh] = this.mapSize,
      { ox, oy, vw, vh } = this.frame;
    ctx.resetTransform();
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, vw, vh);
    ctx.clip();
    const { zoom, x, y } = this.view;
    ctx.setTransform((vw / mw) * zoom, 0, 0, (vh / mh) * zoom, ox + x * vw, oy + y * vh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    const view = { mw, mh, ox, oy, vw, vh, zoom, x, y };
    for (const draw of this.draws) {
      if (draw.type === "text") this.drawText(draw, ox, oy, vw, vh);
      else if (draw.type === "cached") this.drawCached(ctx, draw, view);
      else this.drawWorld(ctx, draw, view);
    }
    ctx.restore();
  }
}

/** Lines smoothed as `line` smooths them (each pass puts points a quarter and three
 * quarters along every segment), kept as one flat array of x, y with where each line
 * starts: thousands of arrows a frame without an array for every point. */
class Polylines {
  /** `coarse`: lines this small on screen keep their corners (arrowheads a few pixels
   * across look the same). */
  constructor(coarse = false) {
    this.xy = new Float64Array(16384);
    this.length = 0;
    this.starts = [];
    this.coarse = coarse;
  }
  room(count) {
    if (this.length + count <= this.xy.length) return;
    const grown = new Float64Array(Math.max(this.xy.length * 2, this.length + count));
    grown.set(this.xy);
    this.xy = grown;
  }
  /** Adds the line through `points` ([x, y] each), smoothed once. */
  add(points) {
    const n = points.length;
    if (n < 2) return;
    this.room(4 * n);
    const xy = this.xy;
    let k = this.length;
    this.starts.push(k);
    if (n === 2) {
      // A straight line smoothed is the same straight line.
      xy[k++] = points[0][0];
      xy[k++] = points[0][1];
      xy[k++] = points[1][0];
      xy[k++] = points[1][1];
      this.length = k;
      return;
    }
    xy[k++] = points[0][0];
    xy[k++] = points[0][1];
    for (let i = 0; i < n - 1; i++) {
      const [ax, ay] = points[i],
        [bx, by] = points[i + 1];
      xy[k++] = ax * 0.75 + bx * 0.25;
      xy[k++] = ay * 0.75 + by * 0.25;
      xy[k++] = ax * 0.25 + bx * 0.75;
      xy[k++] = ay * 0.25 + by * 0.75;
    }
    xy[k++] = points[n - 1][0];
    xy[k++] = points[n - 1][1];
    this.length = k;
  }
  /** Adds the line through three points a, b, c, smoothed twice. */
  add3(ax, ay, bx, by, cx, cy) {
    if (this.coarse) {
      this.room(6);
      this.starts.push(this.length);
      this.xy.set([ax, ay, bx, by, cx, cy], this.length);
      this.length += 6;
      return;
    }
    // Once: a, 3/4 a + 1/4 b, 1/4 a + 3/4 b, 3/4 b + 1/4 c, 1/4 b + 3/4 c, c.
    const once = [ax, ay, 0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by, 0.75 * bx + 0.25 * cx, 0.75 * by + 0.25 * cy, 0.25 * bx + 0.75 * cx, 0.25 * by + 0.75 * cy, cx, cy];
    this.room(24);
    const xy = this.xy;
    let k = this.length;
    this.starts.push(k);
    xy[k++] = ax;
    xy[k++] = ay;
    for (let i = 0; i < 10; i += 2) {
      const px = once[i],
        py = once[i + 1],
        qx = once[i + 2],
        qy = once[i + 3];
      xy[k++] = px * 0.75 + qx * 0.25;
      xy[k++] = py * 0.75 + qy * 0.25;
      xy[k++] = px * 0.25 + qx * 0.75;
      xy[k++] = py * 0.25 + qy * 0.75;
    }
    xy[k++] = cx;
    xy[k++] = cy;
    this.length = k;
  }
}

/** The game's fog outline smoothing: a five-point moving average along each run
 * of points away from the map's edges. */
function smoothFog(points, [mw, mh]) {
  if (points.length <= 2) return points;
  const edge = points.map(([x, y]) => x <= 0 || x >= mw || y <= 0 || y >= mh),
    result = points.map((p) => [...p]);
  let start = 0;
  while (start < points.length) {
    while (start < points.length && edge[start]) start++;
    let end = start;
    while (end < points.length && !edge[end]) end++;
    const block = points.slice(start, end);
    for (let i = 0; i < block.length; i++) {
      let sx = 0,
        sy = 0;
      for (let d = -2; d <= 2; d++) {
        const p = block[Math.max(0, Math.min(block.length - 1, i + d))];
        sx += p[0];
        sy += p[1];
      }
      result[start + i] = [sx / 5, sy / 5];
    }
    start = end;
  }
  return result;
}

export class Game {
  constructor({ canvas, base, replay, frame, side, room, names, onEnd, onStatus }) {
    this.canvas = canvas;
    this.base = base;
    this.replay = replay;
    this.startFrame = frame;
    this.side = side;
    this.room = room;
    this.names = names; // side → player names
    this.onEnd = onEnd;
    this.onStatus = onStatus;
    this.renderer = new PlayRenderer(canvas);
    this.renderer.view = { zoom: 1, x: 0, y: 0 };
    this.options = { orders: true, health: true, morale: true, flags: true, stats: true, icons: true, players: true };
    this.selected = new Set();
    this.gesture = null;
    this.staged = new Map();
    this.inflight = new Map();
    this.turns = new Map();
    // Every turn applied so far, for saving the match as a replay.
    this.log = [];
    this.received = 0;
    this.tick = frame;
    this.queuedTicks = frame;
    this.busy = false;
    this.budget = 0;
    this.started = false;
    this.startAt = 0;
    this.ended = null;
    this.state = null;
    this.info = null;
    this.fogState = null;
    this.panel = false;
    this.production = false;
    this.help = false;
    this.chat = null;
    this.messages = [];
    this.surrendered = new Set();
    this.peaceOffers = new Map();
    this.peaceAvailableAt = 0;
    this.rateDrag = null;
    this.hover = [0, 0];
    this.pressed = null;
    this.sound = new MatchSound(base);
  }

  async load() {
    this.worker = new Worker(new URL("./engine-worker.js", import.meta.url), { type: "module" });
    const opened = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.kind === "opened") resolve(data);
        else if (data.kind === "error") reject(new Error(data.error));
        else this.receive(data);
      };
      this.worker.onerror = (event) => reject(new Error(event.message || "The game engine stopped."));
    });
    this.worker.postMessage({ kind: "open", replay: this.replay, frame: this.startFrame, base: this.base });
    const { staticRecord, info } = await opened;
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.staticRecord = staticRecord;
    this.info = info;
    this.tick = this.queuedTicks = info.tick;
    this.startFrame = info.tick;
    this.mapSize = staticRecord.static_core.map_size;
    this.sides = staticRecord.player_labels?.length || 2;
    const surface = staticRecord.rendered_map_surface || staticRecord.source_map_surface;
    const source = await createImageBitmap(await (await fetch(`data:image/png;base64,${surface}`)).blob());
    this.renderer.texture("map", prepareMap(source, this.mapSize, staticRecord.static_core.city_positions, !!staticRecord.rendered_map_surface));
    await Promise.all([
      ...artwork().map(async (name) => this.renderer.texture(name, await bitmap(`${this.base}player-assets/${name}.png`))),
      // A panel without its artwork still works.
      ...panelArt.map((name) =>
        bitmap(`${this.base}play-assets/${name}.png`)
          .then((image) => this.renderer.texture(name, image))
          .catch(() => {}),
      ),
    ]);
    // The frame the match starts from.
    await new Promise((resolve) => {
      this.firstFrame = resolve;
      this.request([]);
    });
    this.attach();
    // The simulation keeps time on a timer, which also runs (more slowly) in a
    // hidden tab; drawing follows the display.
    let last = performance.now();
    this.clock = setInterval(() => {
      const now = performance.now();
      this.advance(Math.min(now - last, 1000));
      last = now;
    }, 10);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // Simulation ------------------------------------------------------------------

  /** Before the match, or when the host lets a watcher join a running one. */
  setSide(side) {
    if (side === this.side) return;
    this.side = side;
    this.fogState = null;
    this.mineFor = null;
    this.selected.clear();
    this.gesture = null;
    this.staged.clear();
    this.inflight.clear();
    this.panel = this.production = false;
    this.chat = null;
    if (this.worker && !this.busy) this.request([]);
  }

  /** The match starts `delay` ms from now; its first turn arrives then. */
  start(delay) {
    this.started = true;
    this.startAt = performance.now() + delay;
    this.sound.start();
  }

  /** On a big map, orders share whole offsets and travel in groups (see packOrders). */
  get shared() {
    return this.mapSize?.[0] > 1920;
  }

  addTurn({ turn, commands }) {
    // Packed groups become ordinary orders here, before anything reads the turn: the
    // simulation, the inflight orders and the saved replay all see `orders`.
    for (const entry of commands || [])
      if (entry.groups) {
        entry.orders = [...(entry.orders || []), ...unpackGroups(entry.groups)];
        delete entry.groups;
      }
    this.turns.set(turn, commands);
    this.received = Math.max(this.received, turn + 1);
    this.lastTurnAt = performance.now();
  }

  request(steps) {
    this.busy = true;
    const ships = this.state && this.side !== null
      ? this.state.dots.filter((d) => d.ship && d.color === this.side).map((d) => `${Math.trunc(d.position[0] / 10)},${Math.trunc(d.position[1] / 10)}`).join(";")
      : "";
    this.worker.postMessage({ kind: "steps", steps, draw: true, side: this.side, ships });
  }

  async receive(data) {
    if (data.kind === "error") {
      this.onStatus?.(data.error);
      return;
    }
    if (data.kind !== "frame") return;
    this.info = data.info;
    this.tick = data.info.tick;
    if (data.fog) {
      const outlines = data.fog.outlines.map((polygon) => smoothFog(polygon, this.mapSize));
      this.fogState = { ...data.fog, outlines };
    }
    if (data.chunk) {
      // A big map keeps one object per unit between frames (see decodeChunk), and its
      // units move smoothly between frames, which come less often than the screen's.
      const big = this.mapSize[0] > 1920;
      const { frames } = await decodeChunk(data.chunk, this.staticRecord, big ? (this.reuse ??= {}) : null);
      // The ticks of the previous frame and this one, between which units are drawn.
      this.fromTick = this.toTick ?? frames[0].frame;
      this.toTick = frames[0].frame;
      this.state = frames[0];
      this.sound.frame(this.state, this.side);
    }
    this.busy = false;
    this.firstFrame?.();
    this.firstFrame = null;
    const relative = this.tick - this.startFrame;
    if (this.started && relative > 0 && relative % TURN_TICKS === 0)
      this.room?.send({ type: "hash", turn: relative / TURN_TICKS, hash: this.info.hash });
    if (this.info.winner !== null && this.info.winner !== undefined && !this.ended) this.finish(this.info.winner === this.side ? 1 : this.side === null ? -1 : 0);
  }

  /** Simulates the ticks that are due, up to the next turn the room has not sent. */
  advance(elapsed) {
    if (!this.started || this.ended || performance.now() < this.startAt) return;
    const behind = this.received - Math.floor((this.queuedTicks - this.startFrame) / TURN_TICKS);
    // A page that fell behind (a hidden tab, a slow machine) catches up quickly.
    const rate = behind > 20 ? 120 : behind > 4 ? 8 : behind >= 2 ? 1.5 : 1;
    this.budget = Math.min(this.budget + (elapsed / TICK_MS) * rate, 240);
    if (this.busy) return;
    const steps = [];
    while (this.budget >= 1 && steps.length < 240) {
      const relative = this.queuedTicks - this.startFrame;
      let commands = null;
      if (relative % TURN_TICKS === 0) {
        // Each batch ends at a turn so the state can be compared with the other pages.
        if (steps.length) break;
        const turn = relative / TURN_TICKS;
        if (!this.turns.has(turn)) {
          // A local match makes its turns when they are due.
          this.room?.need?.(turn);
          this.budget = Math.min(this.budget, 1);
          break;
        }
        commands = this.turns.get(turn);
        this.turns.delete(turn);
        this.log.push({ tick: this.queuedTicks, commands });
        this.applyTurn(commands);
        if (this.ended) break;
      }
      steps.push(commands?.length ? commands : null);
      this.queuedTicks++;
      this.budget--;
    }
    if (steps.length) this.request(steps);
  }

  /** What a turn does outside the simulation: messages, surrender and peace. */
  applyTurn(commands) {
    for (const entry of commands) {
      if (entry.orders && (entry.side === this.side))
        for (const [id] of entry.orders) this.inflight.delete(id);
        this.inflightVersion = (this.inflightVersion || 0) + 1;
      if (entry.message) this.messages.push({ side: entry.side, text: entry.message, at: performance.now() });
      if (entry.surrender) this.surrendered.add(entry.side);
      if (entry.peace) this.peaceOffers.set(entry.side, this.queuedTicks);
    }
    const active = this.activeSides();
    if (this.side !== null && this.surrendered.has(this.side)) return this.finish(0);
    if (active.length === 1 && this.surrendered.size) return this.finish(this.side === null ? -1 : active[0] === this.side ? 1 : 0);
    const offered = active.filter((side) => (this.peaceOffers.get(side) ?? -Infinity) > this.queuedTicks - PEACE_COOLDOWN);
    if (active.length > 1 && offered.length === active.length) return this.finish(this.side === null ? -1 : 0.5);
  }

  /** Sides still in the match: they have units or cities and have not surrendered. */
  activeSides() {
    const alive = new Set();
    for (const dot of this.state?.dots || []) if (dot.health > 0) alive.add(dot.color);
    for (const city of this.state?.core.cities || []) alive.add(city.color);
    return [...alive].filter((side) => !this.surrendered.has(side)).sort();
  }

  finish(result) {
    if (this.ended) return;
    this.ended = { result, tick: this.queuedTicks };
    this.selected.clear();
    this.gesture = null;
    this.panel = this.production = false;
    this.sound.end(result);
    this.onEnd?.(result);
  }

  // Commands --------------------------------------------------------------------

  send(orders) {
    if (!orders.size || this.side === null || this.ended) return;
    const packed = packOrders(orders);
    this.room.send({ type: "command", orders: packed.orders, ...(packed.groups.length ? { groups: packed.groups } : {}) });
    for (const [id, points] of orders) this.inflight.set(id, points);
    this.inflightVersion = (this.inflightVersion || 0) + 1;
  }

  confirm() {
    this.send(this.staged);
    this.staged = new Map();
  }

  give(orders, withhold) {
    if (withhold) for (const [id, points] of orders) this.staged.set(id, points);
    else {
      for (const id of orders.keys()) this.staged.delete(id);
      this.send(orders);
    }
    this.selected.clear();
  }

  sendProduction(command) {
    if (this.side === null || this.ended) return;
    this.room.send({ type: "command", production: [command] });
    // The panel shows the choice until the simulation has it.
    const preview = this.tick < (this.productionPreview?.until ?? 0) ? this.productionPreview : {};
    this.productionPreview = { ...preview, ...command, until: this.tick + 60 };
  }

  surrender() {
    if (this.side === null || this.ended) return;
    this.room.send({ type: "surrender" });
    // The game ends a surrendered match at once.
    this.finish(0);
  }

  offerPeace() {
    if (this.side === null || this.ended || this.tick < this.peaceAvailableAt) return;
    this.peaceAvailableAt = this.tick + PEACE_COOLDOWN;
    this.room.send({ type: "command", peace: true });
  }

  // View ------------------------------------------------------------------------

  layout() {
    const dpr = window.devicePixelRatio || 1,
      width = Math.round(this.canvas.clientWidth * dpr),
      height = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) (this.canvas.width = width), (this.canvas.height = height);
    const [mw, mh] = this.mapSize,
      scale = Math.min(width / mw, height / mh),
      vw = Math.trunc(mw * scale),
      vh = Math.trunc(mh * scale);
    this.renderer.frame = { ox: Math.trunc((width - vw) / 2), oy: Math.trunc((height - vh) / 2), vw, vh, dpr };
  }

  canvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect(),
      dpr = this.renderer.frame.dpr;
    return [(event.clientX - rect.left) * dpr, (event.clientY - rect.top) * dpr];
  }

  toWorld([sx, sy]) {
    const { ox, oy, vw, vh } = this.renderer.frame,
      { zoom, x, y } = this.renderer.view,
      [mw, mh] = this.mapSize;
    return [((sx - ox - x * vw) / (vw * zoom)) * mw, ((sy - oy - y * vh) / (vh * zoom)) * mh];
  }

  /** The point at the 1920×1080 reference size of the HUD. */
  toHud([sx, sy]) {
    const { ox, oy, vw, vh } = this.renderer.frame;
    return [((sx - ox) / vw) * 1920, ((sy - oy) / vh) * 1080];
  }

  zoomAt(point, steps) {
    const view = this.renderer.view,
      { ox, oy, vw, vh } = this.renderer.frame,
      [mw, mh] = this.mapSize,
      world = this.toWorld(point);
    // The game zooms by 1.2 a notch, between 1 and 3, about the pointer. A map larger than
    // the game's (the site's big maps) zooms further, to the units' size at 3 on a 1080p map.
    const most = mw > 1920 ? (3 * mw) / 1920 : 3,
      zoom = Math.max(1, Math.min(most, view.zoom * 1.2 ** steps));
    if (zoom === 1) return (this.renderer.view = { zoom, x: 0, y: 0 });
    const x = (point[0] - ox) / vw - (world[0] / mw) * zoom,
      y = (point[1] - oy) / vh - (world[1] / mh) * zoom;
    this.renderer.view = { zoom, x: Math.max(1 - zoom, Math.min(0, x)), y: Math.max(1 - zoom, Math.min(0, y)) };
  }

  pan(dx, dy) {
    const view = this.renderer.view,
      { vw, vh } = this.renderer.frame;
    view.x = Math.max(1 - view.zoom, Math.min(0, view.x + dx / vw));
    view.y = Math.max(1 - view.zoom, Math.min(0, view.y + dy / vh));
  }

  // Input -----------------------------------------------------------------------

  /** The player's living units, worked out once for each frame. */
  myUnits() {
    if (this.mineFor !== this.state) {
      this.mineFor = this.state;
      this.mine = (this.state?.dots || []).filter((dot) => dot.health > 0 && dot.color === this.side);
    }
    return this.mine;
  }

  unitAt(world) {
    let best = null,
      distance = PICK_RADIUS * PICK_RADIUS;
    for (const dot of this.myUnits()) {
      const d = (dot.position[0] - world[0]) ** 2 + (dot.position[1] - world[1]) ** 2;
      if (d < distance) (distance = d), (best = dot);
    }
    return best;
  }

  attach() {
    const canvas = this.canvas;
    this.keys = new Set();
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", () => (this.gesture = null));
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        // One step per wheel event that carries at least a whole notch; touchpads
        // send fractions, which add up.
        this.wheel = (this.wheel || 0) + event.deltaY / (event.deltaMode === 1 ? 3 : 100);
        const steps = Math.trunc(this.wheel);
        if (!steps) return;
        this.wheel -= steps;
        this.zoomAt(this.canvasPoint(event), -Math.sign(steps));
      },
      { passive: false },
    );
    addEventListener("keydown", (event) => this.keyDown(event));
    addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
      // Orders made while Alt was held go out when it is released.
      if (event.key === "Alt" && this.started && !this.ended) this.confirm();
    });
    addEventListener("blur", () => this.keys.clear());
  }

  pointerDown(event) {
    if (!this.state) return;
    const point = this.canvasPoint(event),
      hud = this.toHud(point),
      world = this.toWorld(point);
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers cannot be captured.
    }
    if (event.button === 1) {
      this.panning = point;
      this.rightPan = null;
      return;
    }
    if (event.button === 2) {
      // Holding the right button pans, as the middle one does; a right click that
      // barely moves confirms withheld orders when it is released.
      this.panning = point;
      this.rightPan = { client: [event.clientX, event.clientY], travel: 0 };
      return;
    }
    if (event.button !== 0) return;
    if (this.ended) return;
    if (this.panel && this.panelClick(hud)) return;
    if (this.production && this.productionClick(hud, world)) return;
    if (!this.started || this.side === null || performance.now() < this.startAt) return;
    const unit = this.unitAt(world),
      shift = event.shiftKey;
    if (unit) {
      if (shift) this.selected.add(unit.id);
      else if (!this.selected.has(unit.id)) this.selected = new Set([unit.id]);
    }
    this.gesture = {
      points: [world],
      end: world,
      onUnit: !!unit,
      shift,
      formation: event.ctrlKey,
      withhold: event.altKey,
      client: [event.clientX, event.clientY],
      travel: 0,
    };
  }

  pointerMove(event) {
    const point = this.canvasPoint(event);
    this.hover = this.toHud(point);
    if (this.panning) {
      this.pan(point[0] - this.panning[0], point[1] - this.panning[1]);
      this.panning = point;
      if (this.rightPan) {
        const [cx, cy] = this.rightPan.client;
        this.rightPan.travel = Math.max(this.rightPan.travel, Math.hypot(event.clientX - cx, event.clientY - cy));
      }
      return;
    }
    if (this.rateDrag) {
      this.ratePreview = rateAt(this.toHud(point));
      return;
    }
    if (!this.gesture) return;
    const [cx, cy] = this.gesture.client;
    this.gesture.travel = Math.max(this.gesture.travel, Math.hypot(event.clientX - cx, event.clientY - cy));
    const world = this.toWorld(point);
    this.gesture.end = world;
    extendGesture(this.gesture.points, world);
  }

  pointerUp(event) {
    if (this.panning) {
      const right = this.rightPan;
      this.panning = this.rightPan = null;
      if (right && right.travel < RIGHT_CLICK_PX && this.started) this.confirm();
      return;
    }
    if (this.rateDrag) {
      this.rateDrag = null;
      this.sendProduction({ production_rate: this.ratePreview, production_type: this.productionState().type });
      this.ratePreview = null;
      return;
    }
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture || !this.state) return;
    gesture.end = this.toWorld(this.canvasPoint(event));
    const units = this.myUnits().filter((dot) => this.selected.has(dot.id));
    const withhold = gesture.withhold || event.altKey;
    if (this.shortArrow(gesture)) {
      if (!units.length) return;
      if (gesture.formation) return this.give(formationOrders(units, [gesture.points[0], gesture.end]), withhold);
      return this.give(routeOrders(units, [gesture.points[0], gesture.end], this.shared), withhold);
    }
    const dragged = gesture.points.length > 1;
    if (!dragged) {
      // A click: on a unit it only selects; elsewhere the selection moves there.
      if (gesture.onUnit || !units.length) {
        if (!gesture.onUnit && !gesture.shift) this.selected.clear();
        return;
      }
      return this.give((gesture.withhold || event.altKey ? gatherOrders : clickOrders)(units, gesture.end, this.shared), withhold);
    }
    const loop = [...gesture.points, gesture.end];
    if (this.selecting(gesture, units)) {
      // A loop selects the units inside it.
      if (!gesture.shift) this.selected.clear();
      for (const dot of this.inLoop(loop)) this.selected.add(dot.id);
      return;
    }
    if (!units.length) return;
    if (gesture.formation) return this.give(formationOrders(units, loop), withhold);
    this.give(routeOrders(units, gesture.points, this.shared), withhold);
  }

  /** Whether a gesture is an arrow drawn from a unit that ends before its first
   * waypoint: it goes straight to where the pointer was released. */
  shortArrow(gesture) {
    return gesture.onUnit && gesture.points.length < 2 && gesture.travel >= ARROW_DRAG_PX;
  }

  /** Whether a gesture draws a selection loop rather than an order: with nothing
   * selected, with Shift held, or when it closes around units of the side. */
  selecting(gesture, units) {
    if (gesture.onUnit || gesture.points.length < 2) return false;
    if (!units.length || gesture.shift) return true;
    if (gesture.formation) return false;
    const loop = [...gesture.points, gesture.end];
    return isLoop(loop) && this.inLoop(loop, true).length > 0;
  }

  /** The player's units inside a drawn loop (only the first with `any`), testing the
   * loop's bounding box before the loop itself. */
  inLoop(loop, any = false) {
    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity;
    for (const [x, y] of loop) (left = Math.min(left, x)), (right = Math.max(right, x)), (top = Math.min(top, y)), (bottom = Math.max(bottom, y));
    const found = [];
    for (const dot of this.myUnits()) {
      const [x, y] = dot.position;
      if (x < left || x > right || y < top || y > bottom || !inside(dot.position, loop)) continue;
      found.push(dot);
      if (any) break;
    }
    return found;
  }

  /** The orders a gesture would give if released now, to draw while it is held. */
  preview(gesture) {
    // The same gesture over the same frame gives the same orders: worked out once.
    const key = [this.state?.frame, this.selected.size, gesture.points.length, gesture.end?.[0], gesture.end?.[1], gesture.formation, gesture.withhold, gesture.onUnit, gesture.travel, gesture.shift, this.keys.has("AltLeft") || this.keys.has("AltRight")].join();
    if (this.previewKey === key && this.previewFor === gesture) return this.previewed;
    this.previewKey = key;
    this.previewFor = gesture;
    return (this.previewed = this.plan(gesture));
  }

  plan(gesture) {
    const units = this.myUnits().filter((dot) => this.selected.has(dot.id));
    if (!units.length || this.selecting(gesture, units)) return null;
    if (this.shortArrow(gesture)) return (gesture.formation ? formationOrders : routeOrders)(units, [gesture.points[0], gesture.end], this.shared);
    if (gesture.points.length < 2) return gesture.onUnit ? null : (gesture.withhold || this.keys.has("AltLeft") || this.keys.has("AltRight") ? gatherOrders : clickOrders)(units, gesture.end, this.shared);
    if (gesture.formation) return formationOrders(units, [...gesture.points, gesture.end]);
    return routeOrders(units, [...gesture.points, gesture.end], this.shared);
  }

  keyDown(event) {
    // Typing in the lobby's fields is not a game shortcut.
    if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    // Alt alone would move the focus to the browser's menu bar.
    if (event.key === "Alt") event.preventDefault();
    if (!this.state || event.repeat) return;
    if (this.chat) {
      if (event.key === "Escape") this.chat = null;
      else if (event.key === "Enter") {
        if (this.chat.trim()) this.room.send({ type: "command", message: this.chat.trim() });
        this.chat = null;
      } else if (event.key === "Backspace") this.chat = this.chat.slice(0, -1);
      else if (event.key.length === 1 && this.chat.length < 120) this.chat += event.key;
      event.preventDefault();
      return;
    }
    this.keys.add(event.code);
    if (event.key === "Escape") {
      if (this.ended) return void this.onEnd?.(this.ended.result, true);
      this.panel = this.production = this.help = false;
      this.gesture = null;
      return;
    }
    if (event.code === "KeyI") return void (this.help = !this.help);
    if (event.code === "Space") {
      event.preventDefault();
      this.gesture = null;
      this.panel = !this.panel;
      return;
    }
    if (/^Digit[1-9]$/.test(event.code)) return this.toggle(Number(event.code.slice(5)) - 1);
    if (event.code === "KeyT" && this.started && this.side !== null) {
      event.preventDefault();
      this.chat = "";
      return;
    }
    if (!this.started || this.ended) return;
    if (event.code === "Enter" || event.code === "NumpadEnter") return this.confirm();
    if (event.code === "KeyC") {
      this.selected.clear();
      this.staged = new Map();
      this.gesture = null;
      return;
    }
    if (event.code === "KeyS") {
      const units = this.myUnits().filter((dot) => this.selected.has(dot.id));
      for (const dot of units) this.staged.delete(dot.id);
      this.send(stopOrders(units));
      this.selected.clear();
    }
  }

  toggle(index) {
    const [name] = switches[index] || [];
    if (!name) return;
    if (name === "produce") {
      this.production = !this.production;
      this.gesture = null;
    } else if (name === "chat") {
      if (this.started && this.side !== null) this.chat = "";
    } else this.options[name] = !this.options[name];
  }

  panelClick([x, y]) {
    if (x < 180 && y < 180) {
      this.surrender();
      return true;
    }
    if (x > 1740 && y < 180) {
      this.offerPeace();
      return true;
    }
    if (x >= 370 && x <= 1550 && y <= 263) {
      for (let i = 0; i < switches.length; i++) {
        const sx = 498 + Math.floor(i / 3) * 360,
          sy = 42 + (i % 3) * 58;
        if (x >= sx - 60 && x <= sx + 300 && y >= sy - 10 && y <= sy + 56) this.toggle(i);
      }
      return true;
    }
    return false;
  }

  productionState() {
    const side = this.side,
      economy = this.state?.core.economy?.fields || {},
      preview = this.tick < (this.productionPreview?.until ?? 0) ? this.productionPreview : {};
    return {
      rate: preview.production_rate ?? this.info?.rates?.[side] ?? 0.7,
      type: preview.production_type ?? this.info?.types?.[side] ?? "infantry",
      zone: preview.zone ?? economy.industrial_zone?.[side] ?? [],
    };
  }

  productionClick(hud, world) {
    if (this.side === null || !this.started || this.ended) return false;
    const state = this.productionState();
    const knob = lerp(RATE_BEGIN, RATE_END, state.rate);
    if ((hud[0] - knob[0]) ** 2 + (hud[1] - knob[1]) ** 2 <= 35 * 35 || onRateLine(hud)) {
      this.rateDrag = true;
      this.ratePreview = rateAt(hud);
      return true;
    }
    for (const row of productionRows(this.productionTypes()))
      if (hud[0] >= 1500 && hud[1] >= row.top && hud[1] <= row.top + row.height) {
        this.sendProduction({ production_rate: state.rate, production_type: row.type });
        return true;
      }
    if (hud[0] <= 470 && hud[1] >= 810) return true;
    if (hud[0] >= 1450 && hud[1] >= 810) return true;
    // Clicking one of the side's cities turns its production on or off.
    const cities = this.state.core.cities || [];
    const index = cities.findIndex((city) => city.color === this.side && (city.position[0] - world[0]) ** 2 + (city.position[1] - world[1]) ** 2 < 15 * 15);
    if (index < 0) return false;
    const zone = new Set(state.zone);
    if (!zone.delete(index)) zone.add(index);
    this.sendProduction({ zone: [...zone].sort((a, b) => a - b) });
    return true;
  }

  productionTypes() {
    return this.staticRecord.replay?.mode === "experiment" ? ["infantry", "tank", "motorised"] : ["infantry", "tank"];
  }

  // Drawing ---------------------------------------------------------------------

  loop(now) {
    if (this.state) this.paint(now);
    requestAnimationFrame(this.loop);
  }

  /** Whether a unit of another side can be seen through the fog (the game's
   * outside_fog_check): not all four neighbouring cells are fogged. */
  visible(position) {
    const fog = this.fogState;
    if (!fog || this.side === null || this.ended) return true;
    const { width, height, grid } = fog,
      x = Math.max(0, Math.min(width - 1, Math.floor(position[0] / 10))),
      y = Math.max(0, Math.min(height - 1, Math.floor(position[1] / 10))),
      at = (cx, cy) => grid[Math.max(0, Math.min(width - 1, cx)) * height + Math.max(0, Math.min(height - 1, cy))];
    return !(at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1));
  }

  /** Asks the lines worker for a big map's front lines; until they come, the previous
   * ones show (src/play/lines-worker.js). */
  requestLines(state, previous = []) {
    if (!this.linesWorker) {
      this.linesWorker = new Worker(new URL("./lines-worker.js", import.meta.url), { type: "module" });
      this.linesWorker.onmessage = ({ data }) => {
        if (data.id !== this.linesId || this.paintCache?.contours !== this.linesFor) return;
        this.paintCache.lines = data.lines;
      };
    }
    const dots = state.dots,
      positions = new Float32Array(2 * dots.length),
      sides = new Uint8Array(dots.length),
      health = new Float32Array(dots.length),
      ships = new Uint8Array(dots.length);
    dots.forEach((dot, i) => {
      positions[2 * i] = dot.position[0];
      positions[2 * i + 1] = dot.position[1];
      sides[i] = dot.color;
      health[i] = dot.health;
      ships[i] = dot.ship ? 1 : 0;
    });
    this.linesId = (this.linesId ?? 0) + 1;
    this.linesFor = state.render?.contours;
    this.linesWorker.postMessage(
      { id: this.linesId, contours: state.render?.contours || [], mapSize: this.mapSize, positions, sides, health, ships },
      [positions.buffer, sides.buffer, health.buffer, ships.buffer],
    );
    return previous;
  }

  /** Sends a big map's units and bars to the GPU: where each was in the previous frame
   * and where it is now, which the GPU moves between on every repaint. */
  buildUnits(gl, cache, options, mine) {
    const state = cache.state,
      still = [0, 0];
    gl.begin();
    for (const dot of cache.dead) {
      const alpha = 0.75 - (state.frame - dot.frame) * 0.01;
      if (alpha > 0) gl.sprite(unitArtIndex.get(deadSprite(dot)) ?? -1, dot.position, dot.position, still, unitSize(dot), [1, 0], 0, alpha);
    }
    // The game draws every unit twice: all of them, then all of them again. Where both
    // look the same, one instance is drawn twice over.
    for (let pass = 0; pass < 2; pass++)
      for (const dot of cache.dots) {
        const visual = cache.directions.get(dot.id),
          first = visual?.first_vibration || 0,
          second = visual?.second_vibration || 0,
          firstTurn = visual?.first_visual || visual?.visual || [1, 0],
          turn = visual?.visual || [1, 0],
          same = first === second && firstTurn[0] === turn[0] && firstTurn[1] === turn[1];
        if (same && pass === 1) continue;
        const vibration = pass === 0 ? first : second,
          facing = visual?.facing;
        gl.sprite(
          unitLayer(dot),
          dot.from || dot.position,
          dot.position,
          [(facing?.[0] || 0) * vibration, (facing?.[1] || 0) * vibration],
          unitSize(dot),
          pass === 0 ? firstTurn : turn,
          FLIP | (this.selected.has(dot.id) ? DARK : 0) | (same ? TWICE : 0),
        );
      }
    const bars = (options.health ? HEALTH : 0) | (options.morale ? MORALE : 0);
    if (bars)
      for (const dot of cache.dots) if (mine(dot)) gl.bars(dot.from || dot.position, dot.position, dot.health / dot.max_health, dot.morale, bars);
    gl.end();
  }

  paint(now) {
    this.layout();
    const r = this.renderer,
      state = this.state,
      [mw, mh] = this.mapSize,
      mine = (dot) => this.side === null || dot.color === this.side,
      options = this.options;
    // What depends only on the worker's frame and the fog is worked out once for each,
    // not on every repaint: the units that show, their directions and the front lines.
    let cache = this.paintCache;
    const fresh = !cache || cache.state !== state || cache.fog !== this.fogState;
    if (fresh) {
      const shows = (dot) => mine(dot) || this.visible(dot.position);
      cache = this.paintCache = {
        state,
        fog: this.fogState,
        dots: state.dots.filter((dot) => dot.health > 0 && shows(dot)),
        dead: (state.core.dead_dots || []).filter(shows),
        byId: new Map(state.dots.map((dot) => [dot.id, dot])),
        directions: new Map((state.render?.directions || []).map((d) => [d.id, d])),
        // The front lines follow the outlines, which a big map's frames send only
        // when they change; a big map's are worked out in a worker of their own.
        contours: state.render?.contours,
        lines:
          cache?.contours === state.render?.contours
            ? cache.lines
            : this.reuse
              ? this.requestLines(state, cache?.lines)
              : frontLines(state.render?.contours || [], state.dots, this.mapSize),
      };
    }
    // A big map's units are drawn at a clock that runs at the game's 30 ticks a second a
    // tick and a half behind the newest frame, between where the frames on either side
    // of it had them: they move at an even pace however unevenly the frames come.
    let between = 1;
    if (this.reuse && this.toTick !== undefined) {
      const latest = this.toTick,
        elapsed = this.shownAt === undefined ? 0 : (now - this.shownAt) / TICK_MS;
      this.shownAt = now;
      this.shownTick = this.shownTick === undefined ? latest : this.shownTick + elapsed + (latest - 1.5 - this.shownTick) * Math.min(1, elapsed * 0.1);
      this.shownTick = Math.min(latest, Math.max(this.shownTick, latest - 6));
      const span = latest - this.fromTick;
      between = span > 0 ? Math.min(1, Math.max(0, (this.shownTick - this.fromTick) / span)) : 1;
    }
    const at = (dot) =>
      between < 1 && dot.from ? [dot.from[0] + (dot.position[0] - dot.from[0]) * between, dot.from[1] + (dot.position[1] - dot.from[1]) * between] : dot.position;
    // Only what is on screen is drawn.
    const { zoom, x: viewX, y: viewY } = r.view,
      margin = 60,
      left = (-viewX / zoom) * mw - margin,
      right = ((1 - viewX) / zoom) * mw + margin,
      top = (-viewY / zoom) * mh - margin,
      bottom = ((1 - viewY) / zoom) * mh + margin,
      onScreen = (p) => p[0] >= left && p[0] <= right && p[1] >= top && p[1] <= bottom;
    let shown;
    const visible = () => (shown ??= cache.dots.filter((dot) => onScreen(dot.position)));
    // A big map is drawn in layers of their own, each drawn again only when it changes,
    // with the units on the GPU (see drawLayers and gl-units.js).
    const gl = this.reuse && r.units,
      part = (name, version) => !gl || r.layer(name, version),
      routeOf = (id, points) => {
        const dot = cache.byId.get(id);
        return dot && dot.health > 0 && points.length > 1 ? [dot.position, ...points.slice(1)] : null;
      };
    r.begin(this.mapSize);
    if (part("ground", [cache.lines, state.core.capitals])) {
      r.image("map", [mw / 2, mh / 2], this.mapSize);
      if (this.reuse && !gl) r.cached("lines", cache.lines, () => cache.lines.forEach((line) => r.line(line)));
      else for (const line of cache.lines) r.line(line);
      for (const city of state.core.capitals || []) if (city.position) r.image("capital", [city.position[0], city.position[1] - 2], [35, 33]);
    }
    const directions = cache.directions;
    if (gl) {
      r.layer("units", null);
      let selection = this.selected.size;
      for (const id of this.selected) selection = (selection * 31 + id) | 0;
      const key = [cache, selection, options.health, options.morale];
      if (!this.unitKey || this.unitKey.some((item, i) => item !== key[i])) {
        this.unitKey = key;
        this.buildUnits(gl, cache, options, mine);
      }
      r.draws.push({ type: "units", between });
    } else {
      // A big map's units and bars without WebGL: sprites cached at their size on screen.
      const sprites = this.reuse ? r.spriteCache : null,
        batch = sprites ? (this.spriteBatch ??= new SpriteBatch()) : null;
      batch?.clear();
      for (const dot of cache.dead) {
        if (!onScreen(dot.position)) continue;
        const alpha = 0.75 - (state.frame - dot.frame) * 0.01;
        if (alpha <= 0) continue;
        const name = deadSprite(dot);
        if (batch) batch.sprite(sprites.sprite(name), dot.position[0], dot.position[1], ...unitSize(dot), [1, 0], false, alpha, false);
        else r.image(name, dot.position, unitSize(dot), alpha);
      }
      if (batch) {
        // The game draws every unit twice; where both look the same, one cached sprite
        // holds both.
        for (let pass = 0; pass < 2; pass++)
          for (const dot of visible()) {
            const visual = directions.get(dot.id),
              first = visual?.first_vibration || 0,
              second = visual?.second_vibration || 0,
              firstTurn = visual?.first_visual || visual?.visual || [1, 0],
              turn = visual?.visual || [1, 0],
              same = first === second && firstTurn[0] === turn[0] && firstTurn[1] === turn[1];
            if (same && pass === 1) continue;
            const vibration = pass === 0 ? first : second,
              direction = pass === 0 ? firstTurn : turn,
              now = at(dot),
              [width, height] = unitSize(dot);
            batch.sprite(unitLayer(dot), now[0] + (visual?.facing?.[0] || 0) * vibration, now[1] + (visual?.facing?.[1] || 0) * vibration, width, height, direction, true, 1, this.selected.has(dot.id), same ? 2 : 1);
          }
        for (const dot of visible()) {
          if (!mine(dot)) continue;
          const [x, y] = at(dot);
          batch.bars(x, y, dot.health / dot.max_health, dot.morale, options);
        }
        r.sprites(batch);
      } else {
        for (let pass = 0; pass < 2; pass++)
          for (const dot of visible()) {
            const visual = directions.get(dot.id),
              vibration = (pass === 0 ? visual?.first_vibration : visual?.second_vibration) || 0,
              now = at(dot),
              position = [now[0] + (visual?.facing?.[0] || 0) * vibration, now[1] + (visual?.facing?.[1] || 0) * vibration],
              direction = (pass === 0 ? visual?.first_visual : visual?.visual) || visual?.visual || [1, 0];
            r.image(unitSprite(dot), position, unitSize(dot), 1, direction, false, true);
            if (this.selected.has(dot.id)) r.draws.at(-1).dark = true;
          }
        for (const dot of visible()) if (mine(dot)) drawBars(r, between < 1 ? { ...dot, position: at(dot) } : dot, options);
      }
    }
    const fogOn = this.fogState && this.side !== null && !this.ended;
    if (part("over", [fogOn ? this.fogState.outlines : null, options.flags, state.core.cities])) {
      if (fogOn) {
        if (this.reuse && !gl) r.cached("fog", this.fogState.outlines, () => r.fog(this.fogState.outlines));
        else r.fog(this.fogState.outlines);
      }
      if (options.flags)
        for (const city of state.core.cities || [])
          if (onScreen(city.position)) r.image(`${colors[city.color]}_flag`, [city.position[0] + 9, city.position[1] - 13], [21, 27]);
    }
    const productionOn = this.production && this.side !== null && !this.ended;
    // On a big map the icons and routes follow a new frame one repaint later, so that
    // their work does not fall on the repaint that takes in the frame.
    const marked = gl && fresh && this.markedState ? this.markedState : state;
    this.markedState = state;
    if (part("marks", [marked, options.icons, options.orders, this.inflightVersion, productionOn ? this.productionState() : null])) {
      if (options.icons)
        for (const dot of visible()) {
          const icon = mine(dot) && iconFor(dot);
          if (icon) r.image(icon[0], [dot.position[0] + 20, dot.position[1] - 10], icon[1]);
        }
      if (productionOn) {
        // The cities that produce, joined within each connected group.
        const cities = state.core.city_positions || [],
          zone = new Set(this.productionState().zone),
          groups = state.core.economy?.fields?.city_enc?.[this.side] || [[...zone]];
        for (const group of groups) {
          const producing = group.filter((index) => zone.has(index));
          if (producing.length === 1) r.circle(cities[producing[0]], 10, [0.2, 0.2, 0.2, 0.8]);
          for (let i = 0; i < producing.length; i++)
            for (let j = i + 1; j < producing.length; j++) r.line([cities[producing[i]], cities[producing[j]]], [0.2, 0.2, 0.2, 0.8], 10, 2);
        }
      }
      // Routes, the units' own and the orders on their way: every arrow is one path
      // (thousands of units may have one), kept until the frame, the orders or the view
      // change.
      if (options.orders) {
        const key = [this.inflightVersion, left, right, top, bottom].join();
        if (this.routeDraw?.state !== state || this.routeDraw.key !== key) {
          const routes = new Polylines(((r.frame.vw / mw) * zoom) * 12 < 8);
          for (const dot of visible()) {
            if (!mine(dot) || !dot.path?.length || this.inflight.has(dot.id)) continue;
            arrowInto(routes, [dot.position, ...dot.path]);
          }
          for (const [id, points] of this.inflight) {
            const route = routeOf(id, points);
            if (route) arrowInto(routes, route);
          }
          const start = r.draws.length;
          r.lines(routes, [0, 0, 0, 0.5], 5);
          this.routeDraw = { state, key, draw: r.draws.splice(start)[0] || null };
        }
        const draw = this.routeDraw.draw;
        if (draw && this.reuse && !gl) r.cached("routes", this.routeDraw, () => r.draws.push(draw));
        else if (draw) r.draws.push(draw);
      }
    }
    // Withheld orders and the order being drawn are solid black. These and what follows
    // are drawn on every frame.
    if (gl) r.layer("top", null);
    const held = new Polylines(((r.frame.vw / mw) * zoom) * 12 < 8);
    for (const [id, points] of this.staged) {
      const route = routeOf(id, points);
      if (route) arrowInto(held, route);
    }
    if (this.gesture) {
      const orders = this.preview(this.gesture);
      if (orders)
        for (const [id, points] of orders) {
          const route = routeOf(id, points);
          if (route) arrowInto(held, route);
        }
      else if (this.gesture.points.length > 1) r.line([...this.gesture.points, this.gesture.end], [0, 0, 0, 0.5], 5, 2);
    }
    r.lines(held, [0, 0, 0, 1], 3);
    if (options.stats) drawStats(r, state);
    if (options.players)
      for (let side = 0, line = 0; side < this.sides; side++)
        for (const name of this.names?.[side] || []) {
          r.text(`player-${side}-${line}`, name, [0.00313, 1 - (1 / 30 + line / 18)], sideRgb[side]);
          line++;
        }
    r.drawLocal();
    this.hud(now);
  }

  hud(now) {
    const ctx = this.renderer.context,
      { ox, oy, vw, vh } = this.renderer.frame,
      art = this.renderer.sources;
    ctx.save();
    ctx.setTransform(vw / 1920, 0, 0, vh / 1080, ox, oy);
    const text = (value, x, y, size, color = "#000", align = "left", outline = 0, bold = true) => {
      ctx.font = `${bold ? "bold " : ""}${size}px "Arial Narrow", Arial, sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = "top";
      if (outline) {
        ctx.lineJoin = "round";
        ctx.lineWidth = outline * 2;
        ctx.strokeStyle = "#000";
        ctx.strokeText(value, x, y);
      }
      ctx.fillStyle = color;
      ctx.fillText(value, x, y);
    };
    const image = (name, x, y, w, h) => {
      const source = art.get(name);
      if (source) ctx.drawImage(source, x, y, w, h);
    };
    if (this.production && this.side !== null && !this.ended) {
      const state = this.productionState(),
        rate = this.ratePreview ?? state.rate,
        types = this.productionTypes();
      const panel = (x, radii) => {
        ctx.beginPath();
        ctx.roundRect(x, 810, 490, 300, radii);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.lineWidth = 11;
        ctx.strokeStyle = "#000";
        ctx.stroke();
      };
      // Mobilize: a wedge from Min to Max split into five steps, the knob on its edge.
      panel(-20, [0, 40, 0, 0]);
      text("Mobilize:", 34, 846, 54, "#000", "left", 0, false);
      const [bx, by] = RATE_BEGIN,
        [ex, ey] = RATE_END;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex, by);
      ctx.closePath();
      ctx.fillStyle = "#d3d3d3";
      ctx.fill();
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.lineWidth = 6;
      for (let k = 1; k < 5; k++) {
        const x = bx + ((ex - bx) * k) / 5;
        ctx.beginPath();
        ctx.moveTo(x, by);
        ctx.lineTo(x, by + ((ey - by) * k) / 5);
        ctx.stroke();
      }
      text("Min", bx + 6, by + 10, 28, "#000", "left", 0, false);
      text("Max", ex - 52, by + 10, 28, "#000", "left", 0, false);
      const knob = lerp(RATE_BEGIN, RATE_END, rate);
      ctx.beginPath();
      ctx.arc(knob[0], knob[1], 24, 0, Math.PI * 2);
      ctx.fillStyle = css(sideRgb[this.side]);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.stroke();
      // Produce: one row per unit type with its price; the chosen one is marked.
      panel(1450, [40, 0, 0, 0]);
      text("Produce:", 1522, 846, 54, "#000", "left", 0, false);
      for (const row of productionRows(types)) {
        const middle = row.top + row.height / 2,
          size = row.height > 60 ? 54 : 44;
        if (state.type === row.type) {
          ctx.fillStyle = "#d3d3d3";
          ctx.fillRect(1500, row.top, 420, row.height);
          text("➜", 1512, middle - size / 2, size, "#000", "left", 0, false);
        }
        text(unitLabels[row.type], 1572, middle - size / 2, size, "#000", "left", 0, false);
        text(`$${unitPrices[row.type]}`, 1900, middle - size / 2, size, "#000", "right", 0, false);
      }
    }
    if (this.panel && !this.ended) {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.roundRect(370, -100, 1180, 363, 70);
      ctx.fill();
      const enabled = { ...this.options, produce: this.production, chat: !!this.chat };
      switches.forEach(([name, label], i) => {
        const x = 498 + Math.floor(i / 3) * 360,
          y = 42 + (i % 3) * 58;
        text(label, x, y, 50);
        text(`[${i + 1}]`, x + (i < 3 ? 197 : i < 6 ? 153 : 234), y, 50);
        if (i === 8) text("[t]", 1392, y, 50);
        if (enabled[name]) text("➜", x - 56, y, 50);
      });
      const over = (x, y) => this.hover[0] >= x && this.hover[0] <= x + 180 && this.hover[1] >= y && this.hover[1] <= y + 180;
      image(over(0, 0) ? "surrender_button_pressed" : "surrender_button", 0, 0, 180, 180);
      const cooling = this.tick < this.peaceAvailableAt;
      image(cooling || over(1740, 0) ? "peace_button_pressed" : "peace_button", 1740, 0, 180, 180);
    }
    // Chat: recent messages above the bottom edge, and the line being typed.
    const recent = this.messages.filter((m) => now - m.at < 12000).slice(-5);
    recent.forEach((message, i) => {
      const who = (this.names?.[message.side] || [])[0] || colors[message.side];
      text(`${who}: ${message.text}`, 960, 760 - (recent.length - 1 - i) * 46, 40, css(sideRgb[message.side]), "center", 1.5, false);
    });
    if (this.chat !== null) text(`Chat: ${this.chat}_`, 960, 810, 40, "#fff", "center", 1.5, false);
    if (this.started && !this.ended && now < this.startAt) {
      const seconds = Math.ceil((this.startAt - now) / 1000);
      text(`${seconds}`, 960, 400, 200, "#fff", "center", 6);
    }
    if (!this.started && !this.ended) text("Waiting for the match to start", 960, 1000, 44, "#fff", "center", 2, false);
    if (this.waiting && !this.ended) text("Waiting for the other players", 960, 1000, 44, "#fff", "center", 2, false);
    if (this.desynced) text("This match is out of sync with the other players.", 960, 960, 44, "#ff8080", "center", 2, false);
    if (this.help) {
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.beginPath();
      ctx.roundRect(460, 140, 1000, 800, 40);
      ctx.fill();
      helpLines.forEach((line, i) => text(line, 960, 190 + i * 64, 42, "#000", "center", 0, false));
      text("[i] closes this help", 960, 880, 34, "#555", "center", 0, false);
    }
    if (this.ended) {
      const label = this.ended.result === 1 ? "VICTORY" : this.ended.result === 0 ? "DEFEAT" : this.ended.result === 0.5 ? "PEACE" : "MATCH OVER";
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, 1920, 1080);
      text(label, 960, 380, 220, "#fff", "center", 8);
      text("[esc] to exit", 960, 640, 60, "#fff", "center", 3);
    }
    ctx.restore();
    // No turn for a while means the room or the connection is slow or gone.
    this.waiting = this.started && now > this.startAt + 1500 && now - (this.lastTurnAt ?? now) > 1500;
  }

  destroy() {
    clearInterval(this.clock);
    this.worker?.terminate();
    this.linesWorker?.terminate();
    this.renderer.removeLayers();
    this.sound.stop();
  }
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function rateAt(point) {
  const dx = RATE_END[0] - RATE_BEGIN[0],
    dy = RATE_END[1] - RATE_BEGIN[1];
  const t = ((point[0] - RATE_BEGIN[0]) * dx + (point[1] - RATE_BEGIN[1]) * dy) / (dx * dx + dy * dy);
  return Math.round(Math.max(0, Math.min(1, t)) * 100) / 100;
}

function onRateLine(point) {
  const p = lerp(RATE_BEGIN, RATE_END, rateAt(point));
  return (point[0] - p[0]) ** 2 + (point[1] - p[1]) ** 2 <= 20 * 20;
}

/** A route with the replay player's arrowhead at its end. */
/** Adds an arrow's lines to `lines` (Polylines): the path, then its head. */
function arrowInto(lines, path, head = true) {
  if (path.length < 2) return;
  lines.add(path);
  if (!head) return;
  const end = path.at(-1),
    previous = path.at(-2),
    dx = previous[0] - end[0],
    dy = previous[1] - end[1],
    length = Math.sqrt(dx * dx + dy * dy) + 0.01,
    ux = dx / length,
    uy = dy / length;
  for (const side of [-1, 1])
    lines.add3(end[0], end[1], end[0] + 9 * ux - side * 6 * uy, end[1] + 9 * uy + side * 6 * ux, end[0] + 12 * ux - side * 12 * uy, end[1] + 12 * uy + side * 12 * ux);
}

