import { CANVAS_HEIGHT, CANVAS_WIDTH, DEFAULT_TERRAIN_HEX, MODE_LABELS, MODE_TEAMS } from './constants';
import { loadImageFromFile, quantizeCanvasContext } from './editorUtils';
import type { Bridge, EditorSnapshot, MapData, Mode, Point, StoredMap } from './types';

const MODE_ALIASES: Record<string, Mode> = {
  '1v1': '1v1',
  '1v1 duel': '1v1',
  duel: '1v1',
  '3pffa': 'v3',
  '3p ffa': 'v3',
  v3: 'v3',
  '4pffa': 'v4',
  '4p ffa': 'v4',
  ffa: 'v4',
  v4: 'v4',
};

export function normalizeMode(mode: string | null | undefined): Mode {
  return MODE_ALIASES[String(mode ?? '1v1').trim().toLowerCase()] ?? '1v1';
}

export function inferTeamCount(data: Partial<MapData> | null | undefined): number {
  const infantryCount = Array.isArray(data?.infantry) ? data.infantry.length : 0;
  const tankCount = Array.isArray(data?.tanks) ? data.tanks.length : 0;
  return Math.max(2, Math.min(4, infantryCount, tankCount) || Math.max(infantryCount, tankCount, MODE_TEAMS[normalizeMode(data?.mode as string)]));
}

export function teamsForMap(map: Pick<StoredMap, 'teamCount' | 'data'> | null | undefined) {
  return Math.max(2, Math.min(4, Number(map?.teamCount) || inferTeamCount(map?.data)));
}

export function teamsForMode(mode: string | null | undefined) {
  return MODE_TEAMS[normalizeMode(mode)];
}

export function modeLabel(mode: string | null | undefined) {
  return MODE_LABELS[normalizeMode(mode)];
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

export function emptyMapData(mode: Mode = '1v1', width = CANVAS_WIDTH, height = CANVAS_HEIGHT): MapData {
  const teamCount = MODE_TEAMS[mode];
  return {
    map_surface: createSolidMapSurface(width, height),
    mode,
    infantry: Array.from({ length: teamCount }, () => []),
    tanks: Array.from({ length: teamCount }, () => []),
    cities: [],
    capitals: [],
    bridges: [],
  };
}

export function normalizeMapData(data: unknown): MapData {
  if (!data || typeof data !== 'object') return emptyMapData('1v1');

  const raw = data as Partial<MapData> & Record<string, unknown>;
  const mode = normalizeMode(raw.mode as string);
  const teamCount = inferTeamCount(raw);

  const normalizeTeamBuckets = (collection: unknown) =>
    Array.from({ length: teamCount }, (_, index) => {
      const bucket = Array.isArray(collection) ? collection[index] : null;
      return Array.isArray(bucket)
        ? bucket.map(normalizePoint).filter((point): point is Point => point !== null)
        : [];
    });

  const cities = Array.isArray(raw.cities)
    ? raw.cities.map(normalizePoint).filter((point): point is Point => point !== null)
    : [];
  const capitals = Array.isArray(raw.capitals)
    ? raw.capitals.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < cities.length)
    : [];
  const bridges = Array.isArray(raw.bridges)
    ? raw.bridges.map(normalizeBridge).filter((bridge): bridge is Bridge => bridge !== null)
    : [];

  return {
    ...raw,
    map_surface: typeof raw.map_surface === 'string' && raw.map_surface ? raw.map_surface : createSolidMapSurface(),
    mode,
    infantry: normalizeTeamBuckets(raw.infantry),
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
    mode: normalizeMode(mapData.mode),
    infantry: mapData.infantry.map((team) => team.map(([x, y]) => [x, y] as Point)),
    tanks: mapData.tanks.map((team) => team.map(([x, y]) => [x, y] as Point)),
    cities: mapData.cities.map(([x, y]) => [x, y] as Point),
    capitals: [...mapData.capitals],
    bridges: mapData.bridges.map(([start, end]) => [[start[0], start[1]], [end[0], end[1]]] as Bridge),
  };
}

function mapCoordinateStorageScale(width: number, height: number) {
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
    teamCount: Math.max(2, Math.min(4, Number(map.teamCount) || inferTeamCount(map.data))),
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

export function createMapRecord(name: string, mode: Mode = '1v1'): StoredMap {
  const timestamp = Date.now();
  const fileName = `map_${timestamp}.txt`;
  return {
    id: fileName,
    fileName,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    teamCount: MODE_TEAMS[mode],
    data: emptyMapData(mode),
  };
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
