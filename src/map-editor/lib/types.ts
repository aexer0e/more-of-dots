export type Mode = '1v1' | 'v3' | 'v4';

export type Point = [number, number];

export type Bridge = [Point, Point];

export interface MapData {
  map_surface: string;
  mode: Mode;
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
