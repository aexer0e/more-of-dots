import { invoke } from '../../platform';
import { cloneStoredMapRecord, normalizeMapData } from './mapCodec';
import type { StoredMap } from './types';

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** Looks up maps shared in the game's map hub; it signs in to the game for us. */
const MAP_HUB_API = 'https://wod-nations-map.moreofdots.workers.dev';

/** A map from the game's map hub, in the game's own format. */
export interface SharedMap {
  code: string;
  title: string;
  author: string;
  date: number | null;
  upvotes: number;
  downvotes: number;
  map: { map_surface: string; mode?: string; [key: string]: unknown };
}

/** The map hub map with this code; codes are short numbers, usually four digits. */
export async function fetchSharedMap(code: string): Promise<SharedMap> {
  let response: Response;
  try {
    response = await fetch(`${MAP_HUB_API}/v1/maps/${encodeURIComponent(code)}`);
  } catch {
    throw new Error('The map hub could not be reached. Check your connection and try again.');
  }
  const body = await response.json().catch(() => null) as (SharedMap & { error?: string }) | null;
  if (!response.ok || !body?.map) throw new Error(body?.error || `The map hub returned an error (${response.status}).`);
  return body;
}

export type MapSource = { filePath: string } | { file: File } | { shared: SharedMap };

export const mapStore = {
  async list() {
    const maps = await invoke<StoredMap[]>('list_maps');
    return maps.map(cloneStoredMapRecord).sort((left, right) => right.updatedAt - left.updatedAt);
  },

  async get(id: string) {
    const map = await invoke<StoredMap>('read_map', { fileName: id });
    return cloneStoredMapRecord(map);
  },

  /** A map in the game's own coordinates, as the editor works on it. */
  async getGame(id: string) {
    const map = await invoke<StoredMap>('read_map', { fileName: id });
    return { ...map, data: normalizeMapData(map.data) };
  },

  /** Saves a map, given in the game's own coordinates, to the game. Nothing is
   * written when the game could not load it. A new map gets its file here, so
   * later saves use the returned record's id. */
  async putGame(id: string, data: StoredMap['data']) {
    const saved = await invoke<StoredMap>('save_map', { fileName: id, data });
    return cloneStoredMapRecord(saved);
  },

  /** A new empty map; `large` gives a 1920 x 1080 terrain instead of 960 x 540.
   * It has no file (status "unsaved") until its first save. */
  async create(name: string, teams = 2, large = false) {
    const map = await invoke<StoredMap>('create_map', { name, teams, large });
    return cloneStoredMapRecord(map);
  },

  /** Renames a map, which renames its file. The returned record can have a new id.
   * A new map without a file needs its `data`. */
  async rename(id: string, name: string, data?: StoredMap['data']) {
    return cloneStoredMapRecord(await invoke<StoredMap>('rename_map', { fileName: id, name, data }));
  },

  /** A copy of a map in the game, named "<name> copy". */
  async duplicate(id: string) {
    return cloneStoredMapRecord(await invoke<StoredMap>('duplicate_map', { fileName: id }));
  },

  /** Adds a map file (.txt) from elsewhere to the game. */
  async importFile(file: File) {
    const mapBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    return cloneStoredMapRecord(await invoke<StoredMap>('import_map_file', { fileName: file.name, mapBase64 }));
  },

  /** Adds the map a replay was played on (or a map hub map) to the game. */
  async importReplay(name: string, source: MapSource) {
    // A map hub map is recorded the way a custom replay records its map.
    const args = 'filePath' in source
      ? { name, filePath: source.filePath }
      : 'shared' in source
        ? { name, replayBase64: bytesToBase64(new TextEncoder().encode(JSON.stringify({ map: source.shared.map }))) }
        : { name, replayBase64: bytesToBase64(new Uint8Array(await source.file.arrayBuffer())) };
    return cloneStoredMapRecord(await invoke<StoredMap>('import_map_from_replay', args));
  },

  async deleteMany(fileNames: string[]) {
    return invoke<string[]>('delete_maps', { fileNames });
  },
};
