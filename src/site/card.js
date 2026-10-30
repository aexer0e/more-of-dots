// The picture a shared replay's link preview shows, drawn in the sharer's browser
// in the layout of the tournament cards the build draws (scripts/og-cards.mjs).
import { troopCurves } from "../replays/troop-lines";

const WIDTH = 1200,
  HEIGHT = 630,
  PAD_X = 52,
  PAD_Y = 44;
const BLUE = "#8cc0ee",
  RED = "#ff8a8a",
  MUTED = "#c4cdc8",
  TEXT = "#eef4f0";
const SIDE_COLORS = [BLUE, RED, "#c084fc", "#ffa25c"];

let fonts;
// The card's font is published beside the site (og/Inter-*.ttf).
const loadFonts = (base) =>
  (fonts ??= Promise.all(
    ["500", "700"].map(async (weight) => document.fonts.add(await new FontFace("Inter Card", `url(${base}og/Inter-${weight}.ttf)`, { weight }).load())),
  ));
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
const font = (weight, size) => `${weight} ${size}px "Inter Card", ui-sans-serif, system-ui, sans-serif`;
const clock = (frames) => {
  const s = Math.floor(frames / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/// A JPEG of the card: the replay's map, each side's troops, its players and its length and version.
export async function drawCard({ players, frames, version, picture, troops }, base) {
  await loadFonts(base).catch(() => {});
  const canvas = Object.assign(document.createElement("canvas"), { width: WIDTH, height: HEIGHT });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0e1110";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const map = picture ? await loadImage(picture).catch(() => null) : null;
  if (map) {
    const scale = Math.max(WIDTH / map.naturalWidth, HEIGHT / map.naturalHeight);
    const w = map.naturalWidth * scale,
      h = map.naturalHeight * scale;
    ctx.drawImage(map, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
  }
  ctx.fillStyle = "rgba(8,10,9,0.55)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 4;
  ctx.lineJoin = ctx.lineCap = "round";
  troopCurves(troops ?? [], WIDTH, HEIGHT).forEach((path, side) => {
    if (!path) return;
    ctx.strokeStyle = SIDE_COLORS[side];
    ctx.stroke(new Path2D(path));
  });
  ctx.globalAlpha = 1;

  // Site name, top left.
  const middle = PAD_Y + 15;
  ctx.fillStyle = "#5a92c4";
  ctx.beginPath();
  ctx.arc(PAD_X + 15, middle, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e0a458";
  ctx.beginPath();
  ctx.arc(PAD_X + 52, middle, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MUTED;
  ctx.font = font(500, 30);
  ctx.textBaseline = "middle";
  ctx.fillText("War of Dots Replays", PAD_X + 88, middle + 1);

  // Details as chips along the bottom, the first one highlighted.
  const chips = [clock(frames), version ? `v${version}` : null].filter(Boolean);
  const chipHeight = 52,
    chipTop = HEIGHT - PAD_Y - chipHeight;
  let x = PAD_X;
  ctx.font = font(500, 30);
  chips.forEach((text, i) => {
    const width = ctx.measureText(text).width + 40;
    ctx.fillStyle = i === 0 ? "rgba(90,146,196,0.45)" : "rgba(9,11,10,0.82)";
    roundRect(ctx, x, chipTop, width, chipHeight, 14);
    ctx.fillStyle = TEXT;
    ctx.fillText(text, x + 20, chipTop + chipHeight / 2 + 1);
    x += width + 14;
  });

  // Players above them, each in their side's colour, shrunk to fit one line.
  const names = players.length ? players : ["Unknown", "Unknown"];
  const parts = names.flatMap((name, i) => (i ? [["vs", MUTED, 500], [name, [BLUE, RED][i] ?? TEXT, 700]] : [[name, BLUE, 700]]));
  let size = 78;
  const lineWidth = () => {
    let total = 0;
    for (const [text, , weight] of parts) {
      ctx.font = font(weight, size);
      total += ctx.measureText(text).width;
    }
    return total + size * 0.28 * (parts.length - 1);
  };
  while (lineWidth() > WIDTH - PAD_X * 2 && size > 36) size -= 2;
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  x = PAD_X;
  const baseline = chipTop - 28 - size * 0.22;
  for (const [text, color, weight] of parts) {
    ctx.font = font(weight, size);
    ctx.fillStyle = color;
    ctx.fillText(text, x, baseline);
    x += ctx.measureText(text).width + size * 0.28;
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The card could not be drawn."))), "image/jpeg", 0.85));
}
