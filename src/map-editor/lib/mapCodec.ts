import { CANVAS_HEIGHT, CANVAS_WIDTH, DEFAULT_TERRAIN_HEX } from './constants';
import { loadImageFromFile, quantizeCanvasContext } from './editorUtils';
import { mergeShocks } from './preview';
import type { Bridge, EditorSnapshot, MapData, Point, StoredMap } from './types';

const clampTeams = (count: number) => Math.max(2, Math.min(4, count));

/** The game has no map mode: a map has as many teams as it has unit lists. */
export function inferTeamCount(data: Partial<MapData> | null | undefined): number {
  const lists = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  return clampTeams(Math.max(lists(data?.infantry), lists(data?.tanks)));
}

export function teamsForMap(map: Pick<StoredMap, 'teamCount' | 'data'> | null | undefined) {
  return clampTeams(Number(map?.teamCount) || inferTeamCount(map?.data));
}

function normalizePoint(point: unknown): Point | null {
  if (!Array.isArray(point) || point.length < 2) return null;
  const x = Number(point[0]);
  const y = Number(point[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [Math.round(x), Math.round(y)] : null;
}

function normalizeBridge(bridge: unknown): Bridge | null {
  if (Array.isArray(bridge) && bridge.length === 4) {
    const start = normalizePoint([bridge[0], bridge[1]]);
    const end = normalizePoint([bridge[2], bridge[3]]);
    return start && end ? [start, end] : null;
  }

  if (Array.isArray(bridge) && bridge.length === 2) {
    const start = normalizePoint(bridge[0]);
    const end = normalizePoint(bridge[1]);
    return start && end ? [start, end] : null;
  }

  if (bridge && typeof bridge === 'object' && 'value' in (bridge as Record<string, unknown>)) {
    return normalizeBridge((bridge as { value: unknown }).value);
  }

  return null;
}

function createSolidMapSurface(width = CANVAS_WIDTH, height = CANVAS_HEIGHT, hex = DEFAULT_TERRAIN_HEX) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.fillStyle = hex;
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

function fitImageCover(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

export function emptyMapData(teamCount = 2, width = CANVAS_WIDTH, height = CANVAS_HEIGHT): MapData {
  const teams = clampTeams(teamCount);
  return {
    map_surface: createSolidMapSurface(width, height),
    infantry: Array.from({ length: teams }, () => []),
    tanks: Array.from({ length: teams }, () => []),
    cities: [],
    capitals: [],
    bridges: [],
  };
}

/** Changes the number of teams. Units of removed teams are dropped. */
export function withTeamCount(data: MapData, teamCount: number): MapData {
  const teams = clampTeams(teamCount);
  const resize = (lists: Point[][]) => Array.from({ length: teams }, (_, index) => lists[index] ?? []);
  return { ...data, infantry: resize(data.infantry), tanks: resize(data.tanks) };
}

/** Brings a map to the fields the game reads. `mode` is dropped, and shock units
 * that older maps listed apart go back among the infantry. */
export function normalizeMapData(data: unknown): MapData {
  if (!data || typeof data !== 'object') return emptyMapData();

  const { mode: _mode, motorised, ...raw } = data as Partial<MapData> & Record<string, unknown>;
  const teamCount = clampTeams(Math.max(inferTeamCount(raw), Array.isArray(motorised) ? motorised.length : 0));
  const points = (list: unknown) => (Array.isArray(list) ? list.map(normalizePoint).filter((point): point is Point => point !== null) : []);
  const normalizeTeamBuckets = (collection: unknown) =>
    Array.from({ length: teamCount }, (_, index) => points(Array.isArray(collection) ? collection[index] : null));

  const shocks = normalizeTeamBuckets(motorised);
  const infantry = normalizeTeamBuckets(raw.infantry).map((team, index) => (
    shocks[index].length ? mergeShocks(team, shocks[index]) ?? [...team, ...shocks[index]] : team
  ));
  const cities = points(raw.cities);
  const capitals = Array.isArray(raw.capitals)
    ? raw.capitals.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < cities.length)
    : [];
  const bridges = Array.isArray(raw.bridges)
    ? raw.bridges.map(normalizeBridge).filter((bridge): bridge is Bridge => bridge !== null)
    : [];

  return {
    ...raw,
    map_surface: typeof raw.map_surface === 'string' && raw.map_surface ? raw.map_surface : createSolidMapSurface(),
    infantry,
    tanks: normalizeTeamBuckets(raw.tanks),
    cities,
    capitals,
    bridges,
  };
}

export function cloneMapData(mapData: MapData): MapData {
  return {
    ...mapData,
    map_surface: mapData.map_surface,
    infantry: mapData.infantry.map((team) => team.map(([x, y]) => [x, y] as Point)),
    tanks: mapData.tanks.map((team) => team.map(([x, y]) => [x, y] as Point)),
    cities: mapData.cities.map(([x, y]) => [x, y] as Point),
    capitals: [...mapData.capitals],
    bridges: mapData.bridges.map(([start, end]) => [[start[0], start[1]], [end[0], end[1]]] as Bridge),
  };
}

export function mapCoordinateStorageScale(width: number, height: number) {
  return width === 960 && height === 540 ? { x: 5 / 3, y: 5 / 3 } : { x: 1, y: 1 };
}

function scalePoint([x, y]: Point, scaleX: number, scaleY: number): Point {
  return [Math.round(x * scaleX), Math.round(y * scaleY)];
}

export function scaleMapObjects(data: MapData, scaleX: number, scaleY: number): MapData {
  return {
    ...data,
    infantry: data.infantry.map((team) => team.map((point) => scalePoint(point, scaleX, scaleY))),
    tanks: data.tanks.map((team) => team.map((point) => scalePoint(point, scaleX, scaleY))),
    cities: data.cities.map((point) => scalePoint(point, scaleX, scaleY)),
    bridges: data.bridges.map(([start, end]) => [
      scalePoint(start, scaleX, scaleY),
      scalePoint(end, scaleX, scaleY),
    ]),
  };
}

export function cloneMapRecord(map: StoredMap): StoredMap {
  return {
    ...map,
    data: cloneMapData(normalizeMapData(map.data)),
    teamCount: inferTeamCount(map.data),
  };
}

export function cloneStoredMapRecord(map: StoredMap): StoredMap {
  const cloned = cloneMapRecord(map);
  const storageScale = mapCoordinateStorageScale(cloned.width, cloned.height);
  if (storageScale.x === 1 && storageScale.y === 1) return cloned;
  return {
    ...cloned,
    data: scaleMapObjects(cloned.data, 1 / storageScale.x, 1 / storageScale.y),
  };
}

export function mapDataForStorage(map: StoredMap): MapData {
  const storageScale = mapCoordinateStorageScale(map.width, map.height);
  const data = cloneMapData(normalizeMapData(map.data));
  if (storageScale.x === 1 && storageScale.y === 1) return data;
  return scaleMapObjects(data, storageScale.x, storageScale.y);
}

export function snapshotForHistory(map: StoredMap): EditorSnapshot {
  return {
    name: map.name,
    data: cloneMapData(map.data),
  };
}

export function applySnapshot(map: StoredMap, snapshot: EditorSnapshot): StoredMap {
  return {
    ...map,
    name: snapshot.name,
    data: normalizeMapData(snapshot.data),
  };
}

export function serializeSnapshot(snapshot: EditorSnapshot) {
  return JSON.stringify(snapshot);
}

export function parseSnapshot(snapshot: string): EditorSnapshot {
  const parsed = JSON.parse(snapshot) as EditorSnapshot;
  return {
    name: typeof parsed.name === 'string' ? parsed.name : 'Untitled map',
    data: normalizeMapData(parsed.data),
  };
}

export async function mapSurfaceFromImageFile(file: File, width = CANVAS_WIDTH, height = CANVAS_HEIGHT) {
  const image = await loadImageFromFile(file);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return '';

  context.imageSmoothingEnabled = false;
  context.fillStyle = DEFAULT_TERRAIN_HEX;
  context.fillRect(0, 0, width, height);
  fitImageCover(context, image, width, height);
  quantizeCanvasContext(context, width, height);
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

export function base64PngFromCanvas(canvas: HTMLCanvasElement) {
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

export function formatUpdatedAt(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
