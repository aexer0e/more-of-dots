import { Renderer as NativeRenderer } from "./native-renderer.js";
import { zoomView } from "./view.js";

// Playback reuses decoded sprites in a worker-owned canvas. The maintained native
// renderer remains the source of recording frames and reference snapshots.
export class Renderer extends NativeRenderer {
  constructor(canvas) {
    super(canvas);
    this.view = { zoom: 1, x: 0, y: 0 };
  }
  zoomAt(x, y, factor) {
    if (!this.mapSize) return;
    const [mw, mh] = this.mapSize;
    const scale = Math.min(this.canvas.width / mw, this.canvas.height / mh);
    const vw = mw * scale, vh = mh * scale;
    const anchor = [
      (x * this.canvas.width - (this.canvas.width - vw) / 2) / vw,
      (y * this.canvas.height - (this.canvas.height - vh) / 2) / vh,
    ].map(value => Math.max(0, Math.min(1, value)));
    this.view = zoomView(this.view, anchor, factor);
  }
  drawText(draw, ox, oy, vw, vh) {
    const ctx = this.context;
    ctx.save();
    // Rasterize glyphs directly at the output resolution. HUD text stays fixed
    // in the fitted viewport while the map zooms beneath it.
    ctx.setTransform(vw / 1920, 0, 0, vh / 1080, ox, oy);
    ctx.font = `${draw.fontSize}px "Arial Narrow", Arial, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = draw.fix === "right" ? "right" : draw.fix === "left" ? "left" : "center";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = draw.outline * 2;
    ctx.fillStyle = `rgb(${draw.color.slice(0, 3).join(",")})`;
    ctx.strokeText(draw.text, draw.position[0] * 1920, (1 - draw.position[1]) * 1080);
    ctx.fillText(draw.text, draw.position[0] * 1920, (1 - draw.position[1]) * 1080);
    ctx.restore();
  }
  drawLocal() {
    const ctx = this.context,
      [mw, mh] = this.mapSize;
    const width = this.canvas.width,
      height = this.canvas.height;
    const scale = Math.min(width / mw, height / mh);
    const vw = Math.trunc(mw * scale),
      vh = Math.trunc(mh * scale);
    const ox = Math.trunc((width - vw) / 2),
      oy = Math.trunc((height - vh) / 2);
    ctx.resetTransform();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, vw, vh);
    ctx.clip();
    const { zoom, x, y } = this.view;
    ctx.setTransform(vw / mw * zoom, 0, 0, vh / mh * zoom, ox + x * vw, oy + y * vh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    for (const draw of this.draws) {
      if (draw.type === "text") {
        this.drawText(draw, ox, oy, vw, vh);
      } else if (draw.type === "image") {
        let image,
          position = [...draw.position],
          size;
        image = this.sources.get(draw.name);
        size = draw.size;
        if (!image) continue;
        const [dx, dy] = draw.direction || [1, 0];
        ctx.save();
        if (draw.screen) ctx.resetTransform();
        ctx.translate(...position);
        ctx.transform(dx, dy, -dy, dx, 0, 0);
        if (draw.flipY) ctx.scale(1, -1);
        ctx.globalAlpha = draw.alpha ?? 1;
        ctx.drawImage(image, -size[0] / 2, -size[1] / 2, ...size);
        ctx.restore();
      } else {
        const [r, g, b, a] = draw.color;
        ctx.fillStyle =
          ctx.strokeStyle = `rgba(${r * 255},${g * 255},${b * 255},${a})`;
        ctx.beginPath();
        if (draw.type === "circle") {
          ctx.arc(...draw.position, draw.radius, 0, Math.PI * 2);
          ctx.fill();
        } else {
          draw.points.forEach((point, index) =>
            index ? ctx.lineTo(...point) : ctx.moveTo(...point),
          );
          if (draw.type === "polygon") {
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.lineWidth = Math.max(draw.width, 1) / scale;
            ctx.lineJoin = "round";
            ctx.stroke();
          }
        }
      }
    }
    ctx.restore();
  }
  async finish() {
    if (this.recording) return super.finish();
    const started = performance.now();
    this.lastRequest = {
      kind: "render",
      width: this.canvas.width,
      height: this.canvas.height,
      mapSize: this.mapSize,
      draws: this.draws,
      record: false,
      present: true,
    };
    this.drawLocal();
    this.renderMs = performance.now() - started;
  }
  async referenceSnapshot() {
    await this.pending;
    const draws = this.draws;
    const canvas = this.canvas,
      context = this.context;
    const surface = new OffscreenCanvas(canvas.width, canvas.height);
    this.canvas = surface;
    this.context = surface.getContext("2d", { alpha: false });
    try {
      this.draws = draws;
      await super.finish();
      return new FileReaderSync().readAsDataURL(
        await surface.convertToBlob({ type: "image/png" }),
      );
    } finally {
      this.canvas = canvas;
      this.context = context;
    }
  }
}
