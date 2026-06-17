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

type ArtifactPayload = {
  filename: string;
  mime_type: string;
  base64: string;
  bytes: number;
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
  target_sim_speed?: number;
  fast_forward_controller?: boolean;
  fast_forward_step_method?: string;
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
};

type Troop = {
  slot: number | string;
  unit_id: string;
  owner?: number | string | null;
  type?: string | number | null;
  x: number | null;
  y: number | null;
  health?: number | null;
  morale?: number | null;
  alive: boolean;
  path: Array<{ x: number; y: number }>;
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

const foundAppRoot = document.querySelector<HTMLDivElement>("#app");
if (!foundAppRoot) {
  throw new Error("App root is missing.");
}
const appRoot: HTMLDivElement = foundAppRoot;

const PLAYER_COLORS = ["#063bff", "#ff1616", "#1ebd5a", "#ffdd22", "#7d35ff", "#ff8a1f", "#19d8ff", "#ff5aa8"];
const AUTHORITATIVE_SOURCES = new Set(["game-live-python", "memory", "local-session-memory-capture"]);
const GAME_TICKS_PER_SECOND = 30;

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
let captureProgressToken = 0;
let dropActive = false;
let playing = false;
let frameIndex = 0;
let playbackTick = 0;
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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number < 1024) return `${number} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`;
  return `${(number / 1024 / 1024).toFixed(1)} MB`;
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

function sampleAtFrame(): Sample | null {
  if (!activeStats?.samples.length) return null;
  return activeStats.samples[Math.min(frameIndex, activeStats.samples.length - 1)] ?? null;
}

function firstCapturedTick(stats = activeStats): number {
  const summaryTick = Number(stats?.summary?.first_tick);
  const sampleTick = Number(stats?.samples.at(0)?.tick);
  if (Number.isFinite(summaryTick)) return summaryTick;
  if (Number.isFinite(sampleTick)) return sampleTick;
  return 0;
}

function lastCapturedTick(stats = activeStats): number {
  const summaryTick = Number(stats?.summary?.last_tick);
  const sampleTick = Number(stats?.samples.at(-1)?.tick);
  if (Number.isFinite(summaryTick)) return summaryTick;
  if (Number.isFinite(sampleTick)) return sampleTick;
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
  playbackTick = Number(sampleAtFrame()?.tick ?? firstCapturedTick());
}

function metadataValue(key: string): unknown {
  return activeJob?.metadata?.[key] ?? activeStats?.replay_metadata?.[key] ?? "-";
}

function players(): string[] {
  return playerNamesFromMetadata(activeJob?.metadata ?? activeStats?.replay_metadata);
}

function messages(): Array<{ tick: number; player: string; text: string }> {
  const output: Array<{ tick: number; player: string; text: string }> = [];
  const names = players();
  for (const sample of activeStats?.samples ?? []) {
    for (const [key, value] of Object.entries(sample.events ?? {})) {
      if (key.startsWith("message") && typeof value === "string" && value.trim()) {
        const index = Number(key.replace("message", ""));
        output.push({ tick: sample.tick, player: names[index] ?? `Player ${index + 1}`, text: value.trim() });
      }
    }
  }
  return output.slice(-24).reverse();
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

function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  font: string,
  align: CanvasTextAlign = "left",
) {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(238, 244, 245, 0.85)";
  ctx.lineWidth = 4;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function fitCanvasText(ctx: CanvasRenderingContext2D, text: string, font: string, maxWidth: number): string {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let output = text.trim();
  while (output.length > 3 && ctx.measureText(`${output}...`).width > maxWidth) {
    output = output.slice(0, -1).trimEnd();
  }
  return output.length > 3 ? `${output}...` : output;
}

function drawHud(ctx: CanvasRenderingContext2D, width: number, height: number, sample: Sample) {
  const teams = teamList().slice(0, 4);
  const topY = 76;
  const bottomY = Math.max(160, height - 162);
  const titleFont = "700 30px Inter, Segoe UI, sans-serif";
  const valueFont = "700 31px Inter, Segoe UI, sans-serif";
  const leftTextWidth = Math.max(126, width - 338);

  teams.slice(0, 2).forEach((team, index) => {
    const name = fitCanvasText(ctx, team.name || `Player ${index + 1}`, titleFont, leftTextWidth);
    drawOutlinedText(ctx, name, 10, topY + index * 35, team.color_hex ?? teamColor(index), titleFont);
  });

  drawOutlinedText(ctx, "Funds:", width - 14, topY, "#6f7074", titleFont, "right");
  teams.slice(0, 2).forEach((team, index) => {
    const metric = metricForTeam(sample, Number(team.index));
    const value = formatStat(metric.funds);
    drawOutlinedText(ctx, value, width - 14, topY + 36 + index * 35, team.color_hex ?? teamColor(index), valueFont, "right");
  });

  drawOutlinedText(ctx, "Casualties:", 10, bottomY, "#6f7074", titleFont);
  teams.slice(0, 2).forEach((team, index) => {
    const metric = metricForTeam(sample, Number(team.index));
    const value = metric.casualties_estimate ?? metric.casualties ?? metric.troop_casualties;
    drawOutlinedText(ctx, formatStat(value, true), 10, bottomY + 36 + index * 35, team.color_hex ?? teamColor(index), valueFont);
  });

  drawOutlinedText(ctx, "Troops:", width - 14, bottomY, "#6f7074", titleFont, "right");
  teams.slice(0, 2).forEach((team, index) => {
    const metric = metricForTeam(sample, Number(team.index));
    const value = metric.troops_estimate ?? metric.strength ?? metric.alive_units;
    drawOutlinedText(ctx, formatStat(value, true), width - 14, bottomY + 36 + index * 35, team.color_hex ?? teamColor(index), valueFont, "right");
  });

  drawOutlinedText(ctx, `Tick ${formatStat(sample.tick)}`, width / 2, topY, "#eef4f5", "800 18px Inter, Segoe UI, sans-serif", "center");
}

function drawTroop(
  ctx: CanvasRenderingContext2D,
  troop: Troop,
  latest: { x: number; y: number },
  color: string,
  fit: number,
) {
  const typeText = String(troop.type ?? "").toLowerCase();
  const isTank = typeText.includes("tank") || typeText === "1";
  const radius = Math.max(4, Math.min(8, (isTank ? 10 : 8) * Math.sqrt(fit)));
  ctx.save();
  ctx.fillStyle = troop.alive ? color : "#707981";
  ctx.strokeStyle = "rgba(0,0,0,0.72)";
  ctx.lineWidth = 2;
  if (isTank) {
    ctx.beginPath();
    ctx.moveTo(latest.x, latest.y - radius);
    ctx.lineTo(latest.x + radius, latest.y + radius);
    ctx.lineTo(latest.x - radius, latest.y + radius);
    ctx.closePath();
  } else {
    ctx.beginPath();
    ctx.arc(latest.x, latest.y, radius, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();

  const health = Number(troop.health);
  if (troop.alive && Number.isFinite(health)) {
    const maxHealth = isTank ? 200 : 100;
    const percent = Math.max(0, Math.min(1, health / maxHealth));
    const barWidth = isTank ? 28 : 23;
    const barHeight = 5;
    const barX = latest.x - barWidth / 2;
    const barY = latest.y - radius - 12;
    ctx.fillStyle = "rgba(0,0,0,0.82)";
    ctx.fillRect(barX - 1, barY - 1, barWidth + 2, barHeight + 2);
    ctx.fillStyle = "#04f58b";
    ctx.fillRect(barX, barY, barWidth * percent, barHeight);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.strokeRect(barX, barY, barWidth, barHeight);
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
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0c1012";
  ctx.fillRect(0, 0, width, height);

  const sample = sampleAtFrame();
  if (!activeStats || !sample) {
    ctx.fillStyle = "rgba(238,244,245,0.08)";
    ctx.font = "800 72px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("WOD", width / 2, height / 2);
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
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, offsetX, offsetY, worldWidth * fit, worldHeight * fit);
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

  if (showPower) {
    ctx.strokeStyle = "rgba(0,0,0,0.26)";
    ctx.lineWidth = 2;
    ctx.strokeRect(offsetX, offsetY, worldWidth * fit, worldHeight * fit);
  }

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
        drawTroop(ctx, troop, latest, color, fit);
      }
    }
  });

  drawHud(ctx, width, height, sample);

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
}

function progressPercent(): string {
  return `${Math.max(0, Math.min(100, progress.value)).toFixed(0)}%`;
}

function renderOverlay(): string {
  if (phase === "loading") {
    return `
      <div class="loading-screen">
        <div class="loading-card">
          <span class="loading-kicker">Loading Replay</span>
          <h2>${escapeHtml(progress.label)}</h2>
          <p>${escapeHtml(progress.detail)}</p>
          <div class="progress-track" aria-label="Replay loading progress">
            <div class="progress-fill" style="width:${progressPercent()}"></div>
          </div>
          <div class="progress-meta">
            <span>${escapeHtml(selectedFileName || "Replay")}</span>
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
          <span class="loading-kicker">War of Dots</span>
          <h2>Open a replay and start watching.</h2>
          <p>Drop a .rep file here or choose one from disk. The app will launch the hidden game, capture live gamestate, and only open playback when the capture is authoritative.</p>
          <label class="primary-file-button" for="fileInput">Open .rep</label>
          <span class="backend-line">${backendLine()}</span>
        </div>
      </div>
    `;
  }

  if (dropActive) {
    return `<div class="drop-overlay"><div>Drop replay file</div></div>`;
  }

  return "";
}

function backendLine(): string {
  if (phase === "booting") return "Starting local backend";
  if (!statusPayload) return "Desktop backend unavailable in this preview";
  if (statusPayload.runner.game_exe_exists && statusPayload.runner.game_python_capture_available) return "Hidden game capture ready";
  if (statusPayload.runner.game_exe_exists) return "Game staged, capture probe unavailable";
  if (statusPayload.steam_game_exists) return "Steam install found";
  return "Game-backed capture required";
}

function backendTone(): string {
  if (!statusPayload) return "offline";
  if (statusPayload.runner.game_exe_exists) return "ready";
  return "fallback";
}

function renderPlayers(): string {
  const teams = teamList();
  const sample = sampleAtFrame();
  if (!teams.length) return `<p class="empty-state">Player metadata will appear after loading.</p>`;
  return teams
    .map((team, index) => {
      const metric = sample ? metricForTeam(sample, Number(team.index)) : null;
      const statsLine = metric
        ? `troops ${formatStat(metric.troops_estimate ?? metric.alive_units, true)} - losses ${formatStat(metric.casualties_estimate ?? metric.casualties, true)}`
        : `player ${index + 1}`;
      return `
        <div class="player-row">
          <div class="player-top">
            <span class="swatch" style="background:${escapeHtml(team.color_hex ?? PLAYER_COLORS[index % PLAYER_COLORS.length])}"></span>
            <span class="player-name">${escapeHtml(team.name)}</span>
          </div>
          <span class="player-stats">${escapeHtml(statsLine)}</span>
        </div>
      `;
    })
    .join("");
}

function renderMessages(): string {
  const items = messages();
  if (!items.length) return `<p class="empty-state">Match messages will appear here.</p>`;
  return items
    .map(
      (message) => `
        <div class="message-row">
          <span class="message-time">${formatTime(message.tick)} ${escapeHtml(message.player)}</span>
          <p>${escapeHtml(message.text)}</p>
        </div>
      `,
    )
    .join("");
}

function render() {
  const sample = sampleAtFrame();
  const maxFrame = Math.max(0, (activeStats?.samples.length ?? 1) - 1);
  const firstTick = firstCapturedTick();
  const lastTick = lastCapturedTick();
  const endTick = replayEndTick();
  const reachedEnd = activeStats ? captureReachedReplayEnd(activeStats) : false;
  const summary = activeStats?.summary ?? {};

  appRoot.innerHTML = `
    <main class="app-shell">
      <section class="viewer-area" aria-label="Replay viewer">
        <canvas id="replayCanvas" aria-label="Replay canvas"></canvas>
        <input id="fileInput" type="file" accept=".rep,application/gzip">
        ${
          activeStats
            ? `
          <div class="topbar">
            <div class="file-controls">
              <label class="file-button" for="fileInput">Open another</label>
            </div>
            <div class="status-cluster">
              <span class="backend-pill ${backendTone()}">${escapeHtml(backendLine())}</span>
            </div>
          </div>
        `
            : ""
        }
        ${renderOverlay()}
        ${
          activeStats
            ? `
          <div class="timeline-dock" aria-label="Replay timeline controls">
            <div class="timeline-meta">
              <span id="currentTime">Tick ${formatStat(sample?.tick ?? firstTick)}</span>
              <span id="durationTime">${formatReplayClock(sample?.tick ?? firstTick)} / ${formatReplayClock(endTick || lastTick)}</span>
            </div>
            <input id="timeline" type="range" min="0" max="${maxFrame}" step="1" value="${frameIndex}" aria-label="Replay timeline">
          </div>
        `
            : ""
        }
        <div id="toast" class="toast ${notice ? `visible ${notice.tone}` : ""}" role="status" aria-live="polite">${escapeHtml(notice?.text ?? "")}</div>
      </section>

      <aside class="side-panel" aria-label="Replay details and playback controls">
        <header class="replay-header">
          <p class="eyebrow">War of Dots</p>
          <h1 id="replayTitle">${escapeHtml(activeJob?.filename ?? (selectedFileName || "Replay Player"))}</h1>
          <p id="replaySubtitle">${escapeHtml(activeStats ? `${captureSource(activeJob, activeStats)} - ${summary.sample_count ?? 0} samples` : "Choose a replay to capture from the hidden game.")}</p>
        </header>

        <section class="control-block transport" aria-label="Playback controls">
          <div class="transport-row">
            <button id="playButton" class="play-button" type="button" ${activeStats ? "" : "disabled"}>${playing ? "Pause" : "Play"}</button>
            <button id="resetButton" type="button" ${activeStats ? "" : "disabled"}>Reset</button>
          </div>
          <div class="speed-control">
            <div class="speed-label-row">
              <label for="speedRange">Speed</label>
              <strong id="speedValue">${speed.toFixed(1)}x</strong>
            </div>
            <input id="speedRange" type="range" min="0.5" max="16" step="0.5" value="${speed}" aria-label="Playback speed">
          </div>
        </section>

        <section class="control-block toggles" aria-label="Drawing layers">
          <label><input id="trailsToggle" type="checkbox" ${showTrails ? "checked" : ""}> Trails</label>
          <label><input id="dotsToggle" type="checkbox" ${showDots ? "checked" : ""}> Dots</label>
          <label><input id="zonesToggle" type="checkbox" ${showPower ? "checked" : ""}> Power</label>
          <label><input id="messagesToggle" type="checkbox" ${showMessages ? "checked" : ""}> Messages</label>
        </section>

        <section class="info-grid" aria-label="Replay metadata">
          <div><span>Map</span><strong>${escapeHtml(metadataValue("map"))}</strong></div>
          <div><span>Version</span><strong>${escapeHtml(metadataValue("version"))}</strong></div>
          <div><span>Result</span><strong>${escapeHtml(summary.result ?? metadataValue("result"))}</strong></div>
          <div><span>Samples</span><strong>${escapeHtml(summary.sample_count ?? "-")}</strong></div>
          <div><span>First tick</span><strong>${escapeHtml(formatStat(firstTick))}</strong></div>
          <div><span>Last tick</span><strong>${escapeHtml(formatStat(lastTick))}</strong></div>
          <div><span>End tick</span><strong>${escapeHtml(formatStat(endTick))}</strong></div>
          <div><span>Capture</span><strong>${reachedEnd ? "Reached end" : "Partial"}</strong></div>
          <div><span>Troop slots</span><strong>${escapeHtml(summary.troop_slots_seen ?? "-")}</strong></div>
        </section>

        <section class="players-block" aria-label="Players">
          <h2>Players</h2>
          <div class="players-list">${renderPlayers()}</div>
        </section>

        <section class="messages-block" aria-label="Replay messages">
          <h2>Messages</h2>
          <div class="message-list">${renderMessages()}</div>
        </section>

        <section class="players-block" aria-label="Downloads">
          <h2>Outputs</h2>
          <div class="download-list">
            <button data-artifact="simulated-replay" type="button" ${activeJob?.status === "captured" ? "" : "disabled"}>Simulated replay</button>
            <button data-artifact="stats" type="button" ${activeStats ? "" : "disabled"}>Stats JSON</button>
            <button data-artifact="logs" type="button" ${activeJob ? "" : "disabled"}>Logs</button>
          </div>
        </section>
      </aside>
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
  document.querySelector<HTMLButtonElement>("#playButton")?.addEventListener("click", () => {
    if (!activeStats) return;
    playing ? pausePlayback() : startPlayback();
  });
  document.querySelector<HTMLButtonElement>("#resetButton")?.addEventListener("click", () => {
    frameIndex = 0;
    pausePlayback();
    renderCanvas();
    updatePlaybackUi();
  });
  document.querySelector<HTMLInputElement>("#timeline")?.addEventListener("input", (event) => {
    frameIndex = Number((event.target as HTMLInputElement).value);
    syncPlaybackTickToFrame();
    renderCanvas();
    updatePlaybackUi();
  });
  document.querySelector<HTMLInputElement>("#speedRange")?.addEventListener("input", (event) => {
    speed = Number((event.target as HTMLInputElement).value);
    updatePlaybackUi();
  });
  document.querySelector<HTMLInputElement>("#trailsToggle")?.addEventListener("change", (event) => {
    showTrails = (event.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.querySelector<HTMLInputElement>("#dotsToggle")?.addEventListener("change", (event) => {
    showDots = (event.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.querySelector<HTMLInputElement>("#zonesToggle")?.addEventListener("change", (event) => {
    showPower = (event.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.querySelector<HTMLInputElement>("#messagesToggle")?.addEventListener("change", (event) => {
    showMessages = (event.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-artifact]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.artifact;
      if (kind) void downloadArtifact(kind);
    });
  });
}

function updatePlaybackUi() {
  const sample = sampleAtFrame();
  const maxFrame = Math.max(0, (activeStats?.samples.length ?? 1) - 1);
  const endTick = replayEndTick();
  const timeline = document.querySelector<HTMLInputElement>("#timeline");
  if (timeline) {
    timeline.max = String(maxFrame);
    timeline.value = String(frameIndex);
    timeline.disabled = !activeStats;
  }
  const currentTime = document.querySelector<HTMLElement>("#currentTime");
  if (currentTime) currentTime.textContent = `Tick ${formatStat(sample?.tick ?? firstCapturedTick())}`;
  const durationTime = document.querySelector<HTMLElement>("#durationTime");
  if (durationTime) durationTime.textContent = `${formatReplayClock(sample?.tick ?? 0)} / ${formatReplayClock(endTick)}`;
  const playButton = document.querySelector<HTMLButtonElement>("#playButton");
  if (playButton) playButton.textContent = playing ? "Pause" : "Play";
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

function base64ToBlob(payload: ArtifactPayload): Blob {
  const bytes = base64ToBytes(payload.base64);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([arrayBuffer], { type: payload.mime_type });
}

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function readStats(jobId: string): Promise<Stats> {
  const payload = await invoke<ArtifactPayload>("read_artifact", { jobId, kind: "stats" });
  const text = new TextDecoder().decode(base64ToBytes(payload.base64));
  const parsed = JSON.parse(text) as Stats;
  if (!parsed || !Array.isArray(parsed.samples)) {
    throw new Error("Stats artifact did not contain playable samples.");
  }
  return parsed;
}

function jobStatusProgress(status: string): { value: number; label: string; detail: string } {
  switch (status) {
    case "queued":
      return { value: 18, label: "Queued capture", detail: "The replay is validated and waiting for the hidden game runner." };
    case "local_runner_starting":
      return { value: 28, label: "Starting local runner", detail: "Preparing the logged-in desktop automation session." };
    case "launching_hidden_game":
      return { value: 38, label: "Launching hidden game", detail: "Starting War of Dots on the automation desktop and waiting for the Python probe." };
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
    const losses = formatStat(team.casualties_estimate ?? team.casualties ?? team.troop_casualties, true);
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
      `Sampler ${formatStat(event.sample_hz)} Hz`,
      `Game pump ${formatStat(event.target_sim_speed)}x`,
      `Controller ${event.fast_forward_controller ? "on" : "off"} / ${event.fast_forward_step_method ?? "step"}`,
    ];
    value = Math.max(value, 46);
  } else if (event?.stage === "capture-sample") {
    const tick = Number(event.tick);
    const endTick = Number(event.end_tick);
    const tickPercent = Number.isFinite(Number(event.tick_percent))
      ? Number(event.tick_percent)
      : Number.isFinite(tick) && Number.isFinite(endTick) && endTick > 0
        ? tick / endTick
        : 0;
    const boundedPercent = Math.max(0, Math.min(1, tickPercent));
    value = Math.max(value, 48 + boundedPercent * 47);
    label = "Capturing live gamestate";
    detail = `Captured tick ${formatStat(tick)} / ${formatStat(endTick)} (${(boundedPercent * 100).toFixed(1)}%) at ${formatReplayClock(tick)} / ${formatReplayClock(endTick)}.`;
    facts = [
      `Samples ${formatStat(event.sample_count)} / ${formatStat(event.max_samples)}`,
      `Objects ${formatStat(event.game_object_count)} game / ${formatStat(event.game_scene_count)} scene`,
      `Visible units ${formatStat(event.troop_count)}`,
      `Elapsed ${formatTime(Number(event.elapsed_ms ?? 0))}`,
      ...teamProgressFacts(event, payload.job),
    ];
    if (event.completion) {
      value = Math.max(value, 96);
      facts.unshift(`Reached replay end: ${String(event.completion.reason ?? "complete").replaceAll("-", " ")}`);
    }
  } else if (event?.phase) {
    label = "Opening replay scene";
    detail = `Hidden game probe: ${event.phase.replaceAll("-", " ")}.`;
    facts = [`Job ${payload.job?.job_id ?? "-"}`, `Status ${status || "launching"}`];
    value = Math.max(value, 42);
  } else {
    facts = [`Job ${payload.job?.job_id ?? "-"}`, `Status ${status || "working"}`];
  }

  const statsSummary = payload.stats?.summary as Record<string, unknown> | undefined;
  if (statsSummary?.sample_count) {
    facts.unshift(`Captured samples ${formatStat(statsSummary.sample_count)}`);
  }

  setProgress(value, label, detail, facts.filter(Boolean).slice(0, 8));
}

function stopCaptureProgressPolling() {
  window.clearInterval(captureProgressTimer);
  captureProgressTimer = 0;
  captureProgressToken += 1;
}

function startCaptureProgressPolling(filename: string, startedAfterMs: number) {
  window.clearInterval(captureProgressTimer);
  const token = ++captureProgressToken;
  const poll = async () => {
    if (token !== captureProgressToken || phase !== "loading") return;
    try {
      const payload = await invoke<CaptureProgressPayload>("capture_progress", { filename, startedAfterMs });
      if (token === captureProgressToken && phase === "loading") applyCaptureProgress(payload, filename);
    } catch {
      // Keep the current loading text; capture itself will report errors when it finishes.
    }
  };
  void poll();
  captureProgressTimer = window.setInterval(() => void poll(), 1000);
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
  resetMapImage();
  frameIndex = 0;
  notice = null;
  setProgress(3, "Reading replay", "Loading the replay file from disk.");
  render();
  await nextPaint();

  try {
    const buffer = await file.arrayBuffer();
    setProgress(14, "Replay loaded", `${file.name} is ready for hidden game capture.`);
    await nextPaint();

    await ensureGameRuntime();

    setProgress(36, "Launching hidden game", "Starting War of Dots on the automation desktop.");
    await nextPaint();

    setProgress(48, "Capturing gamestate", "Injecting the live sampler and waiting for authoritative game-state samples.");
    startProgressDrift(92);
    const replayBase64 = bytesToBase64(new Uint8Array(buffer));
    const captureStartedAt = Date.now();
    startCaptureProgressPolling(file.name, captureStartedAt);
    const job = await invoke<Job>("capture_replay", { filename: file.name, replayBase64 });
    stopCaptureProgressPolling();
    if (job.status !== "captured") throw new Error(job.error ?? "Game-backed capture failed.");

    const stats = getStats(job) ?? (await readStats(job.job_id));
    if (!stats?.samples.length) throw new Error("Game-backed capture completed without playable samples.");
    if (!isAuthoritativeCapture(job, stats)) {
      throw new Error(`Refusing non-authoritative capture source: ${captureSource(job, stats) || "unknown"}.`);
    }
    if (!captureReachedReplayEnd(stats)) {
      throw new Error(
        `Refusing partial capture: live sampler stopped at tick ${formatStat(lastCapturedTick(stats))} of ${formatStat(replayEndTick(stats))}.`,
      );
    }

    activeJob = job;
    activeStats = stats;
    boundsCache = null;
    frameIndex = 0;
    syncPlaybackTickToFrame();
    jobs = [job, ...jobs.filter((candidate) => candidate.job_id !== job.job_id)];
    setProgress(100, "Capture ready", "Opening authoritative playback.");
    stopProgressDrift();
    await nextPaint();
    phase = "ready";
    notice = { tone: "success", text: "Game-backed capture loaded. Playback started." };
    render();
    startPlayback();
    void refreshBackend({ quiet: true });
  } catch (error) {
    stopCaptureProgressPolling();
    stopProgressDrift();
    phase = "error";
    notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
    render();
  }
}

async function downloadArtifact(kind: string) {
  if (!activeJob) return;
  try {
    const payload = await invoke<ArtifactPayload>("read_artifact", { jobId: activeJob.job_id, kind });
    const url = URL.createObjectURL(base64ToBlob(payload));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = payload.filename;
    anchor.click();
    URL.revokeObjectURL(url);
    notice = { tone: "success", text: `Prepared ${payload.filename} (${formatBytes(payload.bytes)}).` };
  } catch (error) {
    notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
  }
  render();
}

function startPlayback() {
  if (!activeStats?.samples.length) return;
  if (frameIndex >= activeStats.samples.length - 1) frameIndex = 0;
  syncPlaybackTickToFrame();
  playing = true;
  lastAnimationTime = 0;
  updatePlaybackUi();
  window.cancelAnimationFrame(animationHandle);
  animationHandle = window.requestAnimationFrame(tickPlayback);
}

function pausePlayback() {
  playing = false;
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

window.addEventListener("resize", renderCanvas);
installFileDrop();
render();
void refreshBackend();
