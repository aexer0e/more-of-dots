import { invoke } from '@tauri-apps/api/core';
import { cloneStoredMapRecord, mapDataForStorage } from './mapCodec';
import type { Mode, StoredMap } from './types';

export const mapStore = {
  async list() {
    const maps = await invoke<StoredMap[]>('list_maps');
    return maps.map(cloneStoredMapRecord).sort((left, right) => right.updatedAt - left.updatedAt);
  },

  async get(id: string) {
    const map = await invoke<StoredMap>('read_map', { fileName: id });
    return cloneStoredMapRecord(map);
  },

  async create(name: string, mode: Mode = '1v1') {
    const map = await invoke<StoredMap>('create_map', { name, mode });
    return cloneStoredMapRecord(map);
  },

  async put(map: StoredMap) {
    const saved = await invoke<StoredMap>('save_map', {
      fileName: map.fileName || map.id,
      data: mapDataForStorage(map),
    });
    return cloneStoredMapRecord(saved);
  },

  async deleteMany(fileNames: string[]) {
    return invoke<string[]>('delete_maps', { fileNames });
  },
};
