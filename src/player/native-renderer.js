import { invoke } from "./worker-ipc.js";

// Drawing commands come exclusively from the independently simulated replay.
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.textures = new Map();
    this.textureData = new Map();
    this.sources = new Map();
    this.uploads = [];
    this.sequence = 0;
    this.pending = Promise.resolve();
  }
  texture(name, source) {
    this.sources.set(name, source);
    const encoded =
      source instanceof OffscreenCanvas
        ? source
            .convertToBlob({ type: "image/png" })
            .then((blob) => new FileReaderSync().readAsDataURL(blob))
        : Promise.resolve(source.png);
    this.uploads.push(
      encoded.then((data) => {
        const texture = { kind: "texture", name, png: data.split(",")[1] };
        this.textureData.set(name, texture);
        return texture;
      }),
    );
    this.textures.set(name, true);
  }
  // Replay-specific images change between replays; shared artwork stays decoded.
  forget(names) {
    for (const name of names) {
      this.sources.get(name)?.close?.();
      this.sources.delete(name);
      this.textures.delete(name);
      this.textureData.delete(name);
    }
    // Opening a replay restarts the native renderer, which needs every texture again.
    this.nativeUploaded = false;
  }
  begin(mapSize) {
    this.mapSize = mapSize;
    this.draws = [];
  }
  image(
    name,
    position,
    size,
    alpha = 1,
    direction = [1, 0],
    screen = false,
    flipY = false,
  ) {
    if (this.textures.has(name))
      this.draws.push({
        type: "image",
        name,
        position,
        size,
        alpha,
        direction,
        screen,
        flipY,
      });
  }
  polygon(points, color) {
    this.draws.push({ type: "polygon", points, color });
  }
  circle(position, radius, color) {
    this.draws.push({ type: "circle", position, radius, color });
  }
  text(
    name,
    text,
    position,
    color,
    fix = "left",
    fontSize = 60,
    outline = 1.5,
  ) {
    this.draws.push({
      type: "text",
      name,
      text,
      position,
      color,
      fix,
      fontSize,
      outline,
    });
  }
  line(points, color = [0, 0, 0, 1], width = 8, smooth = 1) {
    if (points.length < 2) return;
    for (let pass = 0; pass < smooth; pass++) {
      const refined = [points[0].map(Math.fround)];
      const blend = (a, b, weight) =>
        pass === 0
          ? Math.fround(a * weight + b * (1 - weight))
          : Math.fround(
              Math.fround(a * weight) + Math.fround(b * (1 - weight)),
            );
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i],
          b = points[i + 1];
        refined.push(
          [blend(a[0], b[0], 0.75), blend(a[1], b[1], 0.75)],
          [blend(a[0], b[0], 0.25), blend(a[1], b[1], 0.25)],
        );
      }
      refined.push(points.at(-1).map(Math.fround));
      points = refined;
    }
    this.draws.push({ type: "line", points, color, width });
  }
  async finish() {
    const sequence = ++this.sequence;
    const uploads = this.uploads.splice(0),
      request = {
        kind: "render",
        width: this.canvas.width,
        height: this.canvas.height,
        mapSize: this.mapSize,
        draws: this.draws,
      };
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        await Promise.all(uploads);
        request.textures = this.nativeUploaded
          ? []
          : [...this.textureData.values()];
        this.lastRequest = {
          ...request,
          textures: [...this.textureData.values()],
        };
        const started = performance.now();
        const pixels = await invoke("render_frame", { request });
        this.nativeUploaded = true;
        this.renderMs = performance.now() - started;
        if (sequence !== this.sequence) return;
        const rgb = new Uint8Array(pixels);
        if (rgb.length !== request.width * request.height * 3)
          throw new Error("Incomplete replay image.");
        if (
          !this.imageData ||
          this.imageData.width !== request.width ||
          this.imageData.height !== request.height
        )
          this.imageData = new ImageData(request.width, request.height);
        const rgba = this.imageData.data;
        for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 4) {
          rgba[dst] = rgb[src];
          rgba[dst + 1] = rgb[src + 1];
          rgba[dst + 2] = rgb[src + 2];
          rgba[dst + 3] = 255;
        }
        this.context.putImageData(this.imageData, 0, 0);
      });
    return this.pending;
  }
}
