import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import MapEditorApp from "./map-editor/App";
import "./styles.css";

declare global {
  interface Window {
    __mapEditorConfirmLeave?: () => Promise<boolean>;
  }
}

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
  city_owner_counts?: Record<string, number>;
  city_owner_source_counts?: Record<string, number>;
  city_expected_owner_counts?: Array<number | null>;
  city_observed_owner_counts?: Array<number | null>;
  city_owner_count_mismatch?: boolean;
  target_sim_speed?: number;
  target_game_seconds_per_wall_second?: number;
  target_ticks_per_wall_second?: number;
  target_ticks_per_poll?: number;
  actual_game_seconds_per_wall_second?: number | null;
  tick_delta?: number | null;
  wall_delta_ms?: number | null;
  replay_sample_hz?: number;
  replay_sample_tick_gap?: number;
  fast_forward_controller?: boolean;
  fast_forward_step_method?: string;
  fast_forward_frames_per_sample?: number;
  next_fast_forward_frames_per_sample?: number;
  max_fast_forward_frames_per_sample?: number;
  capture_throttle_seconds?: number;
  timing_ms?: Record<string, number>;
  previous_pump_ms?: number | null;
  troop_cache_refresh?: boolean;
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
  owner_source?: string | null;
  owner_raw?: unknown;
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
  funds_displayed?: number | null;
  funds_raw?: number | null;
  city_count?: number | null;
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
  bridges?: Array<Array<{ x: number; y: number }>>;
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
type ReplayLaunchRequest = { fileName: string; filePath: string };
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

type ReplayBrowserPlayer = {
  name: string;
  teamIndex: number;
  winner: boolean;
};

type ReplayBrowserItem = {
  fileName: string;
  filePath: string;
  players: ReplayBrowserPlayer[];
  length: string;
  durationSeconds: number;
  thumbnailDataUrl?: string | null;
  modified: number;
  scoreDelta?: number | null;
};

type ReplayBrowserPayload = {
  replays: ReplayBrowserItem[];
  totalCandidates: number;
};

type BrowserSuggestion = {
  name: string;
  normalizedName: string;
  replayCount: number;
  winCount: number;
  lossCount: number;
  opponents: string[];
};
type BrowserFilterState = {
  query: string;
  enabledTypes: Set<string>;
  durationRange: { min: number; max: number };
};
type BrowserRenderedCard = {
  element: HTMLElement;
  searchText: string;
  matchType: string;
  durationSeconds: number;
  modified: number;
  names: string[];
  normalizedNames: string[];
  winnerIndex: number;
  winnerName: string;
  nameElements: HTMLElement[];
  winnerNameElement: HTMLElement | null;
  visible: boolean;
};
type BrowserPage = "replays" | "leaderboard" | "region" | "mapEditor";
type BrowserReplayPageSizeOption = 20 | 50 | 100 | "all";
type UserCheckpoint = {
  fetchedAt: number;
  source?: string | null;
  fields: Record<string, unknown>;
  score?: number | null;
  username?: string | null;
};
type UserDataPayload = {
  fetchedAt: number;
  username?: string | null;
  score?: number | null;
  source?: string | null;
  lookupError?: string | null;
  userData: unknown;
  messages: unknown[];
  checkpoints: UserCheckpoint[];
  checkpointFile?: string;
};
type ScorePoint = {
  time: number;
  score: number;
  label: string;
};
type LeaderboardLocalStats = {
  username: string;
  normalizedUsername: string;
  score: number;
  officialRank?: number | null;
  games?: number | null;
  wins?: number | null;
  losses?: number | null;
  region?: string | null;
  source?: string | null;
  fetchedAt?: number | null;
};
type LeaderboardSyncState = {
  status: "synced" | "not-submitted" | "sync-failed" | string;
  syncedAt?: number | null;
  username?: string | null;
  publicRank?: number | null;
  publicScore?: number | null;
  message?: string | null;
  error?: string | null;
};
type LeaderboardStatusPayload = {
  configured: boolean;
  canSubmit: boolean;
  submitReason: string;
  hasPassword: boolean;
  loginUsername?: string | null;
  local?: LeaderboardLocalStats | null;
  lastSync?: LeaderboardSyncState | null;
};
type LeaderboardRow = {
  rank: number;
  username: string;
  normalizedUsername?: string | null;
  score: number;
  officialRank?: number | null;
  games?: number | null;
  wins?: number | null;
  losses?: number | null;
  region?: string | null;
  updatedAt?: number | null;
  lastSeen?: number | null;
};
type LeaderboardListPayload = {
  configured: boolean;
  rows: LeaderboardRow[];
  message?: string | null;
};
type UserField = {
  key: string;
  label: string;
  value: unknown;
};
type RegionName = "NA" | "EU" | "ASIA";
type RegionStatusPayload = {
  gameRunning: boolean;
  selectedRegion?: RegionName | null;
  selectedAt?: number | null;
  message?: string | null;
  applyResult?: unknown;
};

const foundAppRoot = document.querySelector<HTMLDivElement>("#app");
if (!foundAppRoot) {
  throw new Error("App root is missing.");
}
const appRoot: HTMLDivElement = foundAppRoot;

function renderBootFatal(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "The replay window failed to start.");
  appRoot.innerHTML = `
    <main class="boot-fatal">
      <section>
        <h1>Replay window failed to start</h1>
        <p>${escapeHtml(message)}</p>
      </section>
    </main>
  `;
}

window.addEventListener("error", (event) => {
  if (!appRoot.childElementCount) renderBootFatal(event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  if (!appRoot.childElementCount) renderBootFatal(event.reason);
});

const currentWindowLabel = (() => {
  try {
    return getCurrentWindow().label;
  } catch (error) {
    renderBootFatal(error);
    return "";
  }
})();
const routeParams = new URLSearchParams(window.location.search);
const isStaticReplayPlayer = currentWindowLabel === "replayPlayer";
const labelLaunchId = currentWindowLabel.startsWith("replay-player-") ? currentWindowLabel.slice("replay-player-".length) : "";
const appMode = routeParams.get("mode") === "player" || labelLaunchId || isStaticReplayPlayer ? "player" : "browser";
const launchId = routeParams.get("launch") ?? labelLaunchId;

const PLAYER_COLORS = ["#063bff", "#ff1616", "#7d35ff", "#ff8a1f", "#1ebd5a", "#ffdd22", "#19d8ff", "#ff5aa8"];
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
const UNIT_PROJECTION_POWER_SCALE = 3.12;
const CITY_PROJECTION_GUARD_WEIGHT = 80;
const MAX_GRAPH_TEAMS = 4;
const GRAPH_COMPACT_SIZE = { width: 228, height: 122 };
const GRAPH_MIN_SIZE = { width: 170, height: 96 };
const DURATION_SLIDER_STEPS = 1000;
const DURATION_SLIDER_MIDPOINT_SECONDS = 5 * 60;
const SUGGESTION_LIMIT = 8;
const BROWSER_REPLAY_PAGE_SIZE_STORAGE_KEY = "wodReplayBrowserPageSize";
const BROWSER_REPLAY_PAGE_SIZE_OPTIONS: BrowserReplayPageSizeOption[] = [20, 50, 100, "all"];
const DEFAULT_BROWSER_REPLAY_PAGE_SIZE: BrowserReplayPageSizeOption = 100;
const BROWSER_REPLAY_PLAYBACK_ENABLED = false;
const REGION_NAMES: RegionName[] = ["NA", "EU", "ASIA"];
const REGION_LABELS: Record<RegionName, string> = {
  NA: "North America",
  EU: "Europe",
  ASIA: "Asia",
};
const FALLBACK_THUMBNAIL = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#9fbd42"/>
  <path d="M0 282c84-42 146-7 218-45 92-48 138-164 251-115 72 31 117 2 171-30v268H0z" fill="#2f7f35"/>
  <path d="M38 50c58-38 107 28 163 8 83-29 129-77 213-38 58 27 121-10 226 16v66c-102-38-154 10-223-14-90-32-133 61-222 40-80-19-120-18-157 21z" fill="#2f9fe9"/>
  <path d="M0 305c89-42 134 11 217-26 84-38 125-135 219-101 75 27 125 8 204-35v39c-82 37-133 60-207 33-86-31-132 63-216 100-83 37-129-17-217 24z" fill="#e9e3b4"/>
  <path d="M46 254c75-63 147-72 229-48 105 30 194-9 303-83" fill="none" stroke="#1c241f" stroke-width="9" stroke-linecap="round" opacity=".42"/>
</svg>`)}`;
const GRAPH_DEFINITIONS: Record<GraphKind, GraphDefinition> = {
  troops: { kind: "troops", title: "Troops", approximate: true },
  funds: { kind: "funds", title: "Funds" },
  units: { kind: "units", title: "Units" },
  morale: { kind: "morale", title: "Morale" },
  casualties: { kind: "casualties", title: "Casualties", approximate: true },
};
const DEFAULT_GRAPH_WINDOWS: GraphWindow[] = [
  { id: "graph-troops", kind: "troops", x: 18, y: 72, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: true, z: 9 },
  { id: "graph-funds", kind: "funds", x: 258, y: 72, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: false, z: 10 },
  { id: "graph-units", kind: "units", x: 498, y: 72, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: false, z: 11 },
  { id: "graph-morale", kind: "morale", x: 18, y: 206, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: false, z: 12 },
  { id: "graph-casualties", kind: "casualties", x: 258, y: 206, width: GRAPH_COMPACT_SIZE.width, height: GRAPH_COMPACT_SIZE.height, visible: false, z: 13 },
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
let graphZCounter = 20;
let browserReplays: ReplayBrowserItem[] = [];
let browserLoading = false;
let browserError = "";
let browserReplayTotal = 0;
let browserReplayPage = 0;
let browserSearch = "";
let browserHideUnmatched = true;
let browserSelectedTypes = new Set(["1v1", "3P FFA", "4P FFA"]);
let browserDurationBounds = { min: 0, max: 0 };
let browserDurationRange = { min: 0, max: 0 };
let browserSuggestionOpen = false;
let browserSelectedSuggestion = -1;
let browserSuggestionItems: BrowserSuggestion[] = [];
let browserRenderedCards: BrowserRenderedCard[] = [];
let pendingBrowserSearchFrame = 0;
let browserOpeningPaths = new Set<string>();
let browserReplayPageSize: BrowserReplayPageSizeOption = loadBrowserReplayPageSize();
let browserReplaySignature = "";
let browserReplayPollTimer = 0;
let browserDocumentEventsBound = false;
let currentLaunchSignature = "";
let browserPage: BrowserPage = "replays";
let mapEditorRoot: Root | null = null;
let userDataPayload: UserDataPayload | null = null;
let userDataLoading = false;
let userDataError = "";
let leaderboardStatusPayload: LeaderboardStatusPayload | null = null;
let leaderboardRows: LeaderboardRow[] = [];
let leaderboardLoading = false;
let leaderboardSubmitting = false;
let leaderboardError = "";
let leaderboardDetailsOpen = false;
let regionStatusPayload: RegionStatusPayload | null = null;
let regionLoading = false;
let regionApplying: RegionName | "" = "";
let regionError = "";
let regionPollTimer = 0;

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

function normalizeSearchText(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function formatDurationSeconds(seconds: unknown): string {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function parseBrowserReplayPageSizeOption(value: unknown): BrowserReplayPageSizeOption {
  if (value === "all") return "all";
  const numericValue = Number(value);
  if (numericValue === 20 || numericValue === 50 || numericValue === 100) return numericValue;
  return DEFAULT_BROWSER_REPLAY_PAGE_SIZE;
}

function loadBrowserReplayPageSize(): BrowserReplayPageSizeOption {
  try {
    const rawValue = window.localStorage.getItem(BROWSER_REPLAY_PAGE_SIZE_STORAGE_KEY);
    if (!rawValue) return DEFAULT_BROWSER_REPLAY_PAGE_SIZE;

    let parsedValue: unknown = rawValue;
    try {
      parsedValue = JSON.parse(rawValue);
    } catch {
      parsedValue = rawValue;
    }
    return parseBrowserReplayPageSizeOption(parsedValue);
  } catch {
    return DEFAULT_BROWSER_REPLAY_PAGE_SIZE;
  }
}

function saveBrowserReplayPageSize(value: BrowserReplayPageSizeOption) {
  try {
    window.localStorage.setItem(BROWSER_REPLAY_PAGE_SIZE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // The browser can still function if persistence is unavailable.
  }
}

function browserReplayPageSizeValue(total = browserReplayTotal): number {
  if (browserReplayPageSize === "all") return Math.max(1, total, browserReplays.length);
  return browserReplayPageSize;
}

function browserReplayRequestLimit(): number {
  return browserReplayPageSize === "all" ? 0 : browserReplayPageSize;
}

function browserReplayPageCount(total = browserReplayTotal): number {
  if (browserReplayPageSize === "all") return 1;
  return Math.max(1, Math.ceil(total / browserReplayPageSize));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function browserDurationCurvePower(): number {
  const span = Math.max(0, browserDurationBounds.max - browserDurationBounds.min);
  const midpointOffset = DURATION_SLIDER_MIDPOINT_SECONDS - browserDurationBounds.min;
  if (span === 0 || midpointOffset <= 0 || midpointOffset >= span) return 1;
  return Math.log(midpointOffset / span) / Math.log(0.5);
}

function durationPositionToSeconds(position: unknown): number {
  const span = Math.max(0, browserDurationBounds.max - browserDurationBounds.min);
  if (span === 0) return browserDurationBounds.min;
  const progress = clamp(Number(position) / DURATION_SLIDER_STEPS, 0, 1);
  return Math.round(browserDurationBounds.min + span * progress ** browserDurationCurvePower());
}

function secondsToDurationPosition(seconds: unknown): number {
  const span = Math.max(0, browserDurationBounds.max - browserDurationBounds.min);
  if (span === 0) return 0;
  const offset = clamp(Number(seconds) - browserDurationBounds.min, 0, span);
  const progress = (offset / span) ** (1 / browserDurationCurvePower());
  return Math.round(progress * DURATION_SLIDER_STEPS);
}

function replayMatchType(replay: ReplayBrowserItem): string {
  const playerCount = replay.players.length;
  if (playerCount === 2) return "1v1";
  if (playerCount === 3) return "3P FFA";
  if (playerCount === 4) return "4P FFA";
  return `${playerCount}P`;
}

function replayScoreDelta(replay: ReplayBrowserItem): number | null {
  const delta = Number(replay.scoreDelta);
  if (replayMatchType(replay) !== "1v1" || !Number.isFinite(delta) || delta === 0) return null;
  return Math.round(delta);
}

function formatScoreDelta(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign}${Math.abs(delta).toLocaleString()} elo`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function prettifyFieldLabel(path: string): string {
  const tail = path.split(".").at(-1) ?? path;
  return tail
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function flattenUserFields(value: unknown, prefix = "", fields: UserField[] = []): UserField[] {
  if (value === null || value === undefined) return fields;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenUserFields(item, prefix ? `${prefix}.${index}` : String(index), fields));
    return fields;
  }
  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      flattenUserFields(item, prefix ? `${prefix}.${key}` : key, fields);
    });
    return fields;
  }
  fields.push({ key: prefix || "value", label: prettifyFieldLabel(prefix || "value"), value });
  return fields;
}

function compactUserValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString();
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null);
}

function fieldNumber(fields: UserField[], patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const field = fields.find((candidate) => pattern.test(candidate.key) || pattern.test(candidate.label));
    const value = Number(field?.value);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function fieldText(fields: UserField[], patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const field = fields.find((candidate) => pattern.test(candidate.key) || pattern.test(candidate.label));
    if (field?.value !== null && field?.value !== undefined && String(field.value).trim()) return String(field.value);
  }
  return "";
}

function userDataFields(payload: UserDataPayload | null): UserField[] {
  if (!payload) return [];
  const primary = flattenUserFields(payload.userData);
  if (primary.length) return primary;
  return flattenUserFields(payload.messages);
}

function formatUserDate(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "-";
  return new Date(value * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatScoreChartDate(seconds: number, spanSeconds: number): string {
  const date = new Date(seconds * 1000);
  if (spanSeconds <= 26 * 60 * 60) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (spanSeconds > 300 * 24 * 60 * 60) options.year = "2-digit";
  return date.toLocaleDateString(undefined, options);
}

function formatCompactScore(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    const divisor = 1_000_000;
    return `${(value / divisor).toFixed(absolute >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  }
  if (absolute >= 10_000) {
    return `${Math.round(value / 1_000).toLocaleString()}K`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return Math.round(value).toLocaleString();
}

function formatChartRange(seconds: number): string {
  if (seconds >= 2 * 24 * 60 * 60) return `${Math.round(seconds / (24 * 60 * 60)).toLocaleString()} days`;
  if (seconds >= 24 * 60 * 60) return "1 day";
  if (seconds >= 2 * 60 * 60) return `${Math.round(seconds / (60 * 60)).toLocaleString()} hours`;
  if (seconds >= 60 * 60) return "1 hour";
  if (seconds < 60) return "<1 min";
  return `${Math.max(1, Math.round(seconds / 60)).toLocaleString()} min`;
}

function normalizeLeaderboardName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_.-]/g, "");
}

function leaderboardStatsFromUserData(payload: UserDataPayload | null): LeaderboardLocalStats | null {
  const fields = userDataFields(payload);
  const score = Number(payload?.score ?? fieldNumber(fields, [/(^|\.)(score|elo|rating)$/i]));
  const username =
    payload?.username ||
    fieldText(fields, [/(^|\.)(username|userName|name|displayName|playerName)$/i]) ||
    leaderboardStatusPayload?.local?.username ||
    "";
  const normalizedUsername = normalizeLeaderboardName(username);
  if (!Number.isFinite(score) || !username || !normalizedUsername) return leaderboardStatusPayload?.local ?? null;

  const officialRank = fieldNumber(fields, [/(^|\.)(rank|ratingRank|leaderboardRank|officialRank|position|place)$/i]);
  const wins = fieldNumber(fields, [/number[_\s-]*of[_\s-]*wins/i, /(^|\.)(wins|winCount|win_count|victories)$/i]);
  const total = fieldNumber(fields, [
    /number[_\s-]*of[_\s-]*games/i,
    /games[_\s-]*played/i,
    /(^|\.)(games|matches|played|gameCount|game_count|matchCount|match_count|totalGames|total_games|gamesPlayed|games_played)$/i,
  ]);
  const losses = total !== null && wins !== null ? Math.max(0, total - wins) : fieldNumber(fields, [/(^|\.)(losses|lossCount|defeats)$/i]);
  return {
    username,
    normalizedUsername,
    score,
    officialRank,
    games: total,
    wins,
    losses,
    region: regionStatusPayload?.selectedRegion ?? leaderboardStatusPayload?.local?.region ?? null,
    source: payload?.source ?? leaderboardStatusPayload?.local?.source ?? null,
    fetchedAt: payload?.fetchedAt ?? leaderboardStatusPayload?.local?.fetchedAt ?? null,
  };
}

function currentLeaderboardStats(): LeaderboardLocalStats | null {
  return leaderboardStatsFromUserData(userDataPayload) ?? leaderboardStatusPayload?.local ?? null;
}

function formatOptionalNumber(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : "-";
}

function leaderboardRowTime(row: LeaderboardRow): number | null {
  const time = Number(row.updatedAt ?? row.lastSeen);
  return Number.isFinite(time) && time > 0 ? time : null;
}

function leaderboardSyncLabel(status: LeaderboardStatusPayload | null): { label: string; tone: string; detail: string } {
  if (leaderboardSubmitting) return { label: "Syncing", tone: "info", detail: "Submitting the latest score snapshot." };
  if (!status?.configured) return { label: "Not submitted", tone: "warn", detail: status?.submitReason || "Set WOD_LEADERBOARD_URL to publish rankings." };
  if (!status.hasPassword) return { label: "Missing login", tone: "warn", detail: status.submitReason };
  if (status.lastSync?.status === "synced") {
    return { label: "Synced", tone: "good", detail: status.lastSync.syncedAt ? `Updated ${formatUserDate(status.lastSync.syncedAt)}` : "Latest score submitted." };
  }
  if (status.lastSync?.status === "sync-failed") {
    return { label: "Sync failed", tone: "bad", detail: status.lastSync.error || status.submitReason };
  }
  return { label: status.canSubmit ? "Not submitted" : "Not submitted", tone: status.canSubmit ? "info" : "warn", detail: status.submitReason };
}

function renderLeaderboardRows(currentName: string): string {
  if (leaderboardLoading && !leaderboardRows.length) {
    return `<div class="leaderboard-state">Loading public leaderboard...</div>`;
  }
  if (leaderboardError) {
    return `<div class="leaderboard-state is-error">${escapeHtml(leaderboardError)}</div>`;
  }
  if (!leaderboardRows.length) {
    const message = leaderboardStatusPayload?.configured
      ? "No public scores have been submitted yet."
      : "Leaderboard backend is not configured yet.";
    return `<div class="leaderboard-state">${escapeHtml(message)}</div>`;
  }

  return `
    <div class="leaderboard-table" role="table" aria-label="Public leaderboard">
      <div class="leaderboard-table-head" role="row">
        <span>Rank</span>
        <span>Player</span>
        <span>Score</span>
        <span>Games</span>
        <span>Wins</span>
        <span>Region</span>
        <span>Updated</span>
      </div>
      ${leaderboardRows
        .map((row) => {
          const normalized = normalizeLeaderboardName(row.normalizedUsername || row.username);
          const isCurrent = Boolean(currentName && normalized === currentName);
          const rank = Number(row.officialRank ?? row.rank);
          const hasRank = Number.isFinite(rank) && rank > 0;
          const topClass = hasRank && rank <= 3 ? ` is-top-${rank}` : "";
          return `
            <div class="leaderboard-row${topClass}${isCurrent ? " is-current" : ""}" role="row">
              <span class="leaderboard-rank" data-label="Rank">${hasRank ? `#${escapeHtml(rank.toLocaleString())}` : "-"}</span>
              <strong class="leaderboard-player" data-label="Player">${escapeHtml(row.username || "Unknown")}</strong>
              <span class="leaderboard-score" data-label="Score">${escapeHtml(formatOptionalNumber(row.score))}</span>
              <span data-label="Games">${escapeHtml(formatOptionalNumber(row.games))}</span>
              <span data-label="Wins">${escapeHtml(formatOptionalNumber(row.wins))}</span>
              <span data-label="Region">${escapeHtml(row.region || "-")}</span>
              <span data-label="Updated">${escapeHtml(formatUserDate(leaderboardRowTime(row)))}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function userScorePoints(payload: UserDataPayload | null): ScorePoint[] {
  if (!payload) return [];
  const points = payload.checkpoints
    .map((checkpoint) => ({
      time: Number(checkpoint.fetchedAt),
      score: Number(checkpoint.score ?? checkpoint.fields?.score),
      label: checkpoint.username || "Checkpoint",
    }))
    .filter((point) => Number.isFinite(point.time) && point.time > 0 && Number.isFinite(point.score));
  const currentScore = Number(payload.score);
  if (Number.isFinite(currentScore)) {
    const currentTime = Number(payload.fetchedAt || Math.floor(Date.now() / 1000));
    const last = points.at(-1);
    if (!last || last.time !== currentTime || last.score !== currentScore) {
      points.push({ time: currentTime, score: currentScore, label: "Current" });
    }
  }
  return points.sort((left, right) => left.time - right.time);
}

function renderScoreChart(payload: UserDataPayload | null): string {
  const points = userScorePoints(payload);
  if (points.length < 2) {
    return `<div class="score-chart-empty">Score history will appear after at least two scored checkpoints.</div>`;
  }

  const width = 760;
  const height = 292;
  const padding = { left: 68, right: 34, top: 28, bottom: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const minTime = Math.min(...points.map((point) => point.time));
  const maxTime = Math.max(...points.map((point) => point.time));
  const minScore = Math.min(...points.map((point) => point.score));
  const maxScore = Math.max(...points.map((point) => point.score));
  const timeSpan = Math.max(1, maxTime - minTime);
  const scoreSpread = Math.max(0, maxScore - minScore);
  const scorePadding = Math.max(12, Math.round(scoreSpread * 0.18), scoreSpread === 0 ? 24 : 0);
  const lowScore = minScore - scorePadding;
  const highScore = maxScore + scorePadding;
  const scoreSpan = Math.max(1, highScore - lowScore);
  const x = (time: number) => padding.left + ((time - minTime) / timeSpan) * plotWidth;
  const y = (score: number) => padding.top + (1 - (score - lowScore) / scoreSpan) * plotHeight;
  const plotted = points.map((point) => ({
    ...point,
    x: x(point.time),
    y: y(point.score),
  }));
  const path = plotted.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const last = points.at(-1)!;
  const first = points[0]!;
  const delta = last.score - first.score;
  const best = points.reduce((winner, point) => (point.score > winner.score ? point : winner), points[0]!);
  const range = Math.max(0, maxTime - minTime);
  const chartBottom = height - padding.bottom;
  const areaPath = `${path} L${plotted.at(-1)!.x.toFixed(1)} ${chartBottom} L${plotted[0]!.x.toFixed(1)} ${chartBottom} Z`;
  const horizontalTicks = Array.from({ length: 5 }, (_, index) => lowScore + (scoreSpan * index) / 4);
  const timeTickCount = range > 4 * 24 * 60 * 60 ? 4 : 3;
  const timeTicks =
    maxTime > minTime
      ? Array.from({ length: timeTickCount }, (_, index) => minTime + ((maxTime - minTime) * index) / (timeTickCount - 1))
      : [minTime];
  const sparsePoints =
    plotted.length > 80
      ? plotted.filter((_, index) => index === 0 || index === plotted.length - 1 || index % Math.ceil(plotted.length / 60) === 0)
      : plotted;
  const lastX = x(last.time);
  const lastY = y(last.score);
  const calloutWidth = 118;
  const calloutHeight = 34;
  const calloutX = clamp(lastX + 14, padding.left + 6, width - padding.right - calloutWidth - 6);
  const calloutY = clamp(lastY - calloutHeight - 14, padding.top + 4, chartBottom - calloutHeight - 4);
  const deltaLabel = delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();

  return `
    <div class="score-chart-meta">
      <div>
        <span>Current</span>
        <strong>${escapeHtml(last.score.toLocaleString())}</strong>
      </div>
      <div>
        <span>Change</span>
        <strong class="${delta >= 0 ? "is-gain" : "is-loss"}">${escapeHtml(deltaLabel)}</strong>
      </div>
      <div>
        <span>Best</span>
        <strong>${escapeHtml(best.score.toLocaleString())}</strong>
      </div>
      <div>
        <span>Range</span>
        <strong>${escapeHtml(formatChartRange(range || timeSpan))}</strong>
      </div>
    </div>
    <div class="score-chart-wrap">
      <svg class="score-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Score over time">
        <defs>
          <linearGradient id="scoreChartLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#67b7ff" />
            <stop offset="100%" stop-color="#72ef97" />
          </linearGradient>
          <linearGradient id="scoreChartArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#67b7ff" stop-opacity="0.34" />
            <stop offset="100%" stop-color="#67b7ff" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <g class="score-chart-grid">
          ${horizontalTicks
            .map(
              (tick) =>
                `<line x1="${padding.left}" y1="${y(tick).toFixed(1)}" x2="${width - padding.right}" y2="${y(tick).toFixed(1)}" />`,
            )
            .join("")}
          ${timeTicks
            .map((tick) => `<line x1="${x(tick).toFixed(1)}" y1="${padding.top}" x2="${x(tick).toFixed(1)}" y2="${chartBottom}" />`)
            .join("")}
        </g>
        <g class="score-chart-axis">
          <line x1="${padding.left}" y1="${chartBottom}" x2="${width - padding.right}" y2="${chartBottom}" />
          <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${chartBottom}" />
          ${horizontalTicks
            .map(
              (tick) =>
                `<text x="${padding.left - 12}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatCompactScore(tick))}</text>`,
            )
            .join("")}
          ${timeTicks
            .map(
              (tick, index) =>
                `<text x="${x(tick).toFixed(1)}" y="${height - 18}" text-anchor="${index === 0 ? "start" : index === timeTicks.length - 1 ? "end" : "middle"}">${escapeHtml(formatScoreChartDate(tick, range || timeSpan))}</text>`,
            )
            .join("")}
        </g>
        <path class="score-chart-area" d="${areaPath}" />
        <path class="score-chart-line" d="${path}" />
        <g class="score-chart-points">
          ${sparsePoints
            .map(
              (point) =>
                `<circle class="score-chart-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3"><title>${escapeHtml(
                  `${point.label}: ${point.score.toLocaleString()} on ${formatUserDate(point.time)}`,
                )}</title></circle>`,
            )
            .join("")}
        </g>
        <circle class="score-chart-highlight is-best" cx="${x(best.time).toFixed(1)}" cy="${y(best.score).toFixed(1)}" r="6">
          <title>${escapeHtml(`Best: ${best.score.toLocaleString()} on ${formatUserDate(best.time)}`)}</title>
        </circle>
        <line class="score-chart-callout-line" x1="${lastX.toFixed(1)}" y1="${lastY.toFixed(1)}" x2="${calloutX.toFixed(1)}" y2="${(calloutY + calloutHeight / 2).toFixed(1)}" />
        <circle class="score-chart-highlight is-current" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="7">
          <title>${escapeHtml(`Current: ${last.score.toLocaleString()} on ${formatUserDate(last.time)}`)}</title>
        </circle>
        <g class="score-chart-callout">
          <rect class="score-chart-callout-box" x="${calloutX.toFixed(1)}" y="${calloutY.toFixed(1)}" width="${calloutWidth}" height="${calloutHeight}" rx="8" />
          <text class="score-chart-callout-label" x="${(calloutX + 10).toFixed(1)}" y="${(calloutY + 13).toFixed(1)}">Current</text>
          <text class="score-chart-callout-value" x="${(calloutX + 10).toFixed(1)}" y="${(calloutY + 27).toFixed(1)}">${escapeHtml(last.score.toLocaleString())}</text>
        </g>
      </svg>
    </div>
  `;
}

function playerColorClass(player: ReplayBrowserPlayer, fallbackIndex: number): string {
  const teamIndex = Number.isInteger(player.teamIndex) ? player.teamIndex : fallbackIndex;
  return `player-${teamIndex + 1}`;
}

function renderHighlightedText(element: HTMLElement, text: string, query: string) {
  element.replaceChildren();
  if (!query) {
    element.textContent = text;
    return;
  }

  const normalized = normalizeSearchText(text);
  let cursor = 0;
  let matchStart = normalized.indexOf(query);
  while (matchStart !== -1) {
    if (matchStart > cursor) element.append(document.createTextNode(text.slice(cursor, matchStart)));
    const matchEnd = matchStart + query.length;
    const mark = document.createElement("mark");
    mark.textContent = text.slice(matchStart, matchEnd);
    element.append(mark);
    cursor = matchEnd;
    matchStart = normalized.indexOf(query, cursor);
  }
  if (cursor < text.length) element.append(document.createTextNode(text.slice(cursor)));
}

function browserSearchValue(): string {
  return document.querySelector<HTMLInputElement>("#playerSearch")?.value ?? browserSearch;
}

function selectedBrowserMatchTypes(): Set<string> {
  const typeFilters = document.querySelectorAll<HTMLInputElement>(".type-filter");
  if (!typeFilters.length) return new Set(browserSelectedTypes);
  return new Set(Array.from(typeFilters).filter((filter) => filter.checked).map((filter) => filter.value));
}

function currentBrowserDurationRange(): { min: number; max: number } {
  const durationMin = document.querySelector<HTMLInputElement>("#durationMin");
  const durationMax = document.querySelector<HTMLInputElement>("#durationMax");
  if (!durationMin || !durationMax) return { ...browserDurationRange };
  return {
    min: durationPositionToSeconds(durationMin.value),
    max: durationPositionToSeconds(durationMax.value),
  };
}

function currentBrowserFilterState(): BrowserFilterState {
  return {
    query: normalizeSearchText(browserSearchValue()),
    enabledTypes: selectedBrowserMatchTypes(),
    durationRange: currentBrowserDurationRange(),
  };
}

function cardMatchesNonSearchFilters(card: BrowserRenderedCard, filterState: BrowserFilterState): boolean {
  return (
    filterState.enabledTypes.has(card.matchType) &&
    card.durationSeconds >= filterState.durationRange.min &&
    card.durationSeconds <= filterState.durationRange.max
  );
}

function cardMatchesFilters(card: BrowserRenderedCard, filterState: BrowserFilterState): boolean {
  return (!filterState.query || card.searchText.includes(filterState.query)) && cardMatchesNonSearchFilters(card, filterState);
}

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function suggestionMatchRank(name: string, query: string): number {
  if (!query) return 0;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/\s+/).some((part) => part.startsWith(query))) return 2;
  return name.includes(query) ? 3 : Number.POSITIVE_INFINITY;
}

function sortedOpponentNames(opponents: Map<string, number>): string[] {
  return [...opponents.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], undefined, { sensitivity: "base" }))
    .map(([name]) => name);
}

function buildBrowserSuggestionItems(filterState: BrowserFilterState): BrowserSuggestion[] {
  const stats = new Map<string, BrowserSuggestion & { latestModified: number; rank: number; opponentCounts: Map<string, number> }>();

  for (const card of browserRenderedCards) {
    if (!cardMatchesNonSearchFilters(card, filterState)) continue;

    card.names.forEach((name, index) => {
      const key = card.normalizedNames[index];
      const rank = suggestionMatchRank(key, filterState.query);
      if (!Number.isFinite(rank)) return;

      const existing =
        stats.get(key) ??
        {
          name,
          normalizedName: key,
          replayCount: 0,
          winCount: 0,
          lossCount: 0,
          opponents: [],
          latestModified: 0,
          rank,
          opponentCounts: new Map<string, number>(),
        };

      existing.rank = Math.min(existing.rank, rank);
      existing.replayCount += 1;
      existing.winCount += card.winnerIndex === index ? 1 : 0;
      existing.lossCount += card.winnerIndex >= 0 && card.winnerIndex !== index ? 1 : 0;
      existing.latestModified = Math.max(existing.latestModified, card.modified);
      card.names.forEach((opponentName, opponentIndex) => {
        if (opponentIndex === index) return;
        existing.opponentCounts.set(opponentName, (existing.opponentCounts.get(opponentName) ?? 0) + 1);
      });
      stats.set(key, existing);
    });
  }

  return [...stats.values()]
    .map((item) => ({
      ...item,
      opponents: sortedOpponentNames(item.opponentCounts),
    }))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        right.replayCount - left.replayCount ||
        right.latestModified - left.latestModified ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    )
    .slice(0, SUGGESTION_LIMIT);
}

function setupBrowserDuration(replays: ReplayBrowserItem[], preserveRange: boolean) {
  if (!replays.length) {
    browserDurationBounds = { min: 0, max: 0 };
    browserDurationRange = { min: 0, max: 0 };
    return;
  }
  const durations = replays.map((replay) => Number(replay.durationSeconds) || 0);
  browserDurationBounds = { min: Math.min(...durations), max: Math.max(...durations) };
  if (preserveRange) {
    browserDurationRange = {
      min: clamp(browserDurationRange.min, browserDurationBounds.min, browserDurationBounds.max),
      max: clamp(browserDurationRange.max, browserDurationBounds.min, browserDurationBounds.max),
    };
    if (browserDurationRange.min > browserDurationRange.max) browserDurationRange.min = browserDurationRange.max;
  } else {
    browserDurationRange = { ...browserDurationBounds };
  }
}

function updateBrowserClearButton() {
  const searchInput = document.querySelector<HTMLInputElement>("#playerSearch");
  const clearButton = document.querySelector<HTMLButtonElement>("#clearPlayerSearch");
  if (!clearButton || !searchInput) return;
  clearButton.hidden = searchInput.value.length === 0 || searchInput.disabled;
}

function setBrowserSuggestionsOpen(open: boolean) {
  const searchInput = document.querySelector<HTMLInputElement>("#playerSearch");
  const searchBox = document.querySelector<HTMLElement>("#playerSearchBox");
  const suggestionPanel = document.querySelector<HTMLElement>("#playerSuggestionPanel");
  const shouldOpen = open && !searchInput?.disabled && browserSuggestionItems.length > 0;

  browserSuggestionOpen = shouldOpen;
  if (suggestionPanel) suggestionPanel.hidden = !shouldOpen;
  if (searchBox) searchBox.setAttribute("aria-expanded", String(shouldOpen));
  if (!shouldOpen) {
    browserSelectedSuggestion = -1;
    searchInput?.removeAttribute("aria-activedescendant");
    updateActiveBrowserSuggestion();
  }
}

function closeBrowserSuggestions() {
  setBrowserSuggestionsOpen(false);
}

function suggestionDetailText(item: BrowserSuggestion): string {
  if (!item.opponents.length) return "No opponents yet";
  const opponents = item.opponents.slice(0, 3);
  const remaining = item.opponents.length - opponents.length;
  return `vs ${opponents.join(", ")}${remaining ? `, and ${remaining} more` : ""}`;
}

function renderBrowserSuggestions(query: string) {
  const suggestionList = document.querySelector<HTMLElement>("#playerSuggestionList");
  if (!suggestionList) return;

  const fragment = document.createDocumentFragment();
  browserSuggestionItems.forEach((item, index) => {
    const option = document.createElement("button");
    const primary = document.createElement("span");
    const name = document.createElement("span");
    const meta = document.createElement("span");
    const detail = document.createElement("span");

    option.id = `player-suggestion-${index}`;
    option.type = "button";
    option.className = "player-suggestion";
    option.dataset.index = String(index);
    option.setAttribute("role", "option");

    primary.className = "suggestion-primary";
    name.className = "suggestion-name";
    meta.className = "suggestion-meta";
    detail.className = "suggestion-detail";

    renderHighlightedText(name, item.name, query);
    meta.textContent = `${pluralize(item.replayCount, "replay")} - ${pluralize(item.winCount, "win")} - ${pluralize(item.lossCount, "loss")}`;
    detail.textContent = suggestionDetailText(item);

    primary.append(name, meta);
    option.append(primary, detail);
    fragment.append(option);
  });

  suggestionList.replaceChildren(fragment);
  updateActiveBrowserSuggestion();
}

function refreshBrowserSuggestions(open = document.activeElement === document.querySelector<HTMLInputElement>("#playerSearch")) {
  const filterState = currentBrowserFilterState();
  browserSuggestionItems = buildBrowserSuggestionItems(filterState);
  if (browserSelectedSuggestion >= browserSuggestionItems.length) {
    browserSelectedSuggestion = browserSuggestionItems.length - 1;
  }
  renderBrowserSuggestions(filterState.query);
  setBrowserSuggestionsOpen(open);
}

function updateActiveBrowserSuggestion() {
  const searchInput = document.querySelector<HTMLInputElement>("#playerSearch");
  const suggestionList = document.querySelector<HTMLElement>("#playerSuggestionList");
  if (!searchInput || !suggestionList) return;

  Array.from(suggestionList.children).forEach((option, index) => {
    if (!(option instanceof HTMLElement)) return;
    const selected = index === browserSelectedSuggestion;
    option.classList.toggle("is-active", selected);
    option.setAttribute("aria-selected", String(selected));
  });

  if (browserSelectedSuggestion < 0) {
    searchInput.removeAttribute("aria-activedescendant");
    return;
  }

  const activeOption = suggestionList.children[browserSelectedSuggestion];
  if (!(activeOption instanceof HTMLElement)) {
    searchInput.removeAttribute("aria-activedescendant");
    return;
  }

  searchInput.setAttribute("aria-activedescendant", activeOption.id);
  activeOption.scrollIntoView({ block: "nearest" });
}

function moveBrowserSuggestionSelection(delta: number) {
  if (!browserSuggestionItems.length) refreshBrowserSuggestions(true);
  if (!browserSuggestionItems.length) return;

  const suggestionPanel = document.querySelector<HTMLElement>("#playerSuggestionPanel");
  if (suggestionPanel?.hidden) setBrowserSuggestionsOpen(true);

  const startIndex = browserSelectedSuggestion < 0 ? (delta > 0 ? -1 : 0) : browserSelectedSuggestion;
  browserSelectedSuggestion = (startIndex + delta + browserSuggestionItems.length) % browserSuggestionItems.length;
  updateActiveBrowserSuggestion();
}

function selectBrowserSuggestion(index: number) {
  const item = browserSuggestionItems[index];
  const searchInput = document.querySelector<HTMLInputElement>("#playerSearch");
  if (!item || !searchInput) return;

  browserSearch = item.name;
  searchInput.value = item.name;
  browserSelectedSuggestion = -1;
  updateBrowserClearButton();
  closeBrowserSuggestions();
  scheduleBrowserSearch();
  searchInput.focus();
}

function clearBrowserSearch() {
  const searchInput = document.querySelector<HTMLInputElement>("#playerSearch");
  browserSearch = "";
  browserSelectedSuggestion = -1;
  if (searchInput) searchInput.value = "";
  updateBrowserClearButton();
  refreshBrowserSuggestions(true);
  scheduleBrowserSearch();
  searchInput?.focus();
}

function renderReplayPlayButton(replay: ReplayBrowserItem, label: string, replayIndex: number): string {
  if (!BROWSER_REPLAY_PLAYBACK_ENABLED) return "";
  const isOpening = browserOpeningPaths.has(replay.filePath);
  return `
    <button class="replay-play-button" type="button" data-replay-index="${replayIndex}" ${isOpening ? "disabled" : ""} aria-label="Play ${escapeHtml(label)}">
      <span class="play-glyph"></span>
    </button>
  `;
}

function renderReplayCard(replay: ReplayBrowserItem, replayIndex: number): string {
  const winnerIndex = replay.players.findIndex((player) => player.winner);
  const winner = winnerIndex >= 0 ? replay.players[winnerIndex] : null;
  const matchType = replayMatchType(replay);
  const scoreDelta = replayScoreDelta(replay);
  const scoreDeltaLabel =
    scoreDelta === null
      ? ""
      : `<div class="replay-label elo-delta ${scoreDelta > 0 ? "is-gain" : "is-loss"}">${escapeHtml(formatScoreDelta(scoreDelta))}</div>`;
  const names = replay.players
    .map((player, index) => {
      const separator = index > 0 ? `<span class="matchup-separator"> vs </span>` : "";
      return `${separator}<span class="player-name ${playerColorClass(player, index)}" data-player-index="${index}">${escapeHtml(player.name)}</span>`;
    })
    .join("");
  const winnerLine = winner
    ? `<div class="winner-line">winner: <span class="winner-name ${playerColorClass(winner, winnerIndex)}" data-winner-name>${escapeHtml(winner.name)}</span></div>`
    : "";
  const label = replay.players.map((player) => player.name).join(" versus ");
  return `
    <article class="replay-card" data-card-index="${replayIndex}" aria-label="${escapeHtml(label)}">
      <img class="replay-thumb" alt="" loading="lazy" src="${escapeHtml(replay.thumbnailDataUrl || FALLBACK_THUMBNAIL)}">
      <div class="replay-shade"></div>
      <div class="replay-labels">
        <div class="replay-label-group">
          <div class="replay-label match-type">${escapeHtml(matchType)}</div>
          ${scoreDeltaLabel}
        </div>
        <div class="replay-label length">${escapeHtml(replay.length || formatDurationSeconds(replay.durationSeconds))}</div>
      </div>
      ${renderReplayPlayButton(replay, label, replayIndex)}
      <div class="replay-meta">
        <div class="players">
          <div class="matchup player-count-${replay.players.length}">${names}</div>
          ${winnerLine}
        </div>
      </div>
    </article>
  `;
}

function renderBrowserGrid(): string {
  browserRenderedCards = [];
  if (browserLoading && !browserReplays.length) {
    return `<section id="replayGrid" class="replay-grid is-loading"><div class="state-message">Loading replays...</div></section>`;
  }
  if (browserError) {
    return `<section id="replayGrid" class="replay-grid is-error"><div class="state-message">${escapeHtml(browserError)}</div></section>`;
  }
  if (!browserReplays.length) {
    return `
      <section id="replayGrid" class="replay-grid is-empty"><div class="state-message">No replays found.</div></section>
    `;
  }

  return `
    <section id="replayGrid" class="replay-grid" aria-live="polite">
      ${browserReplays.map((replay, index) => renderReplayCard(replay, index)).join("")}
    </section>
    <div id="searchEmpty" class="state-message search-empty" hidden>No matching replays.</div>
  `;
}

function renderBrowserPager(): string {
  const pageSize = browserReplayPageSizeValue();
  if (browserReplayTotal <= pageSize && browserReplayPage === 0) return "";
  const pageCount = browserReplayPageCount();
  const page = Math.min(browserReplayPage, pageCount - 1);
  const start = browserReplayTotal ? page * pageSize + 1 : 0;
  const end = Math.min(browserReplayTotal, (page + 1) * pageSize);
  return `
    <nav class="replay-pager" aria-label="Replay pages">
      <button id="prevReplayPage" class="replay-page-button" type="button" aria-label="Previous replay page" title="Previous page" ${page <= 0 || browserLoading ? "disabled" : ""}>
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <span class="replay-page-status">
        <strong>${escapeHtml(String(page + 1))} / ${escapeHtml(String(pageCount))}</strong>
        <em>${escapeHtml(String(start))}-${escapeHtml(String(end))} of ${escapeHtml(String(browserReplayTotal))}</em>
      </span>
      <button id="nextReplayPage" class="replay-page-button" type="button" aria-label="Next replay page" title="Next page" ${page >= pageCount - 1 || browserLoading ? "disabled" : ""}>
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </nav>
  `;
}

function renderBrowserPageSizeControl(): string {
  const options = BROWSER_REPLAY_PAGE_SIZE_OPTIONS.map(
    (option) => `
      <option value="${escapeHtml(String(option))}" ${browserReplayPageSize === option ? "selected" : ""}>
        ${option === "all" ? "All" : escapeHtml(String(option))}
      </option>
    `,
  ).join("");
  return `
    <label class="replay-page-size-control" title="Items per page">
      <span>Items</span>
      <select id="replayPageSize" class="replay-page-size-select" aria-label="Items per page" ${browserLoading ? "disabled" : ""}>
        ${options}
      </select>
    </label>
  `;
}

function renderBrowserNav(): string {
  return `
    <nav class="browser-nav" aria-label="Main navigation">
      <button class="browser-nav-button ${browserPage === "replays" ? "is-active" : ""}" type="button" data-browser-page="replays">Replays</button>
      <button class="browser-nav-button ${browserPage === "leaderboard" ? "is-active" : ""}" type="button" data-browser-page="leaderboard">Leaderboard</button>
      <button class="browser-nav-button ${browserPage === "region" ? "is-active" : ""}" type="button" data-browser-page="region">Region</button>
      <button class="browser-nav-button ${browserPage === "mapEditor" ? "is-active" : ""}" type="button" data-browser-page="mapEditor">Map Editor</button>
    </nav>
  `;
}

function renderLeaderboardPage(): string {
  const fields = userDataFields(userDataPayload);
  const stats = currentLeaderboardStats();
  const score = Number(stats?.score);
  const username = stats?.username || "Unknown user";
  const currentName = normalizeLeaderboardName(stats?.normalizedUsername || stats?.username);
  const officialRank = stats?.officialRank ?? null;
  const winsNumber = Number(stats?.wins);
  const gamesNumber = Number(stats?.games);
  const winRate =
    Number.isFinite(winsNumber) && Number.isFinite(gamesNumber) && gamesNumber > 0
      ? clamp((winsNumber / gamesNumber) * 100, 0, 100)
      : null;
  const winRateValue = winRate === null ? "0" : winRate.toFixed(2);
  const winRateLabel = winRate === null ? "-" : `${Math.round(winRate)}%`;
  const winsLabel = Number.isFinite(winsNumber) ? winsNumber.toLocaleString() : "-";
  const sync = leaderboardSyncLabel(leaderboardStatusPayload);
  const fieldRows = fields.length
    ? fields
        .map(
          (field) => `
            <div class="user-field">
              <dt title="${escapeHtml(field.key)}">${escapeHtml(field.label)}</dt>
              <dd>${escapeHtml(compactUserValue(field.value))}</dd>
            </div>
          `,
        )
        .join("")
    : `<div class="state-message">No user fields returned yet.</div>`;

  return `
    <section class="leaderboard-page" aria-label="Leaderboard">
      <div class="leaderboard-actions">
        <div>
          <h1>Leaderboard</h1>
          <p>${userDataPayload ? `Local score fetched ${escapeHtml(formatUserDate(userDataPayload.fetchedAt))}` : "Fetching your War of Dots standing."}</p>
        </div>
        <button id="refreshUserData" class="refresh-user-button ${userDataLoading || leaderboardLoading || leaderboardSubmitting ? "is-loading" : ""}" type="button" ${userDataLoading || leaderboardSubmitting ? "disabled" : ""}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20 12a8 8 0 0 1-13.7 5.7" />
            <path d="M4 12A8 8 0 0 1 17.7 6.3" />
            <path d="M17.7 2.7v3.6h-3.6" />
            <path d="M6.3 21.3v-3.6h3.6" />
          </svg>
          <span>Refresh</span>
        </button>
      </div>
      <div class="leaderboard-sync is-${escapeHtml(sync.tone)}">
        <span>${escapeHtml(sync.label)}</span>
        <strong>${escapeHtml(sync.detail)}</strong>
      </div>
      ${
        userDataError
          ? `<div class="state-message user-data-error">${escapeHtml(userDataError)}</div>`
          : ""
      }
      ${
        userDataLoading && !userDataPayload
          ? `<div class="state-message">Fetching user data...</div>`
          : `
            <div class="leaderboard-standing">
              <div class="standing-hero">
                <div class="standing-name">
                  <span>My standing</span>
                  <strong>${escapeHtml(username)}</strong>
                  <em>${officialRank !== null && Number.isFinite(Number(officialRank)) ? `Rank #${escapeHtml(Number(officialRank).toLocaleString())}` : "Rank pending"}</em>
                </div>
                <div class="standing-metrics">
                  <div class="standing-metric is-score">
                    <span>Score</span>
                    <strong>${Number.isFinite(score) ? escapeHtml(score.toLocaleString()) : "-"}</strong>
                  </div>
                  <div class="standing-metric">
                    <span>Rank</span>
                    <strong>${officialRank !== null && Number.isFinite(Number(officialRank)) ? `#${escapeHtml(Number(officialRank).toLocaleString())}` : "-"}</strong>
                  </div>
                </div>
              </div>
              <div class="standing-win-card" style="--win-rate:${escapeHtml(winRateValue)}">
                <div class="win-card-heading">
                  <span>WIN RATE</span>
                  <strong>${escapeHtml(winRateLabel)}</strong>
                </div>
                <div class="win-rate-ring" aria-label="Win rate ${escapeHtml(winRateLabel)}">
                  <div>
                    <strong>${escapeHtml(winsLabel)}</strong>
                    <span>WINS</span>
                  </div>
                </div>
              </div>
            </div>
            <section class="public-leaderboard">
              <div class="section-heading">
                <h2>Leaderboard</h2>
                <span>${leaderboardRows.length ? `${escapeHtml(String(leaderboardRows.length))} players` : "Global board"}</span>
              </div>
              ${renderLeaderboardRows(currentName)}
            </section>
            <section class="score-history">
              <div class="section-heading">
                <h2>Score over time</h2>
                <span>${escapeHtml(String(userScorePoints(userDataPayload).length))} points</span>
              </div>
              ${renderScoreChart(userDataPayload)}
            </section>
            <details class="user-fields-section" ${leaderboardDetailsOpen ? "open" : ""}>
              <summary>
                <span>Details</span>
                <strong>${escapeHtml(String(fields.length))} fields</strong>
              </summary>
              <dl class="user-fields">${fieldRows}</dl>
            </details>
          `
      }
    </section>
  `;
}

function renderRegionPage(): string {
  const gameRunning = Boolean(regionStatusPayload?.gameRunning);
  const canSelect = gameRunning && !regionLoading && !regionApplying;
  const selectedRegion = gameRunning ? regionStatusPayload?.selectedRegion ?? null : null;
  const statusText = gameRunning
    ? regionStatusPayload?.message || "War of Dots detected. Choose a region to apply it live."
    : regionStatusPayload?.message || "Start War of Dots to apply a region.";
  const regionCards = REGION_NAMES.map((region) => {
    const isSelected = selectedRegion === region;
    const isApplying = regionApplying === region;
    const disabled = !canSelect || isSelected;
    return `
      <button
        class="region-card ${isSelected ? "is-selected" : ""} ${isApplying ? "is-loading" : ""}"
        type="button"
        data-region="${region}"
        ${disabled ? "disabled" : ""}
      >
        <span>${escapeHtml(region)}</span>
        <strong>${escapeHtml(REGION_LABELS[region])}</strong>
        <em>${isApplying ? "Applying" : isSelected ? "Selected" : gameRunning ? "Apply" : "Unavailable"}</em>
      </button>
    `;
  }).join("");

  return `
    <section class="region-page" aria-label="Region selector">
      <div class="region-actions">
        <div>
          <h1>Region</h1>
          <p>${escapeHtml(statusText)}</p>
        </div>
        <button id="refreshRegion" class="refresh-user-button ${regionLoading ? "is-loading" : ""}" type="button" ${regionLoading || Boolean(regionApplying) ? "disabled" : ""}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20 12a8 8 0 0 1-13.7 5.7" />
            <path d="M4 12A8 8 0 0 1 17.7 6.3" />
            <path d="M17.7 2.7v3.6h-3.6" />
            <path d="M6.3 21.3v-3.6h3.6" />
          </svg>
          <span>Refresh</span>
        </button>
      </div>
      ${regionError ? `<div class="state-message region-error">${escapeHtml(regionError)}</div>` : ""}
      <div class="region-status ${gameRunning ? "is-online" : "is-offline"}">
        <span>${gameRunning ? "Game running" : "Game offline"}</span>
        <strong>${selectedRegion ? `Selected ${escapeHtml(selectedRegion)}` : "No region selected"}</strong>
      </div>
      <div class="region-grid">
        ${regionCards}
      </div>
    </section>
  `;
}

function hydrateBrowserCards() {
  browserRenderedCards = [];
  const cardElements = document.querySelectorAll<HTMLElement>("#replayGrid .replay-card");
  cardElements.forEach((element) => {
    const replayIndex = Number(element.dataset.cardIndex);
    const replay = browserReplays[replayIndex];
    if (!replay) return;

    const winnerIndex = replay.players.findIndex((player) => player.winner);
    browserRenderedCards.push({
      element,
      searchText: normalizeSearchText(replay.players.map((player) => player.name).join(" ")),
      matchType: replayMatchType(replay),
      durationSeconds: Number(replay.durationSeconds) || 0,
      modified: Number(replay.modified) || 0,
      names: replay.players.map((player) => player.name),
      normalizedNames: replay.players.map((player) => normalizeSearchText(player.name)),
      winnerIndex,
      winnerName: winnerIndex >= 0 ? replay.players[winnerIndex]?.name ?? "" : "",
      nameElements: Array.from(element.querySelectorAll<HTMLElement>("[data-player-index]")),
      winnerNameElement: element.querySelector<HTMLElement>("[data-winner-name]"),
      visible: true,
    });
  });
}

function applyBrowserSearch() {
  pendingBrowserSearchFrame = 0;
  const filterState = currentBrowserFilterState();
  let visibleCount = 0;

  for (const card of browserRenderedCards) {
    const visible = cardMatchesFilters(card, filterState);
    card.nameElements.forEach((element, index) => {
      renderHighlightedText(element, card.names[index] ?? "", filterState.query);
    });
    if (card.winnerNameElement) {
      renderHighlightedText(card.winnerNameElement, card.winnerName, filterState.query);
    }

    card.element.hidden = browserHideUnmatched && !visible;
    card.element.classList.toggle("is-dimmed", !browserHideUnmatched && !visible);
    card.visible = visible;
    if (visible) visibleCount += 1;
  }

  const searchEmpty = document.querySelector<HTMLElement>("#searchEmpty");
  if (searchEmpty) searchEmpty.hidden = !browserHideUnmatched || visibleCount > 0;
}

function scheduleBrowserSearch() {
  if (pendingBrowserSearchFrame) return;
  pendingBrowserSearchFrame = window.requestAnimationFrame(applyBrowserSearch);
}

function unmountMapEditor() {
  if (!mapEditorRoot) return;
  mapEditorRoot.unmount();
  mapEditorRoot = null;
}

function mountMapEditor() {
  const host = document.querySelector<HTMLElement>("#mapEditorRoot");
  if (!host) return;
  unmountMapEditor();
  mapEditorRoot = createRoot(host);
  mapEditorRoot.render(createElement(MapEditorApp));
}

function renderReplayBrowser() {
  const minPosition = secondsToDurationPosition(browserDurationRange.min);
  const maxPosition = secondsToDurationPosition(browserDurationRange.max);
  const fillLeft = (minPosition / DURATION_SLIDER_STEPS) * 100;
  const fillRight = ((DURATION_SLIDER_STEPS - maxPosition) / DURATION_SLIDER_STEPS) * 100;
  if (browserPage === "mapEditor") {
    appRoot.innerHTML = `
      <main class="replay-browser map-editor-page" aria-label="War of Dots map editor">
        ${renderBrowserNav()}
        <section id="mapEditorRoot" class="map-editor-host" aria-label="Map editor"></section>
      </main>
    `;
    bindBrowserEvents();
    mountMapEditor();
    return;
  }
  unmountMapEditor();
  if (browserPage === "leaderboard") {
    appRoot.innerHTML = `
      <main class="replay-browser" aria-label="War of Dots leaderboard">
        ${renderBrowserNav()}
        ${renderLeaderboardPage()}
      </main>
    `;
    bindBrowserEvents();
    return;
  }
  if (browserPage === "region") {
    appRoot.innerHTML = `
      <main class="replay-browser" aria-label="War of Dots region selector">
        ${renderBrowserNav()}
        ${renderRegionPage()}
      </main>
    `;
    bindBrowserEvents();
    return;
  }

  appRoot.innerHTML = `
    <main class="replay-browser" aria-label="War of Dots replays">
      ${renderBrowserNav()}
      <div class="search-row">
        <div class="search-controls">
          <div
            id="playerSearchBox"
            class="search-combobox"
            role="combobox"
            aria-expanded="false"
            aria-haspopup="listbox"
            aria-owns="playerSuggestionList"
          >
            <input
              id="playerSearch"
              class="player-search"
              type="search"
              placeholder="Search players"
              aria-label="Search player usernames"
              aria-autocomplete="list"
              aria-controls="playerSuggestionList"
              autocomplete="off"
              spellcheck="false"
              value="${escapeHtml(browserSearch)}"
              ${(browserLoading && !browserReplays.length) || browserError || !browserReplays.length ? "disabled" : ""}
            >
            <button id="clearPlayerSearch" class="search-clear" type="button" aria-label="Clear search" ${browserSearch ? "" : "hidden"}>x</button>
            <div id="playerSuggestionPanel" class="player-suggestion-panel" hidden>
              <div id="playerSuggestionList" class="player-suggestion-list" role="listbox" aria-label="Player suggestions"></div>
            </div>
          </div>
          <label class="match-mode-toggle" title="Dim non-matching replays">
            <input id="matchModeToggle" type="checkbox" aria-label="Dim non-matching replays" ${browserHideUnmatched ? "" : "checked"} ${browserReplays.length ? "" : "disabled"}>
            <span aria-hidden="true">&#128123;&#65039;</span>
          </label>
        </div>
        <div class="filter-controls">
          <div class="type-filters" role="group" aria-label="Match type filters">
            ${["1v1", "3P FFA", "4P FFA"]
              .map(
                (type) => `
                  <label><input class="type-filter" type="checkbox" value="${escapeHtml(type)}" ${browserSelectedTypes.has(type) ? "checked" : ""} ${browserReplays.length ? "" : "disabled"}>${escapeHtml(type.replace(" FFA", ""))}</label>
                `,
              )
              .join("")}
          </div>
          <div class="duration-filter" aria-label="Duration filter">
            <span id="durationMinLabel" class="duration-label">${formatDurationSeconds(browserDurationRange.min)}</span>
            <div id="durationSlider" class="duration-slider">
              <div class="duration-track"></div>
              <div id="durationRangeFill" class="duration-range-fill" style="left:${fillLeft}%;right:${fillRight}%"></div>
              <input id="durationMin" type="range" min="0" max="${DURATION_SLIDER_STEPS}" value="${minPosition}" step="1" aria-label="Minimum duration" ${browserReplays.length ? "" : "disabled"}>
              <input id="durationMax" type="range" min="0" max="${DURATION_SLIDER_STEPS}" value="${maxPosition}" step="1" aria-label="Maximum duration" ${browserReplays.length ? "" : "disabled"}>
            </div>
            <span id="durationMaxLabel" class="duration-label">${formatDurationSeconds(browserDurationRange.max)}</span>
          </div>
        </div>
      </div>
      ${renderBrowserGrid()}
      <div class="replay-action-dock">
        <div class="replay-action-group" role="group" aria-label="Replay browser actions">
          ${renderBrowserPageSizeControl()}
          ${renderBrowserPager()}
          <button id="refreshReplays" class="refresh-button ${browserLoading ? "is-loading" : ""}" type="button" aria-label="Refresh replays" title="Refresh replays" ${browserLoading && !browserReplays.length ? "disabled" : ""}>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M20 12a8 8 0 0 1-13.7 5.7" />
              <path d="M4 12A8 8 0 0 1 17.7 6.3" />
              <path d="M17.7 2.7v3.6h-3.6" />
              <path d="M6.3 21.3v-3.6h3.6" />
            </svg>
            <span>Refresh</span>
          </button>
        </div>
      </div>
    </main>
  `;
  hydrateBrowserCards();
  bindBrowserEvents();
  updateBrowserClearButton();
  refreshBrowserSuggestions(browserSuggestionOpen);
  scheduleBrowserSearch();
}

function handleBrowserSuggestionPointerDown(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : null;
  const option = target?.closest<HTMLButtonElement>(".player-suggestion");
  if (!option) return;
  event.preventDefault();
  selectBrowserSuggestion(Number(option.dataset.index));
}

function handleBrowserOutsidePointerDown(event: PointerEvent) {
  if (event.target instanceof Node && document.querySelector("#playerSearchBox")?.contains(event.target)) return;
  closeBrowserSuggestions();
}

async function confirmMapEditorLeave() {
  if (browserPage !== "mapEditor") return true;
  return window.__mapEditorConfirmLeave ? window.__mapEditorConfirmLeave() : true;
}

async function switchBrowserPage(nextPage: BrowserPage) {
  if (browserPage === nextPage) return;
  if (!(await confirmMapEditorLeave())) return;
  browserPage = nextPage;
  renderReplayBrowser();
  if (browserPage === "leaderboard") void ensureLeaderboardLoaded();
  if (browserPage === "region" && !regionStatusPayload && !regionLoading) void loadRegionStatus();
}

function bindBrowserEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-browser-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.dataset.browserPage;
      const nextPage: BrowserPage =
        page === "leaderboard" ? "leaderboard" : page === "region" ? "region" : page === "mapEditor" ? "mapEditor" : "replays";
      void switchBrowserPage(nextPage);
    });
  });
  document.querySelector<HTMLButtonElement>("#refreshUserData")?.addEventListener("click", () => {
    void refreshLeaderboard();
  });
  document.querySelector<HTMLDetailsElement>(".user-fields-section")?.addEventListener("toggle", (event) => {
    leaderboardDetailsOpen = (event.currentTarget as HTMLDetailsElement).open;
  });
  document.querySelector<HTMLButtonElement>("#refreshRegion")?.addEventListener("click", () => {
    void loadRegionStatus();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-region]").forEach((button) => {
    button.addEventListener("click", () => {
      const region = button.dataset.region as RegionName | undefined;
      if (region && REGION_NAMES.includes(region)) void selectRegion(region);
    });
  });
  document.querySelector<HTMLInputElement>("#playerSearch")?.addEventListener("input", (event) => {
    browserSearch = (event.target as HTMLInputElement).value;
    browserSelectedSuggestion = -1;
    updateBrowserClearButton();
    refreshBrowserSuggestions(true);
    scheduleBrowserSearch();
  });
  document.querySelector<HTMLInputElement>("#playerSearch")?.addEventListener("focus", () => {
    refreshBrowserSuggestions(true);
  });
  document.querySelector<HTMLInputElement>("#playerSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveBrowserSuggestionSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveBrowserSuggestionSelection(-1);
      return;
    }

    const suggestionPanel = document.querySelector<HTMLElement>("#playerSuggestionPanel");
    if (event.key === "Enter" && browserSelectedSuggestion >= 0 && !suggestionPanel?.hidden) {
      event.preventDefault();
      selectBrowserSuggestion(browserSelectedSuggestion);
      return;
    }

    if (event.key === "Escape") closeBrowserSuggestions();
  });
  document.querySelector<HTMLButtonElement>("#clearPlayerSearch")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });
  document.querySelector<HTMLButtonElement>("#clearPlayerSearch")?.addEventListener("click", clearBrowserSearch);
  document.querySelector<HTMLElement>("#playerSuggestionList")?.addEventListener("pointerdown", handleBrowserSuggestionPointerDown);
  document.querySelector<HTMLInputElement>("#matchModeToggle")?.addEventListener("click", (event) => {
    browserHideUnmatched = !(event.target as HTMLInputElement).checked;
    scheduleBrowserSearch();
  });
  document.querySelectorAll<HTMLInputElement>(".type-filter").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) browserSelectedTypes.add(input.value);
      else browserSelectedTypes.delete(input.value);
      refreshBrowserSuggestions(document.activeElement === document.querySelector<HTMLInputElement>("#playerSearch"));
      scheduleBrowserSearch();
    });
  });
  const durationMin = document.querySelector<HTMLInputElement>("#durationMin");
  const durationMax = document.querySelector<HTMLInputElement>("#durationMax");
  const updateDurationSliderUi = (minPosition: number, maxPosition: number) => {
    const min = durationPositionToSeconds(minPosition);
    const max = durationPositionToSeconds(maxPosition);
    browserDurationRange = { min, max };
    const fill = document.querySelector<HTMLElement>("#durationRangeFill");
    if (fill) {
      fill.style.left = `${(minPosition / DURATION_SLIDER_STEPS) * 100}%`;
      fill.style.right = `${((DURATION_SLIDER_STEPS - maxPosition) / DURATION_SLIDER_STEPS) * 100}%`;
    }
    const minLabel = document.querySelector<HTMLElement>("#durationMinLabel");
    if (minLabel) minLabel.textContent = formatDurationSeconds(min);
    const maxLabel = document.querySelector<HTMLElement>("#durationMaxLabel");
    if (maxLabel) maxLabel.textContent = formatDurationSeconds(max);
  };
  const handleDurationInput = (activeThumb: HTMLInputElement | null) => {
    let minPosition = clamp(Number(durationMin?.value ?? 0), 0, DURATION_SLIDER_STEPS);
    let maxPosition = clamp(Number(durationMax?.value ?? DURATION_SLIDER_STEPS), 0, DURATION_SLIDER_STEPS);
    if (minPosition > maxPosition) {
      if (activeThumb === durationMin) {
        maxPosition = minPosition;
        if (durationMax) durationMax.value = String(maxPosition);
      } else {
        minPosition = maxPosition;
        if (durationMin) durationMin.value = String(minPosition);
      }
    }
    updateDurationSliderUi(minPosition, maxPosition);
    refreshBrowserSuggestions(document.activeElement === document.querySelector<HTMLInputElement>("#playerSearch"));
    scheduleBrowserSearch();
  };
  durationMin?.addEventListener("input", () => handleDurationInput(durationMin));
  durationMax?.addEventListener("input", () => handleDurationInput(durationMax));
  document.querySelector<HTMLButtonElement>("#refreshReplays")?.addEventListener("click", () => {
    void loadBrowserReplays(true);
  });
  document.querySelector<HTMLSelectElement>("#replayPageSize")?.addEventListener("change", (event) => {
    const nextPageSize = parseBrowserReplayPageSizeOption((event.target as HTMLSelectElement).value);
    if (nextPageSize === browserReplayPageSize) return;
    browserReplayPageSize = nextPageSize;
    browserReplayPage = 0;
    browserReplaySignature = "";
    saveBrowserReplayPageSize(nextPageSize);
    void loadBrowserReplays(true, { page: 0 });
  });
  document.querySelector<HTMLButtonElement>("#prevReplayPage")?.addEventListener("click", () => {
    if (browserReplayPage <= 0) return;
    void loadBrowserReplays(true, { page: browserReplayPage - 1 });
  });
  document.querySelector<HTMLButtonElement>("#nextReplayPage")?.addEventListener("click", () => {
    const pageCount = browserReplayPageCount();
    if (browserReplayPage >= pageCount - 1) return;
    void loadBrowserReplays(true, { page: browserReplayPage + 1 });
  });
  if (BROWSER_REPLAY_PLAYBACK_ENABLED) {
    document.querySelectorAll<HTMLButtonElement>("[data-replay-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const replay = browserReplays[Number(button.dataset.replayIndex)];
        if (replay) void openReplayFromBrowser(replay);
      });
    });
  }
  if (!browserDocumentEventsBound) {
    document.addEventListener("pointerdown", handleBrowserOutsidePointerDown);
    browserDocumentEventsBound = true;
  }
}

async function loadUserData(options: { quiet?: boolean } = {}) {
  if (userDataLoading) return;
  userDataLoading = true;
  userDataError = "";
  if (!options.quiet && browserPage === "leaderboard") renderReplayBrowser();
  try {
    userDataPayload = await invoke<UserDataPayload>("fetch_user_data");
  } catch (error) {
    userDataError = error instanceof Error ? error.message : String(error || "Could not fetch user data.");
  } finally {
    userDataLoading = false;
    if (browserPage === "leaderboard") renderReplayBrowser();
  }
}

async function loadLeaderboardStatus(options: { quiet?: boolean } = {}) {
  if (!options.quiet && browserPage === "leaderboard") renderReplayBrowser();
  try {
    leaderboardStatusPayload = await invoke<LeaderboardStatusPayload>("leaderboard_status");
  } catch (error) {
    leaderboardError = error instanceof Error ? error.message : String(error || "Could not read leaderboard status.");
  } finally {
    if (!options.quiet && browserPage === "leaderboard") renderReplayBrowser();
  }
}

async function loadLeaderboardRows(options: { quiet?: boolean } = {}) {
  if (leaderboardLoading) return;
  leaderboardLoading = true;
  if (!options.quiet) leaderboardError = "";
  if (!options.quiet && browserPage === "leaderboard") renderReplayBrowser();
  try {
    const payload = await invoke<LeaderboardListPayload>("leaderboard_list");
    leaderboardRows = payload.rows ?? [];
    if (!payload.configured && payload.message) leaderboardError = payload.message;
  } catch (error) {
    leaderboardError = error instanceof Error ? error.message : String(error || "Could not load leaderboard.");
  } finally {
    leaderboardLoading = false;
    if (browserPage === "leaderboard") renderReplayBrowser();
  }
}

async function submitLeaderboardSnapshot(options: { quiet?: boolean } = {}) {
  if (leaderboardSubmitting) return;
  leaderboardSubmitting = true;
  if (!options.quiet) leaderboardError = "";
  if (!options.quiet && browserPage === "leaderboard") renderReplayBrowser();
  try {
    await invoke("leaderboard_submit");
  } catch (error) {
    leaderboardError = error instanceof Error ? error.message : String(error || "Could not submit leaderboard score.");
  } finally {
    leaderboardSubmitting = false;
    await loadLeaderboardStatus({ quiet: true });
    if (browserPage === "leaderboard") renderReplayBrowser();
  }
}

async function refreshLeaderboard() {
  const userDataTask = loadUserData();
  const statusTask = loadLeaderboardStatus({ quiet: true });
  const rowsTask = loadLeaderboardRows({ quiet: true });
  await Promise.allSettled([userDataTask, statusTask]);
  await loadLeaderboardStatus({ quiet: true });
  if (leaderboardStatusPayload?.canSubmit) {
    await submitLeaderboardSnapshot({ quiet: true });
  }
  await rowsTask;
  if (browserPage === "leaderboard") renderReplayBrowser();
}

function ensureLeaderboardLoaded() {
  if (!leaderboardStatusPayload) {
    void loadLeaderboardStatus({ quiet: true });
  }
  if (!userDataPayload && !userDataLoading) {
    void loadUserData({ quiet: true }).then(() => {
      void loadLeaderboardStatus({ quiet: true });
    });
  }
  if (!leaderboardRows.length && !leaderboardLoading) {
    void loadLeaderboardRows({ quiet: true });
  }
  if (browserPage === "leaderboard") renderReplayBrowser();
}

async function loadRegionStatus(options: { quiet?: boolean } = {}) {
  if (regionLoading) return;
  regionLoading = true;
  if (!options.quiet) regionError = "";
  if (!options.quiet && browserPage === "region") renderReplayBrowser();
  try {
    regionStatusPayload = await invoke<RegionStatusPayload>("region_status");
  } catch (error) {
    if (!options.quiet) regionError = error instanceof Error ? error.message : String(error || "Could not load region status.");
  } finally {
    regionLoading = false;
    if (browserPage === "region") renderReplayBrowser();
  }
}

async function selectRegion(region: RegionName) {
  if (regionApplying) return;
  regionApplying = region;
  regionError = "";
  renderReplayBrowser();
  try {
    regionStatusPayload = await invoke<RegionStatusPayload>("select_region", { region });
  } catch (error) {
    regionError = error instanceof Error ? error.message : String(error || "Could not apply region.");
  } finally {
    regionApplying = "";
    if (browserPage === "region") renderReplayBrowser();
  }
}

async function openReplayFromBrowser(replay: ReplayBrowserItem) {
  if (browserOpeningPaths.has(replay.filePath)) return;
  browserOpeningPaths.add(replay.filePath);
  renderReplayBrowser();
  try {
    await invoke<string>("open_replay_window", { fileName: replay.fileName, filePath: replay.filePath });
  } catch (error) {
    browserError = error instanceof Error ? error.message : String(error);
  } finally {
    browserOpeningPaths.delete(replay.filePath);
    renderReplayBrowser();
  }
}

function replayListSignature(replays: ReplayBrowserItem[]): string {
  return replays
    .map((replay) =>
      [
        replay.filePath,
        replay.modified,
        replay.durationSeconds,
        replay.scoreDelta ?? "",
        replay.players.map((player) => `${player.name}:${player.winner ? "1" : "0"}`).join(","),
      ].join("|"),
    )
    .join("\n");
}

async function loadBrowserReplays(
  preserveControls = false,
  options: { quiet?: boolean; page?: number } = {},
) {
  if (browserLoading) return;
  const requestLimit = browserReplayRequestLimit();
  const page = requestLimit === 0 ? 0 : Math.max(0, Math.floor(options.page ?? browserReplayPage));
  let shouldRender = !options.quiet;
  browserLoading = true;
  browserError = "";
  if (!options.quiet) renderReplayBrowser();
  try {
    const payload = await invoke<ReplayBrowserPayload>("list_replays", {
      offset: page * requestLimit,
      limit: requestLimit,
    });
    const replays = payload.replays;
    const nextSignature = replayListSignature(replays);
    const changed = nextSignature !== browserReplaySignature || page !== browserReplayPage || payload.totalCandidates !== browserReplayTotal;
    browserReplays = replays;
    browserReplayTotal = payload.totalCandidates;
    browserReplayPage = Math.min(page, browserReplayPageCount(payload.totalCandidates) - 1);
    browserReplaySignature = nextSignature;
    setupBrowserDuration(replays, preserveControls);
    shouldRender = shouldRender || changed;
  } catch (error) {
    if (!options.quiet) {
      browserError = error instanceof Error ? error.message : String(error || "Could not load replays.");
      shouldRender = true;
    }
  } finally {
    browserLoading = false;
    if (shouldRender) renderReplayBrowser();
  }
}

function startBrowserReplayPolling() {
  window.clearInterval(browserReplayPollTimer);
  browserReplayPollTimer = 0;
}

function startRegionPolling() {
  window.clearInterval(regionPollTimer);
  regionPollTimer = window.setInterval(() => {
    if (browserPage !== "region" || regionLoading || regionApplying) return;
    void loadRegionStatus({ quiet: true });
  }, 5000);
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
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return flattenPlayerName(record.username ?? record.name ?? record.displayName ?? record.display_name);
  }
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
  const named = ["blue", "red", "purple", "orange", "green", "yellow", "cyan", "pink"].indexOf(text);
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
      funds_displayed: lerpOptional(team.funds_displayed, target?.funds_displayed, amount),
      funds_raw: lerpOptional(team.funds_raw, target?.funds_raw, amount),
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

function fundsMetricValue(metric: TeamMetric): number | null {
  const displayed = numeric(metric.funds_displayed);
  if (displayed !== null) return displayed;

  const raw = numeric(metric.funds);
  return raw;
}

function casualtiesMetricValue(sample: Sample, metric: TeamMetric): number | null {
  const estimate = numeric(metric.casualties_estimate);
  if (estimate !== null) return estimate;

  const displayed = numeric(metric.displayed_casualties ?? metric.casualties_displayed);
  if (displayed !== null) return displayed;

  const troopCasualties = numeric(metric.troop_casualties);
  if (troopCasualties !== null) return troopCasualties;

  const rawCasualties = numeric(metric.casualties);
  return rawCasualties;
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
        ? fundsMetricValue(metric)
        : kind === "units"
          ? metric.alive_units ?? teamAliveUnitCount(sample, teamIndex)
          : kind === "morale"
            ? teamMoraleTotal(sample, teamIndex)
            : casualtiesMetricValue(sample, metric);
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
  renderGraphLayer();
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
  renderGraphLayer();
}

function renderGraphLayer() {
  const sample = sampleAtFrame();
  const topbar = document.querySelector<HTMLElement>(".topbar");
  if (topbar) topbar.innerHTML = renderGraphPalette();

  const viewer = document.querySelector<HTMLElement>(".viewer-area");
  if (viewer) {
    document.querySelectorAll<HTMLElement>("[data-graph-window-id]").forEach((element) => element.remove());
    viewer.insertAdjacentHTML("beforeend", renderGraphWindows(sample));
  }

  bindGraphEvents();
  renderGraphCanvases(sample);
}

function renderGraphPalette(): string {
  const visible = visibleGraphKinds();
  return `
    <div class="graph-palette-zone" aria-label="Graph windows">
      <div class="graph-palette">
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
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.fillRect(0, 0, width, height);

  if (!sample) return;

  const teams = graphTeamsForSample(sample);
  const currentTick = Number(sample.tick);
  if (!Number.isFinite(currentTick)) return;
  const minTick = currentTick - GAME_TICKS_PER_SECOND * GRAPH_HISTORY_SECONDS;
  const series = teams.map((team, index) => ({
    team,
    color: team.color_hex ?? teamColor(Number(team.index)),
    points: graphMetricHistory(windowState.kind, Number(team.index), sample),
  }));
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const liveValues = teams.map((team) => ({
    team,
    color: team.color_hex ?? teamColor(Number(team.index)),
    value: sample ? graphMetricValue(windowState.kind, sample, Number(team.index)) : null,
  }));

  if (values.length < 2) {
    drawGraphLiveValues(ctx, windowState.kind, liveValues, width);
    ctx.fillStyle = "rgba(22, 31, 35, 0.56)";
    ctx.font = "800 11px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for data", width / 2, height / 2 + 8);
    return;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueSpan = Math.max(1, maxValue - minValue);
  const padLeft = 6;
  const padRight = 6;
  const padTop = 23;
  const padBottom = 6;
  const plotX = padLeft;
  const plotY = padTop;
  const plotWidth = Math.max(1, width - padLeft - padRight);
  const plotHeight = Math.max(1, height - padTop - padBottom);
  const pointToScreen = (point: { tick: number; value: number }) => ({
    x: plotX + Math.max(0, Math.min(1, (point.tick - minTick) / (GAME_TICKS_PER_SECOND * GRAPH_HISTORY_SECONDS))) * plotWidth,
    y: plotY + (1 - (point.value - minValue) / valueSpan) * plotHeight,
  });

  ctx.strokeStyle = "rgba(30, 43, 50, 0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX, plotY + plotHeight / 2);
  ctx.lineTo(plotX + plotWidth, plotY + plotHeight / 2);
  ctx.stroke();

  for (const { color, points } of series) {
    if (points.length < 2) continue;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    points.forEach((point, index) => {
      const screen = pointToScreen(point);
      if (index === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    points.forEach((point, index) => {
      const screen = pointToScreen(point);
      if (index === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.stroke();
  }

  drawGraphLiveValues(ctx, windowState.kind, liveValues, width);
}

function graphTeamsForSample(sample: Sample): Team[] {
  const teamsByIndex = new Map<number, Team>();
  for (const team of teamList()) {
    const index = Number(team.index);
    if (Number.isInteger(index)) teamsByIndex.set(index, team);
  }
  for (const metric of sample.metrics?.teams ?? []) {
    const index = Number(metric.index);
    if (!Number.isInteger(index) || teamsByIndex.has(index)) continue;
    teamsByIndex.set(index, {
      index,
      name: `Player ${index + 1}`,
      color_hex: PLAYER_COLORS[index % PLAYER_COLORS.length],
    });
  }
  return [...teamsByIndex.values()]
    .sort((first, second) => Number(first.index) - Number(second.index))
    .slice(0, MAX_GRAPH_TEAMS);
}

function drawGraphLiveValues(
  ctx: CanvasRenderingContext2D,
  kind: GraphKind,
  values: Array<{ color: string; value: number | null }>,
  width: number,
) {
  let cursorX = width - 5;
  ctx.save();
  ctx.font = "900 11px Inter, Segoe UI, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  values.slice(0, MAX_GRAPH_TEAMS).reverse().forEach((item) => {
    const text = formatGraphValue(kind, item.value);
    const textWidth = Math.ceil(ctx.measureText(text).width);
    const chipWidth = textWidth + 17;
    const chipX = Math.max(4, cursorX - chipWidth);
    ctx.fillStyle = "rgba(255, 255, 255, 0.32)";
    roundedRect(ctx, chipX, 3, chipWidth, 17, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(20, 31, 36, 0.08)";
    ctx.stroke();

    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(chipX + 6, 11.5, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = item.color;
    ctx.fillText(text, cursorX - 5, 11.5);
    cursorX = chipX - 4;
  });
  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
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

function drawBridgeLines(
  ctx: CanvasRenderingContext2D,
  sample: Sample,
  toScreen: (point: WorldPoint) => WorldPoint,
  fit: number,
) {
  const lines = cleanProjectionLines(sample.bridges);
  if (!lines.length) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const line of lines) {
    const points = line.filter(validPoint).map(toScreen);
    if (points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.strokeStyle = "rgba(22, 14, 9, 0.96)";
    ctx.lineWidth = Math.max(7, 13 * Math.max(0.82, fit));
    ctx.stroke();
    ctx.strokeStyle = "rgba(244, 204, 122, 0.98)";
    ctx.lineWidth = Math.max(4, 7 * Math.max(0.82, fit));
    ctx.stroke();
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
  const directLines = cleanProjectionLines(sample.projection_lines);
  if (directLines.length) {
    drawLineSet(ctx, directLines, toScreen, fit, { alpha: 0.88, lineWidth: 2.2, arrowSize: 0 });
    return;
  }

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

  drawLineSet(ctx, directLines, toScreen, fit, { alpha: 0.88, lineWidth: 2.2, arrowSize: 0 });
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
  drawBridgeLines(ctx, sample, toScreen, fit);
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

    if (showDots && troop.alive) {
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
          <div class="loading-header">
            <div class="loading-copy">
              <h2>${escapeHtml(progress.label)}</h2>
              <p>${escapeHtml(progress.detail)}</p>
            </div>
            <div class="loading-percent" aria-label="Progress ${progressPercent()}">${progressPercent()}</div>
          </div>
          <div class="progress-track" aria-label="Replay loading progress">
            <div class="progress-fill" style="width:${progressPercent()}"></div>
          </div>
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
            ? `<div class="topbar">${renderGraphPalette()}</div>`
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
  const percent = document.querySelector<HTMLElement>(".loading-percent");
  if (percent) {
    percent.textContent = progressPercent();
    percent.setAttribute("aria-label", `Progress ${progressPercent()}`);
  }
  const title = document.querySelector<HTMLElement>(".loading-card h2");
  if (title) title.textContent = progress.label;
  const detail = document.querySelector<HTMLElement>(".loading-card p");
  if (detail) detail.textContent = progress.detail;
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

async function releaseLoadedJobArtifacts(jobId: string) {
  try {
    await invoke("release_job_artifacts", { jobId });
  } catch {
    // Cleanup is best-effort; playback should not fail if disk pruning is blocked.
  }
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

function adoptCaptureJob(job: Job | null | undefined) {
  if (!job) return;
  if (activeJob?.job_id !== job.job_id) {
    sampleStreamOffset = 0;
    activeStats = null;
    boundsCache = null;
    resetProjectionMemory();
  }
  activeJob = job;
}

async function applySampleDelta(job: Job | undefined, token = captureProgressToken): Promise<boolean> {
  if (job?.job_id && activeJob?.job_id !== job.job_id) adoptCaptureJob(job);
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
    const losses = formatStat(team.casualties_estimate ?? team.displayed_casualties ?? team.casualties_displayed ?? team.casualties ?? team.troop_casualties, true);
    const funds = formatStat(fundsMetricValue(team));
    return `${label}: troops ${troops}, losses ${losses}, funds ${funds}`;
  });
}

function slowestTimingFact(event: CaptureProgressEvent): string | null {
  const timing = event.timing_ms ?? {};
  const entries = Object.entries(timing)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .sort((first, second) => Number(second[1]) - Number(first[1]));
  const slowest = entries[0];
  if (!slowest) {
    const pump = Number(event.previous_pump_ms);
    return Number.isFinite(pump) ? `Previous pump ${formatStat(pump)} ms` : null;
  }
  const pump = Number(event.previous_pump_ms);
  const pumpText = Number.isFinite(pump) ? `, pump ${formatStat(pump)} ms` : "";
  return `Slowest ${slowest[0].replaceAll("_", " ")} ${formatStat(slowest[1])} ms${pumpText}`;
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

  adoptCaptureJob(payload.job);
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
      `Target pace ${formatStat(event.target_game_seconds_per_wall_second)} game sec/sec`,
      `Target step ${formatStat(event.target_ticks_per_poll ?? event.fast_forward_frames_per_sample)} ticks/poll`,
      `Burst ${formatStat(event.fast_forward_frames_per_sample)} / max ${formatStat(event.max_fast_forward_frames_per_sample)} frames`,
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
    const timingFact = slowestTimingFact(event);
    facts = [
      `Samples ${formatStat(event.sample_count)} / ${formatStat(event.max_samples)}`,
      `Replay cadence ${formatStat(event.replay_sample_hz)} Hz / ${formatStat(event.replay_sample_tick_gap)} ticks`,
      `Objects ${formatStat(event.game_object_count)} game / ${formatStat(event.game_scene_count)} scene`,
      `Visible units ${formatStat(event.troop_count)}`,
      `Cities ${formatStat(event.controlled_city_count)} / ${formatStat(event.city_count)} controlled`,
      `Capture pace ${formatStat(event.actual_game_seconds_per_wall_second)} game sec/sec`,
      `Tick step ${formatStat(event.tick_delta)} in ${formatStat(event.wall_delta_ms)} ms`,
      `Burst ${formatStat(event.fast_forward_frames_per_sample)} -> ${formatStat(event.next_fast_forward_frames_per_sample)} frames/poll`,
      ...(timingFact ? [timingFact] : []),
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
      else adoptCaptureJob(payload.job);
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
  captureProgressTimer = window.setInterval(() => void progressPoll(), 250);
  sampleDeltaTimer = window.setInterval(() => void samplePoll(), 250);
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
    void releaseLoadedJobArtifacts(job.job_id);
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

async function loadReplayPath(filePath: string, fileName: string) {
  pausePlayback();
  phase = "loading";
  selectedFileName = fileName;
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
  setProgress(8, "Replay selected", `${fileName} is ready for hidden game capture.`);
  render();
  await nextPaint();

  try {
    await ensureGameRuntime();

    setProgress(28, "Launching hidden game", "Starting War of Dots on the automation desktop.");
    await nextPaint();

    stopProgressDrift();
    setProgress(30, "Capturing gamestate", "Injecting the live sampler and waiting for authoritative game-state samples.");
    const captureStartedAt = Date.now();
    liveCaptureActive = true;
    startCaptureProgressPolling(fileName, captureStartedAt);
    const job = await invoke<Job>("capture_replay_path", { filename: fileName, path: filePath });
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
    void releaseLoadedJobArtifacts(job.job_id);
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

function launchRequestSignature(request: ReplayLaunchRequest): string {
  return `${request.filePath}\n${request.fileName}`;
}

async function loadReplayLaunchRequest(request: ReplayLaunchRequest, options: { force?: boolean } = {}) {
  const signature = launchRequestSignature(request);
  if (!options.force && currentLaunchSignature === signature && (phase === "loading" || phase === "ready")) return;
  currentLaunchSignature = signature;
  await loadReplayPath(request.filePath, request.fileName);
}

async function loadLaunchRequest() {
  if (!launchId) return;
  try {
    const request = await invoke<ReplayLaunchRequest>("replay_launch_request", { launchId });
    await loadReplayLaunchRequest(request, { force: true });
  } catch (error) {
    phase = "error";
    notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
    render();
  }
}

async function loadCurrentLaunchRequest() {
  if (!isStaticReplayPlayer || phase === "loading") return;
  try {
    const request = await invoke<ReplayLaunchRequest>("current_replay_launch_request");
    await loadReplayLaunchRequest(request);
  } catch {
    if (phase === "booting") {
      phase = "idle";
      render();
    }
  }
}

if (appMode === "browser") {
  renderReplayBrowser();
  void loadBrowserReplays();
  startBrowserReplayPolling();
  startRegionPolling();
  window.addEventListener("keydown", (event) => {
    const wantsSearch = (event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f";
    if (!wantsSearch) return;
    event.preventDefault();
    document.querySelector<HTMLInputElement>("#playerSearch")?.focus();
    document.querySelector<HTMLInputElement>("#playerSearch")?.select();
  });
} else {
  window.addEventListener("resize", () => {
    graphWindows.filter((windowState) => windowState.visible).forEach(clampGraphWindow);
    renderCanvas();
  });
  if (isStaticReplayPlayer) {
    void listen<ReplayLaunchRequest>("replay-launch", (event) => {
      void loadReplayLaunchRequest(event.payload, { force: true });
    }).catch((error) => {
      phase = "error";
      notice = { tone: "error", text: `Replay launch listener failed: ${error instanceof Error ? error.message : String(error)}` };
      render();
    });
    window.addEventListener("focus", () => {
      void loadCurrentLaunchRequest();
    });
  }
  installFileDrop();
  render();
  void loadUnitAssets();
  void refreshBackend();
  if (launchId) void loadLaunchRequest();
}
