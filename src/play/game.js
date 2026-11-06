// A match continued from a replay: the simulation (engine-worker.js), the
// battlefield as the replay player draws it, the fog of war, and the game's
// controls. Turns come from the match room every 15 ticks; the page simulates at
// the game's 30 ticks a second and waits when the next turn has not arrived.
import { decodeChunk } from "../player/frames.js";
import { prepareMap } from "../player/map.js";
import { frontLines } from "../player/frontline.js";
import { Renderer } from "../player/local-renderer.js";
import { iconFor, drawBars, drawStats } from "../player/overlays.js";
import {
  PICK_RADIUS,
  clickOrders,
  extendGesture,
  formationOrders,
  gatherOrders,
  inside,
  isLoop,
  routeOrders,
  stopOrders,
} from "./orders.js";
import { MatchSound } from "./sound.js";

export const TURN_TICKS = 15;
const TICK_MS = 1000 / 30;
// The game's peace offer waits this many ticks before it can be made again.
const PEACE_COOLDOWN = 1800;
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
  texture(name, source) {
    this.sources.set(name, source);
    this.textures.set(name, true);
  }
  fog(polygons) {
    this.draws.push({ type: "fog", polygons });
  }
  drawLocal() {
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
    for (const draw of this.draws) {
      if (draw.type === "text") this.drawText(draw, ox, oy, vw, vh);
      else if (draw.type === "image") {
        const image = this.sources.get(draw.name);
        if (!image) continue;
        const [dx, dy] = draw.direction || [1, 0];
        ctx.save();
        ctx.translate(...draw.position);
        ctx.transform(dx, dy, -dy, dx, 0, 0);
        if (draw.flipY) ctx.scale(1, -1);
        ctx.globalAlpha = draw.alpha ?? 1;
        if (draw.dark) ctx.filter = "brightness(50%)";
        ctx.imageSmoothingEnabled = draw.name !== "map";
        ctx.drawImage(image, -draw.size[0] / 2, -draw.size[1] / 2, ...draw.size);
        ctx.restore();
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
            ctx.lineWidth = (Math.max(draw.width, 1) * mw) / 1920;
            ctx.lineJoin = ctx.lineCap = "round";
            ctx.stroke();
          }
        }
      }
    }
    ctx.restore();
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

  setSide(side) {
    this.side = side;
    this.fogState = null;
    this.request([]);
  }

  /** The match starts `delay` ms from now; its first turn arrives then. */
  start(delay) {
    this.started = true;
    this.startAt = performance.now() + delay;
    this.sound.start();
  }

  addTurn({ turn, commands }) {
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
      const { frames } = await decodeChunk(data.chunk, this.staticRecord);
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
    this.room.send({ type: "command", orders: [...orders].map(([id, points]) => [id, points]) });
    for (const [id, points] of orders) this.inflight.set(id, points);
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
    // The game zooms by 1.2 a notch, between 1 and 3, about the pointer.
    const zoom = Math.max(1, Math.min(3, view.zoom * 1.2 ** steps));
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

  myUnits() {
    return (this.state?.dots || []).filter((dot) => dot.health > 0 && dot.color === this.side);
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
      return;
    }
    if (event.button === 2) {
      // Right-click confirms withheld orders.
      if (this.started) this.confirm();
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
    };
  }

  pointerMove(event) {
    const point = this.canvasPoint(event);
    this.hover = this.toHud(point);
    if (this.panning) {
      this.pan(point[0] - this.panning[0], point[1] - this.panning[1]);
      this.panning = point;
      return;
    }
    if (this.rateDrag) {
      this.ratePreview = rateAt(this.toHud(point));
      return;
    }
    if (!this.gesture) return;
    const world = this.toWorld(point);
    this.gesture.end = world;
    extendGesture(this.gesture.points, world);
  }

  pointerUp(event) {
    if (this.panning) return void (this.panning = null);
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
    const dragged = gesture.points.length > 1;
    if (!dragged) {
      // A click: on a unit it only selects; elsewhere the selection moves there.
      if (gesture.onUnit || !units.length) {
        if (!gesture.onUnit && !gesture.shift) this.selected.clear();
        return;
      }
      return this.give((gesture.withhold || event.altKey ? gatherOrders : clickOrders)(units, gesture.end), withhold);
    }
    const loop = [...gesture.points, gesture.end];
    if (this.selecting(gesture, units)) {
      // A loop selects the units inside it.
      if (!gesture.shift) this.selected.clear();
      for (const dot of this.myUnits()) if (inside(dot.position, loop)) this.selected.add(dot.id);
      return;
    }
    if (!units.length) return;
    if (gesture.formation) return this.give(formationOrders(units, loop), withhold);
    this.give(routeOrders(units, gesture.points), withhold);
  }

  /** Whether a gesture draws a selection loop rather than an order: with nothing
   * selected, with Shift held, or when it closes around units of the side. */
  selecting(gesture, units) {
    if (gesture.onUnit || gesture.points.length < 2) return false;
    if (!units.length || gesture.shift) return true;
    if (gesture.formation) return false;
    const loop = [...gesture.points, gesture.end];
    return isLoop(loop) && this.myUnits().some((dot) => inside(dot.position, loop));
  }

  /** The orders a gesture would give if released now, to draw while it is held. */
  preview(gesture) {
    const units = this.myUnits().filter((dot) => this.selected.has(dot.id));
    if (!units.length || this.selecting(gesture, units)) return null;
    if (gesture.points.length < 2) return gesture.onUnit ? null : (gesture.withhold || this.keys.has("AltLeft") || this.keys.has("AltRight") ? gatherOrders : clickOrders)(units, gesture.end);
    if (gesture.formation) return formationOrders(units, [...gesture.points, gesture.end]);
    return routeOrders(units, [...gesture.points, gesture.end]);
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

  paint(now) {
    this.layout();
    const r = this.renderer,
      state = this.state,
      [mw, mh] = this.mapSize,
      mine = (dot) => this.side === null || dot.color === this.side,
      shows = (dot) => mine(dot) || this.visible(dot.position),
      dots = state.dots.filter((dot) => dot.health > 0 && shows(dot)),
      options = this.options;
    r.begin(this.mapSize);
    r.image("map", [mw / 2, mh / 2], this.mapSize);
    for (const line of frontLines(state.render?.contours || [], state.dots, this.mapSize)) r.line(line);
    for (const city of state.core.capitals || []) if (city.position) r.image("capital", [city.position[0], city.position[1] - 2], [35, 33]);
    for (const dot of (state.core.dead_dots || []).filter(shows)) {
      const alpha = 0.75 - (state.frame - dot.frame) * 0.01;
      if (alpha <= 0) continue;
      const name = dot.ship ? `${colors[dot.color]}_${dot.type === "tank" ? "heavy_ship" : "ship"}` : `${colors[dot.color]}_${dot.type}_15`;
      r.image(name, dot.position, unitSize(dot), alpha);
    }
    const directions = new Map((state.render?.directions || []).map((d) => [d.id, d]));
    for (let pass = 0; pass < 2; pass++)
      for (const dot of dots) {
        const visual = directions.get(dot.id),
          vibration = (pass === 0 ? visual?.first_vibration : visual?.second_vibration) || 0,
          position = [dot.position[0] + (visual?.facing?.[0] || 0) * vibration, dot.position[1] + (visual?.facing?.[1] || 0) * vibration],
          direction = (pass === 0 ? visual?.first_visual : visual?.visual) || visual?.visual || [1, 0];
        r.image(unitSprite(dot), position, unitSize(dot), 1, direction, false, true);
        if (this.selected.has(dot.id)) r.draws.at(-1).dark = true;
      }
    if (options.orders)
      for (const dot of dots) {
        if (!mine(dot) || !dot.path?.length || this.inflight.has(dot.id)) continue;
        arrow(r, [dot.position, ...dot.path], [0, 0, 0, 0.5], 5);
      }
    for (const dot of dots) if (mine(dot)) drawBars(r, dot, options);
    if (this.fogState && this.side !== null && !this.ended) r.fog(this.fogState.outlines);
    if (options.flags)
      for (const city of state.core.cities || []) r.image(`${colors[city.color]}_flag`, [city.position[0] + 9, city.position[1] - 13], [21, 27]);
    if (options.icons)
      for (const dot of dots) {
        const icon = mine(dot) && iconFor(dot);
        if (icon) r.image(icon[0], [dot.position[0] + 20, dot.position[1] - 10], icon[1]);
      }
    if (this.production && this.side !== null && !this.ended) {
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
    // Orders: given ones look like the units' own routes; withheld ones and the
    // order being drawn are solid black.
    const routeOf = (id, points) => {
      const dot = state.dots.find((d) => d.id === id);
      return dot && dot.health > 0 && points.length > 1 ? [dot.position, ...points.slice(1)] : null;
    };
    if (options.orders)
      for (const [id, points] of this.inflight) {
        const route = routeOf(id, points);
        if (route) arrow(r, route, [0, 0, 0, 0.5], 5);
      }
    for (const [id, points] of this.staged) {
      const route = routeOf(id, points);
      if (route) arrow(r, route, [0, 0, 0, 1], 3);
    }
    if (this.gesture) {
      const orders = this.preview(this.gesture);
      if (orders)
        for (const [id, points] of orders) {
          const route = routeOf(id, points);
          if (route) arrow(r, route, [0, 0, 0, 1], 3);
        }
      else if (this.gesture.points.length > 1) r.line([...this.gesture.points, this.gesture.end], [0, 0, 0, 0.5], 5, 2);
    }
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
function arrow(renderer, path, color, width, head = true) {
  if (path.length < 2) return;
  renderer.line(path, color, width, 1);
  if (!head) return;
  const end = path.at(-1),
    previous = path.at(-2),
    dx = previous[0] - end[0],
    dy = previous[1] - end[1],
    length = Math.sqrt(dx * dx + dy * dy) + 0.01,
    ux = dx / length,
    uy = dy / length;
  for (const side of [-1, 1])
    renderer.line([end, [end[0] + 9 * ux - side * 6 * uy, end[1] + 9 * uy + side * 6 * ux], [end[0] + 12 * ux - side * 12 * uy, end[1] + 12 * uy + side * 12 * ux]], color, width, 2);
}
