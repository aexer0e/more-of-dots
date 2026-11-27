// The stats overlay as graphs of the last two minutes (layer 6). Each graph sits
// in a corner of the 1920 by 1080 HUD: funds top right, troops with units bottom
// right, casualties bottom left. Funds and casualties draw a line per side; funds
// are valued with each side's income beside them. In a two-sided game troops are
// one solid line, blue minus red, around a zero line in the middle, blue where
// blue gains and red where red gains, blending through the turns, with units
// dotted the same way. Every scale
// fits the values inside the window.

const TICKS_PER_SECOND = 30;
export const WINDOW_SECONDS = 120;

/** Each side's stats in a state record. */
function statsOf(state) {
  const core = state.core,
    economy = core.economy?.fields || {},
    sides = core.strength?.length || 2,
    units = new Array(sides).fill(0);
  for (const dot of state.dots || []) if (dot?.health > 0 && dot.color < sides) units[dot.color]++;
  const side = (read) => Array.from({ length: sides }, (_, s) => read(s));
  return {
    tick: state.frame,
    troops: side((s) => core.strength?.[s] || 0),
    cas: side((s) => core.troop_casualties?.[s] || 0),
    funds: side((s) => Math.round(economy.zrtyz?.[s] || 0)),
    // Funds the capital's region gains each funds update; negative while it pays upkeep.
    income: side((s) => Math.round(economy.zasdxz?.[s]?.[0] || 0)),
    units,
  };
}

/** One sample of the stats per second of game time, filled from whichever
 * frames the player decodes. */
export class StatHistory {
  constructor() {
    this.clear();
  }
  clear() {
    this.seconds = new Map();
    // Seconds the replay has no frame for.
    this.absent = new Set();
  }
  record(state) {
    if (!state?.core) return;
    const second = Math.floor(state.frame / TICKS_PER_SECOND),
      kept = this.seconds.get(second);
    if (kept && kept.tick <= state.frame) return;
    this.seconds.set(second, statsOf(state));
  }
  /** The earliest second of the window ending at `tick` with no sample yet, or -1. */
  firstMissing(tick) {
    const last = Math.floor(tick / TICKS_PER_SECOND);
    for (let second = Math.max(0, last - WINDOW_SECONDS); second < last; second++)
      if (!this.seconds.has(second) && !this.absent.has(second)) return second;
    return -1;
  }
  /** Samples in the window ending at `state`, oldest first, ending with `state` itself. */
  window(state) {
    const tick = state.frame,
      last = Math.floor(tick / TICKS_PER_SECOND),
      samples = [];
    for (let second = Math.max(0, last - WINDOW_SECONDS); second < last; second++) {
      const sample = this.seconds.get(second);
      if (sample && sample.tick >= tick - WINDOW_SECONDS * TICKS_PER_SECOND) samples.push(sample);
    }
    samples.push(statsOf(state));
    return samples;
  }
}

const rgb = [
  [0, 0, 255],
  [255, 0, 0],
  [156, 0, 187],
  [255, 140, 57],
];
const GRAY = [200, 200, 200],
  ZERO = [255, 255, 255, 0.8],
  DOTTED = [0, 7],
  DASHED = [8, 7],
  M = 12,
  BW = 230,
  BH = 70,
  TITLE = 32,
  VALUE = 32;
// `top` is the title's row; the box sits under it.
const GRAPHS = [
  { key: "funds", title: "Funds", right: true, top: 10, perSide: true },
  { key: "troops", title: "Troops", right: true, top: 954, second: "units" },
  { key: "cas", title: "Casualties", right: false, top: 954, perSide: true },
];

const count = (value, zero) => (value || zero ? `~${(value * 100).toLocaleString("en-US")}` : "0");
function label(key, sample, side) {
  const value = sample[key][side];
  if (key === "troops") return count(value, true);
  if (key === "cas") return count(value);
  // Funds, then the income each funds update, signed unless it is zero.
  const income = sample.income[side];
  return `${value}  ${income > 0 ? "+" : ""}${income}`;
}

// Pushes labels apart vertically when they would overlap, then back inside [lo, hi].
function spread(ys, gap, lo, hi) {
  const order = ys.map((y, s) => [y, s]).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < order.length; k++)
    if (order[k][0] - order[k - 1][0] < gap) {
      const middle = (order[k][0] + order[k - 1][0]) / 2;
      order[k - 1][0] = middle - gap / 2;
      order[k][0] = middle + gap / 2;
    }
  const shift = Math.max(0, lo - order[0][0]) - Math.max(0, order.at(-1)[0] - hi);
  const out = [];
  for (const [y, s] of order) out[s] = y + shift;
  return out;
}

// A scale around zero in the middle of the box, fitting the largest lead.
function centered(values, box) {
  const reach = Math.max(1, ...values.map(Math.abs)) * 1.15,
    middle = box.y + box.h / 2;
  return (value) => middle - (value / reach) * (box.h / 2);
}

// One scale for every side's values, fitting their range.
function fitted(samples, key, box) {
  let lo = Infinity,
    hi = -Infinity;
  for (const sample of samples)
    for (const value of sample[key]) (lo = Math.min(lo, value)), (hi = Math.max(hi, value));
  const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.02, 1),
    min = Math.max(0, lo - pad),
    max = hi + pad;
  return (value) => box.y + box.h - ((value - min) / (max - min)) * box.h;
}

// A line of [x, value] points colored by its direction: blue where it rises
// (blue gaining), red where it falls (red gaining), blending through the turns.
// Each point takes the change over the seconds around it, so a short wobble only
// tints the line; a flat stretch keeps the color of the last change. Returns the
// color at the end.
const TREND_REACH = 8;
function trendLine(renderer, points, Y, width, outline, dash) {
  const values = points.map((point) => point[1]),
    last = values.length - 1,
    trends = values.map((_, i) => values[Math.min(last, i + TREND_REACH)] - values[Math.max(0, i - TREND_REACH)]),
    moving = trends.filter(Boolean).map(Math.abs),
    typical = moving.length ? moving.reduce((sum, value) => sum + value, 0) / moving.length : 1;
  let blue = null;
  const colors = trends.map((trend) => {
    if (trend) blue = 0.5 + 0.5 * Math.tanh((1.2 * trend) / typical);
    if (blue === null) return GRAY;
    return rgb[1].map((red, c) => Math.round(red + (rgb[0][c] - red) * blue));
  });
  renderer.hudLine(points.map(([x, value]) => [x, Y(value)]), GRAY, width, outline, dash, colors);
  return colors[last];
}

/** Draws the graphs through `renderer.text` and the renderer's HUD shapes, all in
 * 1920 by 1080 HUD pixels. */
export function drawStatGraphs(renderer, state, history) {
  const all = history.window(state),
    sides = all.at(-1).troops.length,
    span = WINDOW_SECONDS * TICKS_PER_SECOND,
    t0 = Math.max(0, state.frame - span);
  const text = (name, value, x, y, color, fix, size) =>
    renderer.text(name, value, [x / 1920, 1 - y / 1080], color, fix, size);
  for (const graph of GRAPHS) {
    const { key, right } = graph,
      box = { x: right ? 1920 - M - BW : M, y: graph.top + 40, w: BW, h: BH },
      fix = right ? "right" : "left",
      // Lines start once armies exist, so the first troops do not spike up from zero.
      samples = key === "cas" || key === "funds" ? all : all.filter((s) => s.troops.some(Boolean)),
      X = (t) => box.x + ((t - t0) / span) * box.w,
      column = right ? box.x - M : box.x + box.w + M,
      { second } = graph,
      value = (end, side) => label(key, end, side) + (second ? `  ${end[second][side]}` : "");
    text(`graph-${key}`, graph.title, right ? box.x + box.w : box.x, graph.top + 18, GRAY, fix, TITLE);
    if (graph.perSide || sides !== 2) {
      // Funds, casualties, and every stat when three or four sides leave no single lead: one
      // line per side, the second stat dotted on its own scale.
      renderer.hudLine([[box.x, box.y + box.h], [box.x + box.w, box.y + box.h]], ZERO, 1.5, 1.5);
      if (!samples.length) continue;
      const Y = fitted(samples, key, box),
        end = samples.at(-1),
        ys = end[key].map(Y);
      if (second) {
        const S = fitted(samples, second, box);
        for (let side = sides - 1; side >= 0; side--) {
          renderer.hudLine(samples.map((s) => [X(s.tick), S(s[second][side])]), rgb[side], 3.5, 1.5, DOTTED);
          renderer.hudDot([X(end.tick), S(end[second][side])], 4, rgb[side]);
        }
      }
      for (let side = sides - 1; side >= 0; side--) {
        renderer.hudLine(samples.map((s) => [X(s.tick), Y(s[key][side])]), rgb[side], 2.5, 1.5);
        renderer.hudDot([X(end.tick), ys[side]], 5, rgb[side]);
      }
      const at = spread(ys, 30, box.y - 4, box.y + box.h + 6);
      for (let side = 0; side < sides; side++) text(`graph-${key}-${side}`, value(end, side), column, at[side], rgb[side], fix, VALUE);
      continue;
    }
    const lead = (sample, stat) => sample[stat][0] - sample[stat][1],
      Y = centered(samples.map((s) => lead(s, key)), box);
    renderer.hudLine([[box.x, Y(0)], [box.x + box.w, Y(0)]], ZERO, 2, 0, DASHED);
    if (samples.length) {
      const end = samples.at(-1);
      if (second) {
        // The second stat: dotted, on its own scale.
        const U = centered(samples.map((s) => lead(s, second)), box);
        trendLine(renderer, samples.map((s) => [X(s.tick), lead(s, second)]), U, 3.5, 1.5, DOTTED);
      }
      const trend = trendLine(renderer, samples.map((s) => [X(s.tick), lead(s, key)]), Y, 2.5, 1.5, null);
      renderer.hudDot([X(end.tick), Y(lead(end, key))], 5, trend);
      // Blue's value above the zero line, red's below, as the line leans.
      text(`graph-${key}-0`, value(end, 0), column, box.y + box.h * 0.25, rgb[0], fix, VALUE);
      text(`graph-${key}-1`, value(end, 1), column, box.y + box.h * 0.75, rgb[1], fix, VALUE);
    }
  }
}
