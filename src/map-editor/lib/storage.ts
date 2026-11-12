import { invoke } from '../../platform';
import { cloneStoredMapRecord, mapDataForStorage, normalizeMapData } from './mapCodec';
import type { StoredMap } from './types';

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

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

  /** Saves a map given in the game's own coordinates. A map from the game folder
   * becomes a draft with a new id; later saves use the returned record's id. */
  async putGame(id: string, data: StoredMap['data'], publish = false) {
    const saved = await invoke<StoredMap>('save_map', { fileName: id, data, publish });
    return cloneStoredMapRecord(saved);
  },

  /** A new empty map; `large` gives a 1920 x 1080 terrain instead of 960 x 540. */
  async create(name: string, teams = 2, large = false) {
    const map = await invoke<StoredMap>('create_map', { name, teams, large });
    return cloneStoredMapRecord(map);
  },

  /** Renames a map, which renames its file. The returned record can have a new id. */
  async rename(id: string, name: string) {
    return cloneStoredMapRecord(await invoke<StoredMap>('rename_map', { fileName: id, name }));
  },

  /** Adds a map file (.txt) from elsewhere as a draft. */
  async importFile(file: File) {
    const mapBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    return cloneStoredMapRecord(await invoke<StoredMap>('import_map_file', { fileName: file.name, mapBase64 }));
  },

  /** Makes a draft from the map a replay was played on. */
  async importReplay(name: string, source: { filePath: string } | { file: File }) {
    const args = 'filePath' in source
      ? { name, filePath: source.filePath }
      : { name, replayBase64: bytesToBase64(new Uint8Array(await source.file.arrayBuffer())) };
    return cloneStoredMapRecord(await invoke<StoredMap>('import_map_from_replay', args));
  },

  async put(map: StoredMap, publish = false) {
    const saved = await invoke<StoredMap>('save_map', {
      fileName: map.id,
      data: mapDataForStorage(map),
      publish,
    });
    return cloneStoredMapRecord(saved);
  },

  async deleteMany(fileNames: string[]) {
    return invoke<string[]>('delete_maps', { fileNames });
  },
};
