// Background MP4 export: a setup dialog and a floating progress queue. The
// backend converts replays without playing them, so nothing opens a player.
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { exampleMode, invoke } from "../platform";
import { matchupTitle } from "./filters";

export type ExportReplay = {
  fileName: string;
  filePath: string;
  modified: number;
  durationSeconds: number;
  players: { name: string; teamIndex?: number }[];
};

type ExportProgress = {
  sourcePath: string;
  step: "queued" | "preparing" | "exporting" | "completed" | "failed" | "cancelled";
  frame: number;
  total: number;
  outputPath?: string | null;
  message?: string | null;
};

type Setup = {
  replays: ExportReplay[];
  destinationDir: string;
  concurrency: number;
  speedIndex: number;
  bitrateIndex: number;
  resolutionIndex: number;
  layers: Set<string>;
  // Percent, like the game's volume settings.
  musicVolume: number;
  sfxVolume: number;
  // The sounds are read from the installed game; without it videos are silent.
  soundsInstalled: boolean;
};

type GameAudio = { files: Record<string, string> | null; music: number | null; sfx: number | null };

const SPEEDS = [1, 2, 4, 6, 10, 15, 20, 30] as const;
const BITRATES = [0.5, 1, 2.5, 5, 10] as const;
const RESOLUTIONS = [480, 720, 1080] as const;
// The same eight layers and defaults as the player, which shares its saved choice.
const LAYERS = [
  ["orders", "Orders", true],
  ["health", "Health", true],
  ["morale", "Morale", true],
  ["flags", "City flags", true],
  ["stats", "Stats", true],
  ["icons", "Status icons", true],
  ["produce", "City connections", false],
  ["players", "Player names", true],
] as const;
const DIRECTORY_KEY = "moreOfDotsRecordingDirectory";
const SETTINGS_KEY = "moreOfDotsExportSettings";
const PLAYER_LAYERS_KEY = "replay-player-layers-v2";
// The player's volumes, which start from the game's own settings.
const PLAYER_VOLUME_KEY = "replay-player-volume-v1";
const MAX_CONCURRENCY = 8;

const icon = (paths: string) => `<svg aria-hidden="true" viewBox="0 0 24 24">${paths}</svg>`;
const ICONS = {
  video: icon('<rect x="3" y="6" width="14" height="12" rx="2"/><path d="m17 10 4-2v8l-4-2"/>'),
  close: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
  folder: icon('<path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/>'),
  stop: icon('<rect x="7" y="7" width="10" height="10" rx="1" />'),
  warning: icon('<path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5M12 17h.01"/>'),
};

let setup: Setup | null = null;
let dialogRoot: HTMLDivElement | null = null;
let queueRoot: HTMLDivElement | null = null;
let running = false;
let cancelling = false;
let returnFocus: HTMLElement | null = null;
const progress = new Map<string, ExportProgress>();
const queued = new Map<string, { replay: ExportReplay; speed: number }>();
const rows = new Map<string, HTMLElement>();

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const title = (replay: ExportReplay) => matchupTitle(replay.players) || replay.fileName;
const terminal = (item: ExportProgress) => ["completed", "failed", "cancelled"].includes(item.step);

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value ? { ...fallback, ...JSON.parse(value) } : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // Exporting works without saved preferences.
  }
}

function savedLayers(): Set<string> {
  const saved = readStorage<Record<string, boolean>>(PLAYER_LAYERS_KEY, {});
  return new Set(LAYERS.filter(([name, , enabled]) => saved[name] ?? enabled).map(([name]) => name));
}

function fileName(replay: ExportReplay, speed: number, height: number): string {
  const timestamp = new Date(replay.modified * 1000).toISOString().slice(0, 19).replaceAll(":", "-").replace("T", "_");
  // Named like the game's own replays: "a _ b-vs-c _ d".
  const names = matchupTitle(replay.players.map((player) => ({
    ...player,
    name: player.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim() || "player",
  })), "-vs-", " _ ");
  return `${timestamp}_${names || "replay"}_${speed}x_${height}p.mp4`;
}

export function exportBusy() {
  return running;
}

/** Opens the export options for the selected replays. */
export async function openExportSetup(replays: ExportReplay[]) {
  if (!replays.length || running || setup) return;
  const settings = readStorage<{ concurrency: number; speedIndex: number; bitrateIndex: number; resolutionIndex: number; musicVolume?: number; sfxVolume?: number }>(
    SETTINGS_KEY, { concurrency: 2, speedIndex: 1, bitrateIndex: 3, resolutionIndex: 2 });
  const volume = readStorage<{ music?: number; sfx?: number }>(PLAYER_VOLUME_KEY, {});
  const knownVolume = typeof settings.musicVolume === "number" || typeof volume.music === "number";
  const percent = (saved: number | undefined, fallback: number) =>
    Math.round(Math.max(0, Math.min(100, typeof saved === "number" ? saved : fallback * 100)));
  let destinationDir = "";
  try {
    destinationDir = window.localStorage.getItem(DIRECTORY_KEY)?.trim() || "";
  } catch {
    // Fall back to the Videos folder below.
  }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setup = {
    replays: [...replays],
    destinationDir,
    concurrency: Math.max(1, Math.min(settings.concurrency, replays.length, MAX_CONCURRENCY)),
    speedIndex: Math.min(settings.speedIndex, SPEEDS.length - 1),
    bitrateIndex: Math.min(settings.bitrateIndex, BITRATES.length - 1),
    resolutionIndex: Math.min(settings.resolutionIndex, RESOLUTIONS.length - 1),
    layers: savedLayers(),
    musicVolume: percent(settings.musicVolume, volume.music ?? 0.3),
    sfxVolume: percent(settings.sfxVolume, volume.sfx ?? 0.3),
    soundsInstalled: true,
  };
  renderDialog();
  dialogRoot?.querySelector<HTMLInputElement>("#exportSpeed")?.focus();
  const game = await invoke<GameAudio>("game_audio").catch(() => null);
  if (setup) {
    setup.soundsInstalled = Boolean(game?.files);
    // Until the volumes are changed, they follow the game's settings.
    if (!knownVolume && typeof game?.music === "number" && typeof game.sfx === "number") {
      setup.musicVolume = percent(undefined, game.music);
      setup.sfxVolume = percent(undefined, game.sfx);
    }
    renderDialog();
    dialogRoot?.querySelector<HTMLInputElement>("#exportSpeed")?.focus();
  }
  if (!destinationDir) {
    try {
      setup.destinationDir = await invoke<string>("recording_default_directory");
    } catch (error) {
      setup.destinationDir = "";
      window.alert(`Choose an export folder.\n\n${String(error)}`);
    }
    renderDialog();
  }
}

function scale(values: readonly number[], format: (value: number) => string) {
  return `<div class="recording-slider-scale" aria-hidden="true">${values.map((value) => `<span>${escapeHtml(format(value))}</span>`).join("")}</div>`;
}

function slider(id: string, label: string, hint: string, value: string, min: number, max: number, current: number, extra = "", wide = false, disabled = false) {
  return `
    <label class="recording-option-card ${wide ? "is-wide" : ""}" for="${id}">
      <span class="recording-option-heading">
        <span><strong>${label}</strong><small>${hint}</small></span>
        <output id="${id}Value">${escapeHtml(value)}</output>
      </span>
      <input id="${id}" type="range" min="${min}" max="${max}" step="1" value="${current}"${disabled ? " disabled" : ""}>
      ${extra}
    </label>`;
}

function summary(current: Setup) {
  return `${SPEEDS[current.speedIndex]}× · ${RESOLUTIONS[current.resolutionIndex]}p · ${BITRATES[current.bitrateIndex]} Mbps`;
}

const formatDetails = (current: Setup) =>
  current.soundsInstalled && (current.musicVolume || current.sfxVolume) ? "MP4 · H.264 · game audio" : "MP4 · H.264 · no audio";

function renderDialog() {
  if (!setup) {
    dialogRoot?.remove();
    dialogRoot = null;
    return;
  }
  if (!dialogRoot) {
    dialogRoot = document.createElement("div");
    document.body.appendChild(dialogRoot);
    bindDialog(dialogRoot);
  }
  const current = setup;
  const count = current.replays.length;
  const maxConcurrency = Math.min(MAX_CONCURRENCY, Math.max(1, count));
  const minutes = current.replays.reduce((sum, replay) => sum + (replay.durationSeconds || 0), 0) / 60;
  dialogRoot.innerHTML = `
    <div class="recording-setup-backdrop" role="presentation">
      <section class="recording-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="exportSetupTitle" aria-describedby="exportSetupDescription">
        <header class="recording-setup-header">
          <span class="recording-setup-icon" aria-hidden="true">${ICONS.video}</span>
          <span>
            <small>Replay export</small>
            <h2 id="exportSetupTitle">Export ${count} ${count === 1 ? "video" : "videos"}</h2>
            <p id="exportSetupDescription">Videos are converted in the background, much faster than real time. ${Math.round(minutes)} min of gameplay selected.</p>
          </span>
          <button class="recording-setup-close" type="button" data-export-action="close" aria-label="Close export setup">${ICONS.close}</button>
        </header>

        <div class="recording-destination">
          <span class="recording-destination-icon" aria-hidden="true">${ICONS.folder}</span>
          <span><small>Export folder</small><strong title="${escapeHtml(current.destinationDir)}">${escapeHtml(current.destinationDir || "Loading Videos folder...")}</strong></span>
          <button type="button" data-export-action="folder">Change</button>
        </div>

        <div class="recording-option-grid">
          ${slider("exportSpeed", "Playback speed", "Game time per video second", `${SPEEDS[current.speedIndex]}×`, 0, SPEEDS.length - 1, current.speedIndex, scale(SPEEDS, (v) => `${v}×`))}
          ${slider("exportBitrate", "Video bitrate", "Higher is clearer and larger", `${BITRATES[current.bitrateIndex]} Mbps`, 0, BITRATES.length - 1, current.bitrateIndex, scale(BITRATES, (v) => `${v}M`))}
          ${slider("exportResolution", "Resolution", "16:9 MP4, 30 fps", `${RESOLUTIONS[current.resolutionIndex]}p`, 0, RESOLUTIONS.length - 1, current.resolutionIndex, scale(RESOLUTIONS, (v) => `${v}p`))}
          ${slider("exportConcurrency", "Simultaneous exports", "Videos converted at once", String(current.concurrency), 1, maxConcurrency, current.concurrency, `<div class="recording-slider-endpoints" aria-hidden="true"><span>1</span><span>${maxConcurrency}</span></div>`)}
          ${slider("exportMusic", "Music volume", current.soundsInstalled ? "The game's match music" : "Install War of Dots to add its music", `${current.musicVolume}%`, 0, 100, current.musicVolume, `<div class="recording-slider-endpoints" aria-hidden="true"><span>Off</span><span>100%</span></div>`, false, !current.soundsInstalled)}
          ${slider("exportSfx", "SFX volume", current.soundsInstalled ? "Fighting, production and end sounds" : "Install War of Dots to add its sounds", `${current.sfxVolume}%`, 0, 100, current.sfxVolume, `<div class="recording-slider-endpoints" aria-hidden="true"><span>Off</span><span>100%</span></div>`, false, !current.soundsInstalled)}
        </div>

        <fieldset class="export-layers">
          <legend>Shown in the video</legend>
          ${LAYERS.map(([name, label]) => `<label><input type="checkbox" data-export-layer="${name}" ${current.layers.has(name) ? "checked" : ""}><span>${label}</span></label>`).join("")}
        </fieldset>

        <div class="recording-power-warning" data-export-warning ${current.concurrency > 3 ? "" : "hidden"} role="status">
          ${ICONS.warning}
          <span><strong>Powerful PC recommended</strong><small>Each export uses a CPU core and the graphics card. More than 3 at once can slow everything else down.</small></span>
        </div>

        <footer class="recording-setup-actions">
          <span class="recording-setup-summary"><strong data-export-summary>${summary(current)}</strong><small data-export-format>${formatDetails(current)}</small></span>
          <button class="recording-setup-cancel" type="button" data-export-action="close">Cancel</button>
          <button class="recording-setup-start" type="button" data-export-action="start" ${current.destinationDir ? "" : "disabled"}>${ICONS.video} Export</button>
        </footer>
      </section>
    </div>`;
}

function bindDialog(root: HTMLElement) {
  root.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (!setup) return;
    const value = Number(input.value);
    if (input.id === "exportSpeed") setup.speedIndex = value;
    else if (input.id === "exportBitrate") setup.bitrateIndex = value;
    else if (input.id === "exportResolution") setup.resolutionIndex = value;
    else if (input.id === "exportConcurrency") setup.concurrency = value;
    else if (input.id === "exportMusic") setup.musicVolume = value;
    else if (input.id === "exportSfx") setup.sfxVolume = value;
    else if (input.dataset.exportLayer) {
      if (input.checked) setup.layers.add(input.dataset.exportLayer);
      else setup.layers.delete(input.dataset.exportLayer);
    }
    const set = (id: string, text: string) => {
      const output = root.querySelector<HTMLOutputElement>(`#${id}Value`);
      if (output) output.value = text;
    };
    set("exportSpeed", `${SPEEDS[setup.speedIndex]}×`);
    set("exportBitrate", `${BITRATES[setup.bitrateIndex]} Mbps`);
    set("exportResolution", `${RESOLUTIONS[setup.resolutionIndex]}p`);
    set("exportConcurrency", String(setup.concurrency));
    set("exportMusic", `${setup.musicVolume}%`);
    set("exportSfx", `${setup.sfxVolume}%`);
    const format = root.querySelector("[data-export-format]");
    if (format) format.textContent = formatDetails(setup);
    root.querySelector("[data-export-warning]")?.toggleAttribute("hidden", setup.concurrency <= 3);
    const text = root.querySelector("[data-export-summary]");
    if (text) text.textContent = summary(setup);
  });
  root.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.classList.contains("recording-setup-backdrop")) return closeDialog();
    const action = target.closest<HTMLElement>("[data-export-action]")?.dataset.exportAction;
    if (action === "close") closeDialog();
    else if (action === "folder") void chooseFolder();
    else if (action === "start") void startExport();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
    } else if (event.key === "Tab") {
      const focusable = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && index === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    }
  });
}

function closeDialog() {
  setup = null;
  renderDialog();
  returnFocus?.focus();
}

async function chooseFolder() {
  if (!setup) return;
  const selected = await open({ directory: true, multiple: false, title: "Choose the video export folder" }).catch(() => null);
  if (typeof selected !== "string" || !setup) return;
  setup.destinationDir = selected;
  renderDialog();
  dialogRoot?.querySelector<HTMLButtonElement>('[data-export-action="folder"]')?.focus();
}

async function startExport() {
  const current = setup;
  if (!current?.destinationDir || running) return;
  const speed = SPEEDS[current.speedIndex], height = RESOLUTIONS[current.resolutionIndex];
  writeStorage(DIRECTORY_KEY, current.destinationDir);
  writeStorage(SETTINGS_KEY, {
    concurrency: current.concurrency,
    speedIndex: current.speedIndex,
    bitrateIndex: current.bitrateIndex,
    resolutionIndex: current.resolutionIndex,
    musicVolume: current.musicVolume,
    sfxVolume: current.sfxVolume,
  });
  setup = null;
  renderDialog();
  running = true;
  cancelling = false;
  for (const replay of current.replays) {
    queued.set(replay.filePath, { replay, speed });
    progress.set(replay.filePath, { sourcePath: replay.filePath, step: "queued", frame: 0, total: 0 });
  }
  renderQueue();
  try {
    await invoke("export_replay_videos", {
      items: current.replays.map((replay) => ({ filePath: replay.filePath, fileName: fileName(replay, speed, height) })),
      options: {
        destinationDir: current.destinationDir,
        concurrency: current.concurrency,
        playbackSpeed: speed,
        bitrateKbps: Math.round(BITRATES[current.bitrateIndex] * 1000),
        resolutionHeight: height,
        layers: LAYERS.map(([name]) => name).filter((name) => current.layers.has(name)),
        musicVolume: current.musicVolume / 100,
        sfxVolume: current.sfxVolume / 100,
      },
    });
  } catch (error) {
    for (const replay of current.replays) {
      const item = progress.get(replay.filePath);
      if (item && !terminal(item)) progress.set(replay.filePath, { ...item, step: "failed", message: String(error) });
    }
  } finally {
    running = false;
    cancelling = false;
    renderQueue();
  }
}

function ensureQueue(): HTMLDivElement {
  if (queueRoot) return queueRoot;
  queueRoot = document.createElement("div");
  queueRoot.id = "recordingQueueRoot";
  queueRoot.innerHTML = `
    <aside class="recording-queue" aria-label="Video exports" hidden>
      <header class="recording-queue-header">
        <span><strong>Video exports</strong><small></small></span>
        <button class="recording-queue-stop" type="button" data-queue-action="stop" hidden>${ICONS.stop}<span></span></button>
      </header>
      <div class="recording-queue-list"></div>
    </aside>`;
  document.body.appendChild(queueRoot);
  queueRoot.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-queue-action]");
    if (!button) return;
    const sourcePath = button.closest<HTMLElement>(".recording-queue-item")?.dataset.sourcePath;
    const action = button.dataset.queueAction;
    if (action === "stop" && running && !cancelling) {
      cancelling = true;
      renderQueue();
      void invoke("cancel_replay_exports");
    } else if (action === "open" && sourcePath) {
      const outputPath = progress.get(sourcePath)?.outputPath;
      if (outputPath) void invoke("open_recording_output_directory", { outputPath }).catch((error) => window.alert(String(error)));
    } else if (action === "clear" && sourcePath) {
      progress.delete(sourcePath);
      queued.delete(sourcePath);
      renderQueue();
    }
  });
  return queueRoot;
}

const STEP_LABELS: Record<ExportProgress["step"], string> = {
  queued: "Queued",
  preparing: "Preparing",
  exporting: "Exporting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Rows are patched in place so the panel does not flash on each progress event.
function renderQueue() {
  const root = ensureQueue();
  const panel = root.querySelector<HTMLElement>(".recording-queue")!;
  const list = root.querySelector<HTMLElement>(".recording-queue-list")!;
  const items = [...progress.values()].filter((item) => queued.has(item.sourcePath));
  panel.hidden = items.length === 0;
  const active = items.filter((item) => !terminal(item)).length;
  root.querySelector(".recording-queue-header small")!.textContent = active ? `${active} active` : `${items.length} finished`;
  const stop = root.querySelector<HTMLButtonElement>('[data-queue-action="stop"]')!;
  stop.hidden = !running;
  stop.disabled = cancelling;
  stop.querySelector("span")!.textContent = cancelling ? "Stopping..." : "Stop";
  list.classList.toggle("is-scrollable", items.length > 5);
  items.forEach((item, index) => {
    const { replay, speed } = queued.get(item.sourcePath)!;
    let row = rows.get(item.sourcePath);
    if (!row) {
      row = document.createElement("div");
      row.dataset.sourcePath = item.sourcePath;
      row.innerHTML = `
        <span class="recording-queue-state" aria-hidden="true"></span>
        <span class="recording-queue-copy">
          <strong></strong>
          <small><b></b><span></span></small>
          <span class="recording-queue-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></span>
        </span>
        <span class="recording-queue-actions">
          <button type="button" data-queue-action="open" title="Show in folder" aria-label="Show in folder" hidden>${ICONS.folder}</button>
          <button type="button" data-queue-action="clear" title="Clear" aria-label="Clear" hidden>${ICONS.close}</button>
        </span>`;
      rows.set(item.sourcePath, row);
    }
    const percent = item.step === "completed" ? 100 : item.total ? (100 * item.frame) / item.total : 0;
    // Video frames are 1/30 s apart and each advances the game by `speed` frames.
    const detail = item.step === "exporting" && item.total
      ? `${clock((item.frame * speed) / 30)} / ${clock((item.total * speed) / 30)}`
      : item.message || "";
    row.className = `recording-queue-item is-${item.step === "exporting" ? "recording" : item.step}`;
    row.querySelector("strong")!.textContent = title(replay);
    row.querySelector("small b")!.textContent = STEP_LABELS[item.step];
    const detailNode = row.querySelector<HTMLElement>("small span")!;
    detailNode.textContent = detail;
    detailNode.title = detail;
    const track = row.querySelector<HTMLElement>(".recording-queue-track")!;
    track.setAttribute("aria-valuenow", String(Math.round(percent)));
    track.setAttribute("aria-label", `${STEP_LABELS[item.step]} ${Math.round(percent)} percent`);
    track.querySelector("i")!.style.width = `${percent.toFixed(1)}%`;
    row.querySelector<HTMLElement>('[data-queue-action="open"]')!.hidden = !(item.step === "completed" && item.outputPath);
    row.querySelector<HTMLElement>('[data-queue-action="clear"]')!.hidden = !terminal(item);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  });
  for (const [sourcePath, row] of rows)
    if (!progress.has(sourcePath)) {
      row.remove();
      rows.delete(sourcePath);
    }
}

if (!exampleMode)
  void listen<ExportProgress>("replay-export-progress", (event) => {
    const previous = progress.get(event.payload.sourcePath);
    if (!previous) return;
    progress.set(event.payload.sourcePath, {
      ...previous,
      ...event.payload,
      frame: event.payload.step === "exporting" ? event.payload.frame : previous.frame,
      total: event.payload.total || previous.total,
    });
    renderQueue();
  }).catch((error) => console.error("Video export progress listener failed", error));
