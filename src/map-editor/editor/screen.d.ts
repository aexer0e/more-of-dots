type Point = [number, number];

export interface EditorMap {
  width: number;
  height: number;
  /** The terrain image as a data URL. */
  surface: string;
  infantry: Point[][];
  tanks: Point[][];
  cities: Point[];
  capitals: number[];
  bridges: [Point, Point][];
}

/** The map in the game's file format: the six fields the game reads. */
export interface GameMapData {
  map_surface: string;
  infantry: Point[][];
  tanks: Point[][];
  cities: Point[];
  capitals: number[];
  bridges: [Point, Point][];
}

export interface EditorHandle {
  dirty(): boolean;
  /** With unsaved changes, asks to save them to the game or discard them; true when the editor may close. */
  confirmLeave(): Promise<boolean>;
  /** Saves the map to the game; false (with the reason shown) when the game could not load it. */
  save(): Promise<boolean>;
  stop(): void;
  destroy(): void;
}

export function mountEditor(
  root: HTMLElement,
  options: {
    map: EditorMap;
    name: string;
    status?: string;
    base: string;
    saveLabel?: string;
    /** Saves the map to the game and resolves to its status. Rejects, writing nothing, when the game could not load it. */
    onSave(data: GameMapData): Promise<string>;
    onClose(): void;
    /** An image file as terrain of this size, snapped to the terrain colours. */
    onTerrainImage(file: File, width: number, height: number): Promise<CanvasImageSource>;
    /** Called when the map gains or loses unsaved changes. */
    onDirty?(unsaved: boolean): void;
    /** Renames the map; resolves to the name to show. Clicking the title starts it. */
    onRename?(name: string): Promise<string>;
  },
): EditorHandle;
