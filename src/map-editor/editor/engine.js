// The map editor's map: the model, its tools and its drawing. The map is drawn
// by the replay player's own painter (src/play/game.js): its sprites, sizes,
// flags, capitals and front lines. The starting territory and its contours are
// the engine's, computed in JavaScript (../lib/preview.ts and contours.js).
//
// Every terrain tool previews its exact result before it is applied: the brush
// shows its pixels in the front colour, the bucket shows the area it would fill,
// line, shape and curve show the pixels they will paint, smoothing shows the
// pixels it will change, and placing tools show the sprite.
//
// Coordinates are the game's: a 960 x 540 terrain image is played at 1600 x 900,
// any other size at 1920 x 1080 (engine/replay-sim/src/replay.rs).
import { Game } from "../../play/game.js";
import { prepareMap } from "../../player/map.js";
import { startingTerritory, shockIndexes } from "../lib/preview";
import { extract } from "./contours.js";

// One map is edited at a time; its sizes are set when it opens.
let W = 960, H = 540, WORLD = [1600, 900], SCALE = 0.6;
function setSize(width, height) {
  [W, H] = [width, height];
  WORLD = width === 960 ? [1600, 900] : [1920, 1080];
  SCALE = W / WORLD[0];
}
export const TERRAIN = [
  ["Plains", "#A1C246"], ["Forest", "#388336"], ["River", "#279BFF"], ["Snow", "#E3F2F2"],
  ["Mud", "#784B23"], ["Sand", "#EEE3B0"], ["Hill", "#888A87"], ["Mountain", "#6D6B6F"],
];
const COLORS = ["blue", "red", "purple", "orange"];
const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const nameOf = (r, g, b) => TERRAIN.find(([, hex]) => { const c = rgb(hex); return c[0] === r && c[1] === g && c[2] === b; })?.[0] ?? "Terrain";
export { shockIndexes };

/** Tools that paint terrain colours; Alt picks a colour with any of them. */
export const PAINT_TOOLS = ["brush", "line", "curve", "shape", "bucket", "lasso"];

function image(src) {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`Cannot load ${src.startsWith("data:") ? "the map image" : src}`));
    element.src = src;
  });
}
const art = new Map();
function bitmap(url) {
  if (!art.has(url)) art.set(url, image(url).then((element) => createImageBitmap(element)));
  return art.get(url);
}

/** The replay player's battlefield painter, without a match behind it. */
class Painter extends Game {
  constructor(canvas, base) {
    super({ canvas, base, replay: null, frame: 0, side: null, room: null, names: [] });
    this.sound = { start() {}, frame() {}, end() {}, stop() {} };
    Object.assign(this.options, { stats: false, players: false, health: false, morale: false });
    this.mapSize = WORLD;
    this.showLines = true;
    this.overlay = null;
  }
  async boot() {
    const names = ["capital", "city_icon"];
    for (const color of COLORS) names.push(`${color}_flag`, `${color}_infantry_100`, `${color}_tank_100`, `${color}_motorised_100`);
    await Promise.all(names.map(async (name) => this.renderer.texture(name, await bitmap(`${this.base}player-assets/${name}.png`))));
  }
  canvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [((event.clientX - rect.left) * this.canvas.width) / rect.width, ((event.clientY - rect.top) * this.canvas.height) / rect.height];
  }
  paint(now) {
    const state = this.state, saved = state.render;
    if (!this.showLines) state.render = { ...saved, contours: [] };
    super.paint(now);
    state.render = saved;
    this.overlay?.(this.renderer.context);
  }
  hud() {}
  keyDown() {}
  pointerDown(event) {
    // Only the middle button pans here; every other press belongs to the tools.
    if (event.button === 1) super.pointerDown(event);
  }
  pointerUp() { this.panning = null; }
  toCanvas([wx, wy]) {
    const { ox, oy, vw, vh } = this.renderer.frame, { zoom, x, y } = this.renderer.view;
    return [ox + x * vw + (wx / WORLD[0]) * vw * zoom, oy + y * vh + (wy / WORLD[1]) * vh * zoom];
  }
  /** Canvas pixels per world unit. */
  unit() {
    return (this.renderer.frame.vw / WORLD[0]) * this.renderer.view.zoom;
  }
}

/** The pixels a brush of this size and shape covers, around its centre. */
const masks = new Map();
function brushMask(size, shape) {
  const key = `${size}:${shape}`;
  if (!masks.has(key)) {
    const offsets = [], r = size / 2;
    const from = -Math.floor((size - 1) / 2), to = from + size - 1, centre = size % 2 ? 0 : 0.5;
    for (let dy = from; dy <= to; dy++)
      for (let dx = from; dx <= to; dx++)
        // Odd sizes centre on a pixel, even sizes between four.
        if (shape === "square" || (dx - centre) ** 2 + (dy - centre) ** 2 <= r * r) offsets.push(dx, dy);
    masks.set(key, offsets);
  }
  return masks.get(key);
}

// Masks: the terrain pixels a tool would change, with their bounds. Line, shape,
// curve and smoothing work out their mask first, so the preview and the result
// are the same pixels.
function emptyMask() {
  return { bits: new Uint8Array(W * H), x0: W, y0: H, x1: -1, y1: -1 };
}
function mark(mask, x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  mask.bits[y * W + x] = 1;
  if (x < mask.x0) mask.x0 = x;
  if (x > mask.x1) mask.x1 = x;
  if (y < mask.y0) mask.y0 = y;
  if (y > mask.y1) mask.y1 = y;
}

/** Points along a Catmull-Rom curve through `points`, one about every 4 units. */
function curvePoints(points, closed) {
  const n = points.length;
  if (n < 3) return points.slice();
  const at = (i) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const out = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const steps = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 4));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

function ellipsePoints([x0, y0], [x1, y1]) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / 3));
  return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((i / n) * Math.PI * 2), cy + ry * Math.sin((i / n) * Math.PI * 2)]);
}

/** With Shift: a line in 15 degree steps, a square or a circle. */
function snapAngle(start, end) {
  const step = Math.PI / 12, length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const angle = Math.round(Math.atan2(end[1] - start[1], end[0] - start[0]) / step) * step;
  return [start[0] + Math.cos(angle) * length, start[1] + Math.sin(angle) * length];
}
function squareCorner(start, end) {
  const d = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
  return [start[0] + Math.sign(end[0] - start[0] || 1) * d, start[1] + Math.sign(end[1] - start[1] || 1) * d];
}

/**
 * The colour smoothing gives a pixel, as a palette index, or -1 to keep it. The
 * terrain only has the game's colours, so smoothing takes a vote instead of
 * blending: a pixel takes the most common colour within the radius when that
 * colour outnumbers its own. Specks go, stair steps straighten into the closest
 * clean edge, and areas wider than the radius stay. Colours outside the palette
 * (index 8) never win.
 */
function majority(index, x, y, kernel, counts) {
  counts.fill(0);
  for (let i = 0; i < kernel.length; i += 2) {
    const nx = x + kernel[i], ny = y + kernel[i + 1];
    if (nx >= 0 && ny >= 0 && nx < W && ny < H) counts[index[ny * W + nx]]++;
  }
  const own = index[y * W + x];
  let best = -1, most = own === 8 ? 0 : counts[own];
  for (let c = 0; c < 8; c++) if (counts[c] > most) (best = c), (most = counts[c]);
  return best;
}

/**
 * In 2v2 two players share a colour. They take its units in pairs, in the
 * order the game makes them (the colour's infantry, then its tanks): the first
 * two go to the first player, the next two to the second, and so on. Returns 0
 * or 1 for the unit at `index` in that order.
 */
export function duoPlayer(index) {
  return (index >> 1) & 1;
}

export class MockupMap {
  constructor({ canvas, base, map, hooks = {} }) {
    setSize(map.width ?? 960, map.height ?? 540);
    this.canvas = canvas;
    this.version = 0;
    this.hooks = hooks;
    this.tool = "brush";
    this.front = TERRAIN[1][1];
    this.back = TERRAIN[0][1];
    this.size = 12;
    this.shape = "round";
    this.figure = "rect";
    this.figureStyle = "fill";
    this.curveStyle = "line";
    this.strength = 2;
    this.path = null;
    this.symmetry = "off";
    this.team = 0;
    this.layers = { lines: true, shocks: true, duo: false, units: true, cities: true, bridges: true };
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.terrainVersion = 0;
    const terrain = document.createElement("canvas");
    [terrain.width, terrain.height] = [W, H];
    this.terrainContext = terrain.getContext("2d", { willReadFrequently: true });
    this.terrainCanvas = terrain;
    this.model = {
      infantry: map.infantry.map((team) => team.map((p) => [...p])),
      tanks: map.tanks.map((team) => team.map((p) => [...p])),
      cities: map.cities.map((p) => [...p]),
      capitals: [...map.capitals],
      bridges: (map.bridges || []).map((b) => (b.length === 4 ? [[b[0], b[1]], [b[2], b[3]]] : b.map((p) => [...p]))),
    };
    this.painter = new Painter(canvas, base);
    this.painter.overlay = (context) => this.drawOverlay(context);
    this.ready = (async () => {
      this.terrainContext.drawImage(await image(map.surface), 0, 0, W, H);
      this.pixels = this.terrainContext.getImageData(0, 0, W, H);
      await this.painter.boot();
      this.rebuild();
      this.listen();
      this.painter.attach();
    })();
  }

  get teams() {
    return this.model.infantry.length;
  }

  // Drawing ------------------------------------------------------------------

  surface() {
    const canvas = new OffscreenCanvas(...WORLD), context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.drawImage(this.terrainCanvas, 0, 0, ...WORLD);
    if (this.layers.bridges) {
      context.fillStyle = "rgb(100,60,10)";
      for (const bridge of this.model.bridges) this.bridgePath(context, bridge), context.fill();
    }
    return prepareMap(canvas, WORLD, this.layers.cities ? this.model.cities : [], false);
  }

  /** A bridge's outline as the engine rasterizes it: 15 units wide. */
  bridgePath(context, [a, b], toPoint = (p) => p.map(Math.trunc)) {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    context.beginPath();
    if (!length) return;
    const ox = (-dy * 7.5) / (length + 0.01), oy = (dx * 7.5) / (length + 0.01);
    [[a[0] + ox, a[1] + oy], [a[0] - ox, a[1] - oy], [b[0] - ox, b[1] - oy], [b[0] + ox, b[1] + oy]].forEach((p, i) => (i ? context.lineTo(...toPoint(p)) : context.moveTo(...toPoint(p))));
    context.closePath();
  }

  frame() {
    const { infantry, tanks, cities, capitals } = this.model;
    const key = JSON.stringify([infantry, tanks, cities]);
    if (this.territoryKey !== key) {
      this.territoryKey = key;
      const territory = startingTerritory({ infantry, tanks, cities }, this.teams, W, 1);
      this.territory = territory;
      this.contours = territory ? Array.from({ length: this.teams }, (_, side) => extract(territory.owners, side, territory.width, territory.height)) : [];
    }
    const owners = this.territory?.cityOwners ?? cities.map(() => 0);
    const dots = [];
    this.refs = [];
    if (this.layers.units)
      infantry.forEach((team, side) => {
        const shocks = this.layers.shocks ? shockIndexes(team.length) : new Set();
        team.forEach((position, i) => { this.refs.push(["infantry", side, i]); dots.push({ type: shocks.has(i) ? "motorised" : "infantry", side, position, max: 100 }); });
        tanks[side].forEach((position, i) => { this.refs.push(["tanks", side, i]); dots.push({ type: "tank", side, position, max: 200 }); });
      });
    const showCities = this.layers.cities;
    return {
      frame: 1,
      dots: dots.map((dot, id) => ({ id, color: dot.side, type: dot.type, health: dot.max, max_health: dot.max, position: [...dot.position], ship: false, ship_timer: 0, path: [] })),
      core: {
        cities: showCities ? cities.map((position, i) => ({ position, color: owners[i] })) : [],
        capitals: showCities ? capitals.filter((i) => cities[i]).map((i) => ({ position: cities[i] })) : [],
        city_positions: cities, dead_dots: [], economy: { fields: {} },
      },
      render: { contours: this.contours, directions: [] },
    };
  }

  rebuild({ terrain = true } = {}) {
    if (terrain) this.painter.renderer.texture("map", this.surface());
    this.painter.state = this.frame();
    this.painter.selected = new Set(this.refs.map((ref, id) => (this.isSelected(ref) ? id : -1)).filter((id) => id >= 0));
    this.draw();
    this.hooks.change?.(this);
  }

  draw() {
    if (this.drawing) return;
    this.drawing = true;
    const paint = () => {
      if (!this.drawing) return;
      this.drawing = false;
      if (this.painter.state) this.painter.paint(performance.now());
    };
    // Animation frames pause in a hidden page; a timer still draws there.
    requestAnimationFrame(paint);
    setTimeout(paint, 100);
  }

  // Terrain ------------------------------------------------------------------

  /** Writes changed pixels back to the terrain image and redraws the map. */
  flush() {
    this.terrainContext.putImageData(this.pixels, 0, 0);
    this.terrainVersion++;
    this.labels = null;
    this.rebuild();
  }

  mirrors([x, y], surface = false) {
    const [w, h] = surface ? [W - 1, H - 1] : WORLD;
    const points = [[x, y]];
    if (this.symmetry === "x") points.push([w - x, y]);
    if (this.symmetry === "y") points.push([x, h - y]);
    if (this.symmetry === "rotate") points.push([w - x, h - y]);
    // Four ways: across, above or below, and the opposite corner.
    if (this.symmetry === "quad") points.push([w - x, y], [x, h - y], [w - x, h - y]);
    return points;
  }

  toSurface([x, y]) {
    return [Math.floor(x * SCALE), Math.floor(y * SCALE)];
  }

  stamp([cx, cy], color) {
    const offsets = brushMask(this.size, this.shape), data = this.pixels.data;
    for (let i = 0; i < offsets.length; i += 2) {
      const x = cx + offsets[i], y = cy + offsets[i + 1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const at = (y * W + x) * 4;
      data[at] = color[0]; data[at + 1] = color[1]; data[at + 2] = color[2]; data[at + 3] = 255;
    }
  }

  strokeTo(from, to, color) {
    const a = this.toSurface(from), b = this.toSurface(to);
    const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
    for (let i = 0; i <= steps; i++) {
      const p = [Math.round(a[0] + ((b[0] - a[0]) * i) / steps), Math.round(a[1] + ((b[1] - a[1]) * i) / steps)];
      for (const m of this.mirrors(p, true)) this.stamp(m, color);
    }
  }

  /** Fills a world-space polygon: a pixel is filled when its centre is inside. */
  fillPolygon(points, color) {
    const mask = new OffscreenCanvas(W, H), context = mask.getContext("2d");
    for (const mirrored of this.mirrorShapes(points)) {
      context.beginPath();
      mirrored.forEach((p, i) => (i ? context.lineTo(p[0] * SCALE, p[1] * SCALE) : context.moveTo(p[0] * SCALE, p[1] * SCALE)));
      context.closePath();
      context.fill();
    }
    const alpha = context.getImageData(0, 0, W, H).data, data = this.pixels.data;
    for (let i = 3; i < alpha.length; i += 4) if (alpha[i] >= 128) { data[i - 3] = color[0]; data[i - 2] = color[1]; data[i - 1] = color[2]; }
  }

  mirrorShapes(points) {
    const mirrored = points.map((p) => this.mirrors(p));
    return mirrored[0].map((_, copy) => mirrored.map((copies) => copies[copy]));
  }

  stampInto(mask, [cx, cy]) {
    const offsets = brushMask(this.size, this.shape);
    for (let i = 0; i < offsets.length; i += 2) mark(mask, cx + offsets[i], cy + offsets[i + 1]);
  }

  /** The brush drawn along a polyline of world points, pixel for pixel as the brush paints. */
  strokeMask(mask, points, closed = false) {
    const path = points.map((p) => this.toSurface(p));
    if (closed && path.length > 2) path.push(path[0]);
    if (path.length === 1) this.stampInto(mask, path[0]);
    for (let j = 1; j < path.length; j++) {
      const a = path[j - 1], b = path[j], steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
      for (let i = 0; i <= steps; i++) this.stampInto(mask, [Math.round(a[0] + ((b[0] - a[0]) * i) / steps), Math.round(a[1] + ((b[1] - a[1]) * i) / steps)]);
    }
  }

  /** The inside of a polygon of world points: pixels whose centres are inside. */
  fillMask(mask, points) {
    if (points.length < 3) return;
    const s = points.map(([x, y]) => [x * SCALE, y * SCALE]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1) + 1); y1 = Math.min(H, Math.ceil(y1) + 1);
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0, context = new OffscreenCanvas(w, h).getContext("2d");
    context.beginPath();
    s.forEach(([x, y], i) => (i ? context.lineTo(x - x0, y - y0) : context.moveTo(x - x0, y - y0)));
    context.closePath();
    context.fill();
    const alpha = context.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[(y * w + x) * 4 + 3] >= 128) mark(mask, x + x0, y + y0);
  }

  /** Repeats a mask's pixels on the other sides of the map, as symmetry is set. */
  mirrorMask(mask) {
    if (this.symmetry === "off" || mask.x1 < 0) return mask;
    const { x0, y0, x1, y1 } = mask;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (mask.bits[y * W + x]) for (const [mx, my] of this.mirrors([x, y], true).slice(1)) mark(mask, mx, my);
    return mask;
  }

  applyMask(mask, color) {
    const data = this.pixels.data;
    for (let y = mask.y0; y <= mask.y1; y++)
      for (let x = mask.x0; x <= mask.x1; x++) {
        const i = y * W + x;
        if (mask.bits[i]) { data[i * 4] = color[0]; data[i * 4 + 1] = color[1]; data[i * 4 + 2] = color[2]; data[i * 4 + 3] = 255; }
      }
  }

  /** What the line or shape tool paints for a drag from `start` to `end`. */
  dragMask(tool, start, end, snap) {
    const mask = emptyMask();
    if (tool === "line") this.strokeMask(mask, [start, snap ? snapAngle(start, end) : end]);
    else {
      const corner = snap ? squareCorner(start, end) : end;
      const points = this.figure === "ellipse" ? ellipsePoints(start, corner) : [start, [corner[0], start[1]], corner, [start[0], corner[1]]];
      if (this.figureStyle === "fill") this.fillMask(mask, points);
      else this.strokeMask(mask, points, true);
    }
    return this.mirrorMask(mask);
  }

  /** What a polygon or curve through `points` paints. `close` closes an open curve. */
  pathMask(tool, points, close = false) {
    const mask = emptyMask();
    if (tool === "shape") {
      if (this.figureStyle === "fill") this.fillMask(mask, points);
      else this.strokeMask(mask, points, true);
    } else {
      const style = close && this.curveStyle === "line" ? "loop" : this.curveStyle;
      if (style === "fill") this.fillMask(mask, curvePoints(points, true));
      else this.strokeMask(mask, curvePoints(points, style === "loop"), style === "loop");
    }
    return this.mirrorMask(mask);
  }

  /** Whether the current tool is built from clicked points: a curve, or a polygon. */
  pathTool(tool = this.tool) {
    return tool === "curve" || (tool === "shape" && this.figure === "polygon");
  }

  /** Adds a clicked point. A double-click, or a click on the first point, finishes. */
  addPathPoint(world, back, clicks) {
    if (this.path?.tool !== this.tool) this.path = { tool: this.tool, points: [], back };
    const path = this.path, first = path.points[0];
    if (clicks >= 2 && path.points.length >= 2) return this.finishPath();
    if (first && path.points.length >= 3 && Math.hypot(world[0] - first[0], world[1] - first[1]) * this.painter.unit() < 10) return this.finishPath(true);
    path.points.push(world);
    this.draw();
  }

  finishPath(close = false) {
    const path = this.path;
    this.path = null;
    if (!path) return;
    const closed = path.tool === "shape" || close || this.curveStyle !== "line";
    if (path.points.length >= (closed ? 3 : 2)) {
      this.record();
      this.applyMask(this.pathMask(path.tool, path.points, close), rgb(path.back ? this.back : this.front));
      this.flush();
    }
    this.draw();
  }

  /** Enter finishes the points being clicked, Escape drops them and Backspace
   * removes the last one. Returns whether the key was used. */
  pathKey(key) {
    if (!this.path) return false;
    if (key === "enter") this.finishPath();
    else if (key === "escape") this.path = null;
    else if (key === "backspace") { this.path.points.pop(); if (!this.path.points.length) this.path = null; }
    else return false;
    this.draw();
    return true;
  }

  /** Each terrain pixel's palette index; 8 for a colour outside the palette. */
  paletteIndex() {
    if (this.index?.version === this.terrainVersion) return this.index.values;
    const d = this.pixels.data, values = new Uint8Array(W * H);
    const lookup = new Map(TERRAIN.map(([, hex], i) => { const [r, g, b] = rgb(hex); return [(r << 16) | (g << 8) | b, i]; }));
    for (let i = 0; i < W * H; i++) values[i] = lookup.get((d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2]) ?? 8;
    this.index = { version: this.terrainVersion, values };
    return values;
  }

  /** Smoothing along a drag: each newly covered pixel's result is kept, read from
   * the terrain before the drag, so the preview is the result. */
  smoothAlong(press, from, to) {
    const index = this.paletteIndex(), kernel = brushMask(this.strength * 2 + 1, "round"), offsets = brushMask(this.size, this.shape), counts = new Uint16Array(9);
    const { mask, changes } = press.smooth, a = this.toSurface(from), b = this.toSurface(to);
    const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
    for (let s = 0; s <= steps; s++) {
      const centre = [Math.round(a[0] + ((b[0] - a[0]) * s) / steps), Math.round(a[1] + ((b[1] - a[1]) * s) / steps)];
      for (const [cx, cy] of this.mirrors(centre, true))
        for (let i = 0; i < offsets.length; i += 2) {
          const x = cx + offsets[i], y = cy + offsets[i + 1];
          if (x < 0 || y < 0 || x >= W || y >= H || mask.bits[y * W + x]) continue;
          mark(mask, x, y);
          const next = majority(index, x, y, kernel, counts);
          if (next >= 0) changes.set(y * W + x, next);
        }
    }
  }

  applyChanges(changes) {
    if (!changes.size) return 0;
    this.record();
    const data = this.pixels.data, colors = TERRAIN.map(([, hex]) => rgb(hex));
    for (const [i, c] of changes) { data[i * 4] = colors[c][0]; data[i * 4 + 1] = colors[c][1]; data[i * 4 + 2] = colors[c][2]; data[i * 4 + 3] = 255; }
    this.flush();
    return changes.size;
  }

  /** Smooths the whole map, pass after pass until nothing changes (at most six),
   * as one step to undo. Returns how many pixels changed. */
  smoothAll() {
    const kernel = brushMask(this.strength * 2 + 1, "round"), counts = new Uint16Array(9), colors = TERRAIN.map(([, hex]) => rgb(hex)), data = this.pixels.data;
    let total = 0;
    for (let pass = 0; pass < 6; pass++) {
      const index = this.paletteIndex(), changes = [];
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const next = majority(index, x, y, kernel, counts);
          if (next >= 0) changes.push(y * W + x, next);
        }
      if (!changes.length) break;
      if (!total) this.record();
      for (let i = 0; i < changes.length; i += 2) {
        const at = changes[i] * 4, [r, g, b] = colors[changes[i + 1]];
        data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
      }
      total += changes.length / 2;
      this.index = null; // the next pass reads the smoothed terrain
    }
    if (total) this.flush();
    return total;
  }

  /** A mask (or the smoothing changes) as an image to draw over the map, cached by `key`. */
  maskImage(key, make) {
    if (this.maskPreview?.key === key) return this.maskPreview.image;
    const made = make();
    let image = null;
    if (made && made.mask.x1 >= 0) {
      const { mask } = made, w = mask.x1 - mask.x0 + 1, h = mask.y1 - mask.y0 + 1, canvas = new OffscreenCanvas(w, h), context = canvas.getContext("2d"), out = context.createImageData(w, h);
      const paint = (i, [r, g, b]) => { const x = (i % W) - mask.x0, y = Math.floor(i / W) - mask.y0, o = (y * w + x) * 4; out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = 255; };
      if (made.changes) { const colors = TERRAIN.map(([, hex]) => rgb(hex)); for (const [i, c] of made.changes) paint(i, colors[c]); }
      else { const color = rgb(made.hex); for (let y = mask.y0; y <= mask.y1; y++) for (let x = mask.x0; x <= mask.x1; x++) if (mask.bits[y * W + x]) paint(y * W + x, color); }
      context.putImageData(out, 0, 0);
      image = { canvas, x: mask.x0, y: mask.y0, w, h };
    }
    this.maskPreview = { key, image };
    return image;
  }

  /** Connected areas of one terrain, for the bucket and its preview. */
  regions() {
    if (this.labels) return this.labels;
    const data = this.pixels.data, labels = new Int32Array(W * H).fill(-1);
    let next = 0;
    const same = (a, b) => data[a * 4] === data[b * 4] && data[a * 4 + 1] === data[b * 4 + 1] && data[a * 4 + 2] === data[b * 4 + 2];
    for (let start = 0; start < W * H; start++) {
      if (labels[start] >= 0) continue;
      const id = next++, stack = [start];
      labels[start] = id;
      while (stack.length) {
        const i = stack.pop(), x = i % W;
        for (const n of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W])
          if (n >= 0 && n < W * H && labels[n] < 0 && same(i, n)) { labels[n] = id; stack.push(n); }
      }
    }
    this.labels = labels;
    this.regionMasks = new Map();
    return labels;
  }

  regionAt(world) {
    const [x, y] = this.toSurface(world);
    if (x < 0 || y < 0 || x >= W || y >= H) return -1;
    return this.regions()[y * W + x];
  }

  fillRegion(world, color) {
    const labels = this.regions(), data = this.pixels.data;
    const ids = new Set(this.mirrors(world).map((p) => this.regionAt(p)).filter((id) => id >= 0));
    for (let i = 0; i < labels.length; i++) if (ids.has(labels[i])) { data[i * 4] = color[0]; data[i * 4 + 1] = color[1]; data[i * 4 + 2] = color[2]; }
  }

  terrainAt(world) {
    const [x, y] = this.toSurface(world);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const at = (y * W + x) * 4, d = this.pixels.data;
    return "#" + [d[at], d[at + 1], d[at + 2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  // History ------------------------------------------------------------------

  snapshot() {
    return { pixels: new ImageData(new Uint8ClampedArray(this.pixels.data), W, H), model: JSON.parse(JSON.stringify(this.model)) };
  }
  restore(snapshot) {
    this.version++;
    this.pixels = snapshot.pixels;
    this.model = snapshot.model;
    this.selection = [];
    this.flush();
  }
  record() {
    this.version++;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
  }

  // Settings -----------------------------------------------------------------

  set(changes) {
    Object.assign(this, changes);
    if ("tool" in changes || "figure" in changes) this.path = null;
    if ("tool" in changes) { this.press = null; if (changes.tool !== "move") this.selection = []; if (this.pixels) this.rebuild({ terrain: false }); }
    this.draw();
  }
  /** The brush's width on screen, in CSS pixels, at the current zoom. */
  brushCssSize() {
    const rect = this.canvas.getBoundingClientRect();
    return (this.size / SCALE) * this.painter.unit() * (rect.width / (this.canvas.width || 1));
  }
  setLayer(name, on) {
    this.layers[name] = on;
    // Shock units belong to experiment matches and 2v2 has none, so one view is shown at a time.
    if (on && name === "duo") this.layers.shocks = false;
    if (on && name === "shocks") this.layers.duo = false;
    if (name === "lines") this.painter.showLines = on;
    this.rebuild({ terrain: name === "cities" || name === "bridges" });
  }
  setTeams(count) {
    if (count === this.teams) return;
    this.record();
    const resize = (lists) => Array.from({ length: count }, (_, i) => lists[i] ?? []);
    this.model.infantry = resize(this.model.infantry);
    this.model.tanks = resize(this.model.tanks);
    if (count !== 2) this.layers.duo = false;
    this.team = Math.min(this.team, count - 1);
    this.selection = [];
    this.rebuild({ terrain: false });
  }
  swapColors() { [this.front, this.back] = [this.back, this.front]; this.hooks.colors?.(this); this.draw(); }
  resetColors() { this.front = TERRAIN[1][1]; this.back = TERRAIN[0][1]; this.hooks.colors?.(this); this.draw(); }

  // Objects ------------------------------------------------------------------

  /** The team a mirrored copy belongs to: copy 0 is the original, each later copy
   * goes to the team after. With four-way symmetry and two teams, the left and
   * right halves belong to different teams. */
  mirrorTeam(team, copy = 1) {
    return (team + copy) % this.teams;
  }

  objectsNear(world, radius, kinds) {
    let best = null, distance = radius * radius;
    const consider = (ref, point) => {
      const d = (point[0] - world[0]) ** 2 + (point[1] - world[1]) ** 2;
      if (d < distance) (distance = d), (best = ref);
    };
    if (kinds.includes("units") && this.layers.units)
      for (const kind of ["infantry", "tanks"]) this.model[kind].forEach((list, team) => list.forEach((p, i) => consider([kind, team, i], p)));
    if (kinds.includes("cities") && this.layers.cities) this.model.cities.forEach((p, i) => consider(["cities", null, i], p));
    if (kinds.includes("bridges") && this.layers.bridges)
      this.model.bridges.forEach(([a, b], i) => {
        const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((world[0] - a[0]) * dx + (world[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        consider(["bridges", null, i], [a[0] + t * dx, a[1] + t * dy]);
      });
    return best;
  }

  pointOf([kind, team, index]) {
    return kind === "cities" ? this.model.cities[index] : this.model[kind][team][index];
  }

  isSelected([kind, team, index]) {
    return this.selection.some(([k, t, i]) => k === kind && t === team && i === index);
  }

  removeObjects(refs) {
    // Highest index first, so earlier indexes stay valid.
    for (const [kind, team, index] of [...refs].sort((a, b) => b[2] - a[2])) {
      if (kind === "cities") {
        this.model.cities.splice(index, 1);
        this.model.capitals = this.model.capitals.filter((c) => c !== index).map((c) => (c > index ? c - 1 : c));
      } else if (kind === "bridges") this.model.bridges.splice(index, 1);
      else this.model[kind][team].splice(index, 1);
    }
  }

  deleteSelection() {
    if (!this.selection.length) return;
    this.record();
    this.removeObjects(this.selection);
    this.selection = [];
    this.rebuild();
    this.hooks.selection?.(this);
  }

  /** Copies the selection to the mirrored side (each side, with four-way
   * symmetry), each copy for the team after. */
  mirrorSelection() {
    if (!this.selection.length) return;
    this.record();
    const mode = this.symmetry === "off" ? "rotate" : this.symmetry;
    const flips = { x: [[-1, 1]], y: [[1, -1]], rotate: [[-1, -1]], quad: [[-1, 1], [1, -1], [-1, -1]] }[mode];
    const flip = ([x, y], [fx, fy]) => [fx < 0 ? WORLD[0] - x : x, fy < 0 ? WORLD[1] - y : y];
    const capitals = this.selection.filter(([kind, , index]) => kind === "cities" && this.model.capitals.includes(index)).map(([, , index]) => index);
    for (const ref of this.selection)
      flips.forEach((f, k) => {
        const [kind, team] = ref, point = flip(this.pointOf(ref), f).map(Math.round), copy = this.mirrorTeam(team, k + 1);
        if (kind === "cities") {
          this.model.cities.push(point);
          if (capitals.includes(ref[2])) this.model.capitals.push(this.model.cities.length - 1);
        } else if (kind === "infantry") this.addInfantry(copy, point);
        else this.model[kind][copy].push(point);
      });
    this.selection = [];
    this.rebuild();
    this.hooks.selection?.(this);
  }

  /**
   * Adds infantry so that no unit already placed changes whether it becomes a
   * shock unit. Experiment matches convert infantry by their place counted from
   * the end of the list, never the first; a unit added as the second keeps every
   * other unit's place from the end, and the first stays first.
   */
  addInfantry(team, point) {
    const list = this.model.infantry[team];
    // With the 2v2 view, new infantry joins the end of the list instead, so the
    // units already placed keep their player.
    if (list.length && !this.layers.duo) list.splice(1, 0, point); else list.push(point);
  }

  /** Which 2v2 player a unit belongs to (see duoPlayer). */
  duoOf(kind, side, index) {
    return duoPlayer(kind === "tanks" ? this.model.infantry[side].length + index : index);
  }

  /** Whether infantry added for `team` now would become a shock unit. */
  nextIsShock(team) {
    const count = this.model.infantry[team].length;
    return count >= 1 && (count - 1) % 5 === 0;
  }

  /** The team a city starts with: the nearest unit's, as in the engine. */
  cityOwner(point) {
    let owner = null, distance = Infinity;
    this.model.infantry.forEach((team, side) => [...team, ...this.model.tanks[side]].forEach((p) => {
      const d = (p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2;
      if (d < distance) (distance = d), (owner = side);
    }));
    return owner;
  }

  /** Whether a new city at `point` would be its team's first capital. */
  becomesCapital(point) {
    const owner = this.cityOwner(point);
    return owner !== null && !this.model.capitals.some((i) => this.model.cities[i] && this.cityOwner(this.model.cities[i]) === owner);
  }

  place(tool, world) {
    const points = this.mirrors(world.map(Math.round));
    points.forEach((point, copy) => {
      point = point.map(Math.round);
      const team = this.mirrorTeam(this.team, copy);
      if (tool === "infantry") this.addInfantry(team, point);
      else if (tool === "tank") this.model.tanks[team].push(point);
      else if (tool === "city") {
        // A team's first city becomes its capital; moving it moves the capital.
        if (this.objectsNear(point, 16, ["cities"])) return;
        const capital = this.becomesCapital(point);
        this.model.cities.push(point);
        if (capital) this.model.capitals.push(this.model.cities.length - 1);
      }
    });
  }

  // Input --------------------------------------------------------------------

  world(event) {
    return this.painter.toWorld(this.painter.canvasPoint(event));
  }

  listen() {
    const canvas = this.canvas;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      const world = this.world(event), back = event.button === 2;
      let tool = this.tool;
      if (event.altKey && PAINT_TOOLS.includes(tool)) tool = "picker";
      if (this.spaceHeld) tool = "hand";
      this.press = { tool, start: world, last: world, points: [world], back, moved: false, canvas: this.painter.canvasPoint(event) };
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointers cannot be captured.
      }
      const color = rgb(back ? this.back : this.front);
      this.press.shift = event.shiftKey;
      if (this.pathTool(tool)) {
        this.press = null;
        this.addPathPoint(world, back, event.detail);
      } else if (tool === "smooth") {
        this.press.smooth = { mask: emptyMask(), changes: new Map() };
        this.smoothAlong(this.press, world, world);
        this.draw();
      } else if (tool === "brush") {
        this.record();
        this.strokeTo(world, world, color);
        this.flush();
      } else if (tool === "bucket") {
        this.record();
        this.fillRegion(world, color);
        this.flush();
        this.press = null;
      } else if (tool === "picker") {
        const hex = this.terrainAt(world);
        if (hex && TERRAIN.some(([, h]) => h === hex)) { if (back) this.back = hex; else this.front = hex; this.hooks.colors?.(this); }
        this.press = null;
      } else if (["infantry", "tank", "city"].includes(tool)) {
        this.press = null;
        if (back) {
          // Right-click removes the nearest object of the kind the tool places.
          const hit = this.objectsNear(world, 18, tool === "infantry" || tool === "tank" ? ["units"] : ["cities"]);
          if (!hit) return;
          this.record(); this.removeObjects([hit]);
        } else { this.record(); this.place(tool, world); }
        this.rebuild();
      } else if (tool === "bridge" && back) {
        this.press = null;
        const hit = this.objectsNear(world, 18, ["bridges"]);
        if (hit) { this.record(); this.removeObjects([hit]); this.rebuild(); }
      } else if (tool === "move") {
        const hit = this.objectsNear(world, 16, ["units", "cities"]);
        if (hit) {
          if (event.shiftKey) this.selection = this.isSelected(hit) ? this.selection.filter((r) => !(r[0] === hit[0] && r[1] === hit[1] && r[2] === hit[2])) : [...this.selection, hit];
          else if (!this.isSelected(hit)) this.selection = [hit];
          this.press.dragging = true;
          this.press.origin = this.selection.map((ref) => [...this.pointOf(ref)]);
          this.record();
        } else {
          if (!event.shiftKey) this.selection = [];
          this.press.marquee = true;
        }
        this.rebuild({ terrain: false });
        this.hooks.selection?.(this);
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.painter.state) return;
      const world = this.world(event);
      this.hover = world;
      const hex = this.terrainAt(world);
      this.hooks.cursor?.({ x: Math.round(world[0]), y: Math.round(world[1]), terrain: hex ? nameOf(...rgb(hex)) : "" });
      const press = this.press;
      if (press) {
        press.moved = true;
        press.shift = event.shiftKey;
        const tool = press.tool;
        if (tool === "smooth") this.smoothAlong(press, press.last, world);
        else if (tool === "brush") {
          this.strokeTo(press.last, world, rgb(press.back ? this.back : this.front));
          this.flush();
        } else if (tool === "lasso") press.points.push(world);
        else if (tool === "hand") {
          const point = this.painter.canvasPoint(event);
          this.painter.pan(point[0] - press.canvas[0], point[1] - press.canvas[1]);
          press.canvas = point;
        } else if (tool === "move" && press.dragging) {
          const dx = world[0] - press.start[0], dy = world[1] - press.start[1];
          this.selection.forEach((ref, i) => {
            const p = [Math.round(press.origin[i][0] + dx), Math.round(press.origin[i][1] + dy)];
            if (ref[0] === "cities") this.model.cities[ref[2]] = p; else this.model[ref[0]][ref[1]][ref[2]] = p;
          });
          this.rebuild({ terrain: this.selection.some((ref) => ref[0] === "cities") });
        }
        press.last = world;
      }
      this.draw();
    });
    const release = () => {
      const press = this.press;
      this.press = null;
      if (!press) return;
      const color = rgb(press.back ? this.back : this.front), end = press.last;
      if (press.tool === "smooth") this.applyChanges(press.smooth.changes);
      else if ((press.tool === "line" || press.tool === "shape") && press.moved && Math.hypot(end[0] - press.start[0], end[1] - press.start[1]) * this.painter.unit() > 2) {
        this.record();
        this.applyMask(this.dragMask(press.tool, press.start, end, press.shift), color);
        this.flush();
      } else if (press.tool === "lasso" && press.points.length > 2) {
        this.record();
        this.fillPolygon(press.points, color);
        this.flush();
      } else if (press.tool === "bridge" && !press.back && Math.hypot(end[0] - press.start[0], end[1] - press.start[1]) > 6) {
        this.record();
        const a = this.mirrors(press.start.map(Math.round)), b = this.mirrors(end.map(Math.round));
        a.forEach((start, i) => this.model.bridges.push([start.map(Math.round), b[i].map(Math.round)]));
        this.rebuild();
      } else if (press.tool === "move") {
        if (press.marquee && press.moved) {
          const [x0, x1] = [press.start[0], end[0]].sort((a, b) => a - b), [y0, y1] = [press.start[1], end[1]].sort((a, b) => a - b);
          const inside = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
          const found = [];
          if (this.layers.units) for (const kind of ["infantry", "tanks"]) this.model[kind].forEach((list, team) => list.forEach((p, i) => inside(p) && found.push([kind, team, i])));
          if (this.layers.cities) this.model.cities.forEach((p, i) => inside(p) && found.push(["cities", null, i]));
          this.selection = [...this.selection, ...found.filter((ref) => !this.isSelected(ref))];
        } else if (press.dragging && !press.moved) this.undoStack.pop();
        this.rebuild({ terrain: false });
        this.hooks.selection?.(this);
      }
      this.draw();
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", () => { this.press = null; this.draw(); });
    canvas.addEventListener("pointerleave", () => { this.hover = null; this.hooks.cursor?.(null); this.draw(); });
    canvas.addEventListener("wheel", () => this.draw(), { passive: true });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  // Previews -----------------------------------------------------------------

  /** The brush's pixels as an image in a colour, cached by size, shape and colour. */
  brushImage(hex) {
    const key = `${this.size}:${this.shape}:${hex}`;
    if (this.brushCache?.key !== key) {
      const offsets = brushMask(this.size, this.shape), canvas = new OffscreenCanvas(this.size, this.size), context = canvas.getContext("2d");
      const from = -Math.floor((this.size - 1) / 2);
      context.fillStyle = hex;
      for (let i = 0; i < offsets.length; i += 2) context.fillRect(offsets[i] - from, offsets[i + 1] - from, 1, 1);
      this.brushCache = { key, canvas, from };
    }
    return this.brushCache;
  }

  regionImage(id, hex) {
    const key = `${this.terrainVersion}:${id}:${hex}`;
    this.regionMasks ??= new Map();
    if (!this.regionMasks.has(key)) {
      const labels = this.regions(), canvas = new OffscreenCanvas(W, H), context = canvas.getContext("2d"), out = context.createImageData(W, H), [r, g, b] = rgb(hex);
      for (let i = 0; i < labels.length; i++) if (labels[i] === id) { out.data[i * 4] = r; out.data[i * 4 + 1] = g; out.data[i * 4 + 2] = b; out.data[i * 4 + 3] = 255; }
      context.putImageData(out, 0, 0);
      if (this.regionMasks.size > 6) this.regionMasks.clear();
      this.regionMasks.set(key, canvas);
    }
    return this.regionMasks.get(key);
  }

  drawOverlay(context) {
    const painter = this.painter, unit = painter.unit(), toCanvas = (p) => painter.toCanvas(p);
    const hover = this.hover, press = this.press;
    const tool = press?.tool ?? (this.spaceHeld ? "hand" : this.tool);
    const hex = press?.back ? this.back : this.front;
    context.save();
    context.resetTransform();
    context.imageSmoothingEnabled = false;
    const px = unit / SCALE; // canvas pixels per terrain pixel
    const outline = (path) => { context.lineWidth = 1; context.strokeStyle = "rgba(0,0,0,0.55)"; path(); context.stroke(); };

    // The symmetry axis while a symmetric tool is in use.
    if (this.symmetry !== "off" && hover && tool !== "move" && tool !== "hand" && tool !== "picker") {
      context.setLineDash([6, 6]);
      context.strokeStyle = "rgba(255,255,255,0.35)";
      context.lineWidth = 1;
      context.beginPath();
      const [mw, mh] = WORLD;
      if (this.symmetry !== "y") { context.moveTo(...toCanvas([mw / 2, 0])); context.lineTo(...toCanvas([mw / 2, mh])); }
      if (this.symmetry !== "x") { context.moveTo(...toCanvas([0, mh / 2])); context.lineTo(...toCanvas([mw, mh / 2])); }
      context.stroke();
      context.setLineDash([]);
    }

    if (hover && !press && (tool === "brush" || tool === "line" || (tool === "curve" && this.curveStyle !== "fill" && !this.path) || (tool === "shape" && this.figureStyle === "outline" && !this.path))) {
      // The brush's own pixels in the colour it will paint.
      const { canvas, from } = this.brushImage(this.front);
      context.globalAlpha = 0.85;
      for (const p of this.mirrors(this.toSurface(hover), true)) {
        const [x, y] = toCanvas([(p[0] + from) / SCALE, (p[1] + from) / SCALE]);
        context.drawImage(canvas, x, y, this.size * px, this.size * px);
      }
      context.globalAlpha = 1;
      const [cx, cy] = toCanvas(hover);
      outline(() => { context.beginPath(); if (this.shape === "square") context.rect(cx - (this.size * px) / 2, cy - (this.size * px) / 2, this.size * px, this.size * px); else context.arc(cx, cy, (this.size * px) / 2, 0, Math.PI * 2); });
    }

    if (hover && !press && tool === "bucket") {
      // The area the bucket would fill, in the colour it would fill it with.
      const ids = new Set(this.mirrors(hover).map((p) => this.regionAt(p)).filter((id) => id >= 0));
      context.globalAlpha = 0.8;
      const [x0, y0] = toCanvas([0, 0]), [x1, y1] = toCanvas(WORLD);
      for (const id of ids) context.drawImage(this.regionImage(id, this.front), x0, y0, x1 - x0, y1 - y0);
      context.globalAlpha = 1;
    }

    // Line and shape while dragged, polygon and curve while clicked: the pixels they paint.
    const drawMask = (image, alpha) => {
      if (!image) return;
      const [x, y] = toCanvas([image.x / SCALE, image.y / SCALE]);
      context.globalAlpha = alpha;
      context.drawImage(image.canvas, x, y, image.w * px, image.h * px);
      context.globalAlpha = 1;
    };
    const settings = [this.size, this.shape, this.figure, this.figureStyle, this.curveStyle, this.symmetry, hex, W];
    if (press && press.moved && (tool === "line" || tool === "shape")) {
      const key = JSON.stringify(["drag", tool, press.start, press.last, press.shift, settings]);
      drawMask(this.maskImage(key, () => ({ mask: this.dragMask(tool, press.start, press.last, press.shift), hex })), 0.9);
    }
    if (this.path && this.path.tool === tool) {
      const pathHex = this.path.back ? this.back : this.front;
      const points = hover ? [...this.path.points, hover] : this.path.points;
      const key = JSON.stringify(["path", tool, points, settings, pathHex]);
      drawMask(this.maskImage(key, () => ({ mask: this.pathMask(tool, points), hex: pathHex })), 0.9);
      // The clicked points; the first is larger, as clicking it closes the shape.
      this.path.points.forEach((p, i) => {
        const [x, y] = toCanvas(p);
        context.beginPath();
        context.arc(x, y, i ? 3.5 : 5.5, 0, Math.PI * 2);
        context.fillStyle = "#fff";
        context.fill();
        context.lineWidth = 1.5;
        context.strokeStyle = "rgba(0,0,0,0.7)";
        context.stroke();
      });
    }
    if (press?.smooth) drawMask(this.maskImage(`smooth:${press.smooth.mask.x0},${press.smooth.mask.y0},${press.smooth.mask.x1},${press.smooth.mask.y1}:${press.smooth.changes.size}`, () => ({ mask: press.smooth.mask, changes: press.smooth.changes })), 1);
    if (hover && tool === "smooth") {
      const [cx, cy] = toCanvas(hover);
      for (const color of ["rgba(0,0,0,0.6)", "rgba(255,255,255,0.8)"]) {
        context.setLineDash(color.startsWith("rgba(0") ? [] : [4, 4]);
        context.lineWidth = 1;
        context.strokeStyle = color;
        context.beginPath();
        if (this.shape === "square") context.rect(cx - (this.size * px) / 2, cy - (this.size * px) / 2, this.size * px, this.size * px);
        else context.arc(cx, cy, (this.size * px) / 2, 0, Math.PI * 2);
        context.stroke();
      }
      context.setLineDash([]);
    }

    if (press && tool === "lasso") {
      const shape = press.points;
      context.fillStyle = hex;
      context.globalAlpha = 0.85;
      for (const s of this.mirrorShapes(shape)) {
        context.beginPath();
        s.forEach((p, i) => (i ? context.lineTo(...toCanvas(p)) : context.moveTo(...toCanvas(p))));
        context.closePath();
        context.fill();
      }
      context.globalAlpha = 1;
      for (const s of this.mirrorShapes(shape)) outline(() => { context.beginPath(); s.forEach((p, i) => (i ? context.lineTo(...toCanvas(p)) : context.moveTo(...toCanvas(p)))); context.closePath(); });
    }

    if (hover && !press && (tool === "lasso" || (tool === "shape" && this.figureStyle === "fill"))) {
      const [x, y] = toCanvas(hover);
      context.fillStyle = this.front;
      context.fillRect(x + 8, y + 8, 12, 12);
      outline(() => { context.beginPath(); context.rect(x + 8, y + 8, 12, 12); });
    }

    if (tool === "bridge" && hover) {
      // The bridge as it will be drawn into the map.
      const ends = press && !press.back ? [press.start, press.last] : null;
      context.fillStyle = "rgb(100,60,10)";
      context.globalAlpha = 0.9;
      if (ends) {
        const a = this.mirrors(ends[0]), b = this.mirrors(ends[1]);
        a.forEach((start, i) => { this.bridgePath(context, [start, b[i]], toCanvas); context.fill(); });
      } else for (const p of this.mirrors(hover)) { const [x, y] = toCanvas(p); context.fillRect(x - 7.5 * unit, y - 7.5 * unit, 15 * unit, 15 * unit); }
      context.globalAlpha = 1;
    }

    if (hover && !press && (tool === "infantry" || tool === "tank")) {
      // The sprite the unit will have, for each team it is placed for.
      this.mirrors(hover).forEach((p, copy) => {
        const team = this.mirrorTeam(this.team, copy);
        const type = tool === "infantry" && this.layers.shocks && this.nextIsShock(team) ? "motorised" : tool;
        const sprite = painter.renderer.sources.get(`${COLORS[team]}_${type}_100`);
        const [x, y] = toCanvas(p);
        context.globalAlpha = 0.7;
        if (sprite) context.drawImage(sprite, x - 12 * unit, y - 12 * unit, 24 * unit, 24 * unit);
      });
      context.globalAlpha = 1;
    }

    if (hover && !press && tool === "city") {
      for (const p of this.mirrors(hover)) {
        const near = this.objectsNear(p, 16, ["cities"]);
        const [x, y] = toCanvas(near ? this.model.cities[near[2]] : p);
        context.globalAlpha = 0.85;
        if (!near) {
          // The city as it will look, with the capital it becomes when its team has none.
          context.fillStyle = "#ffff00";
          context.beginPath(); context.arc(x, y, 9 * unit, 0, Math.PI * 2); context.fill();
          const sprite = this.becomesCapital(p) && painter.renderer.sources.get("capital");
          if (sprite) context.drawImage(sprite, x - 17.5 * unit, y - 2 * unit - 16.5 * unit, 35 * unit, 33 * unit);
        }
        context.globalAlpha = 1;
      }
    }

    if (hover && !press && tool === "picker") {
      const pick = this.terrainAt(hover);
      if (pick) {
        const [x, y] = toCanvas(hover);
        context.fillStyle = pick;
        context.beginPath(); context.arc(x + 18, y - 18, 11, 0, Math.PI * 2); context.fill();
        context.lineWidth = 2; context.strokeStyle = "#fff"; context.stroke();
      }
    }

    // 2v2: a badge on each unit with the player who commands it, and on the unit being placed.
    if (this.layers.duo && this.layers.units && this.teams === 2) {
      const badge = ([wx, wy], player, alpha = 1) => {
        const [x, y] = toCanvas([wx, wy]), r = 7, bx = x + Math.max(8, 9 * unit), by = y - Math.max(8, 9 * unit);
        context.globalAlpha = alpha;
        context.beginPath();
        context.arc(bx, by, r, 0, Math.PI * 2);
        context.fillStyle = player ? "#1b2230" : "#ffffff";
        context.fill();
        context.lineWidth = 1.5;
        context.strokeStyle = player ? "#ffffff" : "#1b2230";
        context.stroke();
        context.fillStyle = player ? "#ffffff" : "#1b2230";
        context.font = "700 10px Inter, 'Segoe UI', sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(player + 1), bx, by + 0.5);
        context.globalAlpha = 1;
      };
      for (const kind of ["infantry", "tanks"]) this.model[kind].forEach((list, side) => list.forEach((p, i) => badge(p, this.duoOf(kind, side, i))));
      if (hover && !press && (tool === "infantry" || tool === "tank")) {
        this.mirrors(hover).forEach((p, copy) => {
          const side = this.mirrorTeam(this.team, copy), next = this.model.infantry[side].length + (tool === "tank" ? this.model.tanks[side].length : 0);
          badge(p, duoPlayer(next), 0.8);
        });
      }
    }

    // Selection: a ring around selected cities, and the marquee being drawn.
    if (this.selection.length) {
      context.strokeStyle = "#fff";
      context.lineWidth = 2;
      for (const ref of this.selection) if (ref[0] === "cities") { const [x, y] = toCanvas(this.pointOf(ref)); context.beginPath(); context.arc(x, y, 15 * unit, 0, Math.PI * 2); context.stroke(); }
    }
    if (press?.marquee && press.moved) {
      const [ax, ay] = toCanvas(press.start), [bx, by] = toCanvas(press.last);
      context.setLineDash([5, 4]);
      context.strokeStyle = "#fff";
      context.lineWidth = 1;
      context.strokeRect(Math.min(ax, bx) + 0.5, Math.min(ay, by) + 0.5, Math.abs(bx - ax), Math.abs(by - ay));
      context.setLineDash([]);
    }
    context.restore();
  }

  // Files --------------------------------------------------------------------

  /** The map in the game's format: the six fields the game reads. */
  toMapData() {
    const round = (p) => p.map(Math.round);
    const { infantry, tanks, cities, capitals, bridges } = this.model;
    return {
      map_surface: this.terrainCanvas.toDataURL("image/png").split(",")[1],
      infantry: infantry.map((team) => team.map(round)),
      tanks: tanks.map((team) => team.map(round)),
      cities: cities.map(round),
      capitals: capitals.filter((i) => i < cities.length),
      bridges: bridges.map((bridge) => bridge.map(round)),
    };
  }

  /** The map as a replay at its first frame, for a test match. With shock units
   * on, the match uses the experiment rules and lists them apart, as the game does. */
  toReplay() {
    const map = this.toMapData();
    if (this.layers.shocks) {
      map.motorised = map.infantry.map((team) => { const s = shockIndexes(team.length); return team.filter((_, i) => s.has(i)).reverse(); });
      map.infantry = map.infantry.map((team) => { const s = shockIndexes(team.length); return team.filter((_, i) => !s.has(i)); });
    }
    const names = ["Blue", "Red", "Purple", "Orange"].slice(0, this.teams).map((name) => [name]);
    const root = { version: "1.4.1", mode: this.layers.shocks ? "experiment" : "1v1", map, end: 0, player_usernames: names };
    return new TextEncoder().encode(JSON.stringify(root));
  }

  /** Replaces the terrain with an image already snapped to the terrain colours. */
  replaceTerrain(source) {
    this.record();
    this.terrainContext.drawImage(source, 0, 0, W, H);
    this.pixels = this.terrainContext.getImageData(0, 0, W, H);
    this.flush();
  }

  fillTerrain(hex) {
    this.record();
    this.terrainContext.fillStyle = hex;
    this.terrainContext.fillRect(0, 0, W, H);
    this.pixels = this.terrainContext.getImageData(0, 0, W, H);
    this.flush();
  }

  destroy() {
    this.destroyed = true;
    this.painter.canvas.remove();
  }

  counts() {
    const owners = this.territory?.cityOwners ?? [];
    return this.model.infantry.map((team, side) => ({
      infantry: team.length,
      shocks: shockIndexes(team.length).size,
      players: [0, 1].map((player) => Array.from({ length: team.length + this.model.tanks[side].length }, (_, k) => duoPlayer(k)).filter((p) => p === player).length),
      tanks: this.model.tanks[side].length,
      cities: owners.filter((owner) => owner === side).length,
    }));
  }
}

export function mount(options) {
  return new MockupMap(options);
}
