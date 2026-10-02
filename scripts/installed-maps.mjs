import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mapFolders = ['fahero_maps', 'zolamare_maps', 'eronion_maps'];

export async function readInstalledMaps(game) {
  const paths = new Map();
  const root = await fs.realpath(game).catch(() => null);
  if (root) {
    for (const folder of mapFolders) {
      const directory = path.join(root, 'assets', folder);
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!/\.png$/i.test(entry.name)) continue;
        const resolved = await fs.realpath(path.join(directory, entry.name)).catch(() => null);
        if (!resolved || !resolved.startsWith(root + path.sep)) continue;
        if (!(await fs.stat(resolved)).isFile()) continue;
        paths.set(`assets/${folder}/${entry.name}`, resolved);
      }
    }
  }
  let hashes;
  const vanillaId = async (raw) => {
      const surface = raw.custom_map?.map_surface ?? raw.map?.map_surface;
      if (typeof surface === 'string' && surface.trim()) {
        hashes ??= Promise.all([...paths].sort(([a], [b]) => a.localeCompare(b)).map(async ([id, file]) => {
          const bytes = await fs.readFile(file).catch(() => null);
          return bytes ? [hash(bytes), id] : null;
        })).then((values) => {
          const result = new Map();
          for (const entry of values.filter(Boolean)) if (!result.has(entry[0])) result.set(...entry);
          return result;
        });
        const payload = surface.trim().replace(/^data:image\/png;base64,/, '');
        return (await hashes).get(hash(Buffer.from(payload, 'base64'))) ?? null;
      }
      const id = String(raw.map?.path ?? raw.map ?? '').trim().replaceAll('\\', '/');
      if (/^\d+$/.test(id)) return mapFolders.map(folder => `assets/${folder}/map${id}.png`).find(id => paths.has(id)) ?? `legacy:${id}`;
      return paths.has(id) ? id : null;
  };
  return {
    async isVanilla(raw) { return (await vanillaId(raw)) !== null; },
    async identity(raw) {
      const id = await vanillaId(raw);
      if (id) {
        const parts = id.split('/');
        const family = parts[1]?.replace(/_maps$/, '');
        const label = id.startsWith('legacy:') ? `Map ${id.slice(7)}`
          : `${family[0].toUpperCase()}${family.slice(1)} ${parts[2].replace(/^map|\.png$/g, '')}`;
        return { mapKey: `vanilla:${id}`, mapLabel: label };
      }
      const surface = raw.custom_map?.map_surface ?? raw.map?.map_surface;
      const mapPath = raw.map?.path ?? (typeof raw.map === 'string' || typeof raw.map === 'number' ? String(raw.map) : null);
      if (!surface && (!mapPath || mapPath === 'custom')) return { mapKey: null, mapLabel: null };
      const digest = hash(surface ? Buffer.from(surface.trim().replace(/^data:image\/png;base64,/, ''), 'base64') : mapPath.replaceAll('\\', '/'));
      return { mapKey: `custom:${digest}`, mapLabel: `#${digest.slice(0, 10)}` };
    },
  };
}
