// A test match on the map being edited: the play page's battlefield and controls
// (src/play/game.js) on a canvas over the map, simulated by the WebAssembly
// engine from the map's first frame. Every team's units take orders; the selected
// team's economy is shown. Production, surrender, peace and chat are not part of a
// test match, and there is no fog of war.
import { Game } from "../../play/game.js";
import { prepareMap } from "../../player/map.js";

const COLORS = ["blue", "red", "purple", "orange"];
const NAMES = ["Blue", "Red", "Purple", "Orange"];

const artwork = () => {
  const names = ["capital", "ship_icon", "water_icon", "city_icon", "healing_icon", "forest_icon"];
  for (const color of COLORS) {
    names.push(`${color}_flag`, `${color}_ship`, `${color}_heavy_ship`);
    for (const type of ["infantry", "tank", "motorised"]) for (const health of [100, 50, 15]) names.push(`${color}_${type}_${health}`);
  }
  return names;
};

function image(src) {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`Cannot load ${src}`));
    element.src = src;
  });
}

/** Stands in for the match room: the orders given since the last turn become the
 * next turn, one command for each team whose units were ordered. */
class LocalRoom {
  constructor(game) {
    this.game = game;
    this.pending = new Map();
  }
  send(message) {
    if (message.type !== "command" || !message.orders) return;
    for (const [id, points] of message.orders) {
      this.pending.delete(id);
      this.pending.set(id, points);
    }
  }
  need(turn) {
    const teams = new Map((this.game.state?.dots || []).map((dot) => [dot.id, dot.color]));
    const bySide = new Map();
    for (const [id, points] of this.pending) {
      const side = teams.get(id) ?? this.game.side;
      if (!bySide.has(side)) bySide.set(side, []);
      bySide.get(side).push([id, points]);
    }
    const commands = [...bySide].map(([side, orders]) => ({ side, orders }));
    this.pending = new Map();
    this.game.addTurn({ turn, commands });
  }
  close() {}
}

export class TestMatch extends Game {
  constructor({ canvas, base, side, teams, onEnd }) {
    super({ canvas, base, replay: null, frame: 0, side, room: null, names: NAMES.slice(0, teams).map((name) => [name]), onEnd });
    this.room = new LocalRoom(this);
    this.sound = { start() {}, frame() {}, end() {}, stop() {} };
    this.active = true;
  }

  async run(replay) {
    this.worker = new Worker(new URL("./run-worker.js", import.meta.url), { type: "module" });
    const opened = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.kind === "opened") resolve(data);
        else if (data.kind === "error") reject(new Error(data.error));
      };
      this.worker.onerror = (event) => reject(new Error(event.message || "The game engine stopped."));
    });
    this.worker.postMessage({ kind: "open", replay, base: this.base });
    const { staticRecord, info } = await opened;
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.staticRecord = staticRecord;
    this.info = info;
    this.tick = this.queuedTicks = this.startFrame = info.tick;
    this.mapSize = staticRecord.static_core.map_size;
    this.sides = staticRecord.player_labels?.length || 2;
    const surface = await createImageBitmap(await image(`data:image/png;base64,${staticRecord.rendered_map_surface || staticRecord.source_map_surface}`));
    this.renderer.texture("map", prepareMap(surface, this.mapSize, staticRecord.static_core.city_positions, !!staticRecord.rendered_map_surface));
    await Promise.all(artwork().map(async (name) => this.renderer.texture(name, await createImageBitmap(await image(`${this.base}player-assets/${name}.png`)))));
    await new Promise((resolve) => {
      this.firstFrame = resolve;
      this.request([]);
    });
    this.attach();
    let last = performance.now();
    this.clock = setInterval(() => {
      const now = performance.now();
      this.advance(Math.min(now - last, 1000));
      last = now;
    }, 10);
    const loop = (now) => {
      if (!this.active) return;
      if (this.state) this.paint(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.start(0);
  }

  /** No fog of war: every side is shown. */
  request(steps) {
    this.busy = true;
    this.worker.postMessage({ kind: "steps", steps, draw: true });
  }

  /** The team whose economy is shown. Units of every team can still be ordered. */
  setSide(side) {
    this.side = side;
  }

  /** Every team's units can be selected and ordered. */
  myUnits() {
    return (this.state?.dots || []).filter((dot) => dot.health > 0);
  }

  /** Orders reach the simulation for every team, not only the shown one. */
  applyTurn(commands) {
    for (const entry of commands) if (entry.orders) for (const [id] of entry.orders) this.inflight.delete(id);
    return super.applyTurn(commands);
  }

  /** Draws every team as your own (orders and health bars); the economy panel
   * stays on the shown team. */
  paint(now) {
    const side = this.side;
    this.side = null;
    this.hud = (time) => {
      this.side = side;
      Game.prototype.hud.call(this, time);
    };
    try {
      super.paint(now);
    } finally {
      this.side = side;
      delete this.hud;
    }
  }

  canvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [((event.clientX - rect.left) * this.canvas.width) / rect.width, ((event.clientY - rect.top) * this.canvas.height) / rect.height];
  }

  sendProduction() {}
  surrender() {}
  offerPeace() {}
  productionClick(hud) {
    // The production widget shows, but its controls do nothing in a test match.
    return hud[1] >= 810 && (hud[0] <= 470 || hud[0] >= 1450);
  }

  attach() {
    // The game listens on the window; those listeners stop when the match ends.
    const own = globalThis.addEventListener;
    globalThis.addEventListener = (type, listener, options) =>
      own.call(globalThis, type, (event) => { if (this.active) listener(event); }, options);
    try {
      super.attach();
    } finally {
      globalThis.addEventListener = own;
    }
  }

  destroy() {
    this.active = false;
    super.destroy();
  }
}
