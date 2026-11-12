// A small drawing of a map for cards: its terrain, bridges, cities, capitals and
// starting units, with the replay player's sprites. Positions are the game's, so
// a 960 x 540 terrain covers 1600 x 900 (engine/replay-sim/src/replay.rs).
import { shockIndexes } from './preview';
import type { MapData } from './types';

export interface MapPreview {
  data: MapData;
  width: number;
  height: number;
  /** The match mode the replay was played in; experiment shows shock units. */
  mode?: string;
}

const COLORS = ['blue', 'red', 'purple', 'orange'];
const sprites = new Map<string, Promise<HTMLImageElement | null>>();

function sprite(base: string, name: string) {
  if (!sprites.has(name))
    sprites.set(name, new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = `${base}player-assets/${name}.png`;
    }));
  return sprites.get(name)!;
}

function terrain(base64: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The map image could not be read.'));
    image.src = `data:image/png;base64,${base64}`;
  });
}

export async function drawMapPreview(canvas: HTMLCanvasElement, preview: MapPreview, base: string) {
  const { data, width } = preview;
  const world = width === 960 ? [1600, 900] : [1920, 1080];
  const context = canvas.getContext('2d');
  if (!context) return;
  const scale = canvas.width / world[0];
  const at = ([x, y]: number[]) => [x * scale, y * scale];
  // Sprites keep a readable size on a small card.
  const size = (units: number, least: number) => Math.max(units * scale, least);

  context.imageSmoothingEnabled = false;
  context.drawImage(await terrain(data.map_surface), 0, 0, canvas.width, canvas.height);

  context.fillStyle = 'rgb(100,60,10)';
  for (const [a, b] of data.bridges) {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (!length) continue;
    const ox = (-dy * 7.5) / length, oy = (dx * 7.5) / length;
    context.beginPath();
    [[a[0] + ox, a[1] + oy], [a[0] - ox, a[1] - oy], [b[0] - ox, b[1] - oy], [b[0] + ox, b[1] + oy]].forEach((p, i) => {
      const [x, y] = at(p);
      if (i) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.closePath();
    context.fill();
  }

  context.fillStyle = '#ffff00';
  for (const city of data.cities) {
    const [x, y] = at(city);
    context.beginPath();
    context.arc(x, y, size(9, 2.5), 0, Math.PI * 2);
    context.fill();
  }

  context.imageSmoothingEnabled = true;
  const experiment = preview.mode === 'experiment';
  const units: Array<[string, number[], number]> = [];
  data.infantry.forEach((team, side) => {
    const shocks = experiment ? shockIndexes(team.length) : new Set<number>();
    team.forEach((point, i) => units.push([`${COLORS[side]}_${shocks.has(i) ? 'motorised' : 'infantry'}_100`, point, 24]));
    data.tanks[side]?.forEach((point) => units.push([`${COLORS[side]}_tank_100`, point, 24]));
  });
  for (const [name, point, units_] of units) {
    const image = await sprite(base, name);
    if (!image) continue;
    const [x, y] = at(point), s = size(units_, 6);
    context.drawImage(image, x - s / 2, y - s / 2, s, s);
  }
  const capital = await sprite(base, 'capital');
  if (capital)
    for (const index of data.capitals) {
      const city = data.cities[index];
      if (!city) continue;
      const [x, y] = at(city), w = size(35, 10), h = (w * 33) / 35;
      context.drawImage(capital, x - w / 2, y - h / 2, w, h);
    }
}
