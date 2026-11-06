// Decodes an ownership snapshot and paints it over the terrain, off the UI thread.
// Bit or byte value 1 is Red and 0 is Blue, matching the capture worker and the website.

type Job = { id: number; encoding: string; width: number; height: number; bytes: ArrayBuffer; terrainUrl: string; maskUrl: string };

const RED = [196, 92, 92];
const BLUE = [86, 128, 200];
const FRONT = [248, 236, 214];

let terrain: Promise<Uint8Array | null> | null = null;
let mask: Promise<Uint8Array> | null = null;

async function inflate(data: ArrayBuffer | Response): Promise<Uint8Array> {
  const body = data instanceof Response ? data.body! : new Response(data).body!;
  return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
}

/** Terrain brightness per pixel, 0-255. Without OffscreenCanvas the map is drawn flat. */
function loadTerrain(url: string, width: number, height: number) {
  return terrain ??= (async () => {
    try {
      if (typeof OffscreenCanvas === 'undefined') return null;
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      const rgba = context.getImageData(0, 0, width, height).data;
      const lum = new Uint8Array(width * height);
      for (let pixel = 0; pixel < lum.length; pixel++) {
        const offset = pixel * 4;
        lum[pixel] = (rgba[offset] * 77 + rgba[offset + 1] * 151 + rgba[offset + 2] * 28) >> 8;
      }
      return lum;
    } catch {
      return null;
    }
  })();
}

function loadMask(url: string) {
  return mask ??= fetch(url).then((response) => {
    if (!response.ok) throw new Error('The playable-area mask is missing.');
    return inflate(response);
  });
}

/** Owner per pixel: 0 for water and other unplayable space, 1 Red, 2 Blue. */
async function owners(job: Job): Promise<Uint8Array> {
  const total = job.width * job.height;
  const raw = await inflate(job.bytes);
  const result = new Uint8Array(total);
  if (job.encoding === 'raw-u8-zlib-v1') {
    if (raw.length !== total) throw new Error('The map has unexpected dimensions.');
    for (let pixel = 0; pixel < total; pixel++) result[pixel] = raw[pixel] === 1 ? 1 : raw[pixel] === 0 ? 2 : 0;
    return result;
  }
  if (job.encoding !== 'playable-bitset-zlib-v1') throw new Error(`Unsupported map format: ${job.encoding}`);
  const playable = await loadMask(job.maskUrl);
  let index = 0;
  for (let pixel = 0; pixel < total; pixel++) {
    if (!((playable[pixel >> 3] >> (pixel & 7)) & 1)) continue;
    result[pixel] = ((raw[index >> 3] >> (index & 7)) & 1) ? 1 : 2;
    index++;
  }
  return result;
}

async function paint(job: Job): Promise<Uint8ClampedArray> {
  const { width, height } = job;
  const [owner, lum] = await Promise.all([owners(job), loadTerrain(job.terrainUrl, width, height)]);
  const total = width * height;
  // Fronts: land pixels next to the other faction, widened to stay visible when scaled down.
  const edge = new Uint8Array(total);
  for (let pixel = 0; pixel < total; pixel++) {
    const own = owner[pixel];
    if (!own) continue;
    const x = pixel % width;
    const right = x + 1 < width ? owner[pixel + 1] : 0;
    const down = pixel + width < total ? owner[pixel + width] : 0;
    if ((right && right !== own) || (down && down !== own)) edge[pixel] = 1;
  }
  const rgba = new Uint8ClampedArray(total * 4);
  for (let pixel = 0; pixel < total; pixel++) {
    const offset = pixel * 4;
    const light = lum ? lum[pixel] / 255 : 0.5;
    const own = owner[pixel];
    rgba[offset + 3] = 255;
    if (!own) {
      const shade = 0.1 + 0.1 * light;
      rgba[offset] = 14 + 40 * shade; rgba[offset + 1] = 20 + 50 * shade; rgba[offset + 2] = 26 + 60 * shade;
      continue;
    }
    const x = pixel % width;
    const nearFront = edge[pixel]
      || (x > 0 && edge[pixel - 1]) || (x + 1 < width && edge[pixel + 1])
      || (pixel >= width && edge[pixel - width]) || (pixel + width < total && edge[pixel + width]);
    if (nearFront) {
      rgba[offset] = FRONT[0]; rgba[offset + 1] = FRONT[1]; rgba[offset + 2] = FRONT[2];
      continue;
    }
    const color = own === 1 ? RED : BLUE;
    const factor = 0.6 + 0.45 * light;
    rgba[offset] = color[0] * factor; rgba[offset + 1] = color[1] * factor; rgba[offset + 2] = color[2] * factor;
  }
  return rgba;
}

self.onmessage = async (event: MessageEvent<Job>) => {
  const job = event.data;
  try {
    const rgba = await paint(job);
    (self as unknown as Worker).postMessage({ id: job.id, rgba: rgba.buffer }, [rgba.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id: job.id, error: (error as Error).message || 'The map could not be decoded.' });
  }
};
