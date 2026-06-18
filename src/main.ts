import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type RunnerState = {
  available: boolean;
  game_exe_exists: boolean;
  game_python_capture_available: boolean;
  desktop_strategy: string;
  window_strategy: string;
};

type BackendStatus = {
  status: string;
  runtime_dir: string;
  steam_game_dir: string;
  steam_game_exists: boolean;
  capture_source: string;
  runner: RunnerState;
};

type Job = {
  job_id: string;
  filename?: string;
  status: string;
  metadata: null | Record<string, unknown>;
  capture: null | Record<string, unknown>;
  synthesis: null | Record<string, unknown>;
  error: null | string;
};

type UnitAssetsPayload = {
  asset_dir: string;
  assets: Record<string, string>;
};

type ProgressState = {
  value: number;
  label: string;
  detail: string;
  facts: string[];
};

type CaptureProgressEvent = {
  stage?: string;
  phase?: string;
  status?: string;
  sample_index?: number;
  sample_count?: number;
  sample_hz?: number;
  max_samples?: number;
  tick?: number;
  tick_source?: string;
  end_tick?: number;
  tick_percent?: number | null;
  elapsed_ms?: number;
  game_object_count?: number;
  game_scene_count?: number;
  troop_count?: number;
  city_count?: number;
  controlled_city_count?: number;
  target_sim_speed?: number;
  replay_sample_hz?: number;
  replay_sample_tick_gap?: number;
  fast_forward_controller?: boolean;
  fast_forward_step_method?: string;
  fast_forward_frames_per_sample?: number;
  capture_throttle_seconds?: number;
  teams?: TeamMetric[];
  completion?: Record<string, unknown> | null;
};

type CaptureProgressPayload = {
  found: boolean;
  latest_mtime_ms?: number;
  job?: Job;
  event?: CaptureProgressEvent | null;
  event_count?: number;
  artifact?: Record<string, unknown> | null;
  stats?: Record<string, unknown> | null;
  partial_stats?: Record<string, unknown> | null;
};

type CaptureSampleDeltaPayload = {
  found: boolean;
  offset: number;
  samples: Sample[];
  meta?: (Omit<Stats, "samples"> & { samples?: Sample[] }) | null;
  final_stats?: (Omit<Stats, "samples"> & { samples?: Sample[] }) | null;
  stream_bytes?: number;
};

type Troop = {
  slot: number | string;
  unit_id: string;
  owner?: number | string | null;
  type?: string | number | null;
  unit_kind?: string | number | null;
  class_name?: string | null;
  ship_state?: Record<string, unknown> | null;
  x: number | null;
  y: number | null;
  health?: number | null;
  morale?: number | null;
  morale_state?: Record<string, unknown> | null;
  alive: boolean;
  path: Array<{ x: number; y: number }>;
  projection_lines?: Array<Array<{ x: number; y: number }>>;
  projection_reset?: boolean;
};

type City = {
  city_id: number | string;
  x: number | null;
  y: number | null;
  owner?: number | string | null;
  capital?: boolean;
};

type WorldPoint = { x: number; y: number };
type ProjectionPathState = {
  lines: WorldPoint[][];
  signature: string;
  frameIndex: number;
  tick: number;
};
type ProjectionSource = WorldPoint & {
  owner: number;
  weight: number;
  kind: "unit" | "city";
  influenceRadius: number;
  localRadius: number;
  localWeight: number;
  guardRadius: number;
};

type Team = {
  index: number;
  name: string;
  color_name?: string | null;
  color_hex?: string | null;
};

type TeamMetric = {
  index: number;
  alive_units?: number;
  total_units?: number;
  health_total?: number;
  strength?: number | null;
  troops_estimate?: number | null;
  displayed_casualties?: number | null;
  casualties_displayed?: number | null;
  casualties?: number | null;
  casualties_estimate?: number | null;
  troop_casualties?: number | null;
  funds?: number | null;
};

type SampleMetrics = {
  teams?: TeamMetric[];
  sources?: Record<string, string | null>;
};

type Sample = {
  sample_index: number;
  timestamp_ms: number;
  tick: number;
  troops: Troop[];
  cities?: City[];
  projection_lines?: Array<Array<{ x: number; y: number }>>;
  metrics?: SampleMetrics;
  events: Record<string, unknown>;
};

type MapPayload = {
  source?: string;
  image_data_url?: string;
  image_png?: string;
  width?: number;
  height?: number;
};

type Stats = {
  source: string;
  replay_metadata?: Record<string, unknown>;
  map?: MapPayload | null;
  teams?: Team[];
  samples: Sample[];
  summary: Record<string, unknown>;
};

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Phase = "booting" | "idle" | "loading" | "ready" | "error";
type GraphKind = "troops" | "funds" | "units" | "morale" | "casualties";
type GraphDefinition = {
  kind: GraphKind;
  title: string;
  approximate?: boolean;
};
type GraphWindow = {
  id: string;
  kind: GraphKind;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  z: number;
};
type GraphDragState = {
  id: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
};
type GraphResizeState = {
  id: string;
  pointerId: number;
  edge: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
};

const foundAppRoot = document.querySelector<HTMLDivElement>("#app");
if (!foundAppRoot) {
  throw new Error("App root is missing.");
}
const appRoot: HTMLDivElement = foundAppRoot;

const PLAYER_COLORS = ["#063bff", "#ff1616", "#1ebd5a", "#ffdd22", "#7d35ff", "#ff8a1f", "#19d8ff", "#ff5aa8"];
const AUTHORITATIVE_SOURCES = new Set(["game-live-python", "memory", "local-session-memory-capture"]);
const GAME_TICKS_PER_SECOND = 30;
const GRAPH_HISTORY_SECONDS = 300;
const MAX_BUFFERED_SAMPLES = 6000;
const MAX_PROJECTION_MEMORY_UNITS = 1000;
const PATH_REACHED_DISTANCE = 18;
const PATH_TRIM_DISTANCE = 28;
const CITY_MARKER_COLOR = "#f2df25";
const POWER_PROJECTION_GRID_PX = 11;
const UNIT_PROJECTION_INFLUENCE_RADIUS = 132;
const UNIT_PROJECTION_LOCAL_RADIUS = 50;
const UNIT_PROJECTION_LOCAL_WEIGHT = 4.375;
const UNIT_PROJECTION_GUARD_RADIUS = 20;
const UNIT_PROJECTION_GUARD_WEIGHT = 35;
const UNIT_PROJECTION_POWER_SCALE = 0.6;
const CITY_PROJECTION_GUARD_WEIGHT = 80;
const GRAPH_COMPACT_SIZE = { width: 272, height: 166 };
const GRAPH_MIN_SIZE = { width: 220, height: 132 };
const GRAPH_DEFINITIONS: Record<GraphKind, GraphDefinition> = {
  troops: { kind: "troops", title: "Troops", approximate: true },
  funds: { kind: "funds", title: "Funds" },
  units: { kind: "units", title: "Units" },
  morale: { kind: "morale", title: "Morale" },
  casualties: { kind: "casualties", title: "Casualties", approximate: true },
};
const DEFAULT_GRAPH_WINDOWS: GraphWindow[] = [
  { id: "graph-troops", kind: "troops", x: 18, y: 78, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: true, z: 9 },
  { id: "graph-funds", kind: "funds", x: 306, y: 78, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: false, z: 10 },
  { id: "graph-units", kind: "units", x: 594, y: 78, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: false, z: 11 },
  { id: "graph-morale", kind: "morale", x: 18, y: 260, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: false, z: 12 },
  { id: "graph-casualties", kind: "casualties", x: 306, y: 260, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: false, z: 13 },
];

let statusPayload: BackendStatus | null = null;
let jobs: Job[] = [];
let activeJob: Job | null = null;
let activeStats: Stats | null = null;
let boundsCache: Bounds | null = null;
let phase: Phase = "booting";
let selectedFileName = "";
let notice: { tone: "info" | "success" | "error"; text: string } | null = null;
let progress: ProgressState = { value: 0, label: "Starting", detail: "Opening the local replay backend.", facts: [] };
let progressTimer = 0;
let captureProgressTimer = 0;
let sampleDeltaTimer = 0;
let captureProgressToken = 0;
let captureProgressInFlight = false;
let sampleDeltaInFlight = false;
let sampleStreamOffset = 0;
let liveCaptureActive = false;
let liveEdgePaused = false;
let dropActive = false;
let playing = false;
let frameIndex = 0;
let playbackTick = 0;
let seekDragging = false;
let speed = 4;
let animationHandle = 0;
let lastAnimationTime = 0;
let showTrails = true;
let showDots = true;
let showPower = true;
let showMessages = true;
let mapImage: HTMLImageElement | null = null;
let mapImageSource = "";
let mapImageReady = false;
let unitAssetUrls: Record<string, string> = {};
let unitAssetsLoading = false;
const unitImageCache = new Map<string, { image: HTMLImageElement; source: string; ready: boolean }>();
let projectionPathMemory = new Map<string, ProjectionPathState>();
let projectionMemoryFrame = -1;
let graphWindows = DEFAULT_GRAPH_WINDOWS.map((windowState) => ({ ...windowState }));
let graphDrag: GraphDragState | null = null;
let graphResize: GraphResizeState | null = null;
let graphPaletteCloseTimer = 0;
let graphZCounter = 20;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatReplayClock(tick: unknown): string {
  const number = Number(tick);
  if (!Number.isFinite(number)) return "--:--";
  return formatTime((number / GAME_TICKS_PER_SECOND) * 1000);
}

function formatStat(value: unknown, approximate = false): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const rounded = Math.round(number);
  return `${approximate ? "~" : ""}${rounded.toLocaleString()}`;
}

function resetMapImage() {
  mapImage = null;
  mapImageSource = "";
  mapImageReady = false;
}

function ensureMapImage(): HTMLImageElement | null {
  const imagePng = activeStats?.map?.image_png ?? "";
  const source = activeStats?.map?.image_data_url ?? (imagePng ? `data:image/png;base64,${imagePng}` : "");
  if (!source) {
    resetMapImage();
    return null;
  }
  if (source !== mapImageSource) {
    mapImageSource = source;
    mapImageReady = false;
    mapImage = new Image();
    mapImage.onload = () => {
      mapImageReady = true;
      renderCanvas();
    };
    mapImage.onerror = () => {
      mapImageReady = false;
      renderCanvas();
    };
    mapImage.src = source;
  }
  return mapImageReady ? mapImage : null;
}

async function loadUnitAssets() {
  if (unitAssetsLoading || Object.keys(unitAssetUrls).length) return;
  unitAssetsLoading = true;
  try {
    const payload = await invoke<UnitAssetsPayload>("unit_assets");
    unitAssetUrls = payload.assets ?? {};
    unitImageCache.clear();
    renderCanvas();
  } catch {
    unitAssetUrls = {};
  } finally {
    unitAssetsLoading = false;
  }
}

function flattenPlayerName(value: unknown): string {
  if (Array.isArray(value)) return value.map(flattenPlayerName).filter(Boolean).join(" ");
  return String(value ?? "").trim();
}

function playerNamesFromMetadata(metadata: Record<string, unknown> | null | undefined): string[] {
  const raw = metadata?.player_usernames;
  if (!Array.isArray(raw)) return [];
  return raw.map(flattenPlayerName).filter(Boolean);
}

function teamList(): Team[] {
  if (activeStats?.teams?.length) return activeStats.teams;
  const names = players();
  return names.map((name, index) => ({ index, name, color_hex: PLAYER_COLORS[index % PLAYER_COLORS.length] }));
}

function teamForIndex(index: number): Team {
  return teamList().find((team) => Number(team.index) === index) ?? {
    index,
    name: `Player ${index + 1}`,
    color_hex: PLAYER_COLORS[index % PLAYER_COLORS.length],
  };
}

function ownerIndex(owner: unknown): number | null {
  const number = Number(owner);
  if (Number.isInteger(number)) return number;
  const text = String(owner ?? "").trim().toLowerCase();
  const named = ["blue", "red", "green", "yellow", "purple", "orange", "cyan", "pink"].indexOf(text);
  return named >= 0 ? named : null;
}

function teamColor(index: number): string {
  return teamForIndex(index).color_hex ?? PLAYER_COLORS[index % PLAYER_COLORS.length];
}

function getStats(job: Job | null): Stats | null {
  const stats = job?.capture?.stats;
  if (stats && typeof stats === "object" && "samples" in stats) return stats as Stats;
  return null;
}

function captureSource(job: Job | null, stats: Stats | null): string {
  const source = job?.capture?.source ?? stats?.source ?? "";
  return String(source);
}

function isAuthoritativeCapture(job: Job | null, stats: Stats | null): boolean {
  return AUTHORITATIVE_SOURCES.has(captureSource(job, stats));
}

function rawSampleAtFrame(index = frameIndex): Sample | null {
  if (!activeStats?.samples.length) return null;
  return activeStats.samples[Math.min(index, activeStats.samples.length - 1)] ?? null;
}

function numeric(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function lerpOptional(start: unknown, end: unknown, amount: number): number | null {
  const first = numeric(start);
  const second = numeric(end);
  if (first === null && second === null) return null;
  if (first === null) return second;
  if (second === null) return first;
  return lerp(first, second, amount);
}

function interpolateTroops(current: Troop[], next: Troop[], amount: number): Troop[] {
  const nextById = new Map(next.map((troop) => [troop.unit_id, troop]));
  return current.map((troop) => {
    const target = nextById.get(troop.unit_id);
    const x = lerpOptional(troop.x, target?.x, amount);
    const y = lerpOptional(troop.y, target?.y, amount);
    return {
      ...troop,
      type: target && amount >= 0.5 ? target.type ?? troop.type : troop.type,
      unit_kind: target && amount >= 0.5 ? target.unit_kind ?? troop.unit_kind : troop.unit_kind,
      class_name: target && amount >= 0.5 ? target.class_name ?? troop.class_name : troop.class_name,
      ship_state: target && amount >= 0.5 ? target.ship_state ?? troop.ship_state : troop.ship_state,
      x,
      y,
      health: lerpOptional(troop.health, target?.health, amount),
      morale: lerpOptional(troop.morale, target?.morale, amount),
      morale_state: target && amount >= 0.5 ? target.morale_state ?? troop.morale_state : troop.morale_state,
      alive: target ? troop.alive || target.alive : troop.alive,
      path: x !== null && y !== null ? [...(troop.path ?? []), { x, y }] : troop.path,
      projection_lines: target?.projection_lines ?? troop.projection_lines,
      projection_reset: target?.projection_reset ?? troop.projection_reset,
    };
  });
}

function interpolateTeamMetrics(current: TeamMetric[] = [], next: TeamMetric[] = [], amount: number): TeamMetric[] {
  const nextByIndex = new Map(next.map((team) => [Number(team.index), team]));
  return current.map((team) => {
    const target = nextByIndex.get(Number(team.index));
    return {
      ...team,
      alive_units: Math.round(lerpOptional(team.alive_units, target?.alive_units, amount) ?? team.alive_units ?? 0),
      total_units: Math.round(lerpOptional(team.total_units, target?.total_units, amount) ?? team.total_units ?? 0),
      health_total: lerpOptional(team.health_total, target?.health_total, amount) ?? team.health_total,
      strength: lerpOptional(team.strength, target?.strength, amount),
      troops_estimate: lerpOptional(team.troops_estimate, target?.troops_estimate, amount),
      displayed_casualties: lerpOptional(team.displayed_casualties, target?.displayed_casualties, amount),
      casualties_displayed: lerpOptional(team.casualties_displayed, target?.casualties_displayed, amount),
      casualties: lerpOptional(team.casualties, target?.casualties, amount),
      casualties_estimate: lerpOptional(team.casualties_estimate, target?.casualties_estimate, amount),
      troop_casualties: lerpOptional(team.troop_casualties, target?.troop_casualties, amount),
      funds: lerpOptional(team.funds, target?.funds, amount),
    };
  });
}

function sampleAtFrame(): Sample | null {
  const current = rawSampleAtFrame();
  const next = rawSampleAtFrame(frameIndex + 1);
  if (!current || !next || current === next) return current;
  const currentTick = Number(current.tick);
  const nextTick = Number(next.tick);
  if (!Number.isFinite(currentTick) || !Number.isFinite(nextTick) || nextTick <= currentTick) return current;
  const amount = Math.max(0, Math.min(1, (playbackTick - currentTick) / (nextTick - currentTick)));
  if (amount <= 0) return current;
  if (amount >= 1) return next;
  return {
    ...current,
    tick: Math.round(lerp(currentTick, nextTick, amount)),
    timestamp_ms: Math.round(lerpOptional(current.timestamp_ms, next.timestamp_ms, amount) ?? current.timestamp_ms),
    troops: interpolateTroops(current.troops, next.troops, amount),
    projection_lines: next.projection_lines ?? current.projection_lines,
    metrics: {
      ...current.metrics,
      teams: interpolateTeamMetrics(current.metrics?.teams, next.metrics?.teams, amount),
    },
  };
}

function firstCapturedTick(stats = activeStats): number {
  const sampleTick = Number(stats?.samples.at(0)?.tick);
  if (Number.isFinite(sampleTick)) return sampleTick;
  const summaryTick = Number(stats?.summary?.first_tick);
  if (Number.isFinite(summaryTick)) return summaryTick;
  return 0;
}

function lastCapturedTick(stats = activeStats): number {
  const sampleTick = Number(stats?.samples.at(-1)?.tick);
  if (Number.isFinite(sampleTick)) return sampleTick;
  const summaryTick = Number(stats?.summary?.last_tick);
  if (Number.isFinite(summaryTick)) return summaryTick;
  return 0;
}

function replayEndTick(stats = activeStats): number {
  const summaryTick = Number(stats?.summary?.end_tick);
  const metadataTick = Number(stats?.replay_metadata?.end);
  const fallbackTick = lastCapturedTick(stats);
  if (Number.isFinite(summaryTick) && summaryTick > 0) return summaryTick;
  if (Number.isFinite(metadataTick) && metadataTick > 0) return metadataTick;
  return fallbackTick;
}

function captureReachedReplayEnd(stats: Stats): boolean {
  const endTick = replayEndTick(stats);
  if (!endTick) return true;
  return lastCapturedTick(stats) >= endTick - 2;
}

function frameForTick(tick: number): number {
  const samples = activeStats?.samples ?? [];
  if (!samples.length) return 0;
  let low = 0;
  let high = samples.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const sampleTick = Number(samples[middle]?.tick ?? 0);
    if (sampleTick <= tick) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, Math.min(samples.length - 1, high));
}

function syncPlaybackTickToFrame() {
  playbackTick = Number(rawSampleAtFrame()?.tick ?? firstCapturedTick());
}

function timelineState(stats = activeStats, sample = sampleAtFrame()) {
  const firstTick = firstCapturedTick(stats);
  const loadedTick = Math.max(firstTick, lastCapturedTick(stats));
  const endTick = Math.max(loadedTick, replayEndTick(stats));
  const span = Math.max(1, endTick - firstTick);
  const currentTick = Math.max(firstTick, Math.min(loadedTick, Number(sample?.tick ?? playbackTick ?? firstTick)));
  const loadedPercent = Math.max(0, Math.min(100, ((loadedTick - firstTick) / span) * 100));
  const playedPercent = Math.max(0, Math.min(loadedPercent, ((currentTick - firstTick) / span) * 100));
  return {
    firstTick,
    loadedTick,
    endTick,
    currentTick,
    loadedPercent,
    playedPercent,
  };
}

function seekToTick(targetTick: number) {
  if (!activeStats?.samples.length) return;
  const state = timelineState(activeStats);
  playbackTick = Math.max(state.firstTick, Math.min(state.loadedTick, targetTick));
  frameIndex = frameForTick(playbackTick);
  if (playbackTick >= state.loadedTick && liveCaptureActive && isPartialCapture(activeStats)) {
    frameIndex = activeStats.samples.length - 1;
    playbackTick = state.loadedTick;
    liveEdgePaused = playing;
  } else {
    liveEdgePaused = false;
  }
  lastAnimationTime = 0;
  renderCanvas();
  updatePlaybackUi();
}

function seekToRatio(ratio: number) {
  if (!activeStats) return;
  const state = timelineState(activeStats);
  const bounded = Math.max(0, Math.min(1, ratio));
  seekToTick(state.firstTick + (state.endTick - state.firstTick) * bounded);
}

function seekRatioFromPointer(event: PointerEvent, element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return (event.clientX - rect.left) / rect.width;
}

function players(): string[] {
  return playerNamesFromMetadata(activeJob?.metadata ?? activeStats?.replay_metadata);
}

function troopBounds(samples: Sample[]): Bounds {
  const points: Array<{ x: number; y: number }> = [];
  for (const sample of samples) {
    for (const troop of sample.troops) {
      for (const point of troop.path ?? []) {
        if (Number.isFinite(point.x) && Number.isFinite(point.y)) points.push(point);
      }
      if (Number.isFinite(troop.x) && Number.isFinite(troop.y)) points.push({ x: Number(troop.x), y: Number(troop.y) });
    }
  }
  if (!points.length) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = 80;
  return {
    minX: Math.min(...xs) - padding,
    minY: Math.min(...ys) - padding,
    maxX: Math.max(...xs) + padding,
    maxY: Math.max(...ys) + padding,
  };
}

function replayBounds(): Bounds {
  if (!activeStats) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const mapWidth = Number(activeStats.map?.width);
  const mapHeight = Number(activeStats.map?.height);
  if (Number.isFinite(mapWidth) && mapWidth > 0 && Number.isFinite(mapHeight) && mapHeight > 0) {
    return { minX: 0, minY: 0, maxX: mapWidth, maxY: mapHeight };
  }
  boundsCache ??= troopBounds(activeStats.samples);
  return boundsCache;
}

function colorForTroop(troop: Troop): string {
  const owner = ownerIndex(troop.owner);
  if (owner !== null) return teamColor(owner);
  const key = String(troop.slot ?? troop.unit_id);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return PLAYER_COLORS[hash % PLAYER_COLORS.length];
}

function unitAssetColor(owner: number | null): string {
  const fallback = ["blue", "red", "purple", "orange"];
  const team = owner !== null ? teamForIndex(owner) : null;
  const named = String(team?.color_name ?? "").trim().toLowerCase();
  if (["blue", "red", "purple", "orange"].includes(named)) return named;
  if (owner !== null) return fallback[Math.max(0, owner) % fallback.length];
  return "blue";
}

function textUnitKind(value: unknown): "inf" | "tank" | "ship" | "heavy_ship" | null {
  const text = String(value ?? "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (!text) return null;
  if (text === "3" || text === "heavy_ship" || text.includes("_heavy_ship") || (text.includes("heavy") && text.includes("ship"))) {
    return "heavy_ship";
  }
  if (text === "2" || text === "ship" || text.includes("_ship") || text.includes("ship") || text.includes("boat") || text.includes("naval")) {
    return "ship";
  }
  if (text === "1" || text === "tank" || text.includes("tank")) return "tank";
  if (text === "0" || text === "inf" || text === "infantry" || text.includes("infantry") || text.includes("_inf")) return "inf";
  return null;
}

function truthyShipHint(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return Boolean(text && !["0", "false", "none", "null", "no", "off", "[]", "{}", "()"].includes(text));
  }
  return true;
}

function shipStateNumber(state: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = Number(state?.[key]);
  return Number.isFinite(value) ? value : null;
}

function unitKind(troop: Troop): "inf" | "tank" | "ship" | "heavy_ship" {
  const explicitKind = textUnitKind(troop.unit_kind);
  if (explicitKind) return explicitKind;
  const textKind = textUnitKind(troop.type) ?? textUnitKind(troop.class_name);
  if (textKind === "ship" || textKind === "heavy_ship") return textKind;
  const baseKind = textKind ?? "inf";
  const shipState: Record<string, unknown> = troop.ship_state ?? {};
  if (truthyShipHint(shipState.heavy_ship) || truthyShipHint(shipState._heavy_ship)) return "heavy_ship";
  if (truthyShipHint(shipState.is_ship) || truthyShipHint(shipState.ship) || truthyShipHint(shipState._ship) || truthyShipHint(shipState.ship_info)) {
    return baseKind === "tank" ? "heavy_ship" : "ship";
  }
  const shipTimer = shipStateNumber(shipState, "ship_timer");
  const waterTimer = shipStateNumber(shipState, "water_timer");
  if ((shipTimer !== null && shipTimer > 0) || (waterTimer !== null && waterTimer >= 2.75)) {
    return baseKind === "tank" ? "heavy_ship" : "ship";
  }
  if (baseKind === "tank") return "tank";
  return "inf";
}

function unitHealthRatio(troop: Troop, kind: string): number | null {
  const health = Number(troop.health);
  if (!Number.isFinite(health)) return null;
  if (health <= 1) return Math.max(0, Math.min(1, health));
  const maxHealth = kind === "tank" || kind === "heavy_ship" ? 200 : 100;
  return Math.max(0, Math.min(1, health / maxHealth));
}

function unitMoraleRatio(troop: Troop): number | null {
  const morale = Number(troop.morale);
  if (!Number.isFinite(morale)) return null;
  if (morale <= 1) return Math.max(0, Math.min(1, morale));
  return Math.max(0, Math.min(1, morale / 100));
}

function healthStage(ratio: number | null): 1 | 2 | 3 {
  if (ratio === null || ratio > 0.58) return 1;
  return ratio > 0.25 ? 2 : 3;
}

function unitTextureKey(troop: Troop): string {
  const owner = ownerIndex(troop.owner);
  const color = unitAssetColor(owner);
  const kind = unitKind(troop);
  if (kind === "ship" || kind === "heavy_ship") return `${color}_${kind}`;
  return `${color}_${kind}${healthStage(unitHealthRatio(troop, kind))}`;
}

function assetTexture(key: string, fallbackKey = ""): HTMLImageElement | null {
  const source = unitAssetUrls[key] ?? (fallbackKey ? unitAssetUrls[fallbackKey] : "");
  if (!source) return null;
  const cached = unitImageCache.get(key);
  if (cached?.source === source) return cached.ready ? cached.image : null;
  const image = new Image();
  const entry = { image, source, ready: false };
  unitImageCache.set(key, entry);
  image.onload = () => {
    entry.ready = true;
    renderCanvas();
  };
  image.onerror = () => {
    unitImageCache.delete(key);
  };
  image.src = source;
  return null;
}

function unitTexture(key: string): HTMLImageElement | null {
  return assetTexture(key, key.endsWith("_ship") ? "black_ship" : "");
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (![3, 6].includes(normalized.length)) return `rgba(255,255,255,${alpha})`;
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  const value = Number.parseInt(full, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function metricForTeam(sample: Sample, index: number): TeamMetric {
  return sample.metrics?.teams?.find((metric) => Number(metric.index) === index) ?? { index };
}

function teamAliveUnitCount(sample: Sample, teamIndex: number): number {
  return (sample.troops ?? []).filter((troop) => troop.alive && ownerIndex(troop.owner) === teamIndex).length;
}

function teamMoraleTotal(sample: Sample, teamIndex: number): number | null {
  const metric = metricForTeam(sample, teamIndex) as TeamMetric & {
    morale_total?: number | null;
    morale?: number | null;
    average_morale?: number | null;
  };
  const metricValue = numeric(metric.morale_total ?? metric.morale);
  if (metricValue !== null) return metricValue;

  let total = 0;
  let count = 0;
  for (const troop of sample.troops ?? []) {
    if (!troop.alive || ownerIndex(troop.owner) !== teamIndex) continue;
    const ratio = unitMoraleRatio(troop);
    if (ratio === null) continue;
    total += ratio * 100;
    count += 1;
  }
  if (count > 0) return total;

  const averageMorale = numeric(metric.average_morale);
  const unitCount = numeric(metric.alive_units) ?? teamAliveUnitCount(sample, teamIndex);
  return averageMorale !== null && unitCount > 0 ? averageMorale * unitCount : null;
}

function graphMetricValue(kind: GraphKind, sample: Sample, teamIndex: number): number | null {
  const metric = metricForTeam(sample, teamIndex);
  const value =
    kind === "troops"
      ? metric.troops_estimate ?? metric.strength ?? metric.alive_units
      : kind === "funds"
        ? metric.funds
        : kind === "units"
          ? metric.alive_units ?? teamAliveUnitCount(sample, teamIndex)
          : kind === "morale"
            ? teamMoraleTotal(sample, teamIndex)
            : metric.displayed_casualties ?? metric.casualties_displayed ?? metric.casualties_estimate ?? metric.casualties ?? metric.troop_casualties;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function graphMetricHistory(kind: GraphKind, teamIndex: number, sample: Sample): Array<{ tick: number; value: number }> {
  const currentTick = Number(sample.tick);
  if (!activeStats || !Number.isFinite(currentTick)) return [];
  const minTick = currentTick - GAME_TICKS_PER_SECOND * GRAPH_HISTORY_SECONDS;
  const history = activeStats.samples
    .filter((candidate) => candidate.tick >= minTick && candidate.tick <= currentTick)
    .map((candidate) => {
      const value = graphMetricValue(kind, candidate, teamIndex);
      return value === null ? null : { tick: candidate.tick, value };
    })
    .filter((point): point is { tick: number; value: number } => point !== null);
  const currentValue = graphMetricValue(kind, sample, teamIndex);
  if (currentValue !== null && (history.at(-1)?.tick ?? -1) < currentTick) {
    history.push({ tick: currentTick, value: currentValue });
  }
  return history;
}

function formatGraphValue(kind: GraphKind, value: unknown): string {
  return formatStat(value, GRAPH_DEFINITIONS[kind].approximate === true);
}

function graphAreaSize(): { width: number; height: number } {
  const area = document.querySelector<HTMLElement>(".viewer-area");
  return {
    width: Math.max(1, area?.clientWidth ?? window.innerWidth),
    height: Math.max(1, area?.clientHeight ?? window.innerHeight),
  };
}

function clampGraphWindow(windowState: GraphWindow) {
  const area = graphAreaSize();
  const margin = 8;
  windowState.width = Math.max(GRAPH_MIN_SIZE.width, Math.min(area.width - margin * 2, windowState.width));
  windowState.height = Math.max(GRAPH_MIN_SIZE.height, Math.min(area.height - margin * 2, windowState.height));
  const maxX = Math.max(margin, area.width - windowState.width - margin);
  const maxY = Math.max(margin, area.height - windowState.height - margin);
  windowState.x = Math.max(margin, Math.min(maxX, windowState.x));
  windowState.y = Math.max(margin, Math.min(maxY, windowState.y));
}

function raiseGraphWindow(id: string) {
  const windowState = graphWindows.find((candidate) => candidate.id === id);
  if (!windowState) return;
  windowState.z = ++graphZCounter;
  const element = document.querySelector<HTMLElement>(`[data-graph-window-id="${id}"]`);
  if (element) element.style.zIndex = String(windowState.z);
}

function visibleGraphKinds(): Set<GraphKind> {
  return new Set(graphWindows.filter((windowState) => windowState.visible).map((windowState) => windowState.kind));
}

function showGraphWindow(kind: GraphKind) {
  const windowState = graphWindows.find((candidate) => candidate.kind === kind);
  if (!windowState) return;
  windowState.visible = true;
  clampGraphWindow(windowState);
  raiseGraphWindow(windowState.id);
  render();
}

function toggleGraphKind(kind: GraphKind) {
  const windowState = graphWindows.find((candidate) => candidate.kind === kind);
  if (!windowState) return;
  if (windowState.visible) closeGraphWindow(windowState.id);
  else showGraphWindow(kind);
}

function closeGraphWindow(id: string) {
  const windowState = graphWindows.find((candidate) => candidate.id === id);
  if (!windowState) return;
  windowState.visible = false;
  render();
}

function renderGraphPalette(): string {
  const visible = visibleGraphKinds();
  return `
    <div class="graph-palette" aria-label="Graph windows">
      <div class="graph-palette-handle" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <div class="graph-palette-buttons">
      ${Object.values(GRAPH_DEFINITIONS)
        .map(
          (definition) => `
            <button
              type="button"
              data-graph-toggle="${definition.kind}"
              class="${visible.has(definition.kind) ? "active" : ""}"
              aria-pressed="${visible.has(definition.kind) ? "true" : "false"}"
            >${escapeHtml(definition.title)}</button>
          `,
        )
        .join("")}
      </div>
    </div>
  `;
}

function renderGraphWindows(sample: Sample | null): string {
  return graphWindows
    .filter((windowState) => windowState.visible)
    .map((windowState) => {
      clampGraphWindow(windowState);
      const definition = GRAPH_DEFINITIONS[windowState.kind];
      return `
        <section
          class="graph-window"
          data-graph-window-id="${escapeHtml(windowState.id)}"
          style="left:${windowState.x}px;top:${windowState.y}px;width:${windowState.width}px;height:${windowState.height}px;z-index:${windowState.z}"
          aria-label="${escapeHtml(definition.title)} graph"
        >
          <header class="graph-titlebar" data-graph-drag="${escapeHtml(windowState.id)}">
            <strong>${escapeHtml(definition.title)}</strong>
            <div class="graph-actions">
              <button class="graph-close" type="button" data-graph-close="${escapeHtml(windowState.id)}" aria-label="Close ${escapeHtml(definition.title)} graph"></button>
            </div>
          </header>
          <div class="graph-body">
            <canvas class="graph-canvas" data-graph-id="${escapeHtml(windowState.id)}"></canvas>
          </div>
          ${["n", "e", "s", "w", "ne", "nw", "se", "sw"]
            .map((edge) => `<span class="graph-resize-handle ${edge}" data-graph-resize="${escapeHtml(windowState.id)}" data-edge="${edge}"></span>`)
            .join("")}
        </section>
      `;
    })
    .join("");
}

function drawMetricGraphCanvas(canvas: HTMLCanvasElement, windowState: GraphWindow, sample: Sample | null) {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.floor(width * scale);
  const pixelHeight = Math.floor(height * scale);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  disableImageSmoothing(ctx);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(3, 5, 6, 0.18)";
  ctx.fillRect(0, 0, width, height);

  if (!sample) return;

  const teams = teamList().slice(0, 2);
  const currentTick = Number(sample.tick);
  if (!Number.isFinite(currentTick)) return;
  const minTick = currentTick - GAME_TICKS_PER_SECOND * GRAPH_HISTORY_SECONDS;
  const series = teams.map((team, index) => ({
    team,
    color: team.color_hex ?? teamColor(index),
    points: graphMetricHistory(windowState.kind, Number(team.index), sample),
  }));
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const liveValues = teams.map((team, index) => ({
    team,
    color: team.color_hex ?? teamColor(index),
    value: sample ? graphMetricValue(windowState.kind, sample, Number(team.index)) : null,
  }));

  if (values.length < 2) {
    ctx.fillStyle = "rgba(238, 244, 245, 0.54)";
    ctx.font = "800 12px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for data", width / 2, height / 2);
    drawGraphLiveValues(ctx, windowState.kind, liveValues, width, height);
    return;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueSpan = Math.max(1, maxValue - minValue);
  const padLeft = 8;
  const padRight = 92;
  const padTop = 12;
  const padBottom = 12;
  const plotX = padLeft;
  const plotY = padTop;
  const plotWidth = Math.max(1, width - padLeft - padRight);
  const plotHeight = Math.max(1, height - padTop - padBottom);
  const pointToScreen = (point: { tick: number; value: number }) => ({
    x: plotX + Math.max(0, Math.min(1, (point.tick - minTick) / (GAME_TICKS_PER_SECOND * GRAPH_HISTORY_SECONDS))) * plotWidth,
    y: plotY + (1 - (point.value - minValue) / valueSpan) * plotHeight,
  });

  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX, plotY + plotHeight / 2);
  ctx.lineTo(plotX + plotWidth, plotY + plotHeight / 2);
  ctx.stroke();

  for (const { color, points } of series) {
    if (points.length < 2) continue;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, index) => {
      const screen = pointToScreen(point);
      if (index === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.stroke();
  }

  drawGraphLiveValues(ctx, windowState.kind, liveValues, width, height);
}

function drawGraphLiveValues(
  ctx: CanvasRenderingContext2D,
  kind: GraphKind,
  values: Array<{ color: string; value: number | null }>,
  width: number,
  height: number,
) {
  const startY = Math.max(18, height / 2 - 17);
  ctx.save();
  ctx.font = "900 13px Inter, Segoe UI, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  values.slice(0, 2).forEach((item, index) => {
    const y = startY + index * 28;
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(width - 78, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = item.color;
    ctx.fillText(formatGraphValue(kind, item.value), width - 8, y);
  });
  ctx.restore();
}

function renderGraphCanvases(sample: Sample | null) {
  document.querySelectorAll<HTMLCanvasElement>(".graph-canvas").forEach((canvas) => {
    const id = canvas.dataset.graphId;
    const windowState = graphWindows.find((candidate) => candidate.id === id);
    if (windowState) drawMetricGraphCanvas(canvas, windowState, sample);
  });
}

function previousRawTroop(troop: Troop, searchFrames = 4): Troop | null {
  const key = String(troop.unit_id ?? troop.slot);
  for (let index = frameIndex - 1; index >= Math.max(0, frameIndex - searchFrames); index -= 1) {
    const found = rawSampleAtFrame(index)?.troops.find((candidate) => String(candidate.unit_id ?? candidate.slot) === key);
    if (found) return found;
  }
  return null;
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function damageShakeOffset(troop: Troop, fit: number): { x: number; y: number } {
  if (!troop.alive) return { x: 0, y: 0 };
  const health = Number(troop.health);
  const previous = Number(previousRawTroop(troop)?.health);
  if (!Number.isFinite(health) || !Number.isFinite(previous) || previous <= health) return { x: 0, y: 0 };
  const loss = previous - health;
  const intensity = Math.max(0.35, Math.min(1, loss / Math.max(8, previous * 0.12)));
  const amplitude = Math.max(1.5, Math.min(7, (2.5 + loss * 0.04) * Math.max(0.8, fit))) * 0.3;
  const seed = stableHash(String(troop.unit_id ?? troop.slot));
  const phase = playbackTick * 1.9 + seed * 0.013;
  return {
    x: Math.sin(phase) * amplitude * intensity,
    y: Math.cos(phase * 1.37) * amplitude * 0.7 * intensity,
  };
}

function disableImageSmoothing(ctx: CanvasRenderingContext2D) {
  ctx.imageSmoothingEnabled = false;
  ctx.imageSmoothingQuality = "low";
}

function drawPixelImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  disableImageSmoothing(ctx);
  ctx.drawImage(image, Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}

function validPoint(point: WorldPoint | null | undefined): point is WorldPoint {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function resetProjectionMemory() {
  projectionPathMemory = new Map();
  projectionMemoryFrame = -1;
}

function troopKey(troop: Troop): string {
  return String(troop.unit_id ?? troop.slot);
}

function troopPoint(troop: Troop): WorldPoint | null {
  const x = Number(troop.x);
  const y = Number(troop.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  const latest = troop.path?.at(-1);
  return validPoint(latest) ? latest : null;
}

function pointDistanceSq(first: WorldPoint, second: WorldPoint): number {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return dx * dx + dy * dy;
}

function pointDistance(first: WorldPoint, second: WorldPoint): number {
  return Math.sqrt(pointDistanceSq(first, second));
}

function dedupeLinePoints(points: WorldPoint[]): WorldPoint[] {
  const output: WorldPoint[] = [];
  for (const point of points) {
    if (!validPoint(point)) continue;
    const previous = output.at(-1);
    if (!previous || pointDistanceSq(previous, point) > 4) output.push({ x: point.x, y: point.y });
  }
  return output;
}

function cleanProjectionLines(lines: Troop["projection_lines"] | undefined): WorldPoint[][] {
  return (lines ?? [])
    .map((line) => dedupeLinePoints(line.filter(validPoint)))
    .filter((line) => line.length >= 2 && pointDistanceSq(line[0], line.at(-1)!) > 25);
}

function projectionSignature(lines: WorldPoint[][]): string {
  return lines
    .map((line) => {
      const assignmentPoints = line.length > 1 ? line.slice(1) : line;
      return assignmentPoints.map((point) => `${Math.round(point.x / 4)},${Math.round(point.y / 4)}`).join(";");
    })
    .join("|");
}

function polylineLength(points: WorldPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += pointDistance(points[index - 1], points[index]);
  }
  return total;
}

function closestPointOnPolyline(points: WorldPoint[], target: WorldPoint) {
  let bestPoint = points[0];
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestSegmentIndex = 0;
  let bestLengthAlong = 0;
  let lengthBeforeSegment = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const segmentLengthSq = dx * dx + dy * dy;
    const segmentLength = Math.sqrt(segmentLengthSq);
    const amount =
      segmentLengthSq > 0 ? Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / segmentLengthSq)) : 0;
    const projected = { x: start.x + dx * amount, y: start.y + dy * amount };
    const distanceSq = pointDistanceSq(target, projected);
    if (distanceSq < bestDistanceSq) {
      bestPoint = projected;
      bestDistanceSq = distanceSq;
      bestSegmentIndex = index;
      bestLengthAlong = lengthBeforeSegment + segmentLength * amount;
    }
    lengthBeforeSegment += segmentLength;
  }

  return {
    point: bestPoint,
    distance: Math.sqrt(bestDistanceSq),
    segmentIndex: bestSegmentIndex,
    lengthAlong: bestLengthAlong,
    totalLength: lengthBeforeSegment,
  };
}

function remainingProjectionLine(line: WorldPoint[], unitPosition: WorldPoint): WorldPoint[] | null {
  const points = dedupeLinePoints(line);
  if (points.length < 2) return null;
  const totalLength = polylineLength(points);
  if (totalLength < PATH_REACHED_DISTANCE) return null;
  const destination = points.at(-1)!;
  const destinationDistance = pointDistance(unitPosition, destination);
  if (destinationDistance <= PATH_REACHED_DISTANCE) return null;

  const closest = closestPointOnPolyline(points, unitPosition);
  const progress = closest.lengthAlong / Math.max(1, closest.totalLength);
  if (closest.distance <= PATH_TRIM_DISTANCE && progress >= 0.985) return null;

  if (closest.distance > PATH_TRIM_DISTANCE || closest.lengthAlong <= PATH_REACHED_DISTANCE) return points;

  const remaining = dedupeLinePoints([closest.point, ...points.slice(closest.segmentIndex + 1)]);
  return remaining.length >= 2 ? remaining : null;
}

function updateProjectionMemoryFromSample(sample: Sample, index: number) {
  for (const troop of sample.troops) {
    const key = troopKey(troop);
    const position = troopPoint(troop);
    if (!troop.alive || !position) {
      projectionPathMemory.delete(key);
      continue;
    }
    if (troop.projection_reset) {
      projectionPathMemory.delete(key);
      continue;
    }

    const lines = cleanProjectionLines(troop.projection_lines);
    if (lines.length) {
      const signature = projectionSignature(lines);
      projectionPathMemory.set(key, { lines, signature, frameIndex: index, tick: sample.tick });
      continue;
    }

    const existing = projectionPathMemory.get(key);
    if (!existing) continue;
    const remaining = existing.lines.map((line) => remainingProjectionLine(line, position)).filter((line): line is WorldPoint[] => line !== null);
    if (!remaining.length) projectionPathMemory.delete(key);
  }
  trimProjectionMemory();
}

function trimProjectionMemory() {
  if (projectionPathMemory.size <= MAX_PROJECTION_MEMORY_UNITS) return;
  const staleKeys = [...projectionPathMemory.entries()]
    .sort((left, right) => left[1].frameIndex - right[1].frameIndex)
    .slice(0, projectionPathMemory.size - MAX_PROJECTION_MEMORY_UNITS)
    .map(([key]) => key);
  for (const key of staleKeys) projectionPathMemory.delete(key);
}

function updateProjectionMemoryToFrame(targetFrame: number) {
  if (!activeStats?.samples.length) {
    resetProjectionMemory();
    return;
  }
  const boundedFrame = Math.max(0, Math.min(targetFrame, activeStats.samples.length - 1));
  if (boundedFrame < projectionMemoryFrame) resetProjectionMemory();
  for (let index = projectionMemoryFrame + 1; index <= boundedFrame; index += 1) {
    const sample = rawSampleAtFrame(index);
    if (sample) updateProjectionMemoryFromSample(sample, index);
  }
  projectionMemoryFrame = boundedFrame;
}

function activeProjectionLines(sample: Sample): WorldPoint[][] {
  updateProjectionMemoryToFrame(frameIndex);
  const troopsByKey = new Map(sample.troops.map((troop) => [troopKey(troop), troop]));
  const output: WorldPoint[][] = [];

  for (const [key, path] of projectionPathMemory) {
    const troop = troopsByKey.get(key);
    const position = troop ? troopPoint(troop) : null;
    if (!troop || !troop.alive || !position) {
      projectionPathMemory.delete(key);
      continue;
    }
    const remaining = path.lines.map((line) => remainingProjectionLine(line, position)).filter((line): line is WorldPoint[] => line !== null);
    if (!remaining.length) {
      projectionPathMemory.delete(key);
      continue;
    }
    output.push(...remaining);
  }

  return output;
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  from: WorldPoint,
  to: WorldPoint,
  size: number,
) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - Math.PI / 6) * size, to.y - Math.sin(angle - Math.PI / 6) * size);
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle + Math.PI / 6) * size, to.y - Math.sin(angle + Math.PI / 6) * size);
  ctx.stroke();
}

function drawLineSet(
  ctx: CanvasRenderingContext2D,
  lines: WorldPoint[][],
  toScreen: (point: WorldPoint) => WorldPoint,
  fit: number,
  options: { alpha: number; lineWidth: number; arrowSize: number; dashed?: boolean },
) {
  if (!lines.length) return;
  ctx.save();
  ctx.strokeStyle = `rgba(0, 0, 0, ${options.alpha})`;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, options.lineWidth * Math.max(0.8, fit));
  if (options.dashed) ctx.setLineDash([Math.max(7, 9 * fit), Math.max(4, 5 * fit)]);
  for (const line of lines) {
    const points = line.filter(validPoint).map(toScreen);
    if (points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
    const last = points.at(-1);
    const previous = points.at(-2);
    if (options.arrowSize > 0 && last && previous) {
      drawArrowHead(ctx, previous, last, Math.max(6, options.arrowSize * Math.max(0.8, fit)));
    }
  }
  ctx.restore();
}

function drawPathLines(
  ctx: CanvasRenderingContext2D,
  sample: Sample,
  toScreen: (point: WorldPoint) => WorldPoint,
  fit: number,
) {
  drawLineSet(ctx, activeProjectionLines(sample), toScreen, fit, { alpha: 0.78, lineWidth: 3.2, arrowSize: 9 });
}

function troopProjectionWeight(troop: Troop): number {
  const kind = unitKind(troop);
  const ratio = unitHealthRatio(troop, kind) ?? 1;
  const kindWeight = kind === "tank" ? 1.12 : kind === "ship" || kind === "heavy_ship" ? 1.08 : 1;
  return UNIT_PROJECTION_POWER_SCALE * kindWeight * (0.5 + ratio * 0.5);
}

function projectionSources(sample: Sample): ProjectionSource[] {
  const sources: ProjectionSource[] = [];
  for (const troop of sample.troops ?? []) {
    if (!troop.alive) continue;
    const owner = ownerIndex(troop.owner);
    const point = troopPoint(troop);
    if (owner === null || !point) continue;
    const weight = troopProjectionWeight(troop);
    sources.push({
      ...point,
      owner,
      weight,
      kind: "unit",
      influenceRadius: UNIT_PROJECTION_INFLUENCE_RADIUS,
      localRadius: UNIT_PROJECTION_LOCAL_RADIUS,
      localWeight: UNIT_PROJECTION_LOCAL_WEIGHT * weight,
      guardRadius: UNIT_PROJECTION_GUARD_RADIUS,
    });
  }
  for (const city of sample.cities ?? []) {
    const owner = ownerIndex(city.owner);
    const x = Number(city.x);
    const y = Number(city.y);
    if (owner === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    sources.push({
      x,
      y,
      owner,
      weight: city.capital ? 3.6 : 2.45,
      kind: "city",
      influenceRadius: city.capital ? 330 : 285,
      localRadius: city.capital ? 120 : 96,
      localWeight: city.capital ? 3.4 : 2.4,
      guardRadius: 36,
    });
  }
  return sources;
}

function projectionOwnerList(sources: ProjectionSource[]): number[] {
  return [...new Set(sources.map((source) => source.owner))].sort((first, second) => first - second);
}

function projectionScoresAt(
  x: number,
  y: number,
  sources: ProjectionSource[],
  owners: number[],
  ownerPositions: Map<number, number>,
): Float64Array {
  const scores = new Float64Array(owners.length);
  for (const source of sources) {
    const ownerPosition = ownerPositions.get(source.owner);
    if (ownerPosition === undefined) continue;
    const dx = x - source.x;
    const dy = y - source.y;
    const distanceSq = dx * dx + dy * dy;
    const influenceSq = source.influenceRadius * source.influenceRadius;
    const localSq = source.localRadius * source.localRadius;
    const guardSq = source.guardRadius * source.guardRadius;
    scores[ownerPosition] += source.weight * influenceSq / (distanceSq + influenceSq);
    scores[ownerPosition] += source.localWeight * localSq / (distanceSq + localSq);
    if (distanceSq < guardSq) {
      const guardWeight = source.kind === "unit" ? UNIT_PROJECTION_GUARD_WEIGHT : CITY_PROJECTION_GUARD_WEIGHT;
      scores[ownerPosition] += guardWeight * (1 - distanceSq / guardSq);
    }
  }
  return scores;
}

function projectionMarginForOwner(scores: Float64Array, ownerPosition: number): number {
  const ownerScore = scores[ownerPosition] ?? -Infinity;
  let nextBest = -Infinity;
  for (let index = 0; index < scores.length; index += 1) {
    if (index !== ownerPosition && scores[index] > nextBest) nextBest = scores[index];
  }
  return ownerScore - nextBest;
}

function contourT(first: number, second: number): number {
  const denominator = first - second;
  if (Math.abs(denominator) < 0.000001) return 0.5;
  return Math.max(0, Math.min(1, first / denominator));
}

function contourKey(point: WorldPoint): string {
  return `${Math.round(point.x * 2)},${Math.round(point.y * 2)}`;
}

function dedupeContourSegments(segments: Array<[WorldPoint, WorldPoint]>): Array<[WorldPoint, WorldPoint]> {
  const seen = new Set<string>();
  const output: Array<[WorldPoint, WorldPoint]> = [];
  for (const segment of segments) {
    const first = contourKey(segment[0]);
    const second = contourKey(segment[1]);
    const key = first < second ? `${first}|${second}` : `${second}|${first}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(segment);
  }
  return output;
}

function contourSegmentsToLines(segments: Array<[WorldPoint, WorldPoint]>): WorldPoint[][] {
  const items = segments.map(([a, b]) => ({ a, b, used: false }));
  const adjacency = new Map<string, number[]>();
  items.forEach((segment, index) => {
    for (const key of [contourKey(segment.a), contourKey(segment.b)]) {
      const list = adjacency.get(key) ?? [];
      list.push(index);
      adjacency.set(key, list);
    }
  });

  const takeNext = (key: string): number | null => {
    for (const index of adjacency.get(key) ?? []) {
      if (!items[index].used) return index;
    }
    return null;
  };

  const lines: WorldPoint[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const firstSegment = items[index];
    if (firstSegment.used) continue;
    firstSegment.used = true;
    const line = [firstSegment.a, firstSegment.b];

    for (;;) {
      const end = line.at(-1)!;
      const nextIndex = takeNext(contourKey(end));
      if (nextIndex === null) break;
      const segment = items[nextIndex];
      segment.used = true;
      const nextPoint = contourKey(segment.a) === contourKey(end) ? segment.b : segment.a;
      line.push(nextPoint);
      if (line.length > 2 && contourKey(line[0]) === contourKey(line.at(-1)!)) break;
    }

    for (;;) {
      const start = line[0];
      const nextIndex = takeNext(contourKey(start));
      if (nextIndex === null) break;
      const segment = items[nextIndex];
      segment.used = true;
      const nextPoint = contourKey(segment.a) === contourKey(start) ? segment.b : segment.a;
      line.unshift(nextPoint);
      if (line.length > 2 && contourKey(line[0]) === contourKey(line.at(-1)!)) break;
    }

    if (line.length >= 2) lines.push(line);
  }
  return lines;
}

function addMarchingSquareSegments(
  segments: Array<[WorldPoint, WorldPoint]>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  values: [number, number, number, number],
) {
  const edgePoint = (edge: number): WorldPoint => {
    if (edge === 0) {
      const t = contourT(values[0], values[1]);
      return { x: lerp(x0, x1, t), y: y0 };
    }
    if (edge === 1) {
      const t = contourT(values[1], values[2]);
      return { x: x1, y: lerp(y0, y1, t) };
    }
    if (edge === 2) {
      const t = contourT(values[3], values[2]);
      return { x: lerp(x0, x1, t), y: y1 };
    }
    const t = contourT(values[0], values[3]);
    return { x: x0, y: lerp(y0, y1, t) };
  };

  const index =
    (values[0] >= 0 ? 1 : 0) |
    (values[1] >= 0 ? 2 : 0) |
    (values[2] >= 0 ? 4 : 0) |
    (values[3] >= 0 ? 8 : 0);
  const cases: Record<number, Array<[number, number]>> = {
    1: [[3, 0]],
    2: [[0, 1]],
    3: [[3, 1]],
    4: [[1, 2]],
    5: [[3, 2], [0, 1]],
    6: [[0, 2]],
    7: [[3, 2]],
    8: [[2, 3]],
    9: [[0, 2]],
    10: [[0, 3], [1, 2]],
    11: [[1, 2]],
    12: [[1, 3]],
    13: [[0, 1]],
    14: [[3, 0]],
  };

  for (const [first, second] of cases[index] ?? []) {
    segments.push([edgePoint(first), edgePoint(second)]);
  }
}

function smoothStrokeLine(ctx: CanvasRenderingContext2D, points: WorldPoint[]) {
  if (points.length < 2) return;
  const closed = points.length > 3 && contourKey(points[0]) === contourKey(points.at(-1)!);
  const line = closed ? points.slice(0, -1) : points;
  if (line.length < 2) return;

  ctx.beginPath();
  if (closed) {
    const last = line.at(-1)!;
    const first = line[0];
    ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
    for (let index = 0; index < line.length; index += 1) {
      const point = line[index];
      const next = line[(index + 1) % line.length];
      ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    }
    ctx.closePath();
  } else {
    ctx.moveTo(line[0].x, line[0].y);
    for (let index = 1; index < line.length - 1; index += 1) {
      const point = line[index];
      const next = line[index + 1];
      ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    }
    const last = line.at(-1)!;
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

function drawProjectionLines(
  ctx: CanvasRenderingContext2D,
  sample: Sample,
  toScreen: (point: WorldPoint) => WorldPoint,
  fit: number,
  bounds: Bounds,
  screenRect: { x: number; y: number; width: number; height: number },
) {
  const sources = projectionSources(sample);
  const owners = projectionOwnerList(sources);
  if (owners.length >= 2 && screenRect.width > 2 && screenRect.height > 2) {
    const columns = Math.max(2, Math.min(220, Math.ceil(screenRect.width / POWER_PROJECTION_GRID_PX)));
    const rows = Math.max(2, Math.min(140, Math.ceil(screenRect.height / POWER_PROJECTION_GRID_PX)));
    const cellWidth = screenRect.width / columns;
    const cellHeight = screenRect.height / rows;
    const ownerPositions = new Map(owners.map((owner, index) => [owner, index]));
    const margins = owners.map(() => new Float32Array((columns + 1) * (rows + 1)));

    for (let row = 0; row <= rows; row += 1) {
      for (let column = 0; column <= columns; column += 1) {
        const screenX = screenRect.x + column * cellWidth;
        const screenY = screenRect.y + row * cellHeight;
        const worldX = bounds.minX + (screenX - screenRect.x) / fit;
        const worldY = bounds.minY + (screenY - screenRect.y) / fit;
        const scores = projectionScoresAt(worldX, worldY, sources, owners, ownerPositions);
        for (let ownerIndexValue = 0; ownerIndexValue < owners.length; ownerIndexValue += 1) {
          margins[ownerIndexValue][row * (columns + 1) + column] = projectionMarginForOwner(scores, ownerIndexValue);
        }
      }
    }

    const allSegments: Array<[WorldPoint, WorldPoint]> = [];
    for (let ownerIndexValue = 0; ownerIndexValue < owners.length; ownerIndexValue += 1) {
      const ownerMargins = margins[ownerIndexValue];
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x0 = screenRect.x + column * cellWidth;
          const y0 = screenRect.y + row * cellHeight;
          const x1 = x0 + cellWidth;
          const y1 = y0 + cellHeight;
          const stride = columns + 1;
          addMarchingSquareSegments(allSegments, x0, y0, x1, y1, [
            ownerMargins[row * stride + column],
            ownerMargins[row * stride + column + 1],
            ownerMargins[(row + 1) * stride + column + 1],
            ownerMargins[(row + 1) * stride + column],
          ]);
        }
      }
    }

    const lines = contourSegmentsToLines(dedupeContourSegments(allSegments)).filter((line) => line.length > 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(screenRect.x, screenRect.y, screenRect.width, screenRect.height);
    ctx.clip();
    ctx.strokeStyle = "rgba(0,0,0,0.86)";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.8, 2.25 * Math.max(0.82, fit));
    for (const line of lines) smoothStrokeLine(ctx, line);
    ctx.restore();
    return;
  }

  const lines = cleanProjectionLines(sample.projection_lines);
  drawLineSet(ctx, lines, toScreen, fit, { alpha: 0.88, lineWidth: 2.2, arrowSize: 0 });
}

function flagTextureForOwner(owner: unknown): HTMLImageElement | null {
  const ownerNumber = ownerIndex(owner);
  if (ownerNumber === null) return null;
  return assetTexture(`${unitAssetColor(ownerNumber)}_flag`);
}

function drawCity(
  ctx: CanvasRenderingContext2D,
  city: City,
  screen: WorldPoint,
  fit: number,
) {
  const markerSize = Math.max(6, 30 * fit);
  const radius = markerSize / 2;
  const capitalTexture = city.capital ? assetTexture("capital") : null;

  ctx.save();
  disableImageSmoothing(ctx);
  ctx.fillStyle = CITY_MARKER_COLOR;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fill();

  if (capitalTexture) {
    const imageHeight = capitalTexture.naturalHeight && capitalTexture.naturalWidth
      ? markerSize * (capitalTexture.naturalHeight / capitalTexture.naturalWidth)
      : markerSize;
    drawPixelImage(ctx, capitalTexture, screen.x - markerSize / 2, screen.y - imageHeight / 2, markerSize, imageHeight);
  }
  ctx.restore();
}

function drawCityFlag(
  ctx: CanvasRenderingContext2D,
  city: City,
  screen: WorldPoint,
  fit: number,
) {
  const markerSize = Math.max(6, 30 * fit);
  const radius = markerSize / 2;
  const flagTexture = flagTextureForOwner(city.owner);
  if (flagTexture) {
    ctx.save();
    disableImageSmoothing(ctx);
    const flagWidth = Math.max(5, markerSize * 0.72);
    const flagHeight = flagTexture.naturalHeight && flagTexture.naturalWidth
      ? flagWidth * (flagTexture.naturalHeight / flagTexture.naturalWidth)
      : flagWidth * 0.62;
    const flagX = screen.x - flagWidth * 0.12;
    const flagY = screen.y - radius - flagHeight * 0.78;
    drawPixelImage(ctx, flagTexture, flagX, flagY, flagWidth, flagHeight);
    ctx.restore();
  }
}

function drawCityBases(
  ctx: CanvasRenderingContext2D,
  sample: Sample,
  toScreen: (point: WorldPoint) => WorldPoint,
  fit: number,
) {
  for (const city of sample.cities ?? []) {
    const x = Number(city.x);
    const y = Number(city.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    drawCity(ctx, city, toScreen({ x, y }), fit);
  }
}

function drawCityFlags(
  ctx: CanvasRenderingContext2D,
  sample: Sample,
  toScreen: (point: WorldPoint) => WorldPoint,
  fit: number,
) {
  for (const city of sample.cities ?? []) {
    const x = Number(city.x);
    const y = Number(city.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    drawCityFlag(ctx, city, toScreen({ x, y }), fit);
  }
}

function drawTroop(
  ctx: CanvasRenderingContext2D,
  troop: Troop,
  latest: { x: number; y: number },
  color: string,
  fit: number,
) {
  const kind = unitKind(troop);
  const isTank = kind === "tank";
  const isShip = kind === "ship" || kind === "heavy_ship";
  const worldSize = isShip ? 42 : 30;
  const texture = unitTexture(unitTextureKey(troop));
  const spriteWidth = Math.max(6, worldSize * fit);
  const spriteHeight = texture?.naturalHeight && texture.naturalWidth
    ? spriteWidth * (texture.naturalHeight / texture.naturalWidth)
    : spriteWidth;
  ctx.save();
  disableImageSmoothing(ctx);
  ctx.globalAlpha = troop.alive ? 1 : 0.42;
  if (texture) {
    drawPixelImage(ctx, texture, latest.x - spriteWidth / 2, latest.y - spriteHeight / 2, spriteWidth, spriteHeight);
  } else {
    const radius = spriteWidth / 2;
    ctx.fillStyle = troop.alive ? color : "#707981";
    ctx.strokeStyle = "rgba(0,0,0,0.72)";
    ctx.lineWidth = Math.max(1, 2 * fit);
    ctx.beginPath();
    if (isTank) {
      ctx.moveTo(latest.x, latest.y - radius);
      ctx.lineTo(latest.x + radius, latest.y + radius);
      ctx.lineTo(latest.x - radius, latest.y + radius);
      ctx.closePath();
    } else {
      ctx.arc(latest.x, latest.y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const healthRatio = unitHealthRatio(troop, kind);
  const moraleRatio = unitMoraleRatio(troop);
  if (troop.alive && (healthRatio !== null || moraleRatio !== null)) {
    const barWidth = Math.max(10, spriteWidth * 0.82);
    const barHeight = Math.max(2, 4 * fit);
    const barGap = Math.max(1, 2 * fit);
    const barX = latest.x - barWidth / 2;
    const barY = latest.y - spriteHeight / 2 - Math.max(5, 7 * fit);
    const drawStatusBar = (row: number, ratio: number, fill: string) => {
      const y = barY + row * (barHeight + barGap);
      ctx.fillStyle = "rgba(0,0,0,0.82)";
      ctx.fillRect(barX - 1, y - 1, barWidth + 2, barHeight + 2);
      ctx.fillStyle = fill;
      ctx.fillRect(barX, y, barWidth * ratio, barHeight);
    };
    if (healthRatio !== null) drawStatusBar(0, healthRatio, "#04f58b");
    if (moraleRatio !== null) drawStatusBar(1, moraleRatio, "#2478ff");
  }
  ctx.restore();
}

function renderCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#replayCanvas");
  if (!canvas) return;
  const area = canvas.parentElement;
  const width = Math.max(1, area?.clientWidth ?? canvas.clientWidth);
  const height = Math.max(1, area?.clientHeight ?? canvas.clientHeight);
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.floor(width * scale);
  const pixelHeight = Math.floor(height * scale);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  disableImageSmoothing(ctx);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0c1012";
  ctx.fillRect(0, 0, width, height);

  const sample = sampleAtFrame();
  if (!activeStats || !sample) {
    ctx.fillStyle = "rgba(238,244,245,0.08)";
    ctx.font = "800 72px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("WOD", width / 2, height / 2);
    renderGraphCanvases(null);
    return;
  }

  const bounds = replayBounds();
  const worldWidth = Math.max(1, bounds.maxX - bounds.minX);
  const worldHeight = Math.max(1, bounds.maxY - bounds.minY);
  const fit = Math.min(width / worldWidth, height / worldHeight);
  const offsetX = (width - worldWidth * fit) / 2;
  const offsetY = (height - worldHeight * fit) / 2;
  const toScreen = (point: { x: number; y: number }) => ({
    x: offsetX + (point.x - bounds.minX) * fit,
    y: offsetY + (point.y - bounds.minY) * fit,
  });

  const image = ensureMapImage();
  if (image) {
    drawPixelImage(ctx, image, offsetX, offsetY, worldWidth * fit, worldHeight * fit);
  } else {
    ctx.fillStyle = "#9fc246";
    ctx.fillRect(offsetX, offsetY, worldWidth * fit, worldHeight * fit);
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1;
    for (let x = offsetX; x < offsetX + worldWidth * fit; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, offsetY);
      ctx.lineTo(x, offsetY + worldHeight * fit);
      ctx.stroke();
    }
    for (let y = offsetY; y < offsetY + worldHeight * fit; y += 64) {
      ctx.beginPath();
      ctx.moveTo(offsetX, y);
      ctx.lineTo(offsetX + worldWidth * fit, y);
      ctx.stroke();
    }
  }

  if (showPower) drawProjectionLines(ctx, sample, toScreen, fit, bounds, {
    x: offsetX,
    y: offsetY,
    width: worldWidth * fit,
    height: worldHeight * fit,
  });
  drawCityBases(ctx, sample, toScreen, fit);
  drawPathLines(ctx, sample, toScreen, fit);

  sample.troops.forEach((troop) => {
    const color = colorForTroop(troop);
    const points = (troop.path ?? []).map(toScreen);
    if (showTrails && points.length > 1) {
      ctx.strokeStyle = hexToRgba(color, troop.alive ? 0.46 : 0.16);
      ctx.globalAlpha = troop.alive ? 0.58 : 0.2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (showDots) {
      const latest =
        Number.isFinite(troop.x) && Number.isFinite(troop.y)
          ? toScreen({ x: Number(troop.x), y: Number(troop.y) })
          : points.at(-1);
      if (latest) {
        const shake = damageShakeOffset(troop, fit);
        drawTroop(ctx, troop, { x: latest.x + shake.x, y: latest.y + shake.y }, color, fit);
      }
    }
  });
  drawCityFlags(ctx, sample, toScreen, fit);

  if (showMessages) {
    const frameMessages = Object.entries(sample.events ?? {}).filter(([key, value]) => key.startsWith("message") && value);
    if (frameMessages.length) {
      ctx.fillStyle = "rgba(21,26,30,0.94)";
      ctx.fillRect(20, height - 126, Math.min(560, width - 40), 74);
      ctx.fillStyle = "#eef4f5";
      ctx.font = "700 14px Inter, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(frameMessages[0][1]).slice(0, 76), 34, height - 84);
    }
  }
  renderGraphCanvases(sample);
}

function progressPercent(): string {
  return `${Math.max(0, Math.min(100, progress.value)).toFixed(0)}%`;
}

function renderOverlay(): string {
  if (phase === "loading") {
    return `
      <div class="loading-screen">
        <div class="loading-card">
          <h2>${escapeHtml(progress.label)}</h2>
          <p>${escapeHtml(progress.detail)}</p>
          <div class="progress-track" aria-label="Replay loading progress">
            <div class="progress-fill" style="width:${progressPercent()}"></div>
          </div>
          <div class="progress-meta">
            <strong>${progressPercent()}</strong>
          </div>
          ${
            progress.facts.length
              ? `<div class="progress-facts">${progress.facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}</div>`
              : ""
          }
        </div>
      </div>
    `;
  }

  if (!activeStats) {
    return `
      <div class="welcome-screen ${dropActive ? "drop-active" : ""}">
        <div class="welcome-card">
          <h2>Open a replay and start watching.</h2>
          <p>Drop a .rep file here or choose one from disk. The app will launch the hidden game, capture live gamestate, and only open playback when the capture is authoritative.</p>
          <label class="primary-file-button" for="fileInput">Open .rep</label>
        </div>
      </div>
    `;
  }

  if (dropActive) {
    return `<div class="drop-overlay"><div>Drop replay file</div></div>`;
  }

  return "";
}

function renderTimeline(sample: Sample | null): string {
  const state = timelineState(activeStats, sample);
  return `
    <div class="timeline-dock" aria-label="Replay timeline controls">
      <button
        id="playButton"
        class="play-button transport-button ${playing ? "is-paused" : "is-playing"}"
        type="button"
        ${activeStats ? "" : "disabled"}
        aria-label="${playing ? "Pause replay" : "Play replay"}"
        title="${playing ? "Pause" : "Play"}"
      ><span></span></button>
      <div
        id="seekBar"
        class="seek-bar"
        role="slider"
        tabindex="0"
        aria-label="Replay timeline"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="${state.playedPercent.toFixed(1)}"
        aria-valuetext="Tick ${formatStat(state.currentTick)} of ${formatStat(state.endTick)}"
      >
        <div class="seek-track">
          <div id="seekLoaded" class="seek-loaded" style="width:${state.loadedPercent.toFixed(3)}%"></div>
          <div id="seekPlayed" class="seek-played" style="width:${state.playedPercent.toFixed(3)}%"></div>
          <div id="seekThumb" class="seek-thumb" style="left:${state.playedPercent.toFixed(3)}%"></div>
        </div>
      </div>
      <div class="timeline-speed">
        <strong id="speedValue">${speed.toFixed(1)}x</strong>
        <input id="speedRange" type="range" min="0.5" max="16" step="0.5" value="${speed}" aria-label="Playback speed">
      </div>
    </div>
  `;
}

function render() {
  const sample = sampleAtFrame();

  appRoot.innerHTML = `
    <main class="app-shell">
      <section class="viewer-area" aria-label="Replay viewer">
        <canvas id="replayCanvas" aria-label="Replay canvas"></canvas>
        <input id="fileInput" type="file" accept=".rep,application/gzip">
        ${
          activeStats
            ? `<div class="topbar"><div class="file-controls"><label class="file-button" for="fileInput">Open replay</label></div>${renderGraphPalette()}</div>`
            : ""
        }
        ${renderOverlay()}
        ${activeStats ? renderTimeline(sample) : ""}
        ${activeStats ? renderGraphWindows(sample) : ""}
      </section>
    </main>
  `;

  bindEvents();
  renderCanvas();
  updatePlaybackUi();
}

function bindEvents() {
  document.querySelector<HTMLInputElement>("#fileInput")?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void loadReplayFile(file);
  });
  bindPointerActivation(document.querySelector<HTMLButtonElement>("#playButton"), () => {
    if (!activeStats) return;
    playing ? pausePlayback() : startPlayback();
  });
  bindSeekBar();
  document.querySelector<HTMLInputElement>("#speedRange")?.addEventListener("input", (event) => {
    speed = Number((event.target as HTMLInputElement).value);
    updatePlaybackUi();
  });
  bindGraphEvents();
}

function bindPointerActivation(element: HTMLElement | null, handler: (event: PointerEvent | KeyboardEvent) => void) {
  if (!element) return;
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    handler(event);
  });
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handler(event);
  });
}

function bindGraphEvents() {
  const palette = document.querySelector<HTMLElement>(".graph-palette");
  if (palette) {
    palette.addEventListener("pointerenter", () => openGraphPalette(palette));
    palette.addEventListener("pointerleave", () => scheduleGraphPaletteClose(palette));
    palette.addEventListener("focusin", () => openGraphPalette(palette));
    palette.addEventListener("focusout", () => scheduleGraphPaletteClose(palette));
  }

  document.querySelectorAll<HTMLButtonElement>("[data-graph-toggle]").forEach((button) => {
    bindPointerActivation(button, () => {
      const kind = button.dataset.graphToggle as GraphKind | undefined;
      if (kind && kind in GRAPH_DEFINITIONS) toggleGraphKind(kind);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-graph-close]").forEach((button) => {
    bindPointerActivation(button, () => {
      const id = button.dataset.graphClose;
      if (id) closeGraphWindow(id);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-graph-window-id]").forEach((element) => {
    element.addEventListener("pointerdown", () => {
      const id = element.dataset.graphWindowId;
      if (id) raiseGraphWindow(id);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-graph-drag]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      const id = handle.dataset.graphDrag;
      const element = id ? document.querySelector<HTMLElement>(`[data-graph-window-id="${id}"]`) : null;
      if (!id || !element || (event.target instanceof HTMLElement && event.target.closest("button"))) return;
      const rect = element.getBoundingClientRect();
      graphDrag = {
        id,
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      handle.setPointerCapture(event.pointerId);
      raiseGraphWindow(id);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!graphDrag || graphDrag.pointerId !== event.pointerId) return;
      const windowState = graphWindows.find((candidate) => candidate.id === graphDrag?.id);
      const element = document.querySelector<HTMLElement>(`[data-graph-window-id="${graphDrag.id}"]`);
      const area = document.querySelector<HTMLElement>(".viewer-area");
      if (!windowState || !element || !area) return;
      const areaRect = area.getBoundingClientRect();
      windowState.x = event.clientX - areaRect.left - graphDrag.offsetX;
      windowState.y = event.clientY - areaRect.top - graphDrag.offsetY;
      clampGraphWindow(windowState);
      element.style.left = `${windowState.x}px`;
      element.style.top = `${windowState.y}px`;
      renderGraphCanvases(sampleAtFrame());
    });

    const stopDrag = (event: PointerEvent) => {
      if (!graphDrag || graphDrag.pointerId !== event.pointerId) return;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
      graphDrag = null;
    };
    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);
  });

  document.querySelectorAll<HTMLElement>("[data-graph-resize]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      const id = handle.dataset.graphResize;
      const edge = handle.dataset.edge ?? "";
      const windowState = graphWindows.find((candidate) => candidate.id === id);
      if (!id || !windowState || !edge) return;
      graphResize = {
        id,
        pointerId: event.pointerId,
        edge,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: windowState.x,
        startY: windowState.y,
        startWidth: windowState.width,
        startHeight: windowState.height,
      };
      handle.setPointerCapture(event.pointerId);
      raiseGraphWindow(id);
      event.preventDefault();
      event.stopPropagation();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!graphResize || graphResize.pointerId !== event.pointerId) return;
      resizeGraphWindow(event);
    });

    const stopResize = (event: PointerEvent) => {
      if (!graphResize || graphResize.pointerId !== event.pointerId) return;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
      graphResize = null;
    };
    handle.addEventListener("pointerup", stopResize);
    handle.addEventListener("pointercancel", stopResize);
  });
}

function openGraphPalette(element: HTMLElement) {
  window.clearTimeout(graphPaletteCloseTimer);
  element.classList.add("open");
}

function scheduleGraphPaletteClose(element: HTMLElement) {
  window.clearTimeout(graphPaletteCloseTimer);
  graphPaletteCloseTimer = window.setTimeout(() => {
    if (element.matches(":hover") || element.matches(":focus-within")) return;
    element.classList.remove("open");
  }, 260);
}

function resizeGraphWindow(event: PointerEvent) {
  if (!graphResize) return;
  const windowState = graphWindows.find((candidate) => candidate.id === graphResize?.id);
  const element = document.querySelector<HTMLElement>(`[data-graph-window-id="${graphResize.id}"]`);
  if (!windowState || !element) return;

  const dx = event.clientX - graphResize.startClientX;
  const dy = event.clientY - graphResize.startClientY;
  const area = graphAreaSize();
  const margin = 8;
  const maxWidth = Math.max(GRAPH_MIN_SIZE.width, area.width - margin * 2);
  const maxHeight = Math.max(GRAPH_MIN_SIZE.height, area.height - margin * 2);

  let x = graphResize.startX;
  let y = graphResize.startY;
  let width = graphResize.startWidth;
  let height = graphResize.startHeight;

  if (graphResize.edge.includes("e")) width = graphResize.startWidth + dx;
  if (graphResize.edge.includes("s")) height = graphResize.startHeight + dy;
  if (graphResize.edge.includes("w")) {
    width = graphResize.startWidth - dx;
    x = graphResize.startX + dx;
  }
  if (graphResize.edge.includes("n")) {
    height = graphResize.startHeight - dy;
    y = graphResize.startY + dy;
  }

  width = Math.max(GRAPH_MIN_SIZE.width, Math.min(maxWidth, width));
  height = Math.max(GRAPH_MIN_SIZE.height, Math.min(maxHeight, height));
  if (graphResize.edge.includes("w")) x = graphResize.startX + graphResize.startWidth - width;
  if (graphResize.edge.includes("n")) y = graphResize.startY + graphResize.startHeight - height;

  windowState.x = x;
  windowState.y = y;
  windowState.width = width;
  windowState.height = height;
  clampGraphWindow(windowState);

  element.style.left = `${windowState.x}px`;
  element.style.top = `${windowState.y}px`;
  element.style.width = `${windowState.width}px`;
  element.style.height = `${windowState.height}px`;
  renderGraphCanvases(sampleAtFrame());
}

function bindSeekBar() {
  const seekBar = document.querySelector<HTMLElement>("#seekBar");
  if (!seekBar) return;
  seekBar.addEventListener("pointerdown", (event) => {
    if (!activeStats) return;
    seekDragging = true;
    seekBar.setPointerCapture(event.pointerId);
    seekToRatio(seekRatioFromPointer(event, seekBar));
  });
  seekBar.addEventListener("pointermove", (event) => {
    if (!seekDragging || !activeStats) return;
    seekToRatio(seekRatioFromPointer(event, seekBar));
  });
  const stopDragging = (event: PointerEvent) => {
    if (!seekDragging) return;
    seekDragging = false;
    try {
      seekBar.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };
  seekBar.addEventListener("pointerup", stopDragging);
  seekBar.addEventListener("pointercancel", stopDragging);
  seekBar.addEventListener("keydown", (event) => {
    if (!activeStats) return;
    const step = event.shiftKey ? GAME_TICKS_PER_SECOND * 30 : GAME_TICKS_PER_SECOND * 5;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekToTick(playbackTick - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seekToTick(playbackTick + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      seekToTick(firstCapturedTick());
    } else if (event.key === "End") {
      event.preventDefault();
      seekToTick(lastCapturedTick());
    }
  });
}

function updatePlaybackUi() {
  const sample = sampleAtFrame();
  const state = timelineState(activeStats, sample);
  const seekBar = document.querySelector<HTMLElement>("#seekBar");
  if (seekBar) {
    seekBar.setAttribute("aria-valuenow", state.playedPercent.toFixed(1));
    seekBar.setAttribute("aria-valuetext", `Tick ${formatStat(state.currentTick)} of ${formatStat(state.endTick)}`);
  }
  const loaded = document.querySelector<HTMLElement>("#seekLoaded");
  if (loaded) loaded.style.width = `${state.loadedPercent}%`;
  const played = document.querySelector<HTMLElement>("#seekPlayed");
  if (played) played.style.width = `${state.playedPercent}%`;
  const thumb = document.querySelector<HTMLElement>("#seekThumb");
  if (thumb) thumb.style.left = `${state.playedPercent}%`;
  const playButton = document.querySelector<HTMLButtonElement>("#playButton");
  if (playButton) {
    playButton.classList.toggle("is-paused", playing);
    playButton.classList.toggle("is-playing", !playing);
    playButton.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    playButton.setAttribute("title", playing ? "Pause" : "Play");
  }
  const speedValue = document.querySelector<HTMLElement>("#speedValue");
  if (speedValue) speedValue.textContent = `${speed.toFixed(1)}x`;
}

function updateProgressUi() {
  const fill = document.querySelector<HTMLElement>(".progress-fill");
  if (fill) fill.style.width = progressPercent();
  const percent = document.querySelector<HTMLElement>(".progress-meta strong");
  if (percent) percent.textContent = progressPercent();
  const title = document.querySelector<HTMLElement>(".loading-card h2");
  if (title) title.textContent = progress.label;
  const detail = document.querySelector<HTMLElement>(".loading-card p");
  if (detail) detail.textContent = progress.detail;
  let facts = document.querySelector<HTMLElement>(".progress-facts");
  if (!facts && progress.facts.length) {
    const card = document.querySelector<HTMLElement>(".loading-card");
    facts = document.createElement("div");
    facts.className = "progress-facts";
    card?.appendChild(facts);
  }
  if (facts) {
    if (progress.facts.length) facts.innerHTML = progress.facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("");
    else facts.remove();
  }
}

function setProgress(value: number, label: string, detail: string, facts: string[] = []) {
  progress = { value, label, detail, facts };
  updateProgressUi();
}

function startProgressDrift(limit: number) {
  window.clearInterval(progressTimer);
  progressTimer = window.setInterval(() => {
    if (phase !== "loading") return;
    if (progress.value < limit) {
      progress.value += Math.max(0.25, (limit - progress.value) * 0.045);
      updateProgressUi();
    }
  }, 140);
}

function stopProgressDrift() {
  window.clearInterval(progressTimer);
  progressTimer = 0;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function readStats(jobId: string): Promise<Stats> {
  let offset = 0;
  let samples: Sample[] = [];
  let meta: CaptureSampleDeltaPayload["meta"] | CaptureSampleDeltaPayload["final_stats"] | null = null;
  for (let index = 0; index < 24 && samples.length < MAX_BUFFERED_SAMPLES; index += 1) {
    const payload = await invoke<CaptureSampleDeltaPayload>("capture_sample_delta", { jobId, offset });
    offset = Number(payload.offset ?? offset);
    sampleStreamOffset = offset;
    meta = payload.final_stats ?? payload.meta ?? meta;
    samples = appendDeltaSamples(samples, Array.isArray(payload.samples) ? payload.samples : []);
    if (!payload.found || !payload.samples.length || offset >= Number(payload.stream_bytes ?? 0)) break;
  }
  if (!meta || !samples.length) throw new Error("Stats artifact did not contain playable streamed samples.");
  return statsFromMeta(meta, samples, Boolean(meta && meta.summary?.partial === false));
}

function isPartialCapture(stats: Stats | null): boolean {
  if (!stats) return false;
  if (stats.summary?.partial === true) return true;
  return !captureReachedReplayEnd(stats);
}

function replaySubtitle(): string {
  if (!activeStats) return "Choose a replay to capture from the hidden game.";
  const sampleCount = Number(activeStats.summary?.sample_count ?? activeStats.samples.length);
  const lastTick = lastCapturedTick(activeStats);
  const endTick = replayEndTick(activeStats);
  const mode = liveCaptureActive || isPartialCapture(activeStats) ? "live capture" : "complete capture";
  return `${captureSource(activeJob, activeStats)} - ${mode} - ${formatStat(sampleCount)} samples - tick ${formatStat(lastTick)} / ${formatStat(endTick)}`;
}

function setActiveStats(stats: Stats, job: Job | null, { firstPartial = false } = {}) {
  const previousTick = Number.isFinite(playbackTick) ? playbackTick : firstCapturedTick(stats);
  const previousSource = activeStats?.map?.image_data_url ?? activeStats?.map?.image_png ?? "";
  const nextSource = stats.map?.image_data_url ?? stats.map?.image_png ?? "";
  const previousJobId = activeJob?.job_id ?? "";
  activeJob = job ?? activeJob;
  activeStats = stats;
  boundsCache = null;
  if (firstPartial || previousJobId !== (activeJob?.job_id ?? "")) resetProjectionMemory();
  if (previousSource && previousSource !== nextSource) resetMapImage();

  const maxFrame = Math.max(0, stats.samples.length - 1);
  if (firstPartial || frameIndex > maxFrame) {
    frameIndex = Math.min(frameIndex, maxFrame);
  }
  playbackTick = Math.min(Math.max(previousTick, firstCapturedTick(stats)), lastCapturedTick(stats));
  frameIndex = frameForTick(playbackTick);
}

function trimBufferedSamples(samples: Sample[]): Sample[] {
  if (samples.length <= MAX_BUFFERED_SAMPLES) return samples;
  return samples.slice(samples.length - MAX_BUFFERED_SAMPLES);
}

function appendDeltaSamples(existing: Sample[], incoming: Sample[]): Sample[] {
  if (!incoming.length) return existing;
  const lastIndex = Number(existing.at(-1)?.sample_index ?? -1);
  const filtered = incoming.filter((sample) => Number(sample.sample_index) > lastIndex);
  return filtered.length ? trimBufferedSamples([...existing, ...filtered]) : existing;
}

function statsFromMeta(meta: CaptureSampleDeltaPayload["meta"] | CaptureSampleDeltaPayload["final_stats"], samples: Sample[], final = false): Stats {
  const summary = meta?.summary ?? {};
  const sampleCount = Number(summary.sample_count);
  return {
    source: String(meta?.source ?? ""),
    replay_metadata: meta?.replay_metadata,
    map: meta?.map,
    teams: meta?.teams,
    samples,
    summary: {
      ...summary,
      sample_count: Number.isFinite(sampleCount) ? sampleCount : samples.length,
      buffered_sample_count: samples.length,
      first_tick: samples[0]?.tick ?? summary.first_tick,
      last_tick: samples.at(-1)?.tick ?? summary.last_tick,
      simulated_until_tick: samples.at(-1)?.tick ?? summary.simulated_until_tick,
      partial: final ? summary.partial === true : true,
    },
  };
}

async function applySampleDelta(job: Job | undefined, token = captureProgressToken): Promise<boolean> {
  const jobId = job?.job_id ?? activeJob?.job_id;
  if (!jobId) return false;
  const payload = await invoke<CaptureSampleDeltaPayload>("capture_sample_delta", { jobId, offset: sampleStreamOffset });
  if (token !== captureProgressToken) return false;
  sampleStreamOffset = Number(payload.offset ?? sampleStreamOffset);

  const meta = payload.final_stats ?? payload.meta;
  const incoming = Array.isArray(payload.samples) ? payload.samples : [];
  if (!meta || !AUTHORITATIVE_SOURCES.has(String(meta.source)) || (!incoming.length && !activeStats)) return false;

  const previousLastIndex = Number(activeStats?.samples.at(-1)?.sample_index ?? -1);
  const samples = appendDeltaSamples(activeStats?.samples ?? [], incoming);
  if (!samples.length) return false;
  const stats = statsFromMeta(meta, samples, Boolean(payload.final_stats));

  const hadNewSamples = Number(samples.at(-1)?.sample_index ?? -1) > previousLastIndex;
  const hasNewMap = Boolean(!activeStats?.map?.image_data_url && !activeStats?.map?.image_png && (stats.map?.image_data_url || stats.map?.image_png));
  const hasFinalMeta = Boolean(payload.final_stats);
  if (!hadNewSamples && !hasNewMap && !hasFinalMeta) return false;

  const openingViewer = phase === "loading";
  setActiveStats(stats, job ?? activeJob, { firstPartial: openingViewer });
  if (openingViewer) {
    phase = "ready";
    render();
    startPlayback();
  } else {
    renderCanvas();
    updatePlaybackUi();
    if (playing && liveEdgePaused && lastCapturedTick(stats) > playbackTick) {
      liveEdgePaused = false;
      lastAnimationTime = 0;
      window.cancelAnimationFrame(animationHandle);
      animationHandle = window.requestAnimationFrame(tickPlayback);
    }
  }
  return true;
}

function jobStatusProgress(status: string): { value: number; label: string; detail: string } {
  switch (status) {
    case "queued":
      return { value: 12, label: "Queued capture", detail: "The replay is validated and waiting for the hidden game runner." };
    case "cleaning_stale_game_processes":
      return { value: 18, label: "Cleaning hidden game", detail: "Closing stale staged War of Dots processes before this replay starts." };
    case "local_runner_starting":
      return { value: 22, label: "Starting local runner", detail: "Preparing the logged-in desktop automation session." };
    case "spawning_hidden_game_process":
      return { value: 25, label: "Spawning hidden game", detail: "Starting a fresh staged game process owned by this replay job." };
    case "launching_hidden_game":
      return { value: 28, label: "Launching hidden game", detail: "Starting War of Dots on the automation desktop and waiting for the Python probe." };
    case "running_hidden_game_capture":
      return { value: 30, label: "Running hidden capture", detail: "The replay-owned game process is active; waiting for live sampler progress." };
    case "starting_game":
      return { value: 24, label: "Starting game process", detail: "Launching a fresh staged game process for this replay." };
    case "opening_replay":
      return { value: 27, label: "Opening replay", detail: "Loading the replay inside the staged game process." };
    case "sampling_memory":
      return { value: 34, label: "Sampling gamestate", detail: "Reading verified memory fields from the replay-owned game process." };
    case "finalizing":
      return { value: 96, label: "Finalizing capture", detail: "Validating game-backed samples and writing stats." };
    case "synthesizing_replay":
      return { value: 98, label: "Synthesizing output", detail: "Packaging the captured game-state samples into the replay output." };
    case "captured":
      return { value: 100, label: "Capture ready", detail: "Opening authoritative playback." };
    case "failed":
      return { value: progress.value, label: "Capture failed", detail: "The hidden game capture failed. Opening the error details." };
    default:
      return { value: Math.max(progress.value, 32), label: "Preparing capture", detail: status.replaceAll("_", " ") || "Working through the capture pipeline." };
  }
}

function teamProgressFacts(event: CaptureProgressEvent, job: Job | undefined): string[] {
  const names = playerNamesFromMetadata(job?.metadata);
  const teams = event.teams ?? [];
  return teams.slice(0, 2).map((team, index) => {
    const label = names[index] || `Player ${index + 1}`;
    const troops = formatStat(team.troops_estimate ?? team.strength, true);
    const losses = formatStat(team.displayed_casualties ?? team.casualties_displayed ?? team.casualties_estimate ?? team.casualties ?? team.troop_casualties, true);
    const funds = formatStat(team.funds);
    return `${label}: troops ${troops}, losses ${losses}, funds ${funds}`;
  });
}

function applyCaptureProgress(payload: CaptureProgressPayload, filename: string) {
  if (!payload.found) {
    setProgress(
      Math.max(progress.value, 40),
      "Launching hidden game",
      "Waiting for the capture job to appear in the runtime workspace.",
      [`Replay ${filename}`],
    );
    return;
  }

  if (payload.job) activeJob = payload.job;
  const status = String(payload.job?.status ?? "");
  const event = payload.event ?? null;
  const statusProgress = jobStatusProgress(status);
  let value = Math.max(progress.value, statusProgress.value);
  let label = statusProgress.label;
  let detail = statusProgress.detail;
  let facts: string[] = [];

  if (event?.stage === "capture-start") {
    label = "Starting live sampler";
    detail = "The hidden game is loaded; configuring replay-speed and sample cadence.";
    facts = [
      `Target end tick ${formatStat(event.end_tick)}`,
      `Replay samples ${formatStat(event.replay_sample_hz ?? event.sample_hz)} Hz`,
      `Sample gap ${formatStat(event.replay_sample_tick_gap)} ticks`,
      `Game pump ${formatStat(event.target_sim_speed)}x`,
      `Manual burst ${formatStat(event.fast_forward_frames_per_sample)} frames/sample`,
      `Throttle ${Number(event.capture_throttle_seconds ?? 0) > 0 ? `${(Number(event.capture_throttle_seconds) * 1000).toFixed(0)} ms` : "off"}`,
      `Controller ${event.fast_forward_controller ? "on" : "off"} / ${event.fast_forward_step_method ?? "step"}`,
    ];
    value = Math.max(value, 30);
  } else if (event?.stage === "capture-sample") {
    const tick = Number(event.tick);
    const endTick = Number(event.end_tick);
    const tickPercent = Number.isFinite(Number(event.tick_percent))
      ? Number(event.tick_percent)
      : Number.isFinite(tick) && Number.isFinite(endTick) && endTick > 0
        ? tick / endTick
        : 0;
    const boundedPercent = Math.max(0, Math.min(1, tickPercent));
    value = Math.max(value, 30 + boundedPercent * 70);
    label = "Capturing live gamestate";
    detail = `Captured tick ${formatStat(tick)} / ${formatStat(endTick)} (${(boundedPercent * 100).toFixed(1)}%) at ${formatReplayClock(tick)} / ${formatReplayClock(endTick)}.`;
    facts = [
      `Samples ${formatStat(event.sample_count)} / ${formatStat(event.max_samples)}`,
      `Replay cadence ${formatStat(event.replay_sample_hz)} Hz / ${formatStat(event.replay_sample_tick_gap)} ticks`,
      `Objects ${formatStat(event.game_object_count)} game / ${formatStat(event.game_scene_count)} scene`,
      `Visible units ${formatStat(event.troop_count)}`,
      `Cities ${formatStat(event.controlled_city_count)} / ${formatStat(event.city_count)} controlled`,
      `Burst ${formatStat(event.fast_forward_frames_per_sample)} frames/sample`,
      `Elapsed ${formatTime(Number(event.elapsed_ms ?? 0))}`,
      ...teamProgressFacts(event, payload.job),
    ];
    if (event.completion) {
      value = Math.max(value, 100);
      facts.unshift(`Reached replay end: ${String(event.completion.reason ?? "complete").replaceAll("-", " ")}`);
    }
  } else if (event?.phase) {
    label = "Opening replay scene";
    detail = `Hidden game probe: ${event.phase.replaceAll("-", " ")}.`;
    facts = [`Job ${payload.job?.job_id ?? "-"}`, `Status ${status || "launching"}`];
    value = Math.max(value, 28);
  } else {
    facts = [`Job ${payload.job?.job_id ?? "-"}`, `Status ${status || "working"}`];
  }

  const statsSummary = (payload.stats?.summary ?? payload.partial_stats?.summary) as Record<string, unknown> | undefined;
  if (statsSummary?.sample_count) {
    facts.unshift(`Captured samples ${formatStat(statsSummary.sample_count)}`);
  }

  setProgress(value, label, detail, facts.filter(Boolean).slice(0, 8));
}

function stopCaptureProgressPolling() {
  window.clearInterval(captureProgressTimer);
  window.clearInterval(sampleDeltaTimer);
  captureProgressTimer = 0;
  sampleDeltaTimer = 0;
  captureProgressInFlight = false;
  sampleDeltaInFlight = false;
  captureProgressToken += 1;
}

function startCaptureProgressPolling(filename: string, startedAfterMs: number) {
  window.clearInterval(captureProgressTimer);
  window.clearInterval(sampleDeltaTimer);
  const token = ++captureProgressToken;
  const progressPoll = async () => {
    if (token !== captureProgressToken || (phase !== "loading" && !(phase === "ready" && liveCaptureActive))) return;
    if (captureProgressInFlight) return;
    captureProgressInFlight = true;
    try {
      const payload = await invoke<CaptureProgressPayload>("capture_progress", { filename, startedAfterMs });
      if (token !== captureProgressToken || (phase !== "loading" && !(phase === "ready" && liveCaptureActive))) return;
      if (phase === "loading") applyCaptureProgress(payload, filename);
      else if (payload.job) activeJob = payload.job;
    } catch {
      // Keep the current loading text; capture itself will report errors when it finishes.
    } finally {
      captureProgressInFlight = false;
    }
  };

  const samplePoll = async () => {
    if (token !== captureProgressToken || (phase !== "loading" && !(phase === "ready" && liveCaptureActive))) return;
    if (sampleDeltaInFlight) return;
    sampleDeltaInFlight = true;
    try {
      await applySampleDelta(activeJob ?? undefined, token);
    } catch {
      // Capture progress will surface terminal failures; sample hydration should keep trying.
    } finally {
      sampleDeltaInFlight = false;
    }
  };

  void progressPoll();
  void samplePoll();
  captureProgressTimer = window.setInterval(() => void progressPoll(), 500);
  sampleDeltaTimer = window.setInterval(() => void samplePoll(), 100);
}

async function refreshBackend({ quiet = false } = {}) {
  try {
    const [status, jobPayload] = await Promise.all([invoke<BackendStatus>("backend_status"), invoke<{ jobs: Job[] }>("list_jobs")]);
    statusPayload = status;
    jobs = jobPayload.jobs;
    if (phase === "booting") phase = "idle";
  } catch (error) {
    statusPayload = null;
    if (!quiet) notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
    if (phase === "booting") phase = "idle";
  }
  if (!quiet) render();
}

async function ensureGameRuntime() {
  await refreshBackend({ quiet: true });
  if (!statusPayload?.steam_game_exists || statusPayload.runner.game_exe_exists) return;

  setProgress(24, "Preparing game runtime", "Copying the Steam install into the app runtime. This only happens when needed.");
  startProgressDrift(42);
  try {
    await invoke<Record<string, unknown>>("stage_game");
    await refreshBackend({ quiet: true });
  } catch (error) {
    throw new Error(`Could not prepare the game runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadReplayFile(file: File) {
  pausePlayback();
  phase = "loading";
  selectedFileName = file.name;
  activeJob = null;
  activeStats = null;
  boundsCache = null;
  resetProjectionMemory();
  sampleStreamOffset = 0;
  liveCaptureActive = false;
  liveEdgePaused = false;
  resetMapImage();
  frameIndex = 0;
  playbackTick = 0;
  notice = null;
  setProgress(3, "Reading replay", "Loading the replay file from disk.");
  render();
  await nextPaint();

  try {
    const buffer = await file.arrayBuffer();
    setProgress(14, "Replay loaded", `${file.name} is ready for hidden game capture.`);
    await nextPaint();

    await ensureGameRuntime();

    setProgress(28, "Launching hidden game", "Starting War of Dots on the automation desktop.");
    await nextPaint();

    stopProgressDrift();
    setProgress(30, "Capturing gamestate", "Injecting the live sampler and waiting for authoritative game-state samples.");
    const replayBase64 = bytesToBase64(new Uint8Array(buffer));
    const captureStartedAt = Date.now();
    liveCaptureActive = true;
    startCaptureProgressPolling(file.name, captureStartedAt);
    const job = await invoke<Job>("capture_replay", { filename: file.name, replayBase64 });
    liveCaptureActive = false;
    stopCaptureProgressPolling();
    if (job.status !== "captured") throw new Error(job.error ?? "Game-backed capture failed.");

    const streamedStats = activeStats as Stats | null;
    if (streamedStats?.samples.length) {
      await applySampleDelta(job);
    }
    const refreshedStats = activeStats as Stats | null;
    const stats = refreshedStats?.samples.length ? refreshedStats : getStats(job) ?? (await readStats(job.job_id));
    if (!stats?.samples.length) throw new Error("Game-backed capture completed without playable samples.");
    if (!isAuthoritativeCapture(job, stats)) {
      throw new Error(`Refusing non-authoritative capture source: ${captureSource(job, stats) || "unknown"}.`);
    }

    setActiveStats(stats, job, { firstPartial: !activeStats });
    frameIndex = Math.min(frameIndex, Math.max(0, stats.samples.length - 1));
    syncPlaybackTickToFrame();
    jobs = [job, ...jobs.filter((candidate) => candidate.job_id !== job.job_id)];
    setProgress(100, "Capture ready", "Opening authoritative playback.");
    stopProgressDrift();
    await nextPaint();
    phase = "ready";
    notice = captureReachedReplayEnd(stats)
      ? { tone: "success", text: "Game-backed capture loaded. Playback started." }
      : {
          tone: "info",
          text: `Game-backed capture is partial through tick ${formatStat(lastCapturedTick(stats))}; seeking is capped to captured samples.`,
        };
    render();
    startPlayback();
    void refreshBackend({ quiet: true });
  } catch (error) {
    liveCaptureActive = false;
    stopCaptureProgressPolling();
    stopProgressDrift();
    const message = error instanceof Error ? error.message : String(error);
    const capturedStats = activeStats as Stats | null;
    if (capturedStats?.samples.length && isAuthoritativeCapture(activeJob, capturedStats)) {
      phase = "ready";
      notice = { tone: "error", text: `${message} Keeping the real samples captured so far.` };
    } else {
      phase = "error";
      notice = { tone: "error", text: message };
    }
    render();
  }
}

function startPlayback() {
  if (!activeStats?.samples.length) return;
  if (frameIndex >= activeStats.samples.length - 1) {
    if (liveCaptureActive && isPartialCapture(activeStats)) {
      frameIndex = activeStats.samples.length - 1;
      syncPlaybackTickToFrame();
      playing = true;
      liveEdgePaused = true;
      updatePlaybackUi();
      return;
    }
    frameIndex = 0;
  }
  syncPlaybackTickToFrame();
  playing = true;
  liveEdgePaused = false;
  lastAnimationTime = 0;
  updatePlaybackUi();
  window.cancelAnimationFrame(animationHandle);
  animationHandle = window.requestAnimationFrame(tickPlayback);
}

function pausePlayback() {
  playing = false;
  liveEdgePaused = false;
  window.cancelAnimationFrame(animationHandle);
  updatePlaybackUi();
}

function tickPlayback(time = 0) {
  if (!playing || !activeStats?.samples.length) return;
  if (!lastAnimationTime) lastAnimationTime = time;
  const elapsedSeconds = Math.max(0, (time - lastAnimationTime) / 1000);
  lastAnimationTime = time;
  playbackTick += elapsedSeconds * speed * GAME_TICKS_PER_SECOND;
  const maxTick = lastCapturedTick();
  frameIndex = frameForTick(Math.min(playbackTick, maxTick));
  if (playbackTick >= maxTick || frameIndex >= activeStats.samples.length - 1) {
    frameIndex = activeStats.samples.length - 1;
    playbackTick = maxTick;
    if (liveCaptureActive && isPartialCapture(activeStats)) {
      liveEdgePaused = true;
      renderCanvas();
      updatePlaybackUi();
      return;
    }
    playing = false;
  }
  if (elapsedSeconds > 0) {
    renderCanvas();
    updatePlaybackUi();
  }
  if (playing) animationHandle = window.requestAnimationFrame(tickPlayback);
}

function installFileDrop() {
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!dropActive) {
      dropActive = true;
      render();
    }
  });
  window.addEventListener("dragleave", (event) => {
    if (event.relatedTarget) return;
    dropActive = false;
    render();
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dropActive = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadReplayFile(file);
    else render();
  });
}

window.addEventListener("resize", () => {
  graphWindows.filter((windowState) => windowState.visible).forEach(clampGraphWindow);
  renderCanvas();
});
installFileDrop();
render();
void loadUnitAssets();
void refreshBackend();
