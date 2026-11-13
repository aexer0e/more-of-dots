// Units and their bars on the canvas, fast enough for the big maps' thousands of units.
// Each sprite is drawn once at its size on screen and turned to one of a fixed set of
// angles, into a small canvas of its own; every unit is then a single unscaled,
// untransformed drawImage at a whole pixel, which is what the canvas does fastest.
// Bars are drawn the same way, one small canvas for each look.

const FLOATS = 11; // an entry: x, y, width, height, direction x, y, kind, a, b, c, alpha
const BARS = -2; // kind of an entry that is a unit's bars
const NEW_A_FRAME = 200; // sprites drawn into the cache a frame; the rest are drawn directly

/** A frame's sprites and bars, kept between frames to avoid new objects. */
export class SpriteBatch {
  constructor() {
    this.data = new Float32Array(FLOATS * 4096);
    this.n = 0;
  }
  clear() {
    this.n = 0;
  }
  push(x, y, width, height, dx, dy, kind, a, b, c, alpha) {
    if ((this.n + 1) * FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data,
      i = this.n++ * FLOATS;
    d[i] = x;
    d[i + 1] = y;
    d[i + 2] = width;
    d[i + 3] = height;
    d[i + 4] = dx;
    d[i + 5] = dy;
    d[i + 6] = kind;
    d[i + 7] = a;
    d[i + 8] = b;
    d[i + 9] = c;
    d[i + 10] = alpha;
  }
  /** A sprite as the canvas draws it: `sprite` an index into the cache's names, centred
   * on x, y, turned to `direction`, upside down with `flipY`, at half brightness with
   * `dark`, and drawn `times` times over (the game draws a unit twice). */
  sprite(sprite, x, y, width, height, direction, flipY, alpha, dark, times = 1) {
    if (sprite < 0) return;
    this.push(x, y, width, height, direction[0], direction[1], sprite, flipY ? 1 : 0, dark ? 1 : 0, times, alpha);
  }
  /** A unit's bars (see barRects in overlays.js) centred on the unit at x, y. */
  bars(x, y, health, morale, options) {
    this.push(x, y, health, morale, options.health ? 1 : 0, options.morale ? 1 : 0, BARS, 0, 0, 0, 1);
  }
}

export class SpriteCache {
  constructor(names, barRects) {
    this.names = names;
    this.index = new Map(names.map((name, i) => [name, i]));
    this.barRects = barRects;
    this.cached = new Map();
    this.scale = 0;
  }

  /** The index of a sprite name, or -1. */
  sprite(name) {
    return this.index.get(name) ?? -1;
  }

  /** Draws `batch` on `ctx` (whose transform is the identity) where a map point x, y is
   * at x * sx + tx, y * sy + ty. `source(index, dark)` gives a sprite's image. */
  draw(ctx, batch, source, sx, sy, tx, ty) {
    if (sx !== this.scale) {
      // A new zoom: every sprite is drawn again at its new size.
      this.cached.clear();
      this.scale = sx;
    }
    this.fresh = 0;
    const d = batch.data;
    let alpha = 1;
    ctx.globalAlpha = 1;
    for (let i = 0, end = batch.n * FLOATS; i < end; i += FLOATS) {
      if (d[i + 10] !== alpha) ctx.globalAlpha = alpha = d[i + 10];
      const x = d[i] * sx + tx,
        y = d[i + 1] * sy + ty,
        image = d[i + 6] === BARS ? this.barsImage(d, i, sx) : this.spriteImage(d, i, sx, source);
      if (image) ctx.drawImage(image, Math.round(x - image.middle), Math.round(y - image.top));
      else this.direct(ctx, d, i, source, sx, sy, x, y);
    }
    ctx.globalAlpha = 1;
  }

  /** A sprite's cached image, drawn now if this frame still has room for new ones. */
  spriteImage(d, i, scale, source) {
    const width = d[i + 2] * scale,
      height = d[i + 3] * scale,
      size = Math.max(width, height),
      // Finer angles for sprites large enough to show them.
      steps = size < 12 ? 32 : size < 32 ? 64 : 128,
      angle = Math.round((Math.atan2(d[i + 5], d[i + 4]) / (2 * Math.PI)) * steps) % steps,
      key = `${d[i + 6]},${Math.round(width * 4)},${Math.round(height * 4)},${angle < 0 ? angle + steps : angle},${d[i + 7]},${d[i + 8]},${d[i + 9]}`;
    let image = this.cached.get(key);
    if (image) return image;
    if (this.fresh >= NEW_A_FRAME) return null;
    const picture = source(d[i + 6], d[i + 8] === 1);
    if (!picture) return null;
    this.fresh++;
    const turn = (angle / steps) * 2 * Math.PI,
      dx = Math.cos(turn),
      dy = Math.sin(turn),
      side = Math.ceil(Math.hypot(width, height)) + 2;
    image = new OffscreenCanvas(side, side);
    const context = image.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.setTransform(dx, dy, -dy * (d[i + 7] ? -1 : 1), dx * (d[i + 7] ? -1 : 1), side / 2, side / 2);
    for (let k = 0; k < d[i + 9]; k++) context.drawImage(picture, -width / 2, -height / 2, width, height);
    image.middle = image.top = side / 2;
    this.cached.set(key, image);
    return image;
  }

  /** A sprite drawn straight onto the canvas, for the frame's sprites past NEW_A_FRAME. */
  direct(ctx, d, i, source, sx, sy, x, y) {
    if (d[i + 6] === BARS) return;
    const picture = source(d[i + 6], d[i + 8] === 1);
    if (!picture) return;
    const dx = d[i + 4],
      dy = d[i + 5],
      flip = d[i + 7] ? -1 : 1,
      width = d[i + 2],
      height = d[i + 3];
    ctx.setTransform(sx * dx, sy * dy, -sx * dy * flip, sy * dx * flip, x, y);
    for (let k = 0; k < d[i + 9]; k++) ctx.drawImage(picture, -width / 2, -height / 2, width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** A unit's bars, cached by how they look at this size on screen. */
  barsImage(d, i, scale) {
    const health = d[i + 2],
      morale = d[i + 3],
      options = { health: d[i + 4] === 1, morale: d[i + 5] === 1 },
      // Fills to a quarter of a pixel on screen.
      key = `b${Math.round(24 * health * scale * 4)},${Math.round(((24 * Math.max(0, morale)) / 100) * scale * 4)},${health > 0.5 ? 0 : health > 0.15 ? 1 : 2},${d[i + 4]},${d[i + 5]}`;
    let image = this.cached.get(key);
    if (image) return image;
    // The bars span x from -14.4 to 14.4 and y from -22.8 to -10.8 around the unit.
    const left = Math.ceil(15 * scale) + 1,
      top = 24 * scale + 1;
    image = new OffscreenCanvas(2 * left, Math.ceil(14 * scale) + 2);
    const context = image.getContext("2d");
    context.setTransform(scale, 0, 0, scale, left, top);
    this.barRects({ position: [0, 0], health, max_health: 1, morale }, options, (x1, y1, x2, y2, [r, g, b, a]) => {
      context.fillStyle = `rgba(${r * 255},${g * 255},${b * 255},${a})`;
      context.fillRect(x1, y1, x2 - x1, y2 - y1);
    });
    image.middle = left;
    image.top = top;
    this.cached.set(key, image);
    return image;
  }
}
