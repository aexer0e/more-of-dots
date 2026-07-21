import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Brackets, Info, Keyboard, Mouse, MousePointer2, MouseRight, Redo2, Undo2, ZoomIn, type LucideIcon } from 'lucide-react';
import { flagAssets, getCachedImage, preloadImages, spriteAssets, uiAssets } from '../lib/assets';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CAPITAL_SIZE,
  CITY_SIZE,
  DEFAULT_BRUSH_SIZE,
  DEFAULT_TERRAIN_HEX,
  HISTORY_LIMIT,
  HIT_RADIUS,
  MODE_LABELS,
  SPRITE_SIZE,
  TEAM_ACCENTS,
  TEAM_COLORS,
  TEAM_LABELS,
  TERRAIN_COLORS,
  TOOLS,
  TOOL_LOOKUP,
  setCanvasSize,
  teamColorForIndex,
} from '../lib/constants';
import {
  base64PngFromCanvas,
  cloneMapData,
  cloneMapRecord,
  scaleMapObjects,
  teamsForMap,
  teamsForMode,
} from '../lib/mapCodec';
import {
  drawCircleOutline,
  drawDot,
  fillPolygonPixels,
  drawRect,
  drawSegment,
  floodFillContext,
  loadImageFromBase64,
  loadImageFromFile,
  nearestTerrainHex,
  pointToSegmentDistance,
  quantizeCanvasContext,
  rgbToHex,
  sampleClosedBezierShape,
  strokePolygonPixels,
} from '../lib/editorUtils';
import type { MapData, Point, StoredMap, ToolId } from '../lib/types';

interface EditorScreenProps {
  initialMap: StoredMap;
  saveMap: (map: StoredMap) => Promise<StoredMap>;
  onClose: (map?: StoredMap) => void;
  registerLeaveGuard?: (handler: (() => Promise<boolean>) | null) => void;
}

type PanelKey = 'terrain' | 'units' | 'map';

interface HistoryEntry {
  data: MapData;
  height: number;
  surface: ImageData | null;
  width: number;
}

type LeaveResult = StoredMap | null | false;

interface EntityBrushSession {
  active: boolean;
  dirty: boolean;
  last: { x: number; y: number } | null;
  pointerId: number | null;
  tool: 'infantry' | 'tank' | 'city' | 'capital' | null;
  working: StoredMap | null;
}

interface MoveSession {
  active: boolean;
  moved: boolean;
  origin: StoredMap | null;
  pointerId: number | null;
  target: Exclude<HoverTarget, { type: 'terrain' } | { type: 'bridge' }> | null;
  working: StoredMap | null;
}

interface PanSession {
  active: boolean;
  moved: boolean;
  pointerId: number | null;
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
  trigger: 'middle' | 'space';
}

interface SelectionRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

type SelectedEntityRef =
  | { kind: 'infantry' | 'tank'; entityIndex: number; teamIndex: number }
  | { kind: 'city'; cityIndex: number };

interface SelectionSession {
  active: boolean;
  marqueeRect: SelectionRect | null;
  mode: 'move' | 'select';
  moved: boolean;
  operation: 'add' | 'replace' | 'subtract';
  originMap: StoredMap | null;
  originRects: SelectionRect[];
  pointerId: number | null;
  start: Point | null;
}

interface ControlHint {
  action: string;
  icon: LucideIcon;
  id: string;
  keys?: string[];
  label: string;
}

interface TeamMapSummary {
  cities: number;
  fundDelta: number;
  heavyUnits: number;
  lightUnits: number;
  teamIndex: number;
}

type HoverTarget =
  | { type: 'terrain'; label: string; terrainHex: string }
  | { type: 'bridge'; label: string; removeLabel: string; bridge: [Point, Point]; color: string }
  | { type: 'infantry' | 'tank'; label: string; removeLabel: string; point: Point; color: string; entityIndex: number; teamIndex: number }
  | { type: 'city' | 'capital'; label: string; removeLabel: string; point: Point; color: string; cityIndex: number };

const BRIDGE_COLOR = '#643C0A';
const BRIDGE_WIDTH = 9;
const MAP_RESOLUTION_OPTIONS = [
  { label: '960x540', width: 960, height: 540 },
  { label: '1920x1080', width: 1920, height: 1080 },
] as const;

function panelForTool(toolId: ToolId): PanelKey {
  const group = TOOL_LOOKUP[toolId].group;
  if (group === 'terrain') return 'terrain';
  if (group === 'units' || group === 'objects') return 'units';
  return 'map';
}

function isTextInputTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function sortCapitalIndices(capitals: number[]) {
  return [...new Set(capitals)].sort((a, b) => a - b);
}

function fitImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
) {
  const sw = image.naturalWidth || image.width;
  const sh = image.naturalHeight || image.height;
  const scale = Math.max(width / sw, height / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  context.drawImage(image, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

function teamAccent(index: number, teamCount: number) {
  return TEAM_ACCENTS[teamColorForIndex(index)];
}

function createTeamMapSummaries(map: StoredMap, teamCount: number): TeamMapSummary[] {
  const summaries = Array.from({ length: teamCount }, (_, teamIndex) => {
    const lightUnits = map.data.infantry[teamIndex]?.length ?? 0;
    const heavyUnits = map.data.tanks[teamIndex]?.length ?? 0;

    return {
      cities: 0,
      fundDelta: 0,
      heavyUnits,
      lightUnits,
      teamIndex,
    };
  });

  const unitPoints = summaries.map((summary) => [
    ...(map.data.infantry[summary.teamIndex] ?? []),
    ...(map.data.tanks[summary.teamIndex] ?? []),
  ]);

  map.data.cities.forEach(([cityX, cityY]) => {
    let claimedBy: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    unitPoints.forEach((teamUnits, teamIndex) => {
      teamUnits.forEach(([unitX, unitY]) => {
        const distance = (unitX - cityX) ** 2 + (unitY - cityY) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          claimedBy = teamIndex;
        }
      });
    });

    if (claimedBy !== null) {
      summaries[claimedBy].cities += 1;
    }
  });

  return summaries.map((summary) => ({
    ...summary,
    fundDelta: summary.cities * 5 - (summary.lightUnits + summary.heavyUnits),
  }));
}

function formatUnitLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTeamMapSummary(summary: TeamMapSummary) {
  const parts: string[] = [];

  if (summary.cities > 0) {
    parts.push(formatUnitLabel(summary.cities, 'City', 'Cities'));
  }

  if (summary.lightUnits > 0) {
    parts.push(formatUnitLabel(summary.lightUnits, 'Light Unit', 'Light Units'));
  }

  if (summary.heavyUnits > 0) {
    parts.push(formatUnitLabel(summary.heavyUnits, 'Heavy Unit', 'Heavy Units'));
  }

  if (parts.length === 0) {
    return '';
  }

  if (summary.fundDelta > 0) {
    return `${parts.join(', ')} (▲ ${summary.fundDelta})`;
  }

  if (summary.fundDelta < 0) {
    return `${parts.join(', ')} (▼ ${Math.abs(summary.fundDelta)})`;
  }

  return parts.join(', ');
}

function createDraftCounts(map: StoredMap) {
  return {
    infantry: map.data.infantry.reduce((c, t) => c + t.length, 0),
    tanks: map.data.tanks.reduce((c, t) => c + t.length, 0),
    cities: map.data.cities.length,
    capitals: map.data.capitals.length,
    bridges: map.data.bridges.length,
  };
}

function clampZoom(value: number) {
  return Math.max(0.35, Math.min(5, Number(value.toFixed(2))));
}

function disableSmoothing(context: CanvasRenderingContext2D) {
  context.imageSmoothingEnabled = false;
}

function mapVisualScale() {
  return Math.max(1, Math.min(CANVAS_WIDTH / 960, CANVAS_HEIGHT / 540));
}

function scaledIconSize(size: number) {
  return Math.round(size * mapVisualScale());
}

function scaledHitRadius() {
  return scaledIconSize(HIT_RADIUS);
}

function isBrushSizedTool(toolId: ToolId) {
  return toolId === 'terrainBrush' || toolId === 'terrainLine' || toolId === 'tank' || toolId === 'capital';
}

function isEntityBrushTool(toolId: ToolId): toolId is 'infantry' | 'tank' | 'city' | 'capital' {
  return toolId === 'infantry' || toolId === 'tank' || toolId === 'city' || toolId === 'capital';
}

function isMoveEntityTool(toolId: ToolId) {
  return toolId === 'infantry' || toolId === 'tank' || toolId === 'city' || toolId === 'capital';
}

function toolControlSignature(toolId: ToolId) {
  if (toolId === 'select') {
    return 'select';
  }

  if (isMoveEntityTool(toolId)) {
    return 'move-entity';
  }

  return toolId;
}

function floatingControlItemsForTool(toolId: ToolId): ControlHint[] {
  if (toolId === 'select') {
    return [
      { id: 'select-drag', icon: MousePointer2, label: 'Left drag', action: 'Draws a selection box.', keys: ['LMB'] },
      { id: 'select-add', icon: Mouse, label: 'Shift + drag', action: 'Adds the new box to the selection.', keys: ['Shift', 'LMB'] },
      { id: 'select-move', icon: MousePointer2, label: 'Drag inside box', action: 'Moves the selected units and cities.', keys: ['LMB'] },
      { id: 'select-carve', icon: Mouse, label: 'Ctrl + drag', action: 'Carves that box out of the selection.', keys: ['Ctrl', 'LMB'] },
    ];
  }

  if (isMoveEntityTool(toolId)) {
    return [
      { id: 'unit-place', icon: MousePointer2, label: 'Left click', action: 'Places the selected unit or city.', keys: ['LMB'] },
      { id: 'unit-drag', icon: MousePointer2, label: 'Left drag', action: 'Moves a placed unit or city.', keys: ['LMB'] },
      { id: 'unit-brush', icon: Mouse, label: 'Shift + left drag', action: 'Brushes replacements to the selected tool.', keys: ['Shift', 'LMB'] },
    ];
  }

  switch (toolId) {
    case 'terrainBrush':
      return [
        { id: 'brush-paint', icon: MousePointer2, label: 'Left drag', action: 'Paints terrain continuously.', keys: ['LMB'] },
        { id: 'brush-wheel', icon: Mouse, label: 'Ctrl + wheel', action: 'Adjusts brush size.', keys: ['Ctrl'] },
        { id: 'brush-brackets', icon: Brackets, label: '[ / ]', action: 'Shrinks or grows the brush.' },
      ];
    case 'terrainLine':
      return [
        { id: 'line-drag', icon: MousePointer2, label: 'Drag', action: 'Draws a thick terrain line.', keys: ['LMB'] },
        { id: 'line-wheel', icon: Mouse, label: 'Ctrl + wheel', action: 'Adjusts line thickness.', keys: ['Ctrl'] },
        { id: 'line-brackets', icon: Brackets, label: '[ / ]', action: 'Shrinks or grows the brush.' },
      ];
    case 'terrainRect':
      return [
        { id: 'rect-drag', icon: MousePointer2, label: 'Drag', action: 'Blocks out a terrain rectangle.', keys: ['LMB'] },
      ];
    case 'terrainFill':
      return [
        { id: 'fill-click', icon: MousePointer2, label: 'Left click', action: 'Flood-fills the hovered terrain region.', keys: ['LMB'] },
      ];
    case 'terrainShape':
      return [
        { id: 'shape-anchor', icon: MousePointer2, label: 'Left click', action: 'Places anchors for a curved terrain shape.', keys: ['LMB'] },
        { id: 'shape-confirm', icon: MouseRight, label: 'Right click', action: 'Places the last anchor and confirms the shape.' },
      ];
    case 'bridge':
      return [
        { id: 'bridge-start', icon: MousePointer2, label: 'Left click', action: 'Places the first bridge point.', keys: ['LMB'] },
        { id: 'bridge-finish', icon: MousePointer2, label: 'Second click', action: 'Places the second point and creates the bridge.' },
      ];
    case 'erase':
      return [
        { id: 'erase-click', icon: MousePointer2, label: 'Click', action: 'Removes the nearest unit, city, or bridge.', keys: ['LMB'] },
        { id: 'erase-right', icon: MouseRight, label: 'Right click', action: 'Also removes the nearest object without switching tools.' },
      ];
    default:
      return [];
  }
}

// Teams are dense player slots: slot 0 is Player 1, slot 1 is Player 2, etc.
function visibleTeamOrder(teamCount: number) {
  return Array.from({ length: teamCount }, (_, index) => index);
}

function clampPan(
  pan: { x: number; y: number },
  zoom: number,
  size: { height: number; width: number },
) {
  const maxX = Math.max(size.width / 2, (size.width * (zoom - 1)) / 2);
  const maxY = Math.max(size.height / 2, (size.height * (zoom - 1)) / 2);

  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

function createSelectionRect(start: { x: number; y: number } | Point, end: { x: number; y: number } | Point): SelectionRect {
  const x1 = Array.isArray(start) ? start[0] : start.x;
  const y1 = Array.isArray(start) ? start[1] : start.y;
  const x2 = Array.isArray(end) ? end[0] : end.x;
  const y2 = Array.isArray(end) ? end[1] : end.y;

  return {
    bottom: Math.max(y1, y2),
    left: Math.min(x1, x2),
    right: Math.max(x1, x2),
    top: Math.min(y1, y2),
  };
}

function selectionRectContainsPoint(rect: SelectionRect, x: number, y: number) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function selectionRectIsTiny(rect: SelectionRect) {
  return rect.right - rect.left < 4 && rect.bottom - rect.top < 4;
}

function offsetSelectionRect(rect: SelectionRect, dx: number, dy: number): SelectionRect {
  return {
    bottom: rect.bottom + dy,
    left: rect.left + dx,
    right: rect.right + dx,
    top: rect.top + dy,
  };
}

function clampSelectionRectDelta(rect: SelectionRect, dx: number, dy: number) {
  return {
    dx: Math.max(-rect.left, Math.min(CANVAS_WIDTH - 1 - rect.right, Math.round(dx))),
    dy: Math.max(-rect.top, Math.min(CANVAS_HEIGHT - 1 - rect.bottom, Math.round(dy))),
  };
}

function offsetSelectionRects(rects: SelectionRect[], dx: number, dy: number) {
  return rects.map((rect) => offsetSelectionRect(rect, dx, dy));
}

function clampSelectionRectsDelta(rects: SelectionRect[], dx: number, dy: number) {
  const bounds = selectionBoundsFromRects(rects);
  if (!bounds) {
    return { dx: 0, dy: 0 };
  }

  return clampSelectionRectDelta(bounds, dx, dy);
}

function selectionBoundsFromRects(rects: SelectionRect[]) {
  if (rects.length === 0) {
    return null;
  }

  return rects.reduce<SelectionRect>((bounds, rect) => ({
    bottom: Math.max(bounds.bottom, rect.bottom),
    left: Math.min(bounds.left, rect.left),
    right: Math.max(bounds.right, rect.right),
    top: Math.min(bounds.top, rect.top),
  }), { ...rects[0] });
}

function pointInsideSelectionRects(rects: SelectionRect[], x: number, y: number) {
  return rects.some((rect) => selectionRectContainsPoint(rect, x, y));
}

function selectionEntityKey(entity: SelectedEntityRef) {
  if (entity.kind === 'city') {
    return `city:${entity.cityIndex}`;
  }

  return `${entity.kind}:${entity.teamIndex}:${entity.entityIndex}`;
}

function mergeSelectedEntities(current: SelectedEntityRef[], extra: SelectedEntityRef[]) {
  const seen = new Set(current.map(selectionEntityKey));
  const merged = [...current];

  for (const entity of extra) {
    const key = selectionEntityKey(entity);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entity);
  }

  return merged;
}

function subtractSelectedEntities(current: SelectedEntityRef[], removed: SelectedEntityRef[]) {
  const removedKeys = new Set(removed.map(selectionEntityKey));
  return current.filter((entity) => !removedKeys.has(selectionEntityKey(entity)));
}

function subtractRectFromRect(source: SelectionRect, cut: SelectionRect) {
  const overlapLeft = Math.max(source.left, cut.left);
  const overlapRight = Math.min(source.right, cut.right);
  const overlapTop = Math.max(source.top, cut.top);
  const overlapBottom = Math.min(source.bottom, cut.bottom);

  if (overlapLeft >= overlapRight || overlapTop >= overlapBottom) {
    return [source];
  }

  const fragments: SelectionRect[] = [];

  if (source.top < overlapTop) {
    fragments.push({ top: source.top, bottom: overlapTop, left: source.left, right: source.right });
  }

  if (overlapBottom < source.bottom) {
    fragments.push({ top: overlapBottom, bottom: source.bottom, left: source.left, right: source.right });
  }

  if (source.left < overlapLeft) {
    fragments.push({ top: overlapTop, bottom: overlapBottom, left: source.left, right: overlapLeft });
  }

  if (overlapRight < source.right) {
    fragments.push({ top: overlapTop, bottom: overlapBottom, left: overlapRight, right: source.right });
  }

  return fragments.filter((rect) => rect.right - rect.left > 1 && rect.bottom - rect.top > 1);
}

function subtractSelectionRects(current: SelectionRect[], cut: SelectionRect) {
  return current.flatMap((rect) => subtractRectFromRect(rect, cut));
}

function emptySelectionSession(): SelectionSession {
  return {
    active: false,
    marqueeRect: null,
    mode: 'select',
    moved: false,
    operation: 'replace',
    originMap: null,
    originRects: [],
    pointerId: null,
    start: null,
  };
}

function hoverTargetKey(target: HoverTarget | null) {
  if (!target) return 'none';
  if (target.type === 'terrain') return `terrain:${target.terrainHex}:${target.label}`;
  if (target.type === 'bridge' && target.bridge) {
    const [[x1, y1], [x2, y2]] = target.bridge;
    return `bridge:${x1}:${y1}:${x2}:${y2}`;
  }
  if (target.type === 'infantry' || target.type === 'tank') {
    return `${target.type}:${target.teamIndex}:${target.entityIndex}`;
  }
  if (target.type === 'city' || target.type === 'capital') {
    return `${target.type}:${target.cityIndex}`;
  }
  return `${target.type}:${target.removeLabel}`;
}

interface ToolIconProps {
  selectedTeam: number;
  teamCount: number;
  toolId: ToolId;
}

function ControlGlyph({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden="true" className="help-row-icon" strokeWidth={2} />;
}

function ToolIcon({ selectedTeam, teamCount, toolId }: ToolIconProps) {
  const teamColor = teamColorForIndex(selectedTeam);

  if (toolId === 'infantry' || toolId === 'tank') {
    return (
      <img
        alt=""
        className="tool-icon-image"
        draggable={false}
        src={spriteAssets[teamColor][toolId === 'infantry' ? 'infantry' : 'tank']}
      />
    );
  }

  if (toolId === 'city' || toolId === 'capital') {
    return <img alt="" className="tool-icon-image" draggable={false} src={toolId === 'city' ? uiAssets.city : uiAssets.capital} />;
  }

  if (toolId === 'terrainFill') {
    return <img alt="" className="tool-icon-image" draggable={false} src={uiAssets.fill} />;
  }

  const svgClassName = 'tool-icon-svg';
  switch (toolId) {
    case 'terrainBrush':
      return (
        <svg aria-hidden="true" className={svgClassName} viewBox="0 0 24 24">
          <path d="M15.8 3.2 20.8 8.2 10.2 18.8 5.2 13.8Z" fill="currentColor" opacity="0.85" />
          <path d="M4.5 19.5c0-2.1 1.7-3.8 3.8-3.8h1.4v1.4c0 2.1-1.7 3.8-3.8 3.8H4.5Z" fill="currentColor" />
        </svg>
      );
    case 'terrainLine':
      return (
        <svg aria-hidden="true" className={svgClassName} viewBox="0 0 24 24">
          <path d="M5 18 18 5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
          <circle cx="5" cy="18" fill="currentColor" r="2" />
          <circle cx="18" cy="5" fill="currentColor" r="2" />
        </svg>
      );
    case 'terrainRect':
      return (
        <svg aria-hidden="true" className={svgClassName} viewBox="0 0 24 24">
          <rect fill="none" height="12" rx="1.5" stroke="currentColor" strokeWidth="2.5" width="16" x="4" y="6" />
        </svg>
      );
    case 'terrainShape':
      return (
        <svg aria-hidden="true" className={svgClassName} viewBox="0 0 24 24">
          <path d="M4.5 14.5c2.5-6 6.5-9 10.5-6 2.7 2 4.5 1.7 4.5 5 0 3.5-3.5 6-7.8 6-4.5 0-8.2-1.8-7.2-5Z" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="7" cy="14" fill="currentColor" r="1.4" />
          <circle cx="17" cy="9" fill="currentColor" r="1.4" />
        </svg>
      );
    case 'bridge':
      return (
        <svg aria-hidden="true" className={svgClassName} viewBox="0 0 24 24">
          <path d="M4 15h16" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
          <path d="M7 15V9m10 6V9" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M7 9c1.2 1 2.8 1.5 5 1.5S15.8 10 17 9" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case 'select':
      return (
        <svg aria-hidden="true" className={svgClassName} viewBox="0 0 24 24">
          <rect fill="none" height="12" rx="1.4" stroke="currentColor" strokeDasharray="3 2" strokeWidth="1.8" width="14" x="4" y="5" />
          <path d="m16 14 3.7 5.3 1.3-1.1-3.2-3.9 3.6-.9-6.6-3.2Z" fill="currentColor" />
        </svg>
      );
    case 'erase':
      return (
        <svg aria-hidden="true" className={svgClassName} viewBox="0 0 24 24">
          <path d="m7 16 5-8 5 8-2 3H9Z" fill="currentColor" opacity="0.9" />
          <path d="M6 18h12" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        </svg>
      );
    default:
      return null;
  }
}

function drawMarkerImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  size: number,
  fallback: string,
) {
  if (image.complete && image.naturalWidth > 0) {
    ctx.save();
    disableSmoothing(ctx);
    ctx.drawImage(image, x - size / 2, y - size / 2, size, size);
    ctx.restore();
    return;
  }

  ctx.fillStyle = fallback;
  ctx.beginPath();
  ctx.arc(x, y, size / 2.2, 0, Math.PI * 2);
  ctx.fill();
}

export function EditorScreen({ initialMap, saveMap, onClose, registerLeaveGuard }: EditorScreenProps) {
  const [draft, setDraft] = useState(() => cloneMapRecord(initialMap));
  setCanvasSize(draft.width, draft.height);
  const [selectedTool, setSelectedTool] = useState<ToolId>('terrainBrush');
  const [selectedTeam, setSelectedTeam] = useState(0);
  const [terrainColor, setTerrainColor] = useState(DEFAULT_TERRAIN_HEX);
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const [terrainRectFilled, setTerrainRectFilled] = useState(true);
  const [terrainShapeFilled, setTerrainShapeFilled] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [expandedPanels, setExpandedPanels] = useState<Record<PanelKey, boolean>>({ map: false, terrain: true, units: false });
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 900);
  const [helpOpen, setHelpOpen] = useState(false);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const [ready, setReady] = useState(false);
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const [leavePromptError, setLeavePromptError] = useState('');
  const [hoverTarget, setHoverTarget] = useState<HoverTarget | null>(null);
  const [shapePointCount, setShapePointCount] = useState(0);
  const [isPanDragging, setIsPanDragging] = useState(false);
  const [isSpacePanActive, setIsSpacePanActive] = useState(false);
  const [selectedEntities, setSelectedEntities] = useState<SelectedEntityRef[]>([]);
  const [selectionRects, setSelectionRects] = useState<SelectionRect[]>([]);

  // mirrors of state for stable handler access (avoids stale closures + extra effects)
  const draftRef = useRef(draft);
  const selectedToolRef = useRef(selectedTool);
  const selectedTeamRef = useRef(selectedTeam);
  const terrainColorRef = useRef(terrainColor);
  const brushSizeRef = useRef(brushSize);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const spacePanActiveRef = useRef(false);
  const selectedEntitiesRef = useRef(selectedEntities);
  const selectionRectsRef = useRef(selectionRects);
  draftRef.current = draft;
  selectedToolRef.current = selectedTool;
  selectedTeamRef.current = selectedTeam;
  terrainColorRef.current = terrainColor;
  brushSizeRef.current = brushSize;
  zoomRef.current = zoom;
  panRef.current = pan;
  selectedEntitiesRef.current = selectedEntities;
  selectionRectsRef.current = selectionRects;

  // canvas refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const terrainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const terrainCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  // render loop
  const frameRef = useRef<number | null>(null);
  const sceneDirtyRef = useRef(true);
  const overlayDirtyRef = useRef(true);

  // interaction
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const hoverTargetRef = useRef<HoverTarget | null>(null);
  const bridgeStartRef = useRef<Point | null>(null);
  const shapePointsRef = useRef<Point[]>([]);
  const paintSessionRef = useRef<{
    active: boolean;
    pointerId: number | null;
    start: { x: number; y: number } | null;
    last: { x: number; y: number } | null;
    snapshot: ImageData | null;
    dirty: boolean;
  }>({ active: false, pointerId: null, start: null, last: null, snapshot: null, dirty: false });
  const entityBrushSessionRef = useRef<EntityBrushSession>({
    active: false,
    dirty: false,
    last: null,
    pointerId: null,
    tool: null,
    working: null,
  });
  const moveSessionRef = useRef<MoveSession>({
    active: false,
    moved: false,
    origin: null,
    pointerId: null,
    target: null,
    working: null,
  });
  const selectionSessionRef = useRef<SelectionSession>(emptySelectionSession());
  const panSessionRef = useRef<PanSession>({
    active: false,
    moved: false,
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    trigger: 'middle',
  });

  // history (in-memory, no base64)
  const historyRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);

  // save state
  const dirtyRef = useRef(false);
  const leavePromptResolverRef = useRef<((result: LeaveResult) => void) | null>(null);
  const mountedRef = useRef(true);

  const counts = useMemo(() => createDraftCounts(draft), [draft]);
  const teamCount = teamsForMap(draft);
  const canvasStackStyle = useMemo(
    () => ({
      '--editor-pan-x': `${pan.x}px`,
      '--editor-pan-y': `${pan.y}px`,
      '--editor-zoom': String(zoom),
    } as CSSProperties),
    [pan.x, pan.y, zoom],
  );

  const requestDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (!mountedRef.current) return;
      if (sceneDirtyRef.current) {
        drawScene();
        sceneDirtyRef.current = false;
      }
      if (overlayDirtyRef.current) {
        drawOverlay();
        overlayDirtyRef.current = false;
      }
    });
  }, []);

  const getCanvasMetrics = useCallback(() => {
    const stage = stageRef.current;
    const canvas = overlayRef.current;
    if (!stage || !canvas) {
      return null;
    }

    const currentZoom = zoomRef.current;
    const stageRect = stage.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const baseWidth = canvas.clientWidth || canvasRect.width / currentZoom;
    const baseHeight = canvas.clientHeight || canvasRect.height / currentZoom;

    return {
      baseHeight,
      baseWidth,
      stageRect,
    };
  }, []);

  const setPanClamped = useCallback((nextPan: { x: number; y: number }, zoomValue = zoomRef.current) => {
    const metrics = getCanvasMetrics();
    const clamped = metrics
      ? clampPan(nextPan, zoomValue, { height: metrics.baseHeight, width: metrics.baseWidth })
      : nextPan;

    panRef.current = clamped;
    setPan(clamped);
    return clamped;
  }, [getCanvasMetrics]);

  // ────────────────────────────────────────────────────────────
  // Init
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    document.title = `${initialMap.name} - WoD Map Editor`;

    const terrain = document.createElement('canvas');
    terrain.width = CANVAS_WIDTH;
    terrain.height = CANVAS_HEIGHT;
    const tctx = terrain.getContext('2d', { willReadFrequently: true });
    terrainCanvasRef.current = terrain;
    terrainCtxRef.current = tctx;

    if (tctx) {
      disableSmoothing(tctx);
      tctx.fillStyle = DEFAULT_TERRAIN_HEX;
      tctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    historyRef.current = [];
    futureRef.current = [];

    const preloadList: string[] = [uiAssets.city, uiAssets.capital];
    for (const color of TEAM_COLORS) {
      preloadList.push(spriteAssets[color].infantry, spriteAssets[color].tank);
      preloadList.push(flagAssets[color]);
    }
    void preloadImages(preloadList).then(() => {
      sceneDirtyRef.current = true;
      requestDraw();
    });

    void (async () => {
      if (initialMap.data.map_surface && tctx) {
        const image = await loadImageFromBase64(initialMap.data.map_surface);
        if (!mountedRef.current) return;
        if (image.naturalWidth > 0) tctx.drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
      if (!mountedRef.current) return;
      historyRef.current = [snapshotHistory()];
      updateHistoryState();
      setReady(true);
      sceneDirtyRef.current = true;
      requestDraw();
    })();

    return () => {
      mountedRef.current = false;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null; // critical: prevent permanently stuck "frame pending" after remount
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.title = `${draft.name || 'Untitled map'} - WoD Map Editor`;
  }, [draft.name]);

  useEffect(() => {
    let wasWide = window.innerWidth > 900;
    const handleResponsiveSidebar = () => {
      const isWide = window.innerWidth > 900;
      if (isWide === wasWide) return;
      wasWide = isWide;
      setSidebarOpen(isWide);
    };
    window.addEventListener('resize', handleResponsiveSidebar);
    return () => window.removeEventListener('resize', handleResponsiveSidebar);
  }, []);

  // Ensure draw after layout commits
  useLayoutEffect(() => {
    sceneDirtyRef.current = true;
    overlayDirtyRef.current = true;
    requestDraw();
  });

  // DPR + zoom-aware canvas backing size to keep zoomed sprites crisp.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const renderScale = Math.min(4, Math.max(dpr, dpr * Math.max(1, zoom)));
      const sync = (canvas: HTMLCanvasElement | null) => {
        if (!canvas) return;
        const w = Math.max(1, Math.round(canvas.clientWidth * renderScale));
        const h = Math.max(1, Math.round(canvas.clientHeight * renderScale));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
      };
      sync(canvasRef.current);
      sync(overlayRef.current);
      setPanClamped(panRef.current);
      sceneDirtyRef.current = true;
      overlayDirtyRef.current = true;
      requestDraw();
    };
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    update();
    return () => ro.disconnect();
  }, [requestDraw, setPanClamped, zoom]);

  // Native non-passive wheel listener (React synthetic onWheel is passive)
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const step = event.shiftKey ? 6 : 2;
        setBrushSize((current) =>
          Math.max(1, Math.min(120, current + (event.deltaY < 0 ? step : -step))),
        );
      } else {
        const step = event.shiftKey ? 0.2 : 0.1;
        const currentZoom = zoomRef.current;
        const nextZoom = clampZoom(currentZoom + (event.deltaY < 0 ? step : -step));
        if (nextZoom !== currentZoom) {
          const metrics = getCanvasMetrics();
          if (metrics) {
            const stageCenterX = metrics.stageRect.left + metrics.stageRect.width / 2;
            const stageCenterY = metrics.stageRect.top + metrics.stageRect.height / 2;
            const localX = (event.clientX - stageCenterX - panRef.current.x) / currentZoom;
            const localY = (event.clientY - stageCenterY - panRef.current.y) / currentZoom;
            const nextPan = {
              x: event.clientX - stageCenterX - localX * nextZoom,
              y: event.clientY - stageCenterY - localY * nextZoom,
            };
            setPanClamped(nextPan, nextZoom);
          }
          zoomRef.current = nextZoom;
          setZoom(nextZoom);
        }
      }
      overlayDirtyRef.current = true;
      sceneDirtyRef.current = true;
      requestDraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [getCanvasMetrics, requestDraw, setPanClamped]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextInputTarget(event.target)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        spacePanActiveRef.current = true;
        setIsSpacePanActive(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey)) {
        const key = event.key.toLowerCase();
        if (key === 'z' && !event.shiftKey) { event.preventDefault(); handleUndo(); return; }
        if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); handleRedo(); return; }
        return;
      }
      if (event.key === 'Escape') {
        setIsPanDragging(false);
        if (moveSessionRef.current.active && moveSessionRef.current.origin) {
          previewDraft(cloneMapRecord(moveSessionRef.current.origin));
        }
        paintSessionRef.current.active = false;
        paintSessionRef.current.snapshot = null;
        entityBrushSessionRef.current = { active: false, dirty: false, last: null, pointerId: null, tool: null, working: null };
        moveSessionRef.current = { active: false, moved: false, origin: null, pointerId: null, target: null, working: null };
        selectionSessionRef.current = emptySelectionSession();
        bridgeStartRef.current = null;
        shapePointsRef.current = [];
        clearSelection();
        hoverPointRef.current = null;
        sceneDirtyRef.current = true;
        overlayDirtyRef.current = true;
        requestDraw();
        return;
      }

      const k = event.key.toLowerCase();
      const map: Record<string, ToolId> = {
        b: 'terrainBrush', l: 'terrainLine', r: 'terrainRect', f: 'terrainFill', s: 'terrainShape',
        q: 'select', i: 'infantry', t: 'tank', c: 'city', k: 'capital', g: 'bridge', e: 'erase',
      };
      if (map[k]) { activateTool(map[k]); return; }
      if (k === '[') setBrushSize((s) => Math.max(1, s - 2));
      if (k === ']') setBrushSize((s) => Math.min(120, s + 2));
      if (/^[1-4]$/.test(k)) {
        const teamOrder = visibleTeamOrder(teamCount);
        const displayIndex = parseInt(k, 10) - 1;
        const team = teamOrder[displayIndex];
        if (team !== undefined) setSelectedTeam(team);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spacePanActiveRef.current = false;
        setIsSpacePanActive(false);
      }
    };
    const onBlur = () => {
      spacePanActiveRef.current = false;
      setIsSpacePanActive(false);
      setIsPanDragging(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamCount]);

  // Mark dirty when relevant state changes
  useEffect(() => {
    sceneDirtyRef.current = true;
    overlayDirtyRef.current = true;
    requestDraw();
  }, [draft, ready, selectedTool, selectedTeam, terrainColor, brushSize, zoom, requestDraw]);

  useEffect(() => {
    if (!hoverPointRef.current) {
      syncHoverTarget(null);
      return;
    }
    syncHoverTarget(findHoverTarget(hoverPointRef.current.x, hoverPointRef.current.y));
  }, [draft]);

  useEffect(() => {
    if (selectedTeam >= teamCount) setSelectedTeam(0);
  }, [selectedTeam, teamCount]);

  useEffect(() => {
    setPanClamped(panRef.current);
  }, [setPanClamped, zoom]);

  useEffect(() => {
    if (selectedTool !== 'select' && (selectedEntitiesRef.current.length > 0 || selectionRectsRef.current.length > 0)) {
      clearSelection();
    }
  }, [selectedTool]);

  // ────────────────────────────────────────────────────────────
  // Rendering
  // ────────────────────────────────────────────────────────────
  function drawScene() {
    const canvas = canvasRef.current;
    const terrain = terrainCanvasRef.current;
    if (!canvas || !terrain) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    disableSmoothing(ctx);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(terrain, 0, 0, w, h);

    ctx.save();
    ctx.scale(w / CANVAS_WIDTH, h / CANVAS_HEIGHT);
    disableSmoothing(ctx);

    // Bridges
    ctx.strokeStyle = BRIDGE_COLOR;
    ctx.lineWidth = BRIDGE_WIDTH;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    for (const [[x1, y1], [x2, y2]] of draftRef.current.data.bridges) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Cities / capitals
    const cityImg = getCachedImage(uiAssets.city);
    const capitalImg = getCachedImage(uiAssets.capital);
    draftRef.current.data.cities.forEach((point, index) => {
      const isCapital = draftRef.current.data.capitals.includes(index);
      const img = isCapital ? capitalImg : cityImg;
      const size = scaledIconSize(isCapital ? CAPITAL_SIZE : CITY_SIZE);
      drawMarkerImage(ctx, img, point[0], point[1], size, isCapital ? '#f7ca5d' : '#e9eef6');
    });

    // Units
    draftRef.current.data.infantry.forEach((team, ti) => {
      const teamColor = teamColorForIndex(ti);
      const img = getCachedImage(spriteAssets[teamColor].infantry);
      for (const [x, y] of team) drawSprite(ctx, img, x, y, scaledIconSize(SPRITE_SIZE), teamAccent(ti, teamCount));
    });
    draftRef.current.data.tanks.forEach((team, ti) => {
      const teamColor = teamColorForIndex(ti);
      const img = getCachedImage(spriteAssets[teamColor].tank);
      for (const [x, y] of team) drawSprite(ctx, img, x, y, scaledIconSize(SPRITE_SIZE + 4), teamAccent(ti, teamCount));
    });

    ctx.restore();
  }

  function drawBridgeHoverHighlight(ctx: CanvasRenderingContext2D) {
    const target = hoverTargetRef.current;
    if (selectedToolRef.current === 'bridge' && target?.type === 'bridge' && target.bridge) {
      ctx.save();
      ctx.strokeStyle = target.color;
      ctx.lineWidth = BRIDGE_WIDTH + 1;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(target.bridge[0][0], target.bridge[0][1]);
      ctx.lineTo(target.bridge[1][0], target.bridge[1][1]);
      ctx.stroke();
      ctx.restore();
    }
  }

  function selectionEntityPoint(map: StoredMap, entity: SelectedEntityRef): Point | null {
    if (entity.kind === 'city') {
      return map.data.cities[entity.cityIndex] ?? null;
    }

    if (entity.kind === 'infantry') {
      return map.data.infantry[entity.teamIndex]?.[entity.entityIndex] ?? null;
    }

    return map.data.tanks[entity.teamIndex]?.[entity.entityIndex] ?? null;
  }

  function setSelectionEntityPoint(map: StoredMap, entity: SelectedEntityRef, point: Point) {
    if (entity.kind === 'city') {
      if (map.data.cities[entity.cityIndex]) {
        map.data.cities[entity.cityIndex] = point;
      }
      return;
    }

    if (entity.kind === 'infantry') {
      if (map.data.infantry[entity.teamIndex]?.[entity.entityIndex]) {
        map.data.infantry[entity.teamIndex][entity.entityIndex] = point;
      }
      return;
    }

    if (map.data.tanks[entity.teamIndex]?.[entity.entityIndex]) {
      map.data.tanks[entity.teamIndex][entity.entityIndex] = point;
    }
  }

  function selectionRectFromEntities(map: StoredMap, entities: SelectedEntityRef[]) {
    const points = entities
      .map((entity) => selectionEntityPoint(map, entity))
      .filter((point): point is Point => point !== null);

    if (points.length === 0) {
      return null;
    }

    let left = points[0][0];
    let right = points[0][0];
    let top = points[0][1];
    let bottom = points[0][1];

    for (const [x, y] of points) {
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }

    const padding = scaledIconSize(20);
    return {
      bottom: Math.min(CANVAS_HEIGHT - 1, bottom + padding),
      left: Math.max(0, left - padding),
      right: Math.min(CANVAS_WIDTH - 1, right + padding),
      top: Math.max(0, top - padding),
    };
  }

  function selectedEntityFromHoverTarget(target: HoverTarget | null): SelectedEntityRef | null {
    if (!target) {
      return null;
    }

    if (target.type === 'city' || target.type === 'capital') {
      return { kind: 'city', cityIndex: target.cityIndex };
    }

    if (target.type === 'infantry' || target.type === 'tank') {
      return { kind: target.type, entityIndex: target.entityIndex, teamIndex: target.teamIndex };
    }

    return null;
  }

  function selectedEntitiesInRect(map: StoredMap, rect: SelectionRect) {
    const next: SelectedEntityRef[] = [];

    map.data.infantry.forEach((team, teamIndex) => team.forEach((point, entityIndex) => {
      if (selectionRectContainsPoint(rect, point[0], point[1])) {
        next.push({ kind: 'infantry', entityIndex, teamIndex });
      }
    }));

    map.data.tanks.forEach((team, teamIndex) => team.forEach((point, entityIndex) => {
      if (selectionRectContainsPoint(rect, point[0], point[1])) {
        next.push({ kind: 'tank', entityIndex, teamIndex });
      }
    }));

    map.data.cities.forEach((point, cityIndex) => {
      if (selectionRectContainsPoint(rect, point[0], point[1])) {
        next.push({ kind: 'city', cityIndex });
      }
    });

    return next;
  }

  function applySelectionState(nextEntities: SelectedEntityRef[], nextRects: SelectionRect[]) {
    selectedEntitiesRef.current = nextEntities;
    selectionRectsRef.current = nextRects;
    setSelectedEntities(nextEntities);
    setSelectionRects(nextRects);
    overlayDirtyRef.current = true;
    requestDraw();
  }

  function clearSelection() {
    applySelectionState([], []);
    selectionSessionRef.current = emptySelectionSession();
  }

  function drawSelectionOverlay(ctx: CanvasRenderingContext2D) {
    const capitalSet = new Set(draftRef.current.data.capitals);
    const marqueeRect = selectionSessionRef.current.active && selectionSessionRef.current.mode === 'select'
      ? selectionSessionRef.current.marqueeRect
      : null;

    for (const entity of selectedEntitiesRef.current) {
      const point = selectionEntityPoint(draftRef.current, entity);
      if (!point) {
        continue;
      }

      const color = entity.kind === 'city'
        ? (capitalSet.has(entity.cityIndex) ? '#f7ca5d' : '#8ad8ff')
        : teamAccent(entity.teamIndex, teamCount);

      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      if (entity.kind === 'tank') {
        const width = scaledIconSize(24);
        const height = scaledIconSize(20);
        ctx.fillRect(point[0] - width / 2, point[1] - height / 2, width, height);
      } else {
        const radius = scaledIconSize(entity.kind === 'city' ? (capitalSet.has(entity.cityIndex) ? 16 : 14) : 13);
        ctx.beginPath();
        ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      if (entity.kind === 'tank') {
        const width = scaledIconSize(24);
        const height = scaledIconSize(20);
        ctx.strokeRect(point[0] - width / 2, point[1] - height / 2, width, height);
      } else {
        const radius = scaledIconSize(entity.kind === 'city' ? (capitalSet.has(entity.cityIndex) ? 16 : 14) : 13);
        ctx.beginPath();
        ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const rect of selectionRectsRef.current) {
      ctx.save();
      ctx.strokeStyle = 'rgba(138, 216, 255, 0.95)';
      ctx.fillStyle = 'rgba(138, 216, 255, 0.08)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 5]);
      ctx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
      ctx.strokeRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
      ctx.setLineDash([]);
      for (const [x, y] of [
        [rect.left, rect.top],
        [rect.right, rect.top],
        [rect.left, rect.bottom],
        [rect.right, rect.bottom],
      ]) {
        ctx.fillRect(x - 2, y - 2, 4, 4);
      }
      ctx.restore();
    }

    if (!marqueeRect) {
      return;
    }

    ctx.save();
    ctx.strokeStyle = selectionSessionRef.current.operation === 'subtract' ? 'rgba(239, 107, 102, 0.96)' : 'rgba(138, 216, 255, 0.96)';
    ctx.fillStyle = selectionSessionRef.current.operation === 'subtract' ? 'rgba(239, 107, 102, 0.10)' : 'rgba(138, 216, 255, 0.08)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.fillRect(marqueeRect.left, marqueeRect.top, marqueeRect.right - marqueeRect.left, marqueeRect.bottom - marqueeRect.top);
    ctx.strokeRect(marqueeRect.left, marqueeRect.top, marqueeRect.right - marqueeRect.left, marqueeRect.bottom - marqueeRect.top);
    ctx.setLineDash([]);
    for (const [x, y] of [
      [marqueeRect.left, marqueeRect.top],
      [marqueeRect.right, marqueeRect.top],
      [marqueeRect.left, marqueeRect.bottom],
      [marqueeRect.right, marqueeRect.bottom],
    ]) {
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    ctx.restore();
  }

  function drawOverlay() {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    disableSmoothing(ctx);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(w / CANVAS_WIDTH, h / CANVAS_HEIGHT);
    disableSmoothing(ctx);

    const tool = selectedToolRef.current;
    const hover = hoverPointRef.current;
    const shapePoints = shapePointsRef.current;

    if (tool === 'bridge' && bridgeStartRef.current) {
      ctx.fillStyle = BRIDGE_COLOR;
      ctx.fillRect(bridgeStartRef.current[0] - 4, bridgeStartRef.current[1] - 4, 8, 8);
      if (hover) {
        ctx.strokeStyle = BRIDGE_COLOR;
        ctx.lineWidth = Math.max(2, BRIDGE_WIDTH - 2);
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(bridgeStartRef.current[0], bridgeStartRef.current[1]);
        ctx.lineTo(hover.x, hover.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (tool === 'terrainShape' && shapePoints.length > 0) {
      const previewPoints = hover ? [...shapePoints, [hover.x, hover.y] as Point] : shapePoints;

      if (previewPoints.length >= 2) {
        const sampled = previewPoints.length >= 3 ? sampleClosedBezierShape(previewPoints) : previewPoints;
        for (let index = 0; index < sampled.length; index += 1) {
          const start = sampled[index];
          const end = sampled[(index + 1) % sampled.length];
          if (previewPoints.length === 2 && index === sampled.length - 1) {
            break;
          }
          drawSegment(ctx, { x: start[0], y: start[1] }, { x: end[0], y: end[1] }, 1, terrainColorRef.current);
        }
      }

      for (const point of shapePoints) {
        ctx.fillStyle = terrainColorRef.current;
        ctx.fillRect(point[0] - 1, point[1] - 1, 3, 3);
      }
    }

    if (tool === 'select' || selectedEntitiesRef.current.length > 0 || selectionSessionRef.current.active) {
      drawSelectionOverlay(ctx);
    }

    drawBridgeHoverHighlight(ctx);

    if (hover) {
      if (tool === 'terrainBrush' || tool === 'terrainLine') {
        drawCircleOutline(ctx, hover, brushSizeRef.current, terrainColorRef.current);
      } else if (tool === 'tank' || tool === 'capital') {
        const size = tool === 'tank'
          ? scaledHitRadius() * 2
          : Math.max(scaledHitRadius() * 2, Math.round(brushSizeRef.current));
        const color = tool === 'tank' ? teamAccent(selectedTeamRef.current, teamCount) : '#f7ca5d';
        drawCircleOutline(ctx, hover, size, color);
      } else if (tool !== 'bridge' && tool !== 'select') {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hover.x, hover.y, scaledHitRadius(), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  function drawSprite(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    x: number,
    y: number,
    size: number,
    fallback: string,
  ) {
    if (image.complete && image.naturalWidth > 0) {
      ctx.save();
      disableSmoothing(ctx);
      ctx.drawImage(image, x - size / 2, y - size / 2, size, size);
      ctx.restore();
      return;
    }
    ctx.fillStyle = fallback;
    ctx.beginPath();
    ctx.arc(x, y, size / 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // ────────────────────────────────────────────────────────────
  // History
  // ────────────────────────────────────────────────────────────
  function snapshotHistory(): HistoryEntry {
    const tctx = terrainCtxRef.current;
    const surface = tctx ? tctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT) : null;
    return {
      data: cloneMapData(draftRef.current.data),
      height: draftRef.current.height || CANVAS_HEIGHT,
      surface,
      width: draftRef.current.width || CANVAS_WIDTH,
    };
  }

  function pushHistory() {
    historyRef.current.push(snapshotHistory());
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    futureRef.current = [];
    updateHistoryState();
    markDirty();
  }

  function updateHistoryState() {
    setHistoryState({
      canUndo: historyRef.current.length > 1,
      canRedo: futureRef.current.length > 0,
    });
  }

  function restoreHistory(entry: HistoryEntry) {
    const terrain = terrainCanvasRef.current;
    const width = entry.width || CANVAS_WIDTH;
    const height = entry.height || CANVAS_HEIGHT;
    setCanvasSize(width, height);
    if (terrain) {
      terrain.width = width;
      terrain.height = height;
      const tctx = terrain.getContext('2d', { willReadFrequently: true });
      terrainCtxRef.current = tctx;
      if (tctx) {
        disableSmoothing(tctx);
        if (entry.surface) tctx.putImageData(entry.surface, 0, 0);
      }
    }
    const next: StoredMap = { ...draftRef.current, width, height, data: cloneMapData(entry.data) };
    draftRef.current = next;
    setDraft(next);
    sceneDirtyRef.current = true;
    overlayDirtyRef.current = true;
    requestDraw();
    markDirty();
  }

  function handleUndo() {
    if (historyRef.current.length < 2) return;
    const current = historyRef.current.pop();
    if (current) futureRef.current.push(current);
    const previous = historyRef.current[historyRef.current.length - 1];
    if (previous) restoreHistory(previous);
    updateHistoryState();
  }

  function handleRedo() {
    const entry = futureRef.current.pop();
    if (!entry) return;
    historyRef.current.push(entry);
    restoreHistory(entry);
    updateHistoryState();
  }

  // ────────────────────────────────────────────────────────────
  // Save state
  // ────────────────────────────────────────────────────────────
  function markDirty() {
    dirtyRef.current = true;
    setSaveState('dirty');
  }

  function buildSyncedMap(source = draftRef.current): StoredMap {
    const terrain = terrainCanvasRef.current;
    const next = cloneMapRecord(source);
    if (terrain) next.data.map_surface = base64PngFromCanvas(terrain);
    return next;
  }

  async function persistNow() {
    if (!dirtyRef.current) return draftRef.current;
    if (!mountedRef.current) return draftRef.current;
    setSaveState('saving');
    const saved = await saveMap(buildSyncedMap());
    dirtyRef.current = false;
    if (!mountedRef.current) return saved;
    draftRef.current = { ...saved };
    setDraft(saved);
    setSaveState('saved');
    return saved;
  }

  function resolveLeavePrompt(result: LeaveResult) {
    const resolve = leavePromptResolverRef.current;
    leavePromptResolverRef.current = null;
    setLeavePromptOpen(false);
    setLeavePromptError('');
    resolve?.(result);
  }

  function requestLeave(): Promise<LeaveResult> {
    if (!dirtyRef.current) {
      return Promise.resolve(draftRef.current);
    }

    if (leavePromptResolverRef.current) {
      return Promise.resolve(false);
    }

    setLeavePromptError('');
    setLeavePromptOpen(true);
    return new Promise((resolve) => {
      leavePromptResolverRef.current = resolve;
    });
  }

  async function saveAndLeave() {
    setLeavePromptError('');
    try {
      const saved = await persistNow();
      resolveLeavePrompt(saved);
    } catch (error) {
      setSaveState('dirty');
      setLeavePromptError(error instanceof Error ? error.message : 'Unable to save map.');
    }
  }

  function discardAndLeave() {
    dirtyRef.current = false;
    setSaveState('saved');
    resolveLeavePrompt(null);
  }

  function cancelLeave() {
    resolveLeavePrompt(false);
  }

  useEffect(() => {
    if (!registerLeaveGuard) return undefined;
    registerLeaveGuard(async () => (await requestLeave()) !== false);
    return () => registerLeaveGuard(null);
  });

  // ────────────────────────────────────────────────────────────
  // Tools / placement
  // ────────────────────────────────────────────────────────────
  function activateTool(toolId: ToolId) {
    setSelectedTool(toolId);
    setExpandedPanels((current) => ({ ...current, [panelForTool(toolId)]: true }));
    bridgeStartRef.current = null;
    shapePointsRef.current = [];
    setShapePointCount(0);
    paintSessionRef.current.snapshot = null;
    paintSessionRef.current.active = false;
    entityBrushSessionRef.current = { active: false, dirty: false, last: null, pointerId: null, tool: null, working: null };
    selectionSessionRef.current = emptySelectionSession();
    sceneDirtyRef.current = true;
    overlayDirtyRef.current = true;
    requestDraw();
  }

  function togglePanel(panel: PanelKey) {
    setExpandedPanels((current) => ({
      map: panel === 'map' ? !current.map : false,
      terrain: panel === 'terrain' ? !current.terrain : false,
      units: panel === 'units' ? !current.units : false,
    }));
  }

  function syncHoverTarget(next: HoverTarget | null) {
    if (hoverTargetKey(hoverTargetRef.current) === hoverTargetKey(next)) {
      hoverTargetRef.current = next;
      return;
    }
    hoverTargetRef.current = next;
    setHoverTarget(next);
  }

  function findHoverTarget(x: number, y: number): HoverTarget | null {
    const hits: Array<{ distance: number; target: HoverTarget }> = [];
    const unitRadius = scaledHitRadius();
    const unitRadiusSquared = unitRadius * unitRadius;

    draftRef.current.data.infantry.forEach((team, teamIndex) => team.forEach((point, entityIndex) => {
      const distance = (point[0] - x) ** 2 + (point[1] - y) ** 2;
      if (distance <= unitRadiusSquared) {
        const teamColor = teamColorForIndex(teamIndex);
        const teamName = TEAM_LABELS[teamColor];
        hits.push({
          distance,
          target: {
            type: 'infantry',
            entityIndex,
            label: `${teamName} infantry`,
            removeLabel: `${teamName.toLowerCase()} infantry`,
            point,
            color: TEAM_ACCENTS[teamColor],
            teamIndex,
          },
        });
      }
    }));

    draftRef.current.data.tanks.forEach((team, teamIndex) => team.forEach((point, entityIndex) => {
      const distance = (point[0] - x) ** 2 + (point[1] - y) ** 2;
      if (distance <= unitRadiusSquared) {
        const teamColor = teamColorForIndex(teamIndex);
        const teamName = TEAM_LABELS[teamColor];
        hits.push({
          distance,
          target: {
            type: 'tank',
            entityIndex,
            label: `${teamName} tank`,
            removeLabel: `${teamName.toLowerCase()} tank`,
            point,
            color: TEAM_ACCENTS[teamColor],
            teamIndex,
          },
        });
      }
    }));

    const capitalSet = new Set(draftRef.current.data.capitals);
    draftRef.current.data.cities.forEach((point, index) => {
      const isCapital = capitalSet.has(index);
      const radius = Math.max(scaledHitRadius(), Math.round(scaledIconSize(isCapital ? CAPITAL_SIZE : CITY_SIZE) / 2));
      const distance = (point[0] - x) ** 2 + (point[1] - y) ** 2;
      if (distance <= radius * radius) {
        hits.push({
          distance,
          target: {
            type: isCapital ? 'capital' : 'city',
            cityIndex: index,
            label: isCapital ? 'Capital' : 'City',
            removeLabel: isCapital ? 'capital' : 'city',
            point,
            color: isCapital ? '#f7ca5d' : '#d7ecff',
          },
        });
      }
    });

    draftRef.current.data.bridges.forEach((bridge) => {
      const distance = pointToSegmentDistance(x, y, bridge[0][0], bridge[0][1], bridge[1][0], bridge[1][1]);
      if (distance <= scaledHitRadius()) {
        hits.push({
          distance,
          target: {
            type: 'bridge',
            label: 'Bridge',
            removeLabel: 'bridge',
            bridge,
            color: BRIDGE_COLOR,
          },
        });
      }
    });

    if (hits.length > 0) {
      hits.sort((left, right) => left.distance - right.distance);
      return hits[0].target;
    }

    const terrainContext = terrainCtxRef.current;
    if (!terrainContext) return null;
    const pixel = terrainContext.getImageData(x, y, 1, 1).data;
    const terrainHex = nearestTerrainHex(rgbToHex(pixel[0], pixel[1], pixel[2]));
    const terrain = TERRAIN_COLORS.find((entry) => entry.hex === terrainHex);
    return {
      type: 'terrain',
      label: `${terrain?.name ?? 'Terrain'} terrain`,
      terrainHex,
    };
  }

  function previewDraft(next: StoredMap) {
    draftRef.current = next;
    setDraft(next);
    sceneDirtyRef.current = true;
    requestDraw();
  }

  function commitDraft(next: StoredMap, withHistory = true) {
    draftRef.current = next;
    setDraft(next);
    sceneDirtyRef.current = true;
    requestDraw();
    if (withHistory) pushHistory();
    else markDirty();
  }

  function updateMapMode(nextMode: StoredMap['data']['mode']) {
    const next = cloneMapRecord(draftRef.current);
    next.data.mode = nextMode;
    const n = teamsForMode(nextMode);
    next.teamCount = n;
    next.data.infantry = Array.from({ length: n }, (_, i) => next.data.infantry[i] ?? []);
    next.data.tanks = Array.from({ length: n }, (_, i) => next.data.tanks[i] ?? []);
    commitDraft(next);
  }

  function updateMapResolution(value: string) {
    const option = MAP_RESOLUTION_OPTIONS.find((resolution) => resolution.label === value);
    if (!option) return;

    const current = draftRef.current;
    if (current.width === option.width && current.height === option.height) return;

    const terrain = terrainCanvasRef.current;
    const tctx = terrainCtxRef.current;
    if (!terrain || !tctx) return;

    const previousWidth = current.width || CANVAS_WIDTH;
    const previousHeight = current.height || CANVAS_HEIGHT;
    const scaleX = option.width / previousWidth;
    const scaleY = option.height / previousHeight;
    const previousTerrain = document.createElement('canvas');
    previousTerrain.width = terrain.width;
    previousTerrain.height = terrain.height;
    const previousContext = previousTerrain.getContext('2d');
    previousContext?.drawImage(terrain, 0, 0);

    setCanvasSize(option.width, option.height);
    terrain.width = option.width;
    terrain.height = option.height;
    disableSmoothing(tctx);
    tctx.fillStyle = DEFAULT_TERRAIN_HEX;
    tctx.fillRect(0, 0, option.width, option.height);
    disableSmoothing(tctx);
    tctx.drawImage(previousTerrain, 0, 0, option.width, option.height);

    const next = cloneMapRecord(current);
    next.width = option.width;
    next.height = option.height;
    next.data = scaleMapObjects(next.data, scaleX, scaleY);
    draftRef.current = next;
    setDraft(next);
    clearSelection();
    setPanClamped({ x: 0, y: 0 });
    sceneDirtyRef.current = true;
    overlayDirtyRef.current = true;
    requestDraw();
    pushHistory();
  }

  function nearestCityIndex(x: number, y: number) {
    let best = -1;
    const hitRadius = scaledHitRadius();
    let bestD = hitRadius * hitRadius;
    draftRef.current.data.cities.forEach(([cx, cy], i) => {
      const d = (cx - x) ** 2 + (cy - y) ** 2;
      if (d < bestD) { best = i; bestD = d; }
    });
    return best;
  }

  function conversionRadius() {
    return Math.max(scaledHitRadius(), Math.round(brushSizeRef.current / 2));
  }

  function applyTankBrush(map: StoredMap, x: number, y: number) {
    const teamIndex = selectedTeamRef.current;
    const radiusSquared = conversionRadius() * conversionRadius();
    const nextInfantry: Point[] = [];
    let changed = false;

    for (const point of map.data.infantry[teamIndex]) {
      const distance = (point[0] - x) * (point[0] - x) + (point[1] - y) * (point[1] - y);
      if (distance <= radiusSquared) {
        map.data.tanks[teamIndex].push(point);
        changed = true;
      } else {
        nextInfantry.push(point);
      }
    }

    map.data.infantry[teamIndex] = nextInfantry;
    return changed;
  }

  function applyInfantryBrush(map: StoredMap, x: number, y: number) {
    const targetTeamIndex = selectedTeamRef.current;
    const radiusSquared = conversionRadius() * conversionRadius();
    const converted: Point[] = [];
    let changed = false;

    map.data.infantry = map.data.infantry.map((team, teamIndex) => team.filter((point) => {
      const distance = (point[0] - x) * (point[0] - x) + (point[1] - y) * (point[1] - y);
      if (distance > radiusSquared) {
        return true;
      }
      if (teamIndex === targetTeamIndex) {
        return true;
      }
      converted.push(point);
      changed = true;
      return false;
    }));

    map.data.tanks = map.data.tanks.map((team) => team.filter((point) => {
      const distance = (point[0] - x) * (point[0] - x) + (point[1] - y) * (point[1] - y);
      if (distance > radiusSquared) {
        return true;
      }
      converted.push(point);
      changed = true;
      return false;
    }));

    if (converted.length > 0) {
      map.data.infantry[targetTeamIndex].push(...converted);
    }

    return changed;
  }

  function applyCapitalBrush(map: StoredMap, x: number, y: number) {
    const radiusSquared = conversionRadius() * conversionRadius();
    const capitalSet = new Set(map.data.capitals);
    let changed = false;

    map.data.cities.forEach((point, index) => {
      const distance = (point[0] - x) * (point[0] - x) + (point[1] - y) * (point[1] - y);
      if (distance <= radiusSquared && !capitalSet.has(index)) {
        capitalSet.add(index);
        changed = true;
      }
    });

    if (changed) {
      map.data.capitals = sortCapitalIndices([...capitalSet]);
    }

    return changed;
  }

  function applyCityBrush(map: StoredMap, x: number, y: number) {
    const radiusSquared = conversionRadius() * conversionRadius();
    const capitalSet = new Set(map.data.capitals);
    let changed = false;

    map.data.cities.forEach((point, index) => {
      const distance = (point[0] - x) * (point[0] - x) + (point[1] - y) * (point[1] - y);
      if (distance <= radiusSquared && capitalSet.has(index)) {
        capitalSet.delete(index);
        changed = true;
      }
    });

    if (changed) {
      map.data.capitals = sortCapitalIndices([...capitalSet]);
    }

    return changed;
  }

  function applyEntityBrushAtPoint(map: StoredMap, tool: 'infantry' | 'tank' | 'city' | 'capital', x: number, y: number) {
    if (tool === 'infantry') return applyInfantryBrush(map, x, y);
    if (tool === 'tank') return applyTankBrush(map, x, y);
    if (tool === 'city') return applyCityBrush(map, x, y);
    return applyCapitalBrush(map, x, y);
  }

  function applyEntityBrushAlongSegment(
    map: StoredMap,
    tool: 'infantry' | 'tank' | 'city' | 'capital',
    start: { x: number; y: number },
    end: { x: number; y: number },
  ) {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const steps = Math.max(Math.abs(deltaX), Math.abs(deltaY), 1);
    let changed = false;

    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      changed = applyEntityBrushAtPoint(
        map,
        tool,
        Math.round(start.x + deltaX * t),
        Math.round(start.y + deltaY * t),
      ) || changed;
    }

    return changed;
  }

  function moveHoveredEntity(
    map: StoredMap,
    target: Exclude<HoverTarget, { type: 'terrain' } | { type: 'bridge' }>,
    x: number,
    y: number,
  ) {
    const nextPoint: Point = [x, y];

    if (target.type === 'infantry') {
      const current = map.data.infantry[target.teamIndex][target.entityIndex];
      if (!current || (current[0] === x && current[1] === y)) return false;
      map.data.infantry[target.teamIndex][target.entityIndex] = nextPoint;
      return true;
    }

    if (target.type === 'tank') {
      const current = map.data.tanks[target.teamIndex][target.entityIndex];
      if (!current || (current[0] === x && current[1] === y)) return false;
      map.data.tanks[target.teamIndex][target.entityIndex] = nextPoint;
      return true;
    }

    if (target.type === 'city' || target.type === 'capital') {
      const current = map.data.cities[target.cityIndex];
      if (!current || (current[0] === x && current[1] === y)) return false;
      map.data.cities[target.cityIndex] = nextPoint;
      return true;
    }

    return false;
  }

  function moveSelectedEntities(map: StoredMap, entities: SelectedEntityRef[], dx: number, dy: number) {
    let changed = false;

    for (const entity of entities) {
      const current = selectionEntityPoint(map, entity);
      if (!current) {
        continue;
      }

      const nextPoint: Point = [current[0] + dx, current[1] + dy];
      if (nextPoint[0] === current[0] && nextPoint[1] === current[1]) {
        continue;
      }

      setSelectionEntityPoint(map, entity, nextPoint);
      changed = true;
    }

    return changed;
  }

  function clampSelectionEntityDelta(map: StoredMap, entities: SelectedEntityRef[], dx: number, dy: number) {
    let minX = CANVAS_WIDTH - 1;
    let maxX = 0;
    let minY = CANVAS_HEIGHT - 1;
    let maxY = 0;
    let found = false;

    for (const entity of entities) {
      const point = selectionEntityPoint(map, entity);
      if (!point) {
        continue;
      }

      found = true;
      if (point[0] < minX) minX = point[0];
      if (point[0] > maxX) maxX = point[0];
      if (point[1] < minY) minY = point[1];
      if (point[1] > maxY) maxY = point[1];
    }

    if (!found) {
      return { dx: 0, dy: 0 };
    }

    return {
      dx: Math.max(-minX, Math.min(CANVAS_WIDTH - 1 - maxX, Math.round(dx))),
      dy: Math.max(-minY, Math.min(CANVAS_HEIGHT - 1 - maxY, Math.round(dy))),
    };
  }

  function deleteSelectedEntities() {
    const selected = selectedEntitiesRef.current;
    if (selected.length === 0) {
      return;
    }

    const next = cloneMapRecord(draftRef.current);
    const infantryByTeam = new Map<number, number[]>();
    const tanksByTeam = new Map<number, number[]>();
    const cityIndexes: number[] = [];

    for (const entity of selected) {
      if (entity.kind === 'city') {
        cityIndexes.push(entity.cityIndex);
        continue;
      }

      const targetMap = entity.kind === 'infantry' ? infantryByTeam : tanksByTeam;
      const bucket = targetMap.get(entity.teamIndex) ?? [];
      bucket.push(entity.entityIndex);
      targetMap.set(entity.teamIndex, bucket);
    }

    infantryByTeam.forEach((indexes, teamIndex) => {
      indexes.sort((left, right) => right - left).forEach((index) => next.data.infantry[teamIndex]?.splice(index, 1));
    });

    tanksByTeam.forEach((indexes, teamIndex) => {
      indexes.sort((left, right) => right - left).forEach((index) => next.data.tanks[teamIndex]?.splice(index, 1));
    });

    cityIndexes.sort((left, right) => right - left).forEach((index) => {
      next.data.cities.splice(index, 1);
      next.data.capitals = next.data.capitals
        .filter((capitalIndex) => capitalIndex !== index)
        .map((capitalIndex) => (capitalIndex > index ? capitalIndex - 1 : capitalIndex));
    });

    clearSelection();
    syncHoverTarget(null);
    commitDraft(next);
  }

  function spaceSelectedUnitsEvenly() {
    const selectedUnits = selectedEntitiesRef.current.filter((entity): entity is Extract<SelectedEntityRef, { kind: 'infantry' | 'tank' }> => (
      entity.kind === 'infantry' || entity.kind === 'tank'
    ));

    if (selectedUnits.length < 2) {
      return;
    }

    const next = cloneMapRecord(draftRef.current);
    const entries = selectedUnits
      .map((entity) => ({ entity, point: selectionEntityPoint(next, entity) }))
      .filter((entry): entry is { entity: Extract<SelectedEntityRef, { kind: 'infantry' | 'tank' }>; point: Point } => entry.point !== null);

    if (entries.length < 2) {
      return;
    }

    let startIndex = 0;
    let endIndex = 1;
    let furthestDistance = -1;

    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const deltaX = entries[left].point[0] - entries[right].point[0];
        const deltaY = entries[left].point[1] - entries[right].point[1];
        const distance = deltaX * deltaX + deltaY * deltaY;
        if (distance > furthestDistance) {
          furthestDistance = distance;
          startIndex = left;
          endIndex = right;
        }
      }
    }

    const startEntry = entries[startIndex];
    const endEntry = entries[endIndex];
    const axisX = endEntry.point[0] - startEntry.point[0];
    const axisY = endEntry.point[1] - startEntry.point[1];
    const axisLengthSquared = Math.max(1, axisX * axisX + axisY * axisY);
    const remaining = entries
      .filter((_, index) => index !== startIndex && index !== endIndex)
      .sort((left, right) => {
        const leftProjection = ((left.point[0] - startEntry.point[0]) * axisX + (left.point[1] - startEntry.point[1]) * axisY) / axisLengthSquared;
        const rightProjection = ((right.point[0] - startEntry.point[0]) * axisX + (right.point[1] - startEntry.point[1]) * axisY) / axisLengthSquared;
        return leftProjection - rightProjection;
      });

    const ordered = [startEntry, ...remaining, endEntry];
    let changed = false;

    ordered.forEach((entry, index) => {
      const t = ordered.length === 1 ? 0 : index / (ordered.length - 1);
      const nextPoint: Point = [
        Math.round(startEntry.point[0] + axisX * t),
        Math.round(startEntry.point[1] + axisY * t),
      ];

      if (entry.point[0] === nextPoint[0] && entry.point[1] === nextPoint[1]) {
        return;
      }

      setSelectionEntityPoint(next, entry.entity, nextPoint);
      changed = true;
    });

    if (!changed) {
      return;
    }

    commitDraft(next);
    applySelectionState([...selectedEntitiesRef.current], [...selectionRectsRef.current]);
  }

  function commitShape(points = shapePointsRef.current, confirmPoint?: Point) {
    const tctx = terrainCtxRef.current;
    const pointsToCommit = confirmPoint && points.length === 2 ? [...points, confirmPoint] : points;
    if (!tctx || pointsToCommit.length < 3) {
      return;
    }

    const sampled = sampleClosedBezierShape(pointsToCommit);
    if (terrainShapeFilled) {
      fillPolygonPixels(tctx, sampled, terrainColorRef.current);
    } else {
      strokePolygonPixels(tctx, sampled, terrainColorRef.current);
    }
    shapePointsRef.current = [];
    setShapePointCount(0);
    hoverPointRef.current = null;
    syncHoverTarget(null);
    sceneDirtyRef.current = true;
    overlayDirtyRef.current = true;
    requestDraw();
    pushHistory();
  }

  function eraseAt(x: number, y: number) {
    const next = cloneMapRecord(draftRef.current);
    const hits: Array<{ kind: 'infantry' | 'tank' | 'city' | 'bridge'; teamIndex?: number; index: number; d: number }> = [];
    const hitRadius = scaledHitRadius();
    const r2 = hitRadius * hitRadius;

    next.data.infantry.forEach((team, ti) => team.forEach((p, i) => {
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d <= r2) hits.push({ kind: 'infantry', teamIndex: ti, index: i, d });
    }));
    next.data.tanks.forEach((team, ti) => team.forEach((p, i) => {
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d <= r2) hits.push({ kind: 'tank', teamIndex: ti, index: i, d });
    }));
    next.data.cities.forEach((p, i) => {
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d <= r2) hits.push({ kind: 'city', index: i, d });
    });
    next.data.bridges.forEach((b, i) => {
      const [[x1, y1], [x2, y2]] = b;
      const d = pointToSegmentDistance(x, y, x1, y1, x2, y2);
      if (d * d <= r2) hits.push({ kind: 'bridge', index: i, d: d * d });
    });

    if (hits.length === 0) return;
    hits.sort((a, b) => a.d - b.d);
    const c = hits[0];
    if (c.kind === 'infantry' && c.teamIndex !== undefined) next.data.infantry[c.teamIndex].splice(c.index, 1);
    if (c.kind === 'tank' && c.teamIndex !== undefined) next.data.tanks[c.teamIndex].splice(c.index, 1);
    if (c.kind === 'bridge') next.data.bridges.splice(c.index, 1);
    if (c.kind === 'city') {
      next.data.cities.splice(c.index, 1);
      next.data.capitals = next.data.capitals
        .filter((idx) => idx !== c.index)
        .map((idx) => (idx > c.index ? idx - 1 : idx));
    }
    commitDraft(next);
  }

  function applyPlacement(x: number, y: number) {
    const tool = selectedToolRef.current;
    if (tool === 'erase') { eraseAt(x, y); return; }
    const next = cloneMapRecord(draftRef.current);
    const team = selectedTeamRef.current;

    if (tool === 'infantry') { next.data.infantry[team].push([x, y]); commitDraft(next); return; }
    if (tool === 'tank') { next.data.tanks[team].push([x, y]); commitDraft(next); return; }
    if (tool === 'city') { next.data.cities.push([x, y]); commitDraft(next); return; }
    if (tool === 'capital') {
      next.data.cities.push([x, y]);
      next.data.capitals = sortCapitalIndices([...next.data.capitals, next.data.cities.length - 1]);
      commitDraft(next);
      return;
    }
    if (tool === 'bridge') {
      if (!bridgeStartRef.current) {
        bridgeStartRef.current = [x, y];
        overlayDirtyRef.current = true;
        requestDraw();
        return;
      }
      next.data.bridges.push([[bridgeStartRef.current[0], bridgeStartRef.current[1]], [x, y]]);
      bridgeStartRef.current = null;
      commitDraft(next);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Pointer
  // ────────────────────────────────────────────────────────────
  function pointFromEvent(canvas: HTMLCanvasElement, event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = canvas.getBoundingClientRect();
    const x = rect.width > 0 ? Math.round(((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH) : 0;
    const y = rect.height > 0 ? Math.round(((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT) : 0;
    return {
      x: Math.max(0, Math.min(CANVAS_WIDTH - 1, x)),
      y: Math.max(0, Math.min(CANVAS_HEIGHT - 1, y)),
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    const canvas = event.currentTarget;
    const shouldPanWithSpace = event.button === 0 && spacePanActiveRef.current;

    const startPanSession = (trigger: PanSession['trigger']) => {
      event.preventDefault();
      panSessionRef.current = {
        active: true,
        moved: false,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPanX: panRef.current.x,
        startPanY: panRef.current.y,
        trigger,
      };
      hoverPointRef.current = null;
      syncHoverTarget(null);
      overlayDirtyRef.current = true;
      requestDraw();
      canvas.setPointerCapture(event.pointerId);
    };

    if (event.button === 1) {
      startPanSession('middle');
      return;
    }

    if (shouldPanWithSpace) {
      startPanSession('space');
      return;
    }

    const point = pointFromEvent(canvas, event);
    hoverPointRef.current = point;
    const nextHoverTarget = findHoverTarget(point.x, point.y);
    syncHoverTarget(nextHoverTarget);
    const tool = selectedToolRef.current;

    if (event.button === 2) {
      if (tool === 'terrainShape' && shapePointsRef.current.length >= 2) {
        commitShape(shapePointsRef.current, [point.x, point.y]);
        return;
      }
      eraseAt(point.x, point.y);
      overlayDirtyRef.current = true;
      requestDraw();
      return;
    }

    if (tool === 'select') {
      const activeRects = selectionRectsRef.current;
      const hasSelection = selectedEntitiesRef.current.length > 0 && activeRects.length > 0;
      const insideSelection = pointInsideSelectionRects(activeRects, point.x, point.y);

      if (hasSelection && insideSelection && !event.shiftKey && !event.ctrlKey) {
        selectionSessionRef.current = {
          active: true,
          marqueeRect: selectionBoundsFromRects(activeRects),
          mode: 'move',
          moved: false,
          operation: 'replace',
          originMap: cloneMapRecord(draftRef.current),
          originRects: activeRects.map((rect) => ({ ...rect })),
          pointerId: event.pointerId,
          start: [point.x, point.y],
        };
        canvas.setPointerCapture(event.pointerId);
        overlayDirtyRef.current = true;
        requestDraw();
        return;
      }

      selectionSessionRef.current = {
        active: true,
        marqueeRect: createSelectionRect(point, point),
        mode: 'select',
        moved: false,
        operation: event.ctrlKey ? 'subtract' : event.shiftKey ? 'add' : 'replace',
        originMap: null,
        originRects: activeRects.map((rect) => ({ ...rect })),
        pointerId: event.pointerId,
        start: [point.x, point.y],
      };
      canvas.setPointerCapture(event.pointerId);
      overlayDirtyRef.current = true;
      requestDraw();
      return;
    }

    if (event.shiftKey && isEntityBrushTool(tool)) {
      const working = cloneMapRecord(draftRef.current);
      const dirty = applyEntityBrushAtPoint(working, tool, point.x, point.y);
      entityBrushSessionRef.current = {
        active: true,
        dirty,
        last: point,
        pointerId: event.pointerId,
        tool,
        working,
      };
      canvas.setPointerCapture(event.pointerId);
      if (dirty) {
        previewDraft(working);
      }
      overlayDirtyRef.current = true;
      requestDraw();
      return;
    }

    if (
      event.button === 0
      && isMoveEntityTool(tool)
      && nextHoverTarget
      && nextHoverTarget.type !== 'terrain'
      && nextHoverTarget.type !== 'bridge'
    ) {
      moveSessionRef.current = {
        active: true,
        moved: false,
        origin: cloneMapRecord(draftRef.current),
        pointerId: event.pointerId,
        target: nextHoverTarget,
        working: cloneMapRecord(draftRef.current),
      };
      canvas.setPointerCapture(event.pointerId);
      overlayDirtyRef.current = true;
      requestDraw();
      return;
    }

    if (tool === 'terrainShape') {
      const nextPoints = [...shapePointsRef.current, [point.x, point.y] as Point];
      shapePointsRef.current = nextPoints;
      setShapePointCount(nextPoints.length);
      overlayDirtyRef.current = true;
      requestDraw();
      return;
    }

    const kind = TOOL_LOOKUP[tool].kind;

    if (kind !== 'terrain') {
      applyPlacement(point.x, point.y);
      overlayDirtyRef.current = true;
      requestDraw();
      return;
    }

    const tctx = terrainCtxRef.current;
    if (!tctx) return;
    canvas.setPointerCapture(event.pointerId);
    bridgeStartRef.current = null;

    if (tool === 'terrainFill') {
      if (floodFillContext(tctx, point.x, point.y, terrainColorRef.current)) {
        sceneDirtyRef.current = true;
        requestDraw();
        pushHistory();
      }
      return;
    }

    paintSessionRef.current = {
      active: true,
      pointerId: event.pointerId,
      start: point,
      last: point,
      snapshot: null,
      dirty: false,
    };

    if (tool === 'terrainBrush') {
      drawDot(tctx, point, brushSizeRef.current, terrainColorRef.current);
      paintSessionRef.current.dirty = true;
      sceneDirtyRef.current = true;
      requestDraw();
      return;
    }
    paintSessionRef.current.snapshot = tctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const panSession = panSessionRef.current;

    if (panSession.active && panSession.pointerId === event.pointerId) {
      event.preventDefault();
      const dx = event.clientX - panSession.startClientX;
      const dy = event.clientY - panSession.startClientY;
      if (!panSession.moved && Math.hypot(dx, dy) >= 4) {
        panSession.moved = true;
      }
      if (!panSession.moved) {
        return;
      }
      setIsPanDragging(true);
      setPanClamped({
        x: panSession.startPanX + dx,
        y: panSession.startPanY + dy,
      });
      return;
    }

    const point = pointFromEvent(canvas, event);
    hoverPointRef.current = point;
    syncHoverTarget(findHoverTarget(point.x, point.y));
    overlayDirtyRef.current = true;

    const tool = selectedToolRef.current;
    const entityBrushSession = entityBrushSessionRef.current;
    const moveSession = moveSessionRef.current;
    const selectionSession = selectionSessionRef.current;
    const session = paintSessionRef.current;
    const tctx = terrainCtxRef.current;

    if (tool === 'terrainShape') {
      requestDraw();
      return;
    }

    if (tool === 'select' && selectionSession.active && selectionSession.pointerId === event.pointerId && selectionSession.start) {
      if (selectionSession.mode === 'select') {
        selectionSession.marqueeRect = createSelectionRect(selectionSession.start, point);
        selectionSession.moved = true;
        requestDraw();
        return;
      }

      if (selectionSession.mode === 'move' && selectionSession.originMap && selectionSession.originRects.length > 0) {
        const entityDelta = clampSelectionEntityDelta(
          selectionSession.originMap,
          selectedEntitiesRef.current,
          point.x - selectionSession.start[0],
          point.y - selectionSession.start[1],
        );
        const rectDelta = clampSelectionRectsDelta(
          selectionSession.originRects,
          point.x - selectionSession.start[0],
          point.y - selectionSession.start[1],
        );
        const delta = {
          dx: Math.sign(entityDelta.dx || rectDelta.dx) * Math.min(Math.abs(entityDelta.dx), Math.abs(rectDelta.dx)),
          dy: Math.sign(entityDelta.dy || rectDelta.dy) * Math.min(Math.abs(entityDelta.dy), Math.abs(rectDelta.dy)),
        };
        const next = cloneMapRecord(selectionSession.originMap);
        const changed = moveSelectedEntities(next, selectedEntitiesRef.current, delta.dx, delta.dy);
        selectionSession.moved = selectionSession.moved || changed;
        if (changed) {
          previewDraft(next);
        }
        applySelectionState(
          [...selectedEntitiesRef.current],
          offsetSelectionRects(selectionSession.originRects, delta.dx, delta.dy),
        );
        return;
      }
    }

    if (moveSession.active && moveSession.pointerId === event.pointerId && moveSession.target && moveSession.working) {
      const changed = moveHoveredEntity(moveSession.working, moveSession.target, point.x, point.y);
      moveSession.moved = moveSession.moved || changed;
      if (changed) {
        previewDraft(moveSession.working);
      }
      requestDraw();
      return;
    }

    if (entityBrushSession.active && entityBrushSession.tool === tool && entityBrushSession.working && entityBrushSession.last) {
      const changed = applyEntityBrushAlongSegment(entityBrushSession.working, entityBrushSession.tool, entityBrushSession.last, point);
      entityBrushSession.last = point;
      entityBrushSession.dirty = entityBrushSession.dirty || changed;
      if (changed) {
        previewDraft(entityBrushSession.working);
      }
      requestDraw();
      return;
    }

    if (!session.active || !tctx || TOOL_LOOKUP[tool].kind !== 'terrain') {
      requestDraw();
      return;
    }

    if (tool === 'terrainBrush' && session.last) {
      drawSegment(tctx, session.last, point, brushSizeRef.current, terrainColorRef.current);
      session.last = point;
      session.dirty = true;
      sceneDirtyRef.current = true;
      requestDraw();
      return;
    }
    if ((tool === 'terrainLine' || tool === 'terrainRect') && session.snapshot && session.start) {
      tctx.putImageData(session.snapshot, 0, 0);
      if (tool === 'terrainLine') {
        drawSegment(tctx, session.start, point, brushSizeRef.current, terrainColorRef.current);
      } else {
        drawRect(tctx, session.start, point, terrainColorRef.current, terrainRectFilled);
      }
      session.dirty = true;
      sceneDirtyRef.current = true;
      requestDraw();
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const tool = selectedToolRef.current;
    setIsPanDragging(false);
    const panSession = panSessionRef.current;
    const moveSession = moveSessionRef.current;
    const entityBrushSession = entityBrushSessionRef.current;
    const selectionSession = selectionSessionRef.current;
    const session = paintSessionRef.current;

    if (panSession.active && panSession.pointerId === event.pointerId) {
      panSessionRef.current = {
        active: false,
        moved: false,
        pointerId: null,
        startClientX: 0,
        startClientY: 0,
        startPanX: 0,
        startPanY: 0,
        trigger: 'middle',
      };
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }

    if (tool === 'select' && selectionSession.active && selectionSession.pointerId === event.pointerId) {
      if (selectionSession.mode === 'select') {
        const marqueeRect = selectionSession.marqueeRect ?? (selectionSession.start ? createSelectionRect(selectionSession.start, selectionSession.start) : null);

        if (marqueeRect) {
          let nextSelected = selectedEntitiesInRect(draftRef.current, marqueeRect);
          if (selectionRectIsTiny(marqueeRect)) {
            const hoveredEntity = selectedEntityFromHoverTarget(hoverTargetRef.current);
            nextSelected = hoveredEntity ? [hoveredEntity] : [];
          }
          const committedRect = selectionRectIsTiny(marqueeRect)
            ? selectionRectFromEntities(draftRef.current, nextSelected) ?? marqueeRect
            : marqueeRect;

          if (selectionSession.operation === 'subtract') {
            applySelectionState(
              subtractSelectedEntities(selectedEntitiesRef.current, nextSelected),
              subtractSelectionRects(selectionSession.originRects, committedRect),
            );
          } else {
            const nextEntities = selectionSession.operation === 'add'
              ? mergeSelectedEntities(selectedEntitiesRef.current, nextSelected)
              : nextSelected;
            const nextRects = selectionSession.operation === 'add'
              ? [...selectionSession.originRects, committedRect]
              : nextEntities.length > 0
                ? [committedRect]
                : [];

            applySelectionState(nextEntities, nextRects);
          }
        } else if (selectionSession.operation === 'replace') {
          clearSelection();
        }
      } else if (selectionSession.mode === 'move') {
        if (selectionSession.moved) {
          pushHistory();
        }
      }

      selectionSessionRef.current = emptySelectionSession();
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }

    if (moveSession.active && moveSession.pointerId === event.pointerId) {
      const wasMoved = moveSession.moved;
      moveSessionRef.current = { active: false, moved: false, origin: null, pointerId: null, target: null, working: null };
      if (wasMoved) {
        pushHistory();
      }
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }

    if (entityBrushSession.active && entityBrushSession.pointerId === event.pointerId) {
      const wasDirty = entityBrushSession.dirty;
      entityBrushSessionRef.current = { active: false, dirty: false, last: null, pointerId: null, tool: null, working: null };
      if (wasDirty) {
        pushHistory();
      }
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }

    if (TOOL_LOOKUP[tool].kind === 'terrain' && session.active) {
      const wasDirty = session.dirty;
      paintSessionRef.current = {
        active: false, pointerId: null, start: null, last: null, snapshot: null, dirty: false,
      };
      if (wasDirty) {
        sceneDirtyRef.current = true;
        requestDraw();
        pushHistory();
      }
    }
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  function handlePointerLeave() {
    if (
      paintSessionRef.current.active
      || entityBrushSessionRef.current.active
      || moveSessionRef.current.active
      || selectionSessionRef.current.active
      || panSessionRef.current.active
    ) return;
    setIsPanDragging(false);
    hoverPointRef.current = null;
    syncHoverTarget(null);
    overlayDirtyRef.current = true;
    requestDraw();
  }

  // ────────────────────────────────────────────────────────────
  // Background / reset / close
  // ────────────────────────────────────────────────────────────
  async function handleBackgroundUpload(file: File) {
    const tctx = terrainCtxRef.current;
    if (!tctx) return;
    const image = await loadImageFromFile(file);
    tctx.fillStyle = DEFAULT_TERRAIN_HEX;
    tctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    fitImageCover(tctx, image, CANVAS_WIDTH, CANVAS_HEIGHT);
    quantizeCanvasContext(tctx);
    sceneDirtyRef.current = true;
    requestDraw();
    pushHistory();
  }

  function resetTerrainToPlains() {
    const tctx = terrainCtxRef.current;
    if (!tctx) return;
    tctx.fillStyle = DEFAULT_TERRAIN_HEX;
    tctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    sceneDirtyRef.current = true;
    requestDraw();
    pushHistory();
  }

  async function handleClose() {
    const result = await requestLeave();
    if (result === false) return;
    onClose(result ?? undefined);
  }

  const terrainTools = TOOLS.filter((t) => t.group === 'terrain');
  const unitTools = TOOLS.filter((t) => t.group === 'units');
  const objectTools = TOOLS.filter((t) => t.group === 'objects');
  const orderedTeams = visibleTeamOrder(teamCount);
  const selectedUnitCount = selectedEntities.filter((entity) => entity.kind === 'infantry' || entity.kind === 'tank').length;
  const liveTeamSummaries = useMemo(
    () => createTeamMapSummaries(draft, teamCount).filter((summary) => formatTeamMapSummary(summary).length > 0),
    [draft, teamCount],
  );
  const stageContext = useMemo(() => {
    const parts = [TOOL_LOOKUP[selectedTool].hint];

    if (selectedTool === 'terrainBrush') {
      parts.push(`Brush ${brushSize}px.`);
    }

    if (selectedTool === 'terrainLine') {
      parts.push(`Line thickness ${brushSize}px.`);
    }

    if (selectedTool === 'terrainShape') {
      if (shapePointCount >= 2) {
        parts.push(`${shapePointCount} anchors placed. Right-click adds the last anchor and confirms.`);
      } else if (shapePointCount > 0) {
        parts.push(`${shapePointCount} anchor placed. Add 1 more anchor, then right-click to confirm.`);
      } else {
        parts.push('Left-click anchors, then right-click to place the last anchor and confirm.');
      }
    }

    if (selectedTool === 'select') {
      if (selectedEntities.length > 0) {
        parts.push(`${selectedEntities.length} selected. Drag inside the box to move them together.`);
      } else {
        parts.push('Drag to select. Shift adds more. Ctrl carves out selection.');
      }
    } else if (isMoveEntityTool(selectedTool)) {
      parts.push('Left click places. Shift + left drag brushes replacements.');
    } else if (selectedTool === 'erase') {
      parts.push('Click or right-click removes the nearest object.');
    } else if (selectedTool === 'bridge') {
      parts.push('Click two points to place a bridge.');
    } else if (selectedTool === 'terrainRect') {
      parts.push(terrainRectFilled ? 'Rectangles are filled when placed.' : 'Rectangles place borders only.');
    } else if (selectedTool === 'terrainShape') {
      parts.push(terrainShapeFilled ? 'Shapes are filled when confirmed.' : 'Shapes place borders only when confirmed.');
    }

    return parts.join(' ');
  }, [brushSize, selectedEntities.length, selectedTool, shapePointCount, terrainRectFilled, terrainShapeFilled]);
  const selectedTerrainOptions = useMemo(() => {
    if (TOOL_LOOKUP[selectedTool].group !== 'terrain') {
      return null;
    }

    if (selectedTool === 'terrainBrush') {
      return (
        <div className="brush-strip">
          <div className="brush-head">
            <span>Brush size</span>
            <strong>{brushSize}px</strong>
          </div>
          <input
            aria-label="Brush size"
            max={120}
            min={1}
            type="range"
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
        </div>
      );
    }

    if (selectedTool === 'terrainLine') {
      return (
        <div className="brush-strip">
          <div className="brush-head">
            <span>Line thickness</span>
            <strong>{brushSize}px</strong>
          </div>
          <input
            aria-label="Line thickness"
            max={120}
            min={1}
            type="range"
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
        </div>
      );
    }

    if (selectedTool === 'terrainRect') {
      return (
        <label className="terrain-option-toggle">
          <input
            checked={terrainRectFilled}
            type="checkbox"
            onChange={(event) => setTerrainRectFilled(event.target.checked)}
          />
          <span>Fill rectangle instead of placing only the border</span>
        </label>
      );
    }

    if (selectedTool === 'terrainShape') {
      return (
        <label className="terrain-option-toggle">
          <input
            checked={terrainShapeFilled}
            type="checkbox"
            onChange={(event) => setTerrainShapeFilled(event.target.checked)}
          />
          <span>Fill shape instead of placing only the border</span>
        </label>
      );
    }

    return <p className="tool-note">This terrain tool has no extra options.</p>;
  }, [brushSize, selectedTool, terrainRectFilled, terrainShapeFilled]);
  const helpItems = useMemo<ControlHint[]>(() => {
    const items: ControlHint[] = [
      { id: 'zoom', icon: ZoomIn, label: 'Wheel', action: 'Zoom into the area under the cursor.' },
      { id: 'pan', icon: Mouse, label: 'Middle drag', action: 'Pan around the canvas.' },
      { id: 'pan-space', icon: Keyboard, label: 'Space + left drag', keys: ['Space', 'LMB'], action: 'Temporarily pan the canvas.' },
      { id: 'brush-size', icon: Mouse, label: 'Ctrl + wheel', keys: ['Ctrl'], action: 'Adjust brush size for brush-based tools.' },
      {
        id: 'erase',
        icon: MouseRight,
        label: 'Right click',
        action: hoverTarget && hoverTarget.type !== 'terrain'
          ? `Remove the hovered ${hoverTarget.removeLabel}.`
          : 'Remove the nearest hovered object.',
      },
      { id: 'undo', icon: Undo2, label: 'Undo', keys: ['Ctrl', 'Z'], action: 'Step back one edit.' },
      { id: 'redo', icon: Redo2, label: 'Redo', keys: ['Ctrl', 'Y'], action: 'Step forward one edit.' },
      { id: 'brush-brackets', icon: Brackets, label: '[ / ]', action: 'Shrink or grow the brush.' },
      { id: 'teams', icon: Keyboard, label: '1 - 4', action: 'Switch the active team color.' },
      { id: 'tools', icon: Keyboard, label: 'Q B L R F S I T C K G E', action: 'Quick-select editor tools.' },
      { id: 'hover', icon: MousePointer2, label: 'Hover', action: 'Preview the active tool at the cursor.' },
    ];

    if (selectedTool === 'select') {
      items.splice(3, 0,
        { id: 'selection-drag', icon: MousePointer2, label: 'Left drag', action: 'Create a selection box.' },
        { id: 'selection-add', icon: Mouse, label: 'Shift + drag', keys: ['Shift'], action: 'Add another area to the selection.' },
        { id: 'selection-move', icon: MousePointer2, label: 'Drag inside box', action: 'Move the selected units and cities together.' },
        { id: 'selection-box', icon: Mouse, label: 'Ctrl + drag', keys: ['Ctrl'], action: 'Carve an area out of the current selection.' },
      );
    }

    if (isMoveEntityTool(selectedTool)) {
      items.splice(3, 0, {
        id: 'move-drag',
        icon: MousePointer2,
        label: 'Left drag',
        action: 'Move the hovered unit or city.',
      });
      items.splice(4, 0, {
        id: 'replace-brush',
        icon: Mouse,
        label: 'Shift + left drag',
        keys: ['Shift'],
        action: 'Brush-replace compatible targets to the selected tool.',
      });
    }

    if (selectedTool === 'terrainShape') {
      items.splice(3, 0, {
        id: 'shape-confirm',
        icon: MouseRight,
        label: 'Right click',
        action: shapePointCount >= 2 ? 'Place the last anchor and confirm the current curved shape.' : 'Confirm a curved shape after placing 2 anchors.',
      });
    }

    if (selectedTool === 'tank' || selectedTool === 'capital') {
      items.splice(3, 0, {
        id: 'convert-drag',
        icon: MousePointer2,
        label: 'Drag',
        action: selectedTool === 'tank' ? 'Convert infantry into tanks.' : 'Convert cities into capitals.',
      });
    }

    return items;
  }, [hoverTarget, selectedTool, shapePointCount]);

  return (
    <>
    <section className={`editor-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <header className="editor-command-bar">
        <div className="editor-command-leading">
          <button
            aria-expanded={sidebarOpen}
            aria-controls="mapEditorSidebar"
            className="editor-sidebar-toggle secondary-button compact"
            type="button"
            onClick={() => setSidebarOpen((current) => !current)}
          >
            Tools
          </button>
          <button className="ghost-button" type="button" onClick={handleClose} title="Back to library">
            ← Library
          </button>
        </div>
        <div className="editor-map-identity">
          <strong>{draft.name || draft.fileName || 'Untitled map'}</strong>
          <span>{draft.width}x{draft.height} · {teamCount} teams · {MODE_LABELS[draft.data.mode]}</span>
        </div>
        <div className="editor-command-actions">
          <div className={`save-badge ${saveState}`}>
            <span className="dot" />
            <span>{saveState === 'saving' ? 'Saving…' : saveState === 'dirty' ? 'Unsaved' : 'Saved'}</span>
          </div>
          <button className="icon-button" type="button" disabled={!historyState.canUndo} onClick={handleUndo} title="Undo (Ctrl+Z)">↶</button>
          <button className="icon-button" type="button" disabled={!historyState.canRedo} onClick={handleRedo} title="Redo (Ctrl+Y)">↷</button>
          <button className="primary-button compact" type="button" disabled={saveState === 'saving' || saveState === 'saved'} onClick={() => { void persistNow(); }}>
            {saveState === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </header>

      <aside id="mapEditorSidebar" className="editor-sidebar">
        <div className="sidebar-panels">
          <section className="control-card control-panel">
            <button
              aria-expanded={expandedPanels.map}
              className="panel-toggle"
              type="button"
              onClick={() => togglePanel('map')}
            >
              <span className="panel-toggle-copy">
                <span className="panel-toggle-title">Map</span>
                <span className="panel-toggle-subtitle">Mode, background, and direct save</span>
              </span>
              <span className={`panel-toggle-chevron ${expandedPanels.map ? 'expanded' : ''}`}>▾</span>
            </button>
            {expandedPanels.map && (
              <div className="panel-body">
              <label className="field-block">
                <span>Resolution</span>
                <select value={`${draft.width}x${draft.height}`} onChange={(e) => updateMapResolution(e.target.value)}>
                  {MAP_RESOLUTION_OPTIONS.map((option) => (
                    <option key={option.label} value={option.label}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="field-block">
                <span>Mode</span>
                <select value={draft.data.mode} onChange={(e) => updateMapMode(e.target.value as StoredMap['data']['mode'])}>
                  <option value="1v1">1v1 Duel</option>
                  <option value="v3">3-Player FFA</option>
                  <option value="v4">4-Player FFA</option>
                </select>
              </label>
              <div className="action-grid">
                <label className="secondary-button file-button">
                  Upload background
                  <input
                    accept="image/*"
                    type="file"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleBackgroundUpload(file);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button className="secondary-button" type="button" onClick={resetTerrainToPlains}>Reset terrain</button>
                <button className="primary-button" type="button" disabled={saveState === 'saving' || saveState === 'saved'} onClick={() => { void persistNow(); }}>
                  {saveState === 'saving' ? 'Saving...' : 'Save to game'}
                </button>
              </div>
              </div>
            )}
          </section>

          <section className="control-card control-panel">
            <button
              aria-expanded={expandedPanels.terrain}
              className="panel-toggle"
              type="button"
              onClick={() => togglePanel('terrain')}
            >
              <span className="panel-toggle-copy">
                <span className="panel-toggle-title">Terrain</span>
                <span className="panel-toggle-subtitle">Brushes, shapes, and palette</span>
              </span>
              <span className={`panel-toggle-chevron ${expandedPanels.terrain ? 'expanded' : ''}`}>▾</span>
            </button>
            {expandedPanels.terrain && (
              <div className="panel-body">
              <div className="tool-grid">
                {terrainTools.map((tool) => (
                  <button
                    key={tool.id}
                    className={`tool-button ${selectedTool === tool.id ? 'active' : ''}`}
                    type="button"
                    onClick={() => activateTool(tool.id)}
                    title={tool.hint}
                  >
                    <span className="glyph"><ToolIcon selectedTeam={selectedTeam} teamCount={teamCount} toolId={tool.id} /></span>
                    <span className="label">{tool.label}</span>
                  </button>
                ))}
              </div>

              {selectedTerrainOptions}

              <div className="swatch-grid">
                {TERRAIN_COLORS.map((entry) => (
                  <button
                    key={entry.hex}
                    aria-label={entry.name}
                    title={entry.name}
                    className={`swatch ${terrainColor === entry.hex ? 'active' : ''}`}
                    style={{ background: entry.hex }}
                    type="button"
                    onClick={() => setTerrainColor(entry.hex)}
                  >
                    <span>{entry.name}</span>
                  </button>
                ))}
              </div>
              </div>
            )}
          </section>

          <section className="control-card control-panel">
            <button
              aria-expanded={expandedPanels.units}
              className="panel-toggle"
              type="button"
              onClick={() => togglePanel('units')}
            >
              <span className="panel-toggle-copy">
                <span className="panel-toggle-title">Units</span>
                <span className="panel-toggle-subtitle">Teams, units, objects, and counts</span>
              </span>
              <span className={`panel-toggle-chevron ${expandedPanels.units ? 'expanded' : ''}`}>▾</span>
            </button>
            {expandedPanels.units && (
              <div className="panel-body">
              <div className="tool-grid">
                {unitTools.concat(objectTools).map((tool) => (
                  <button
                    key={tool.id}
                    className={`tool-button ${selectedTool === tool.id ? 'active' : ''}`}
                    type="button"
                    onClick={() => activateTool(tool.id)}
                    title={tool.hint}
                  >
                    <span className="glyph"><ToolIcon selectedTeam={selectedTeam} teamCount={teamCount} toolId={tool.id} /></span>
                    <span className="label">{tool.label}</span>
                  </button>
                ))}
              </div>

              <div className="team-pills">
                {orderedTeams.map((index, displayIndex) => (
                  <button
                    key={teamColorForIndex(index)}
                    className={selectedTeam === index ? 'active' : ''}
                    type="button"
                    onClick={() => setSelectedTeam(index)}
                    title={`${TEAM_LABELS[teamColorForIndex(index)]} (key ${displayIndex + 1})`}
                  >
                    <img alt="" className="team-flag" draggable={false} src={flagAssets[teamColorForIndex(index)]} />
                    {TEAM_LABELS[teamColorForIndex(index)]}
                  </button>
                ))}
              </div>
              </div>
            )}
          </section>

        </div>
      </aside>

      {sidebarOpen ? (
        <button className="editor-sidebar-scrim" type="button" aria-label="Close tools" onClick={() => setSidebarOpen(false)} />
      ) : null}

      <div className="editor-stage">
        <div className="stage-topbar">
          <div className="stage-tool-summary">
            <span className="tool-chip-pill"><span className="tool-chip-icon"><ToolIcon selectedTeam={selectedTeam} teamCount={teamCount} toolId={selectedTool} /></span>{TOOL_LOOKUP[selectedTool].label}</span>
            <p className="stage-context">{stageContext}</p>
          </div>
          <div className="stage-topbar-actions">
            <div className={`stage-help ${helpOpen ? 'is-open' : ''}`}>
              <button
                aria-label="Show editor controls"
                aria-expanded={helpOpen}
                className="stage-help-trigger"
                type="button"
                onClick={() => setHelpOpen((current) => !current)}
              >
                <Info aria-hidden="true" className="stage-help-trigger-icon" strokeWidth={2.2} />
              </button>
            </div>
          </div>
        </div>

        {helpOpen ? (
          <div className="stage-help-drawer" role="note">
            <div className="stage-help-drawer-heading">
              <strong>Editor controls</strong>
              <button className="ghost-button" type="button" onClick={() => setHelpOpen(false)}>Close</button>
            </div>
            <div className="stage-help-list">
              {helpItems.map((item) => (
                <div key={item.id} className="help-row">
                  <span className="help-row-glyph"><ControlGlyph icon={item.icon} /></span>
                  <div className="help-row-copy">
                    <div className="help-row-head">
                      <span className="help-row-label">{item.label}</span>
                      {item.keys?.length ? (
                        <span className="help-row-keys">
                          {item.keys.map((key) => (
                            <span key={`${item.id}-${key}`} className="keycap">{key}</span>
                          ))}
                        </span>
                      ) : null}
                    </div>
                    <span className="help-row-action">{item.action}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {selectedTool === 'select' && selectedEntities.length > 0 ? (
          <div className="stage-selection-bar" aria-label="Selected map objects">
            <span><strong>{selectedEntities.length}</strong> selected</span>
            <div className="selection-action-bar">
              <button className="secondary-button" type="button" disabled={selectedUnitCount < 2} onClick={spaceSelectedUnitsEvenly}>
                Space evenly
              </button>
              <button className="danger-button" type="button" onClick={deleteSelectedEntities}>Delete</button>
              <button className="ghost-button" type="button" onClick={clearSelection}>Unselect</button>
            </div>
          </div>
        ) : null}

        <div className="stage-frame" ref={stageRef}>
          <div className="canvas-stack" style={canvasStackStyle}>
            <canvas ref={canvasRef} className="map-canvas base" onContextMenu={(e) => e.preventDefault()} />
            <canvas
              ref={overlayRef}
              className={`map-canvas overlay ${isSpacePanActive || panSessionRef.current.active ? 'pan-ready' : ''} ${isPanDragging ? 'dragging' : ''}`}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onPointerLeave={handlePointerLeave}
            />
            {!ready && <div className="canvas-loading"><span className="loading-pulse" /></div>}
          </div>
        </div>
        {liveTeamSummaries.length > 0 ? (
          <div className="stage-map-live-summary" role="status" aria-live="polite" aria-label="Live team map summary">
            {liveTeamSummaries.map((summary) => {
              const teamColor = teamColorForIndex(summary.teamIndex);
              const line = formatTeamMapSummary(summary);

              return (
                <p
                  key={`${teamColor}-${summary.teamIndex}`}
                  className="stage-map-live-summary-line"
                  style={{ '--team-summary-accent': teamAccent(summary.teamIndex, teamCount) } as CSSProperties}
                  title={`${TEAM_LABELS[teamColor]}: ${line}`}
                >
                  {line}
                </p>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
    {leavePromptOpen ? (
      <div className="dialog-scrim" role="presentation">
        <div aria-modal="true" className="dialog-card" role="dialog">
          <p className="eyebrow">Unsaved changes</p>
          <h3>Save this map before leaving?</h3>
          <p>Saving overwrites the War of Dots map file. Discard leaves the file unchanged.</p>
          {leavePromptError ? <div className="dialog-error">{leavePromptError}</div> : null}
          <div className="dialog-actions split">
            <button className="secondary-button" type="button" disabled={saveState === 'saving'} onClick={cancelLeave}>
              Cancel
            </button>
            <span className="dialog-action-spacer" />
            <button className="danger-button" type="button" disabled={saveState === 'saving'} onClick={discardAndLeave}>
              Discard
            </button>
            <button className="primary-button" type="button" disabled={saveState === 'saving'} onClick={() => void saveAndLeave()}>
              {saveState === 'saving' ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
