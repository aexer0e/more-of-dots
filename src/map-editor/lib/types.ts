export type Point = [number, number];

export type Bridge = [Point, Point];

/** The fields War of Dots reads from a map file. The number of teams is the
 * number of unit lists; experiment matches turn some infantry into shock units. */
export interface MapData {
  map_surface: string;
  infantry: Point[][];
  tanks: Point[][];
  cities: Point[];
  capitals: number[];
  bridges: Bridge[];
  [key: string]: unknown;
}

export interface StoredMap {
  id: string;
  fileName: string;
  filePath?: string;
  name: string;
  data: MapData;
  createdAt: number;
  updatedAt: number;
  width: number;
  height: number;
  teamCount: number;
  status?: 'draft' | 'published' | 'invalid';
  issue?: string | null;
  gameFilePath?: string | null;
}

export interface EditorSnapshot {
  name: string;
  data: MapData;
}

export type ToolId =
  | 'terrainBrush'
  | 'terrainLine'
  | 'terrainRect'
  | 'terrainFill'
  | 'terrainShape'
  | 'select'
  | 'infantry'
  | 'tank'
  | 'city'
  | 'capital'
  | 'bridge'
  | 'erase';
