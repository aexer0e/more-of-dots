import type { Mode, ToolId } from './types';

export let CANVAS_WIDTH = 960;
export let CANVAS_HEIGHT = 540;

export function setCanvasSize(width: number, height: number) {
  if (Number.isFinite(width) && width > 0) {
    CANVAS_WIDTH = Math.round(width);
  }
  if (Number.isFinite(height) && height > 0) {
    CANVAS_HEIGHT = Math.round(height);
  }
}
export const HIT_RADIUS = 12;
export const SPRITE_SIZE = 18;
export const CITY_SIZE = 26;
export const CAPITAL_SIZE = 30;
export const DEFAULT_BRUSH_SIZE = 10;
export const HISTORY_LIMIT = 40;
export const DEFAULT_TERRAIN_HEX = '#A1C246';

// Player slots map directly to colors in this fixed order.
// Slot 0 = Player 1, slot 1 = Player 2, and so on:
//   2 teams -> blue vs red
//   3 teams -> blue, red, purple
//   4 teams -> blue, red, purple, orange
export const TEAM_COLORS = ['blue', 'red', 'purple', 'orange'] as const;

export type TeamColor = (typeof TEAM_COLORS)[number];

export const TEAM_LABELS: Record<TeamColor, string> = {
  blue: 'Blue',
  red: 'Red',
  purple: 'Purple',
  orange: 'Orange',
};

export const TEAM_ACCENTS: Record<TeamColor, string> = {
  blue: '#4b8dff',
  red: '#eb5a58',
  purple: '#b881ff',
  orange: '#ff9c47',
};

// A team is just a dense player slot. The color is whatever sits at that slot.
export function teamColorForIndex(teamIndex: number): TeamColor {
  return TEAM_COLORS[teamIndex % TEAM_COLORS.length];
}

export const MODE_TEAMS: Record<Mode, number> = {
  '1v1': 2,
  v3: 3,
  v4: 4,
};

export const MODE_LABELS: Record<Mode, string> = {
  '1v1': '1v1 Duel',
  v3: '3P Free For All',
  v4: '4P Free For All',
};

export const TERRAIN_COLORS = [
  { name: 'Plains', hex: '#A1C246' },
  { name: 'Forest', hex: '#388336' },
  { name: 'River', hex: '#279BFF' },
  { name: 'Snow', hex: '#FFFFFF' },
  { name: 'Mud', hex: '#784B23' },
  { name: 'Sand', hex: '#EEE3B0' },
  { name: 'Hill', hex: '#888A87' },
  { name: 'Mountain', hex: '#6D6B6F' },
] as const;

export const TERRAIN_PALETTE = TERRAIN_COLORS.map((entry) => entry.hex);

export interface ToolDefinition {
  id: ToolId;
  label: string;
  hint: string;
  group: 'terrain' | 'units' | 'objects';
  kind: 'terrain' | 'team' | 'plain' | 'erase' | 'select';
}

export const TOOLS: ToolDefinition[] = [
  { id: 'terrainBrush', label: 'Brush', hint: 'Paint terrain with drag input.', group: 'terrain', kind: 'terrain' },
  { id: 'terrainLine', label: 'Line', hint: 'Draw thick terrain strokes.', group: 'terrain', kind: 'terrain' },
  { id: 'terrainRect', label: 'Rect', hint: 'Block out areas fast.', group: 'terrain', kind: 'terrain' },
  { id: 'terrainFill', label: 'Fill', hint: 'Flood a contiguous terrain region.', group: 'terrain', kind: 'terrain' },
  { id: 'terrainShape', label: 'Shape', hint: 'Left-click anchors, then right-click to fill a curved shape.', group: 'terrain', kind: 'terrain' },
  { id: 'bridge', label: 'Bridge', hint: 'Click two points to span a bridge.', group: 'terrain', kind: 'plain' },
  { id: 'select', label: 'Select', hint: 'Drag to select units and cities. Shift adds. Ctrl drags only the box.', group: 'units', kind: 'select' },
  { id: 'infantry', label: 'Infantry', hint: 'Place infantry for the selected team.', group: 'units', kind: 'team' },
  { id: 'tank', label: 'Tank', hint: 'Brush over infantry to convert them into tanks.', group: 'units', kind: 'team' },
  { id: 'city', label: 'City', hint: 'Place a neutral city.', group: 'objects', kind: 'plain' },
  { id: 'capital', label: 'Capital', hint: 'Brush over cities to turn them into capitals.', group: 'objects', kind: 'plain' },
  { id: 'erase', label: 'Erase', hint: 'Remove the nearest placed object.', group: 'objects', kind: 'erase' },
];

export const TOOL_LOOKUP: Record<ToolId, ToolDefinition> = Object.fromEntries(
  TOOLS.map((tool) => [tool.id, tool]),
) as Record<ToolId, ToolDefinition>;
