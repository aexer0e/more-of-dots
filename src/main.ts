import { invoke, exampleMode } from "./platform";
import { exportBusy, openExportSetup } from "./replays/export";
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LeaderboardApp } from "./leaderboard/App";
import { cached, leaderboardRankIndex, retrieve, type Snapshot } from "./leaderboard/client";
import MapEditorApp from "./map-editor/App";
import "./styles.css";
import "./replays/styles.css";
import { MATCH_TYPES, REPLAY_VARIANTS, matchesReplay, matchupTitle, replaySuggestions, toggleMatchType, type PlayerSuggestion, type ReplayVariant, type ReplayFilterRecord, type ReplayFilters, type ReplaySuggestion } from "./replays/filters";
import { VirtualGrid } from "./replays/virtual-grid";

declare global {
  interface Window {
    __mapEditorConfirmLeave?: () => Promise<boolean>;
  }
}

type ReplayBrowserPlayer = {
  name: string;
  teamIndex: number;
  winner: boolean;
};

type ReplayBrowserItem = {
  fileName: string;
  filePath: string;
  version?: string | null;
  mode?: string | null;
  teamSize?: number;
  players: ReplayBrowserPlayer[];
  draw: boolean;
  length: string;
  durationSeconds: number;
  thumbnailDataUrl?: string | null;
  thumbnailKey?: string | null;
  modified: number;
  scoreDelta?: number | null;
  eventLabel?: string | null;
  mapKey?: string | null;
  mapLabel?: string | null;
};

type ReplayThumbnailPath = {
  thumbnailKey: string;
  filePath: string;
  dataUrl?: string;
};

type ReplayBrowserPayload = {
  replays: ReplayBrowserItem[];
};

type ReplayIndexProgress = {
  phase: "hash" | "parse";
  done: number;
  total: number;
};

type BrowserFilterState = ReplayFilters;
type ThumbnailVariant = "small" | "full";
type BrowserPage = "replays" | "leaderboard" | "mapEditor";
type AppUpdateStatus = "idle" | "checking" | "available" | "downloading" | "installing" | "current" | "error";
type AppUpdateSnooze = {
  version: string;
  until: number;
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
const DURATION_SLIDER_STEPS = 1000;
const DURATION_SLIDER_MIDPOINT_SECONDS = 5 * 60;
const SUGGESTION_LIMIT = 8;
const UPDATE_CHECK_DELAY_MS = 2500;
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;
const UPDATE_SNOOZE_STORAGE_KEY = "moreOfDotsUpdateSnooze";
const BROWSER_GRID_CAPPED_STORAGE_KEY = "wodReplayBrowserGridCapped";
const BROWSER_GRID_CARD_SIZE_STORAGE_KEY = "wodReplayBrowserGridCardSize";
const BROWSER_GRID_CARD_SIZE_MIN = 120;
const BROWSER_GRID_CARD_SIZE_MAX = 480;
const BROWSER_GRID_CARD_SIZE_DEFAULT = 300;
const BROWSER_GRID_CARD_SIZE_STEP = 10;
const BROWSER_REPLAY_PLAYBACK_ENABLED = true;
// Cards narrower than this many device pixels use the downscaled thumbnails.
const SMALL_THUMBNAIL_WIDTH = 480;
const THUMBNAIL_BATCH_SIZE = 32;
const FALLBACK_THUMBNAIL = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#9fbd42"/>
  <path d="M0 282c84-42 146-7 218-45 92-48 138-164 251-115 72 31 117 2 171-30v268H0z" fill="#2f7f35"/>
  <path d="M38 50c58-38 107 28 163 8 83-29 129-77 213-38 58 27 121-10 226 16v66c-102-38-154 10-223-14-90-32-133 61-222 40-80-19-120-18-157 21z" fill="#2f9fe9"/>
  <path d="M0 305c89-42 134 11 217-26 84-38 125-135 219-101 75 27 125 8 204-35v39c-82 37-133 60-207 33-86-31-132 63-216 100-83 37-129-17-217 24z" fill="#e9e3b4"/>
  <path d="M46 254c75-63 147-72 229-48 105 30 194-9 303-83" fill="none" stroke="#1c241f" stroke-width="9" stroke-linecap="round" opacity=".42"/>
</svg>`)}`;
let browserReplays: ReplayBrowserItem[] = [];
let browserLoading = false;
let browserUploading = false;
let browserUploadLabel = "Upload";
let browserSelectedReplayPaths = new Set<string>();
let browserSelectionAnchorPath: string | null = null;
let browserDeleteCandidates: ReplayBrowserItem[] = [];
let browserDeleteInFlight = false;
let browserDeleteError = "";
let browserBulkDownloadInFlight = false;
let browserError = "";
let browserSearch = "";
let browserHideUnmatched = true;
let browserMapSources = new Set<ReplayVariant>(REPLAY_VARIANTS.map(variant => variant.value));
let browserSelectedMap: { key: string; label: string } | null = null;
let browserSelectedPlayer: string | null = null;
let browserSelectedTypes = new Set(MATCH_TYPES);
let browserDurationBounds = { min: 0, max: 0 };
let browserDurationRange = { min: 0, max: 0 };
let browserSuggestionOpen = false;
let browserSelectedSuggestion = -1;
let browserSuggestionItems: ReplaySuggestion[] = [];
let browserFilterRecords: ReplayFilterRecord[] = [];
let pendingBrowserSearchFrame = 0;
// Only cards near the viewport exist; the grid shows `browserGridItems`
// (indexes into `browserReplays`), and `browserMatches` marks filter matches.
let browserGrid: VirtualGrid | null = null;
let browserGridItems: number[] = [];
let browserMatches = new Uint8Array(0);
let browserFilterSignature = "";
let browserThumbnailVariant: ThumbnailVariant = "full";
let browserThumbnailFlushTimer = 0;
let browserThumbnailPrefetchTimer = 0;
// Object URLs by `${variant}:${thumbnailKey}`.
const browserThumbnailUrls = new Map<string, string>();
const browserThumbnailPending = new Set<string>();
const browserThumbnailInFlight = new Set<string>();
let browserIndexProgress: ReplayIndexProgress | null = null;
let browserOpeningPaths = new Set<string>();
let browserGridCapped = loadBrowserGridCapped();
let browserGridCardSize = loadBrowserGridCardSize();
let browserReplaySignature = "";
const LATEST_LEADERBOARD_PATH = "/v1/leaderboard";
let browserLeaderboardRanks = leaderboardRankIndex(cached<Snapshot>(LATEST_LEADERBOARD_PATH)?.data);
let browserLeaderboardRankSignature = [...browserLeaderboardRanks].map(([name, rank]) => `${name}:${rank}`).join("|");
let browserRelativeTimeTimer = 0;
let browserDocumentEventsBound = false;
let browserPage: BrowserPage = "replays";
let mapEditorRoot: Root | null = null;
let appVersion = "";
let appUpdateStatus: AppUpdateStatus = "idle";
let appUpdateManual = false;
let appUpdateVersion = "";
let appUpdateMessage = "";
let appUpdateDownloaded = 0;
let appUpdateTotal: number | null = null;
let pendingAppUpdate: Awaited<ReturnType<typeof check>> = null;
let appUpdateRoot: HTMLDivElement | null = null;
let appUpdateCurrentTimer = 0;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function mediaSrc(pathOrUrl: string | null | undefined): string {
  if (!pathOrUrl) return "";
  return /^(?:data:|blob:|https?:|\/__examples\/)/i.test(pathOrUrl) ? pathOrUrl : convertFileSrc(pathOrUrl);
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

function appVersionLabel(): string {
  return appVersion ? `v${appVersion}` : "Version";
}

function readAppUpdateSnooze(): AppUpdateSnooze | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(UPDATE_SNOOZE_STORAGE_KEY) || "null") as Partial<AppUpdateSnooze> | null;
    if (!value || typeof value.version !== "string" || !Number.isFinite(value.until)) return null;
    return { version: value.version, until: Number(value.until) };
  } catch {
    return null;
  }
}

function isAppUpdateSnoozed(version: string): boolean {
  const snooze = readAppUpdateSnooze();
  return Boolean(snooze && snooze.version === version && snooze.until > Date.now());
}

function snoozeAppUpdate(version: string) {
  try {
    window.localStorage.setItem(
      UPDATE_SNOOZE_STORAGE_KEY,
      JSON.stringify({ version, until: Date.now() + UPDATE_SNOOZE_MS } satisfies AppUpdateSnooze),
    );
  } catch {
    // A failed preference write should not prevent dismissing the prompt.
  }
}

function ensureAppUpdateRoot(): HTMLDivElement {
  if (appUpdateRoot) return appUpdateRoot;
  appUpdateRoot = document.createElement("div");
  appUpdateRoot.id = "appUpdateRoot";
  appUpdateRoot.innerHTML = `
    <aside class="app-update-toast" role="status" aria-live="polite" aria-atomic="true" hidden>
      <span class="app-update-icon" aria-hidden="true"></span>
      <span class="app-update-copy">
        <strong></strong>
        <small></small>
        <div class="app-update-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" hidden><span></span></div>
      </span>
      <span class="app-update-actions">
        <button class="app-update-primary" type="button" data-update-action="install" hidden>Update</button>
        <button type="button" data-update-action="later" hidden>Later</button>
        <button class="app-update-primary" type="button" data-update-action="retry" hidden>Retry</button>
        <button type="button" data-update-action="close" hidden>Close</button>
      </span>
    </aside>
  `;
  document.body.appendChild(appUpdateRoot);
  appUpdateRoot.addEventListener("click", (event) => {
    const action = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-update-action]")?.dataset.updateAction
      : undefined;
    if (action === "install") void installAppUpdate();
    else if (action === "later") dismissAppUpdate();
    else if (action === "retry") void checkForAppUpdate(true);
    else if (action === "close") closeAppUpdateUi();
  });
  return appUpdateRoot;
}

function updateAppVersionControls() {
  document.querySelectorAll<HTMLButtonElement>("[data-app-version]").forEach((button) => {
    button.textContent = appVersionLabel();
    button.title = appUpdateStatus === "checking" ? "Checking for updates" : `More of Dots ${appVersionLabel()} - check for updates`;
    button.setAttribute("aria-label", button.title);
    button.disabled = appUpdateStatus === "checking" || appUpdateStatus === "downloading" || appUpdateStatus === "installing";
    button.classList.toggle("is-checking", appUpdateStatus === "checking");
  });
}

function appUpdateProgressPercent(): number | null {
  if (!appUpdateTotal || appUpdateTotal <= 0) return null;
  return clamp((appUpdateDownloaded / appUpdateTotal) * 100, 0, 100);
}

// Patches the toast in place so download progress does not rebuild the subtree,
// which used to restart the enter animation on every reported chunk.
function renderAppUpdateUi() {
  updateAppVersionControls();
  const root = ensureAppUpdateRoot();
  const toast = root.querySelector<HTMLElement>(".app-update-toast");
  if (!toast) return;

  const visible =
    appUpdateStatus === "available" ||
    appUpdateStatus === "downloading" ||
    appUpdateStatus === "installing" ||
    appUpdateStatus === "error" ||
    appUpdateStatus === "current" ||
    (appUpdateStatus === "checking" && appUpdateManual);
  toast.hidden = !visible;
  if (!visible) return;

  const progress = appUpdateProgressPercent();
  const busy = appUpdateStatus === "downloading" || appUpdateStatus === "installing";
  const title =
    appUpdateStatus === "available"
      ? `Version ${appUpdateVersion} is ready`
      : appUpdateStatus === "checking"
        ? "Checking for updates"
        : appUpdateStatus === "downloading"
          ? "Downloading update"
          : appUpdateStatus === "installing"
            ? "Installing update"
            : appUpdateStatus === "current"
              ? "You're up to date"
              : "Update failed";
  const detail =
    appUpdateMessage ||
    (appUpdateStatus === "available"
      ? "Install when you're ready. More of Dots will restart to finish."
      : appUpdateStatus === "checking"
        ? "Looking for the latest signed release."
        : appUpdateStatus === "downloading"
          ? progress === null
            ? "Downloading the signed installer."
            : `${Math.round(progress)}% downloaded`
          : appUpdateStatus === "installing"
            ? "The app will restart automatically."
            : appUpdateStatus === "current"
              ? `${appVersionLabel()} is the latest version.`
              : "The app is still usable. You can try again.");

  const toastClass = `app-update-toast is-${appUpdateStatus}`;
  if (toast.className !== toastClass) toast.className = toastClass;
  setAttribute(toast, "role", appUpdateStatus === "error" ? "alert" : "status");
  setText(toast.querySelector(".app-update-copy strong"), title);
  setText(toast.querySelector(".app-update-copy small"), detail);

  const bar = toast.querySelector<HTMLElement>(".app-update-progress");
  if (bar) {
    bar.hidden = !busy;
    bar.classList.toggle("is-indeterminate", progress === null);
    if (progress === null) bar.removeAttribute("aria-valuenow");
    else setAttribute(bar, "aria-valuenow", String(Math.round(progress)));
    const fill = bar.querySelector<HTMLElement>("span");
    const width = progress === null ? "" : `${progress}%`;
    if (fill && fill.style.width !== width) fill.style.width = width;
  }

  const shown: Record<string, boolean> = {
    install: appUpdateStatus === "available",
    later: appUpdateStatus === "available",
    retry: appUpdateStatus === "error",
    close: appUpdateStatus === "error" || appUpdateStatus === "current",
  };
  toast.querySelectorAll<HTMLButtonElement>("[data-update-action]").forEach((button) => {
    button.hidden = !shown[button.dataset.updateAction ?? ""];
  });
  const actions = toast.querySelector<HTMLElement>(".app-update-actions");
  if (actions) actions.hidden = !Object.values(shown).some(Boolean);
}

function closeAppUpdateUi() {
  window.clearTimeout(appUpdateCurrentTimer);
  appUpdateStatus = "idle";
  appUpdateManual = false;
  appUpdateMessage = "";
  renderAppUpdateUi();
}

function dismissAppUpdate() {
  if (appUpdateVersion) snoozeAppUpdate(appUpdateVersion);
  pendingAppUpdate = null;
  closeAppUpdateUi();
}

async function checkForAppUpdate(manual = false) {
  if (appUpdateStatus === "checking" || appUpdateStatus === "downloading" || appUpdateStatus === "installing") return;
  window.clearTimeout(appUpdateCurrentTimer);
  appUpdateManual = manual;
  appUpdateStatus = "checking";
  appUpdateMessage = "";
  renderAppUpdateUi();
  try {
    const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    if (!update) {
      pendingAppUpdate = null;
      appUpdateStatus = manual ? "current" : "idle";
      renderAppUpdateUi();
      if (manual) appUpdateCurrentTimer = window.setTimeout(closeAppUpdateUi, 4000);
      return;
    }
    if (!manual && isAppUpdateSnoozed(update.version)) {
      pendingAppUpdate = null;
      appUpdateStatus = "idle";
      renderAppUpdateUi();
      return;
    }
    pendingAppUpdate = update;
    appUpdateVersion = update.version;
    appUpdateStatus = "available";
    renderAppUpdateUi();
  } catch (error) {
    pendingAppUpdate = null;
    appUpdateStatus = manual ? "error" : "idle";
    appUpdateMessage = manual ? (error instanceof Error ? error.message : String(error || "Could not check for updates.")) : "";
    renderAppUpdateUi();
  }
}

async function installAppUpdate() {
  const update = pendingAppUpdate;
  if (!update || appUpdateStatus !== "available") return;
  appUpdateStatus = "downloading";
  appUpdateMessage = "";
  appUpdateDownloaded = 0;
  appUpdateTotal = null;
  renderAppUpdateUi();
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        appUpdateTotal = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        appUpdateDownloaded += event.data.chunkLength;
      } else if (event.event === "Finished") {
        appUpdateStatus = "installing";
      }
      renderAppUpdateUi();
    });
    appUpdateStatus = "installing";
    renderAppUpdateUi();
    await relaunch();
  } catch (error) {
    appUpdateStatus = "error";
    appUpdateMessage = error instanceof Error ? error.message : String(error || "Could not install the update.");
    renderAppUpdateUi();
  }
}

async function initializeAppUpdater() {
  try {
    appVersion = await getVersion();
  } catch {
    appVersion = "";
  }
  renderAppUpdateUi();
  window.setTimeout(() => void checkForAppUpdate(false), UPDATE_CHECK_DELAY_MS);
}

function formatReplayAge(modifiedSeconds: unknown, now = Date.now()): string {
  const modified = Number(modifiedSeconds);
  const ageMinutes = Math.max(1, Math.floor((now - modified * 1000) / 60_000));
  if (!Number.isFinite(modified) || modified <= 0) return "1m ago";
  if (ageMinutes < 60) return `${ageMinutes}m ago`;

  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h ago`;

  const ageDays = Math.floor(ageHours / 24);
  if (ageDays <= 7) return `${ageDays}d ago`;
  return `${Math.floor(ageDays / 7)}w ago`;
}

const replayTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const replayDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

function isSameLocalDate(first: Date, second: Date): boolean {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function formatReplayDate(modifiedSeconds: unknown, now = Date.now()): string {
  const modified = Number(modifiedSeconds);
  if (!Number.isFinite(modified) || modified <= 0) return "";

  const modifiedDate = new Date(modified * 1000);
  const nowDate = new Date(now);
  const timeLabel = replayTimeFormatter.format(modifiedDate);
  if (isSameLocalDate(modifiedDate, nowDate)) return timeLabel;

  const yesterday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1);
  if (isSameLocalDate(modifiedDate, yesterday)) return `Yesterday at ${timeLabel}`;

  return `${replayDateFormatter.format(modifiedDate)} ${timeLabel}`;
}

function browserGridCardScale(): number {
  return browserGridCapped ? 1 : clamp(browserGridCardSize / BROWSER_GRID_CARD_SIZE_DEFAULT, 0.4, 1.6);
}

function loadBrowserGridCapped(): boolean {
  try {
    const rawValue = window.localStorage.getItem(BROWSER_GRID_CAPPED_STORAGE_KEY);
    return rawValue === null ? true : rawValue !== "false";
  } catch {
    return true;
  }
}

function saveBrowserGridCapped(value: boolean) {
  try {
    window.localStorage.setItem(BROWSER_GRID_CAPPED_STORAGE_KEY, String(value));
  } catch {
    // The browser can still function if persistence is unavailable.
  }
}

function loadBrowserGridCardSize(): number {
  try {
    const value = Number(window.localStorage.getItem(BROWSER_GRID_CARD_SIZE_STORAGE_KEY));
    if (!Number.isFinite(value) || value <= 0) return BROWSER_GRID_CARD_SIZE_DEFAULT;
    return clamp(value, BROWSER_GRID_CARD_SIZE_MIN, BROWSER_GRID_CARD_SIZE_MAX);
  } catch {
    return BROWSER_GRID_CARD_SIZE_DEFAULT;
  }
}

function saveBrowserGridCardSize(value: number) {
  try {
    window.localStorage.setItem(BROWSER_GRID_CARD_SIZE_STORAGE_KEY, String(value));
  } catch {
    // The browser can still function if persistence is unavailable.
  }
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

// The replay's own mode names the format; free-for-all lobbies and older
// replays only reveal it by their number of sides.
function replayMatchType(replay: ReplayBrowserItem): string {
  switch (replay.mode) {
    case "1v1": return "1v1";
    case "2v2": return "2v2";
    case "v3": return "3P";
    case "v4": return "4P";
    case "experiment": return "Experiment";
    case "avalanche": return "Avalanche";
  }
  const sides = new Set(replay.players.map((player) => player.teamIndex)).size;
  if (sides === 2) return (replay.teamSize ?? 1) > 1 ? "2v2" : "1v1";
  return sides >= 4 ? "4P" : "3P";
}

function filterSummary(name: string, selected: string[], total: number): string {
  if (selected.length === total) return `${name}: All`;
  if (!selected.length) return `${name}: None`;
  return selected.length <= 2 ? `${name}: ${selected.join(", ")}` : `${name}: ${selected.length} of ${total}`;
}

function replayVariant(replay: ReplayBrowserItem): ReplayVariant {
  return replay.eventLabel === "Custom" ? "custom" : "vanilla";
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
    sources: new Set(browserMapSources),
    mapKey: browserSelectedMap?.key ?? null,
    player: browserSelectedPlayer ? normalizeSearchText(browserSelectedPlayer) : null,
  };
}

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function replayFilterRecord(replay: ReplayBrowserItem): ReplayFilterRecord {
  return {
    names: replay.players.map(player => player.name),
    normalizedNames: replay.players.map(player => normalizeSearchText(player.name)),
    matchType: replayMatchType(replay), durationSeconds: Number(replay.durationSeconds) || 0,
    modified: Number(replay.modified) || 0, teams: replay.players.map(player => player.teamIndex),
    winnerTeam: replay.players.find(player => player.winner)?.teamIndex ?? -1,
    isDraw: replay.draw, mapKey: replay.mapKey ?? null, mapLabel: replay.mapLabel ?? "Unknown map",
    mapSource: replay.eventLabel === "Custom" ? "custom" : "vanilla",
    variant: replayVariant(replay),
    thumbnailKey: replay.thumbnailKey, thumbnailDataUrl: replay.thumbnailDataUrl,
  };
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
  const shouldOpen = open && !!searchInput && !searchInput.disabled;

  browserSuggestionOpen = shouldOpen;
  if (shouldOpen) {
    const overflow = document.querySelector<HTMLDetailsElement>("#replayFilterOverflow");
    if (overflow) overflow.open = false;
  }
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

function suggestionDetailText(item: PlayerSuggestion): string {
  if (!item.opponents.length) return "No opponents yet";
  const opponents = item.opponents.slice(0, 3);
  const remaining = item.opponents.length - opponents.length;
  return `vs ${opponents.join(", ")}${remaining ? `, and ${remaining} more` : ""}`;
}

function renderBrowserSuggestions(query: string) {
  const list = document.querySelector<HTMLElement>("#playerSuggestionList");
  if (!list) return;
  const fragment = document.createDocumentFragment();
  for (const kind of ["player", "map"] as const) {
    const items = browserSuggestionItems.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === kind);
    if (!items.length) continue;
    const group = document.createElement("div");
    group.className = "suggestion-group";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", kind === "player" ? "Players" : "Maps");
    const heading = document.createElement("div");
    heading.className = "suggestion-heading";
    heading.setAttribute("aria-hidden", "true");
    heading.textContent = `${kind === "player" ? "Players" : "Maps"} (${items.length})`;
    group.append(heading);
    for (const { item, index } of items) {
      const active = item.kind === "map" ? browserSelectedMap?.key === item.key
        : normalizeSearchText(browserSelectedPlayer ?? "") === item.key;
      const option = document.createElement("button");
      option.id = `player-suggestion-${index}`;
      option.type = "button";
      option.tabIndex = -1;
      option.className = `player-suggestion ${item.kind}-suggestion`;
      option.dataset.index = String(index);
      option.setAttribute("role", "option");
      option.title = `${active ? "Clear" : "Filter by"} ${item.kind}: ${item.name}`;
      const icon = document.createElement("span");
      icon.className = "suggestion-icon";
      icon.setAttribute("aria-hidden", "true");
      if (item.kind === "map") {
        const thumbnail = document.createElement("img");
        thumbnail.alt = "";
        thumbnail.decoding = "async";
        // The icon is 30px, so the downscaled image is always enough.
        thumbnail.src = replayThumbnailSource(item.thumbnailKey, item.thumbnailDataUrl, "small");
        if (item.thumbnailKey) {
          thumbnail.dataset.thumbnailKey = item.thumbnailKey;
          thumbnail.dataset.thumbnailVariant = "small";
        }
        icon.append(thumbnail);
      } else {
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg>';
      }
      const body = document.createElement("span");
      body.className = "suggestion-body";
      const primary = document.createElement("span");
      primary.className = "suggestion-primary";
      const name = document.createElement("span");
      name.className = "suggestion-name";
      renderHighlightedText(name, item.name, query);
      const meta = document.createElement("span");
      meta.className = "suggestion-meta";
      meta.textContent = item.kind === "player"
        ? `${pluralize(item.replayCount, "replay")} · ${item.winCount}W · ${item.lossCount}L · ${item.drawCount}D`
        : pluralize(item.replayCount, "replay");
      if (item.kind === "player") meta.setAttribute("aria-label", `${item.replayCount} replays, ${item.winCount} wins, ${item.lossCount} losses, ${item.drawCount} draws`);
      const detail = document.createElement("span");
      detail.className = "suggestion-detail";
      detail.textContent = item.kind === "player" ? suggestionDetailText(item) : item.source === "custom" ? "Custom" : "Vanilla";
      detail.title = detail.textContent;
      primary.append(name, meta);
      body.append(primary, detail);
      option.append(icon, body);
      if (active) {
        const clear = document.createElement("span");
        clear.className = "suggestion-clear";
        clear.textContent = "✓ Clear";
        option.append(clear);
      }
      group.append(option);
    }
    fragment.append(group);
  }
  if (!browserSuggestionItems.length) {
    const empty = document.createElement("div");
    empty.className = "suggestion-empty";
    empty.setAttribute("role", "status");
    empty.textContent = "No players or maps match these filters.";
    fragment.append(empty);
  }
  list.replaceChildren(fragment);
  updateActiveBrowserSuggestion();
}

function refreshBrowserSuggestions(open = document.activeElement === document.querySelector<HTMLInputElement>("#playerSearch")) {
  // Suggestions are only seen while the panel is open; they are rebuilt when it opens.
  if (!open) {
    setBrowserSuggestionsOpen(false);
    return;
  }
  const filterState = currentBrowserFilterState();
  browserSuggestionItems = replaySuggestions(browserFilterRecords, filterState, SUGGESTION_LIMIT);
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

  const options = suggestionList.querySelectorAll<HTMLElement>("[role=option]");
  Array.from(options).forEach((option, index) => {
    if (!(option instanceof HTMLElement)) return;
    const selected = index === browserSelectedSuggestion;
    option.classList.toggle("is-active", selected);
    option.setAttribute("aria-selected", String(selected));
  });

  if (browserSelectedSuggestion < 0) {
    searchInput.removeAttribute("aria-activedescendant");
    return;
  }

  const activeOption = options[browserSelectedSuggestion];
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

  if (item.kind === "map") toggleBrowserMap(item.key, item.name);
  else toggleBrowserPlayer(item.name);
  searchInput.focus();
  closeBrowserSuggestions();
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
  // Let the engine resolve maps and report failures. Library metadata, including
  // the retired cached `playable` flag, cannot establish playback compatibility.
  const isOpening = browserOpeningPaths.has(replay.filePath);
  return `
    <button class="replay-play-button" type="button" data-replay-index="${replayIndex}" ${isOpening ? "disabled" : ""} aria-label="Play ${escapeHtml(label)}">
      <span class="play-glyph"></span>
      <span>${isOpening ? "Opening..." : "Play"}</span>
    </button>
  `;
}


function commitBrowserFilters() {
  browserSearch = "";
  const input = document.querySelector<HTMLInputElement>("#playerSearch");
  if (input) input.value = "";
  browserSelectedSuggestion = -1;
  updateBrowserClearButton();
  updateBrowserFilterUi();
  refreshBrowserSuggestions(false);
  scheduleBrowserSearch();
}

function toggleBrowserMap(key: string, label: string) {
  browserSelectedMap = browserSelectedMap?.key === key ? null : { key, label };
  if (browserSelectedMap) {
    const record = browserFilterRecords.find(record => record.mapKey === key);
    if (record) browserMapSources.add(record.variant);
  }
  commitBrowserFilters();
}

function toggleBrowserPlayer(name: string) {
  browserSelectedPlayer = normalizeSearchText(browserSelectedPlayer ?? "") === normalizeSearchText(name) ? null : name;
  commitBrowserFilters();
}

function updateBrowserFilterUi() {
  const chipRow = document.querySelector<HTMLElement>("#activeReplayFilters");
  const chips: string[] = [];
  const chip = (kind: string, label: string) => `<button type="button" class="active-filter-chip" data-clear-filter="${kind}" title="${escapeHtml(label)}" aria-label="Clear ${escapeHtml(label)} filter"><span class="active-filter-name">${escapeHtml(label)}</span><span aria-hidden="true">×</span></button>`;
  if (browserSelectedMap) chips.push(chip("map", `Map: ${browserSelectedMap.label}`));
  if (browserSelectedPlayer) chips.push(chip("player", `Player: ${browserSelectedPlayer}`));
  if (chipRow) {
    const markup = chips.length ? `<div class="replay-filter-inline">${chips.join("")}</div><details id="replayFilterOverflow" class="replay-filter-overflow"><summary aria-label="Show ${chips.length} active map and player ${chips.length === 1 ? "filter" : "filters"}">${chips.length} ${chips.length === 1 ? "filter" : "filters"}<span aria-hidden="true">▾</span></summary><div class="replay-filter-popover">${chips.join("")}</div></details>` : "";
    if (chipRow.innerHTML !== markup) chipRow.innerHTML = markup;
    chipRow.hidden = !chips.length;
  }
  document.querySelectorAll<HTMLInputElement>(".type-filter").forEach(input => { input.checked = browserSelectedTypes.has(input.value); });
  document.querySelectorAll<HTMLInputElement>(".source-filter").forEach(input => { input.checked = browserMapSources.has(input.value as ReplayVariant); });
  const modeCounts = new Map<string, number>(), variantCounts = new Map<string, number>();
  for (const record of browserFilterRecords) {
    modeCounts.set(record.matchType, (modeCounts.get(record.matchType) ?? 0) + 1);
    variantCounts.set(record.variant, (variantCounts.get(record.variant) ?? 0) + 1);
  }
  document.querySelectorAll<HTMLElement>("[data-mode-count]").forEach(element => setText(element, String(modeCounts.get(element.dataset.modeCount ?? "") ?? 0)));
  document.querySelectorAll<HTMLElement>("[data-variant-count]").forEach(element => setText(element, String(variantCounts.get(element.dataset.variantCount ?? "") ?? 0)));
  setText(document.querySelector("#modeFilterSummary"), filterSummary("Mode", MATCH_TYPES.filter(type => browserSelectedTypes.has(type)), MATCH_TYPES.length));
  setText(document.querySelector("#variantFilterSummary"), filterSummary("Map", REPLAY_VARIANTS.filter(variant => browserMapSources.has(variant.value)).map(variant => variant.label), REPLAY_VARIANTS.length));
}

function updateCardFilterButtons(card: HTMLElement) {
  const selectedPlayer = normalizeSearchText(browserSelectedPlayer ?? "");
  card.querySelectorAll<HTMLButtonElement>("[data-filter-kind]").forEach(button => {
    const kind = button.dataset.filterKind;
    const value = button.dataset.filterValue ?? "";
    const active = kind === "map" ? browserSelectedMap?.key === value
      : kind === "mode" ? browserSelectedTypes.size === 1 && browserSelectedTypes.has(value)
      : selectedPlayer === normalizeSearchText(value);
    setAttribute(button, "aria-pressed", String(active));
    setAttribute(button, "title", `${active ? "Clear" : "Filter by"} ${kind}: ${button.dataset.filterLabel ?? value}`);
  });
}

function clearReplayFilter(kind: string) {
  if (kind === "map" || kind === "all") browserSelectedMap = null;
  if (kind === "player" || kind === "all") browserSelectedPlayer = null;
  if (kind === "mode" || kind === "all") browserSelectedTypes = new Set(MATCH_TYPES);
  if (kind === "source" || kind === "all") browserMapSources = new Set(REPLAY_VARIANTS.map(variant => variant.value));
  if (kind === "duration" || kind === "all") {
    const min = document.querySelector<HTMLInputElement>("#durationMin");
    const max = document.querySelector<HTMLInputElement>("#durationMax");
    if (min) min.value = "0";
    if (max) max.value = String(DURATION_SLIDER_STEPS);
    min?.dispatchEvent(new Event("input"));
  }
  commitBrowserFilters();
}

function replayDownloadFileName(replay: ReplayBrowserItem): string {
  // Named like the game's own replays: "a _ b-vs-c _ d".
  const playerNames = matchupTitle(replay.players.map((player) => ({
    ...player,
    name: player.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim() || "player",
  })), "-vs-", " _ ");
  return `${playerNames || "replay"}.rep`;
}

function setText(element: Element | null | undefined, value: string) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setAttribute(element: Element | null | undefined, name: string, value: string) {
  if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function renderReplaySelectButton(replay: ReplayBrowserItem, label: string, replayIndex: number): string {
  const isSelected = browserSelectedReplayPaths.has(replay.filePath);
  return `
    <button
      class="replay-select-button ${isSelected ? "is-selected" : ""}"
      type="button"
      data-replay-select-index="${replayIndex}"
      aria-pressed="${isSelected}"
      aria-label="${escapeHtml(`${isSelected ? "Deselect" : "Select"} replay: ${label}`)}"
      title="${isSelected ? "Deselect replay" : "Select replay"}"
      ${browserDeleteInFlight || browserBulkDownloadInFlight ? "disabled" : ""}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8.5 12 2.3 2.3 4.9-5" />
      </svg>
      <span>${isSelected ? "Selected" : "Select"}</span>
    </button>
  `;
}

function renderReplayCard(replay: ReplayBrowserItem, replayIndex: number): string {
  const winners = replay.players.filter((player) => player.winner);
  const matchType = replayMatchType(replay);
  const scoreDelta = replayScoreDelta(replay);
  const scoreDeltaLabel =
    scoreDelta === null
      ? ""
      : `<div class="replay-label elo-delta ${scoreDelta > 0 ? "is-gain" : "is-loss"}">${escapeHtml(formatScoreDelta(scoreDelta))}</div>`;
  const mapLabel = replay.mapLabel ?? "Unknown map";
  const mapButton = replay.mapKey
    ? `<button type="button" class="replay-label replay-filter-label" data-filter-kind="map" data-filter-value="${escapeHtml(replay.mapKey)}" data-filter-label="${escapeHtml(mapLabel)}" aria-label="Filter by map ${escapeHtml(mapLabel)}" aria-pressed="${browserSelectedMap?.key === replay.mapKey}"><span>${escapeHtml(mapLabel)}</span></button>`
    : `<span class="replay-label unknown-map">Unknown map</span>`;
  // Each team occupies one side, with an independent button for every player.
  const teams: { player: ReplayBrowserPlayer; index: number }[][] = [];
  replay.players.forEach((player, index) => {
    const team = teams.find((members) => members[0].player.teamIndex === player.teamIndex);
    if (team) team.push({ player, index });
    else teams.push([{ player, index }]);
  });
  const hasTeams = teams.some((team) => team.length > 1);
  const renderPlayer = ({ player, index }: { player: ReplayBrowserPlayer; index: number }) => {
    const rank = browserLeaderboardRanks.get(player.name.trim().toLocaleLowerCase());
    const rankCaption = rank == null
      ? ""
      : `<span class="player-rank" aria-label="Elo rank ${rank}" title="Current Elo rank #${rank}">Rank <b>${rank}</b></span>`;
    return `<span class="replay-player"><button type="button" class="player-name player-filter ${playerColorClass(player, index)}" data-player-index="${index}" data-filter-kind="player" data-filter-value="${escapeHtml(player.name)}" aria-label="Filter by player ${escapeHtml(player.name)}">${escapeHtml(player.name)}</button>${rankCaption}</span>`;
  };
  const names = teams
    .map((team, teamIndex) => {
      // Free-for-all matchups wrap after two players; teammates stack vertically.
      const separator = teamIndex === 0
        ? ""
        : hasTeams
        ? `<span class="matchup-separator">vs</span>`
        : teams.length > 2 && teamIndex === 2
        ? `<span class="matchup-break" aria-hidden="true"></span>`
        : `<span class="matchup-separator">${teams.length > 2 ? " · " : " vs "}</span>`;
      return `${separator}<span class="replay-team">${team.map(renderPlayer).join("")}</span>`;
    })
    .join("");
  const winnerLine = replay.draw
    ? `<div class="winner-line">draw</div>`
    : winners.length
    ? `<div class="winner-line">winner: ${winners.map((winner) => `<button type="button" class="winner-name player-filter ${playerColorClass(winner, replay.players.indexOf(winner))}" data-winner-name data-filter-kind="player" data-filter-value="${escapeHtml(winner.name)}" aria-label="Filter by player ${escapeHtml(winner.name)}">${escapeHtml(winner.name)}</button>`).join(" &amp; ")}</div>`
    : "";
  const label = matchupTitle(replay.players, " versus ", " and ");
  const accessibleLabel = replay.eventLabel ? `${label}, ${replay.eventLabel}` : label;
  const replayAge = formatReplayAge(replay.modified);
  const replayDate = formatReplayDate(replay.modified);
  const thumbnailKey = replay.thumbnailKey ?? "";
  const thumbnailSource = replayThumbnailSource(thumbnailKey, replay.thumbnailDataUrl, browserThumbnailVariant);
  const cardClasses = [
    "replay-card",
    BROWSER_REPLAY_PLAYBACK_ENABLED ? "can-play" : "",
    browserSelectedReplayPaths.has(replay.filePath) ? "is-selected" : "",
    !browserHideUnmatched && !browserMatches[replayIndex] ? "is-dimmed" : "",
  ].filter(Boolean).join(" ");
  return `
    <article class="${cardClasses}" data-card-index="${replayIndex}" aria-label="${escapeHtml(accessibleLabel)}">
      <img class="replay-thumb" alt="" decoding="async" src="${escapeHtml(thumbnailSource)}" ${thumbnailKey ? `data-thumbnail-key="${escapeHtml(thumbnailKey)}"` : ""}>
      <div class="replay-shade"></div>
      <div class="replay-labels">
        ${mapButton}
        <div class="replay-label length">${escapeHtml(replay.length || formatDurationSeconds(replay.durationSeconds))}</div>
        <button type="button" class="replay-label replay-filter-label match-type" data-filter-kind="mode" data-filter-value="${escapeHtml(matchType)}" aria-label="Filter by mode ${escapeHtml(matchType)}" aria-pressed="${browserSelectedTypes.size === 1 && browserSelectedTypes.has(matchType)}"><span>${escapeHtml(matchType)}</span></button>
      </div>
      <div class="replay-score-label">${scoreDeltaLabel}</div>
      ${renderReplayPlayButton(replay, label, replayIndex)}
      ${renderReplaySelectButton(replay, label, replayIndex)}
      <time class="replay-age" data-replay-modified="${replay.modified}" datetime="${new Date(replay.modified * 1000).toISOString()}" aria-label="${escapeHtml(`${replayAge}, ${replayDate}`)}" title="${escapeHtml(`${replayAge} · ${replayDate}`)}" aria-live="off">
        <span class="replay-age-relative" data-replay-age>${replayAge}</span>
        <span class="replay-age-separator" aria-hidden="true">·</span>
        <span class="replay-age-date" data-replay-date>${replayDate}</span>
      </time>
      <div class="replay-meta">
        <div class="players">
          <div class="matchup player-count-${replay.players.length} ${hasTeams ? "has-teams" : ""}">${names}</div>
          ${winnerLine}
        </div>
      </div>
    </article>
  `;
}

function renderBrowserLoadingMessage(): string {
  const progress = browserIndexProgress;
  if (!progress || !progress.total) return `<div class="state-message" role="status">Loading replays...</div>`;
  const percent = Math.round((progress.done / progress.total) * 100);
  const label = progress.phase === "hash" ? "Scanning replays" : "Indexing replays";
  return `
    <div class="state-message index-progress" role="status">
      <span class="index-progress-label">${label}… <b>${progress.done.toLocaleString()}</b> of ${progress.total.toLocaleString()}</span>
      <span class="index-progress-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></span>
    </div>
  `;
}

function renderBrowserGrid(): string {
  if (browserLoading && !browserReplays.length) {
    return `<section id="replayGrid" class="replay-grid is-loading">${renderBrowserLoadingMessage()}</section>`;
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
    <section
      id="replayGrid"
      class="replay-grid ${browserGridCapped ? "" : "is-unlocked"} ${browserSelectedReplayPaths.size ? "has-selection" : ""}"
      style="--replay-card-min-width:${browserGridCardSize}px;--replay-card-scale:${browserGridCardScale()}"
    >
      <div id="replayGridCards" class="replay-grid-cards"></div>
    </section>
    <div id="searchEmpty" class="state-message search-empty" hidden>No matching replays.</div>
  `;
}

// Swaps the grid area between its loading, error, empty and card states
// without touching the rest of the page.
function renderBrowserGridArea(dataChanged = true) {
  const current = document.querySelector<HTMLElement>("#replayGrid");
  if (!current) return;
  const wantsCards = !browserError && browserReplays.length > 0;
  if (wantsCards && current.querySelector("#replayGridCards")) {
    applyBrowserSearch(dataChanged);
    return;
  }
  browserGrid?.destroy();
  browserGrid = null;
  document.querySelector("#searchEmpty")?.remove();
  const template = document.createElement("template");
  template.innerHTML = renderBrowserGrid();
  current.replaceWith(template.content);
  bindReplayGridEvents();
  if (wantsCards) mountBrowserGrid();
}

function updateBrowserLoadingProgress() {
  const grid = document.querySelector<HTMLElement>("#replayGrid.is-loading");
  if (grid) grid.innerHTML = renderBrowserLoadingMessage();
  const refresh = document.querySelector<HTMLElement>("#refreshReplays span");
  const progress = browserIndexProgress;
  setText(refresh, browserLoading && progress?.total && browserReplays.length
    ? `${Math.round((progress.done / progress.total) * 100)}%`
    : "Refresh");
}

function syncBrowserControls() {
  const hasReplays = browserReplays.length > 0;
  const search = document.querySelector<HTMLInputElement>("#playerSearch");
  if (search) search.disabled = (browserLoading && !hasReplays) || Boolean(browserError) || !hasReplays;
  updateBrowserClearButton();
  const toggle = document.querySelector<HTMLInputElement>("#matchModeToggle");
  if (toggle) toggle.disabled = !hasReplays;
  document.querySelectorAll<HTMLInputElement>(".type-filter, .source-filter, #durationMin, #durationMax").forEach((input) => {
    input.disabled = !hasReplays;
  });
  document.querySelectorAll<HTMLElement>(".filter-dropdown").forEach((dropdown) => {
    dropdown.toggleAttribute("data-disabled", !hasReplays);
  });
  const durationMin = document.querySelector<HTMLInputElement>("#durationMin");
  const durationMax = document.querySelector<HTMLInputElement>("#durationMax");
  const minPosition = secondsToDurationPosition(browserDurationRange.min);
  const maxPosition = secondsToDurationPosition(browserDurationRange.max);
  if (durationMin) durationMin.value = String(minPosition);
  if (durationMax) durationMax.value = String(maxPosition);
  const fill = document.querySelector<HTMLElement>("#durationRangeFill");
  if (fill) {
    fill.style.left = `${(minPosition / DURATION_SLIDER_STEPS) * 100}%`;
    fill.style.right = `${((DURATION_SLIDER_STEPS - maxPosition) / DURATION_SLIDER_STEPS) * 100}%`;
  }
  setText(document.querySelector("#durationMinLabel"), formatDurationSeconds(browserDurationRange.min));
  setText(document.querySelector("#durationMaxLabel"), formatDurationSeconds(browserDurationRange.max));
  const refresh = document.querySelector<HTMLButtonElement>("#refreshReplays");
  if (refresh) {
    refresh.classList.toggle("is-loading", browserLoading);
    refresh.disabled = browserLoading && !hasReplays;
  }
  updateBrowserLoadingProgress();
  renderReplayUploadDock();
}

function renderReplayDeleteDialog(): string {
  if (!browserDeleteCandidates.length) return "";
  const count = browserDeleteCandidates.length;
  const firstReplay = browserDeleteCandidates[0];
  const matchup = matchupTitle(firstReplay.players) || firstReplay.fileName || "this replay";
  const description = count === 1
    ? `<strong>${escapeHtml(matchup)}</strong> will be permanently removed from War of Dots and the backup library.`
    : `<strong>${count} selected replays</strong> will be permanently removed from War of Dots and the backup library.`;
  return `
    <div id="replayDeleteModal" class="replay-delete-backdrop" role="presentation">
      <section class="replay-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="replayDeleteTitle" aria-describedby="replayDeleteDescription">
        <div class="replay-delete-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M4 7h16" />
            <path d="M9 7V4h6v3" />
            <path d="m7 7 1 13h8l1-13" />
            <path d="M10 11v5M14 11v5" />
          </svg>
        </div>
        <div class="replay-delete-copy">
          <span class="replay-delete-eyebrow">Delete ${count === 1 ? "replay" : `${count} replays`}</span>
          <h2 id="replayDeleteTitle">Remove ${count === 1 ? "this replay" : "selected replays"}?</h2>
          <p id="replayDeleteDescription">${description}</p>
          ${browserDeleteError ? `<div class="replay-delete-error" role="alert">${escapeHtml(browserDeleteError)}</div>` : ""}
        </div>
        <div class="replay-delete-actions">
          <button id="cancelReplayDelete" class="replay-delete-cancel" type="button" ${browserDeleteInFlight ? "disabled" : ""}>Cancel</button>
          <button id="confirmReplayDelete" class="replay-delete-confirm ${browserDeleteInFlight ? "is-deleting" : ""}" type="button" ${browserDeleteInFlight ? "disabled" : ""}>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" />
            </svg>
            <span>${browserDeleteInFlight ? "Deleting..." : `Delete ${count === 1 ? "replay" : `${count} replays`}`}</span>
          </button>
        </div>
      </section>
    </div>
  `;
}

function selectedBrowserReplays(): ReplayBrowserItem[] {
  return browserReplays.filter((replay) => browserSelectedReplayPaths.has(replay.filePath));
}

function renderReplayUploadDockContent(animateSelection = false): string {
  const selectedCount = browserSelectedReplayPaths.size;
  const selectionBusy = browserDeleteInFlight || browserBulkDownloadInFlight;
  if (!selectedCount) {
    return `
      <input id="replayUploadInput" type="file" accept=".rep" multiple hidden>
      <div class="replay-action-group">
        <button id="uploadReplays" class="refresh-button upload-button ${browserUploading ? "is-loading" : ""}" type="button" aria-label="Upload replays" title="Upload replays to War of Dots" ${browserUploading || browserLoading ? "disabled" : ""}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 16V4" />
            <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
            <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
          </svg>
          <span aria-live="polite">${escapeHtml(browserUploadLabel)}</span>
        </button>
      </div>
    `;
  }

  return `
    <div class="replay-action-group replay-selection-actions ${animateSelection ? "is-entering" : ""}" role="group" aria-label="Actions for ${selectedCount} selected ${selectedCount === 1 ? "replay" : "replays"}">
      <span class="replay-selection-count" aria-live="polite"><strong>${selectedCount}</strong> selected</span>
      <button id="unselectAllReplays" class="refresh-button unselect-button" type="button" ${selectionBusy ? "disabled" : ""}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
        <span>Unselect all</span>
      </button>
      <button id="downloadSelectedReplays" class="refresh-button selection-download-button ${browserBulkDownloadInFlight ? "is-loading" : ""}" type="button" ${selectionBusy ? "disabled" : ""}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" /></svg>
        <span>${browserBulkDownloadInFlight ? "Saving..." : "Download"}</span>
      </button>
      <button id="recordSelectedReplays" class="refresh-button selection-record-button" type="button" ${exportBusy() ? "disabled" : ""} title="${exportBusy() ? "Videos are being exported" : "Export selected replays as MP4 videos"}">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect x="3" y="6" width="14" height="12" rx="2" /><path d="m17 10 4-2v8l-4-2" />
        </svg>
        <span>Record</span>
      </button>
      <button id="deleteSelectedReplays" class="refresh-button selection-delete-button" type="button" ${selectionBusy ? "disabled" : ""}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5M14 11v5" /></svg>
        <span>Delete</span>
      </button>
    </div>
  `;
}

function renderBrowserGridWidthToggle(): string {
  const label = browserGridCapped ? "3 max" : "Manual";
  const title = browserGridCapped
    ? "Grid capped at 3 columns. Click to size replay cards manually."
    : "Manual replay card sizing is on. Click to cap the grid at 3 columns.";
  return `
    <button
      id="gridWidthToggle"
      class="grid-width-toggle ${browserGridCapped ? "is-active" : ""}"
      type="button"
      aria-pressed="${browserGridCapped}"
      aria-label="${escapeHtml(title)}"
      title="${escapeHtml(title)}"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3" y="5" width="4" height="14" rx="1" />
        <rect x="10" y="5" width="4" height="14" rx="1" />
        <rect x="17" y="5" width="4" height="14" rx="1" />
      </svg>
      <span>${label}</span>
    </button>
  `;
}

function renderBrowserGridSizeControl(): string {
  return `
    <label
      id="gridSizeControl"
      class="grid-size-control ${browserGridCapped ? "" : "is-visible"}"
      aria-hidden="${browserGridCapped}"
      title="Replay card size"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </svg>
      <input
        id="gridCardSize"
        type="range"
        min="${BROWSER_GRID_CARD_SIZE_MIN}"
        max="${BROWSER_GRID_CARD_SIZE_MAX}"
        step="${BROWSER_GRID_CARD_SIZE_STEP}"
        value="${browserGridCardSize}"
        aria-label="Replay card size"
        aria-valuetext="${browserGridCardSize} pixels wide"
        ${browserGridCapped ? "disabled" : ""}
      >
      <output id="gridCardSizeValue" for="gridCardSize">${browserGridCardSize}</output>
    </label>
  `;
}

function renderBrowserNav(): string {
  return `
    <nav class="browser-nav" aria-label="Main navigation">
      <button class="browser-nav-button ${browserPage === "replays" ? "is-active" : ""}" type="button" data-browser-page="replays">Replays</button>
      <button class="browser-nav-button ${browserPage === "leaderboard" ? "is-active" : ""}" type="button" data-browser-page="leaderboard">Leaderboard</button>
      <button class="browser-nav-button ${browserPage === "mapEditor" ? "is-active" : ""}" type="button" data-browser-page="mapEditor">Map Editor</button>
      <button class="app-version-button" type="button" data-app-version aria-label="Check for updates">${escapeHtml(appVersionLabel())}</button>
    </nav>
  `;
}


function thumbnailCacheKey(variant: ThumbnailVariant, thumbnailKey: string): string {
  return `${variant}:${thumbnailKey}`;
}

// The best image available now for a card: the wanted size, then the other
// size, then the replay's own image or the drawn fallback. The wanted size is
// requested when it is missing.
function replayThumbnailSource(
  thumbnailKey: string | null | undefined,
  dataUrl: string | null | undefined,
  variant: ThumbnailVariant,
): string {
  if (!thumbnailKey) return dataUrl || FALLBACK_THUMBNAIL;
  const wanted = browserThumbnailUrls.get(thumbnailCacheKey(variant, thumbnailKey));
  if (wanted) return wanted;
  queueReplayThumbnail(thumbnailKey, variant);
  return browserThumbnailUrls.get(thumbnailCacheKey(variant === "small" ? "full" : "small", thumbnailKey))
    || dataUrl
    || FALLBACK_THUMBNAIL;
}

// Thumbnails arrive as base64 PNGs; object URLs keep image elements' sources
// short and let the browser share one decoded copy across cards.
function thumbnailObjectUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

function applyLoadedReplayThumbnail(thumbnailKey: string) {
  document.querySelectorAll<HTMLImageElement>(`img[data-thumbnail-key="${CSS.escape(thumbnailKey)}"]`).forEach((image) => {
    const variant = image.dataset.thumbnailVariant === "small" ? "small" : browserThumbnailVariant;
    const source = replayThumbnailSource(thumbnailKey, null, variant);
    if (source !== FALLBACK_THUMBNAIL && image.getAttribute("src") !== source) image.src = source;
  });
}

function scheduleReplayThumbnailFlush() {
  if (!browserThumbnailFlushTimer) {
    browserThumbnailFlushTimer = window.setTimeout(() => void flushReplayThumbnailRequests(), 0);
  }
}

async function flushReplayThumbnailRequests() {
  browserThumbnailFlushTimer = 0;
  // One size per request; whatever is left goes in the next one.
  const first = browserThumbnailPending.values().next().value;
  if (!first) return;
  const variant: ThumbnailVariant = first.startsWith("small:") ? "small" : "full";
  const batch = [...browserThumbnailPending]
    .filter((cacheKey) => cacheKey.startsWith(`${variant}:`))
    .slice(0, THUMBNAIL_BATCH_SIZE);
  batch.forEach((cacheKey) => {
    browserThumbnailPending.delete(cacheKey);
    browserThumbnailInFlight.add(cacheKey);
  });
  const keys = batch.map((cacheKey) => cacheKey.slice(variant.length + 1));
  try {
    const paths = await invoke<ReplayThumbnailPath[]>("replay_thumbnail_paths", { thumbnailKeys: keys, variant });
    for (const item of paths) {
      const source = item.dataUrl ? thumbnailObjectUrl(item.dataUrl) : mediaSrc(item.filePath);
      browserThumbnailUrls.set(thumbnailCacheKey(variant, item.thumbnailKey), source);
      applyLoadedReplayThumbnail(item.thumbnailKey);
    }
  } catch {
    // A missing map image should leave the lightweight fallback in place.
  } finally {
    batch.forEach((cacheKey) => browserThumbnailInFlight.delete(cacheKey));
    if (browserThumbnailPending.size) scheduleReplayThumbnailFlush();
    else scheduleReplayThumbnailPrefetch();
  }
}

function queueReplayThumbnail(thumbnailKey: string, variant: ThumbnailVariant) {
  const cacheKey = thumbnailCacheKey(variant, thumbnailKey);
  if (exampleMode || browserThumbnailUrls.has(cacheKey) || browserThumbnailInFlight.has(cacheKey)) return;
  browserThumbnailPending.add(cacheKey);
  scheduleReplayThumbnailFlush();
}

// Once the visible cards have their images, the rest of the library's are
// loaded in the background, so fast scrolling does not show placeholders.
function scheduleReplayThumbnailPrefetch() {
  if (browserThumbnailPrefetchTimer || exampleMode) return;
  const run = () => {
    browserThumbnailPrefetchTimer = 0;
    if (browserThumbnailPending.size || browserThumbnailInFlight.size || browserPage !== "replays") return;
    const queued = new Set<string>();
    for (const replay of browserReplays) {
      const key = replay.thumbnailKey;
      if (!key || queued.has(key) || browserThumbnailUrls.has(thumbnailCacheKey(browserThumbnailVariant, key))) continue;
      queued.add(key);
      if (queued.size >= THUMBNAIL_BATCH_SIZE) break;
    }
    queued.forEach((key) => queueReplayThumbnail(key, browserThumbnailVariant));
  };
  browserThumbnailPrefetchTimer = "requestIdleCallback" in window
    ? window.requestIdleCallback(run, { timeout: 1000 })
    : globalThis.setTimeout(run, 200);
}

function preferredThumbnailVariant(columnWidth: number): ThumbnailVariant {
  return columnWidth * (window.devicePixelRatio || 1) <= SMALL_THUMBNAIL_WIDTH ? "small" : "full";
}

function renderReplayCards(indexes: number[]): HTMLElement[] {
  const template = document.createElement("template");
  template.innerHTML = indexes.map((index) => renderReplayCard(browserReplays[index], index)).join("");
  return Array.from(template.content.children) as HTMLElement[];
}

// Applies everything that can change while a card exists: search highlights,
// dimming, selection, filter buttons, Play state, image size and its age.
function updateReplayCard(card: HTMLElement, replayIndex: number, now = Date.now()) {
  const replay = browserReplays[replayIndex];
  if (!replay) return;
  const query = normalizeSearchText(browserSearchValue());
  if ((card.dataset.highlight ?? "") !== query) {
    card.dataset.highlight = query;
    card.querySelectorAll<HTMLElement>("[data-player-index]").forEach((element) => {
      renderHighlightedText(element, replay.players[Number(element.dataset.playerIndex)]?.name ?? "", query);
    });
    card.querySelectorAll<HTMLElement>("[data-winner-name]").forEach((element) => {
      renderHighlightedText(element, element.dataset.filterValue ?? "", query);
    });
  }
  card.classList.toggle("is-dimmed", !browserHideUnmatched && !browserMatches[replayIndex]);

  const isSelected = browserSelectedReplayPaths.has(replay.filePath);
  card.classList.toggle("is-selected", isSelected);
  const selectButton = card.querySelector<HTMLButtonElement>("[data-replay-select-index]");
  if (selectButton) {
    selectButton.classList.toggle("is-selected", isSelected);
    selectButton.disabled = browserDeleteInFlight || browserBulkDownloadInFlight;
    setAttribute(selectButton, "aria-pressed", String(isSelected));
    if (selectButton.dataset.selected !== String(isSelected)) {
      selectButton.dataset.selected = String(isSelected);
      const label = matchupTitle(replay.players, " versus ", " and ");
      setAttribute(selectButton, "aria-label", `${isSelected ? "Deselect" : "Select"} replay: ${label}`);
      setAttribute(selectButton, "title", isSelected ? "Deselect replay" : "Select replay");
      setText(selectButton.querySelector("span"), isSelected ? "Selected" : "Select");
    }
  }
  updateCardFilterButtons(card);

  const playButton = card.querySelector<HTMLButtonElement>("[data-replay-index]");
  if (playButton) {
    const opening = browserOpeningPaths.has(replay.filePath);
    playButton.disabled = opening;
    setText(playButton.querySelector("span:last-child"), opening ? "Opening..." : "Play");
  }

  const image = card.querySelector<HTMLImageElement>("img.replay-thumb");
  if (image && replay.thumbnailKey) {
    const source = replayThumbnailSource(replay.thumbnailKey, replay.thumbnailDataUrl, browserThumbnailVariant);
    // Never trade a loaded image for the placeholder.
    if (source !== FALLBACK_THUMBNAIL && image.getAttribute("src") !== source) image.src = source;
  }

  updateReplayAge(card.querySelector<HTMLTimeElement>("[data-replay-modified]"), now);
}

function updateReplayAge(element: HTMLTimeElement | null, now: number) {
  if (!element) return;
  const nextAge = formatReplayAge(element.dataset.replayModified, now);
  const nextDate = formatReplayDate(element.dataset.replayModified, now);
  setText(element.querySelector("[data-replay-age]"), nextAge);
  setText(element.querySelector("[data-replay-date]"), nextDate);
  setAttribute(element, "aria-label", `${nextAge}, ${nextDate}`);
  setAttribute(element, "title", `${nextAge} · ${nextDate}`);
}

function mountBrowserGrid() {
  const scroller = document.querySelector<HTMLElement>("#replayGrid");
  const container = document.querySelector<HTMLElement>("#replayGridCards");
  browserGrid?.destroy();
  browserGrid = null;
  if (!scroller || !container) return;
  browserGrid = new VirtualGrid({
    scroller,
    container,
    create: renderReplayCards,
    update: (element, id) => updateReplayCard(element, id),
    estimateRowHeight: () => 214 * browserGridCardScale(),
    onLayout: (columnWidth) => {
      const variant = preferredThumbnailVariant(columnWidth);
      if (variant === browserThumbnailVariant) return;
      browserThumbnailVariant = variant;
      browserGrid?.refresh();
      scheduleReplayThumbnailPrefetch();
    },
  });
  applyBrowserSearch(true);
}

function updateReplayAgeLabels() {
  const now = Date.now();
  browserGrid?.mountedElements.forEach((card) => updateReplayAge(card.querySelector("[data-replay-modified]"), now));
}

function browserFilterKey(filterState: BrowserFilterState): string {
  return JSON.stringify([
    filterState.query, [...filterState.enabledTypes].sort(), [...filterState.sources].sort(),
    filterState.durationRange.min, filterState.durationRange.max, filterState.mapKey, filterState.player,
    browserHideUnmatched, browserReplays.length,
  ]);
}

// Filters the library as data; only the cards on screen are touched.
// `dataChanged` rebuilds cards after the replay list itself changed.
function applyBrowserSearch(dataChanged = false) {
  pendingBrowserSearchFrame = 0;
  const filterState = currentBrowserFilterState();
  const signature = browserFilterKey(filterState);
  if (!dataChanged && signature === browserFilterSignature) {
    updateBrowserFilterUi();
    return;
  }
  browserFilterSignature = signature;
  if (dataChanged || browserMatches.length !== browserReplays.length) {
    browserFilterRecords = browserReplays.map(replayFilterRecord);
  }

  const matches = new Uint8Array(browserReplays.length);
  const items: number[] = [];
  let visibleCount = 0;
  browserFilterRecords.forEach((record, index) => {
    const visible = matchesReplay(record, filterState);
    matches[index] = Number(visible);
    if (visible) visibleCount += 1;
    if (visible || !browserHideUnmatched) items.push(index);
  });
  browserMatches = matches;
  browserGridItems = items;

  if (browserGrid) {
    if (dataChanged) browserGrid.rebuild();
    browserGrid.setItems(items);
    browserGrid.refresh();
  }
  updateBrowserFilterUi();
  const searchEmpty = document.querySelector<HTMLElement>("#searchEmpty");
  if (searchEmpty) searchEmpty.hidden = !browserHideUnmatched || visibleCount > 0;
  scheduleReplayThumbnailPrefetch();
}

function scheduleBrowserSearch() {
  if (pendingBrowserSearchFrame) return;
  pendingBrowserSearchFrame = window.requestAnimationFrame(() => applyBrowserSearch());
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

let leaderboardRoot: Root | null = null;

function renderReplayBrowser() {

  if (browserPage !== "leaderboard" && leaderboardRoot) {
    leaderboardRoot.unmount();
    leaderboardRoot = null;
  }
  browserGrid?.destroy();
  browserGrid = null;
  const minPosition = secondsToDurationPosition(browserDurationRange.min);
  const maxPosition = secondsToDurationPosition(browserDurationRange.max);
  const fillLeft = (minPosition / DURATION_SLIDER_STEPS) * 100;
  const fillRight = ((DURATION_SLIDER_STEPS - maxPosition) / DURATION_SLIDER_STEPS) * 100;
  if (browserPage === "mapEditor") {
    appRoot.innerHTML = `
      <main class="replay-browser map-editor-page" aria-label="War of Dots map editor">
        ${renderBrowserNav()}${exampleMode ? `<div class="example-banner">Example workspace <span>Latest copied data · up to 100 replays · edits stay in this session</span></div>` : ""}
        <section id="mapEditorRoot" class="map-editor-host" aria-label="Map editor"></section>
      </main>
    `;
    bindBrowserEvents();
    mountMapEditor();
    return;
  }
  unmountMapEditor();
  if (browserPage === "leaderboard") {
    if (!leaderboardRoot) {
      appRoot.innerHTML = `<main class="replay-browser" aria-label="War of Dots leaderboard">${renderBrowserNav()}${exampleMode ? `<div class="example-banner">Example workspace <span>Latest copied data · up to 100 replays · edits stay in this session</span></div>` : ""}<div id="leaderboardRoot" style="display:flex;flex:1;min-height:0;overflow:hidden"></div></main>`;
      bindBrowserEvents();
      leaderboardRoot = createRoot(document.querySelector<HTMLElement>("#leaderboardRoot")!);
      leaderboardRoot.render(createElement(LeaderboardApp));
    }
    return;
  }

  appRoot.innerHTML = `
    <main class="replay-browser" aria-label="War of Dots replays">
      ${renderBrowserNav()}${exampleMode ? `<div class="example-banner">Example workspace <span>Latest copied data · up to 100 replays · edits stay in this session</span></div>` : ""}
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
            <div class="replay-search-field">
            <svg class="replay-search-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
            <input
              id="playerSearch"
              class="player-search"
              type="search"
              placeholder="Search players or maps"
              aria-label="Search players or maps"
              aria-autocomplete="list"
              aria-controls="playerSuggestionList"
              autocomplete="off"
              spellcheck="false"
              value="${escapeHtml(browserSearch)}"
              ${(browserLoading && !browserReplays.length) || browserError || !browserReplays.length ? "disabled" : ""}
            >
            <button id="clearPlayerSearch" class="search-clear" type="button" aria-label="Clear search" ${browserSearch ? "" : "hidden"}>x</button>
            <div id="activeReplayFilters" class="active-replay-filters" role="group" aria-label="Active map and player filters" hidden></div>
            </div>
            <div id="playerSuggestionPanel" class="player-suggestion-panel" hidden>
              <div id="playerSuggestionList" class="player-suggestion-list" role="listbox" aria-label="Player and map suggestions"></div>
              <div class="suggestion-footer" aria-hidden="true">↑↓ Navigate <span>Enter Select</span><span>Esc Close</span></div>
            </div>
          </div>
          <label class="match-mode-toggle" title="Dim non-matching replays">
            <input id="matchModeToggle" type="checkbox" aria-label="Dim non-matching replays" ${browserHideUnmatched ? "" : "checked"} ${browserReplays.length ? "" : "disabled"}>
            <span aria-hidden="true">&#128123;&#65039;</span>
          </label>
        </div>
        <div class="filter-controls">
          <details class="filter-dropdown" ${browserReplays.length ? "" : "data-disabled"}>
            <summary id="modeFilterSummary" aria-label="Match mode filters">${escapeHtml(filterSummary("Mode", MATCH_TYPES.filter(type => browserSelectedTypes.has(type)), MATCH_TYPES.length))}</summary>
            <div class="filter-menu" role="group" aria-label="Match mode filters">
              ${MATCH_TYPES.map(type => `<label><input class="type-filter" type="checkbox" value="${escapeHtml(type)}" ${browserSelectedTypes.has(type) ? "checked" : ""} ${browserReplays.length ? "" : "disabled"}><span>${escapeHtml(type)}</span><span class="filter-count" data-mode-count="${escapeHtml(type)}"></span></label>`).join("")}
            </div>
          </details>
          <details class="filter-dropdown" ${browserReplays.length ? "" : "data-disabled"}>
            <summary id="variantFilterSummary" aria-label="Map filters">${escapeHtml(filterSummary("Map", REPLAY_VARIANTS.filter(variant => browserMapSources.has(variant.value)).map(variant => variant.label), REPLAY_VARIANTS.length))}</summary>
            <div class="filter-menu" role="group" aria-label="Map filters">
              ${REPLAY_VARIANTS.map(variant => `<label><input class="source-filter" type="checkbox" value="${variant.value}" ${browserMapSources.has(variant.value) ? "checked" : ""} ${browserReplays.length ? "" : "disabled"}><span>${escapeHtml(variant.label)}</span><span class="filter-count" data-variant-count="${variant.value}"></span></label>`).join("")}
            </div>
          </details>
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
      <div id="replayUploadDock" class="replay-upload-dock">
        ${renderReplayUploadDockContent()}
      </div>
      <div class="replay-action-dock">
        <div class="replay-action-group" role="group" aria-label="Replay browser actions">
          ${renderBrowserGridWidthToggle()}
          ${renderBrowserGridSizeControl()}
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
      <div id="replayDeleteHost">${renderReplayDeleteDialog()}</div>
    </main>
  `;
  bindBrowserEvents();
  updateBrowserClearButton();
  refreshBrowserSuggestions(browserSuggestionOpen);
  if (document.querySelector("#replayGridCards")) mountBrowserGrid();
  else applyBrowserSearch(true);
}

function handleBrowserSuggestionClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null;
  const option = target?.closest<HTMLButtonElement>(".player-suggestion");
  if (!option) return;
  event.preventDefault();
  selectBrowserSuggestion(Number(option.dataset.index));
}

function handleBrowserOutsidePointerDown(event: PointerEvent) {
  if (event.target instanceof Node && document.querySelector("#playerSearchBox")?.contains(event.target)) return;
  const overflow = document.querySelector<HTMLDetailsElement>("#replayFilterOverflow");
  if (overflow) overflow.open = false;
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
  if (nextPage === "replays") void loadBrowserLeaderboardRanks();
}

function refreshBrowserSelectionUi() {
  const grid = document.querySelector<HTMLElement>("#replayGrid");
  const hasSelection = browserSelectedReplayPaths.size > 0;
  // Toggling the class restyles every card, so it is only touched on change.
  if (grid && grid.classList.contains("has-selection") !== hasSelection) grid.classList.toggle("has-selection", hasSelection);
  browserGrid?.refresh();
  renderReplayUploadDock();
}

const renderedDockMarkup = new WeakMap<HTMLElement, string>();

function renderReplayUploadDock() {
  const dock = document.querySelector<HTMLElement>("#replayUploadDock");
  if (!dock) return;
  const hadSelectionActions = Boolean(dock.querySelector(".replay-selection-actions"));
  const markup = renderReplayUploadDockContent(!hadSelectionActions && browserSelectedReplayPaths.size > 0);
  // Rebuilding the dock restarts its entrance animation, so identical markup is kept.
  if (renderedDockMarkup.get(dock) === markup) return;
  renderedDockMarkup.set(dock, markup);
  dock.innerHTML = markup;
  bindReplayUploadDockEvents();
}

function toggleBrowserReplaySelection(replay: ReplayBrowserItem, selectRange = false) {
  if (browserDeleteInFlight || browserBulkDownloadInFlight) return;

  const shouldSelect = !browserSelectedReplayPaths.has(replay.filePath);
  // Range selection follows the grid's order, including cards not rendered yet.
  const visibleReplayPaths = browserGridItems.map((index) => browserReplays[index].filePath);
  const anchorIndex = browserSelectionAnchorPath ? visibleReplayPaths.indexOf(browserSelectionAnchorPath) : -1;
  const replayIndex = visibleReplayPaths.indexOf(replay.filePath);

  if (selectRange && anchorIndex >= 0 && replayIndex >= 0) {
    const start = Math.min(anchorIndex, replayIndex);
    const end = Math.max(anchorIndex, replayIndex);
    visibleReplayPaths.slice(start, end + 1).forEach((filePath) => {
      if (shouldSelect) browserSelectedReplayPaths.add(filePath);
      else browserSelectedReplayPaths.delete(filePath);
    });
  } else if (shouldSelect) browserSelectedReplayPaths.add(replay.filePath);
  else browserSelectedReplayPaths.delete(replay.filePath);

  browserSelectionAnchorPath = replay.filePath;
  refreshBrowserSelectionUi();
}

function clearBrowserReplaySelection() {
  if (browserDeleteInFlight || browserBulkDownloadInFlight) return;
  browserSelectedReplayPaths.clear();
  browserSelectionAnchorPath = null;
  refreshBrowserSelectionUi();
}

function bindReplayUploadDockEvents() {
  const replayUploadInput = document.querySelector<HTMLInputElement>("#replayUploadInput");
  document.querySelector<HTMLButtonElement>("#uploadReplays")?.addEventListener("click", () => {
    replayUploadInput?.click();
  });
  replayUploadInput?.addEventListener("change", () => {
    const files = Array.from(replayUploadInput.files ?? []);
    replayUploadInput.value = "";
    if (files.length) void uploadBrowserReplays(files);
  });
  document.querySelector<HTMLButtonElement>("#unselectAllReplays")?.addEventListener("click", clearBrowserReplaySelection);
  document.querySelector<HTMLButtonElement>("#downloadSelectedReplays")?.addEventListener("click", () => {
    void downloadSelectedReplays();
  });
  document.querySelector<HTMLButtonElement>("#recordSelectedReplays")?.addEventListener("click", () => {
    void recordSelectedReplays();
  });
  document.querySelector<HTMLButtonElement>("#deleteSelectedReplays")?.addEventListener("click", openReplayDeleteDialog);
}

// Filter dropdowns close on an outside click or Escape, like the other popovers.
document.addEventListener("pointerdown", event => {
  document.querySelectorAll<HTMLDetailsElement>(".filter-dropdown[open]").forEach(dropdown => {
    if (!dropdown.contains(event.target as Node)) dropdown.open = false;
  });
});

function bindBrowserEvents() {
  updateAppVersionControls();
  document.querySelector<HTMLButtonElement>("[data-app-version]")?.addEventListener("click", () => {
    void checkForAppUpdate(true);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-browser-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.dataset.browserPage;
      const nextPage: BrowserPage = page === "leaderboard" ? "leaderboard" : page === "mapEditor" ? "mapEditor" : "replays";
      void switchBrowserPage(nextPage);
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
  document.querySelector<HTMLElement>("#playerSearchBox")?.addEventListener("focusout", event => {
    if (!(event.relatedTarget instanceof Node) || !(event.currentTarget as HTMLElement).contains(event.relatedTarget)) {
      closeBrowserSuggestions();
      const overflow = document.querySelector<HTMLDetailsElement>("#replayFilterOverflow");
      if (overflow) overflow.open = false;
    }
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
  document.querySelector<HTMLElement>("#playerSuggestionList")?.addEventListener("click", handleBrowserSuggestionClick);
  document.querySelector<HTMLElement>("#playerSuggestionList")?.addEventListener("mousedown", event => event.preventDefault());
  document.querySelector<HTMLInputElement>("#matchModeToggle")?.addEventListener("change", (event) => {
    browserHideUnmatched = !(event.target as HTMLInputElement).checked;
    scheduleBrowserSearch();
  });
  document.querySelectorAll<HTMLInputElement>(".source-filter").forEach(input => {
    input.addEventListener("change", () => {
      const source = input.value as ReplayVariant;
      if (input.checked) browserMapSources.add(source);
      else browserMapSources.delete(source);
      updateBrowserFilterUi();
      refreshBrowserSuggestions(false);
      scheduleBrowserSearch();
    });
  });
  document.querySelectorAll<HTMLInputElement>(".type-filter").forEach(input => {
    input.addEventListener("change", () => {
      if (input.checked) browserSelectedTypes.add(input.value);
      else browserSelectedTypes.delete(input.value);
      updateBrowserFilterUi();
      refreshBrowserSuggestions(false);
      scheduleBrowserSearch();
    });
  });
  document.querySelectorAll<HTMLDetailsElement>(".filter-dropdown").forEach(dropdown => dropdown.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !dropdown.open) return;
    dropdown.open = false;
    dropdown.querySelector("summary")?.focus();
  }));
  document.querySelector<HTMLElement>("#activeReplayFilters")?.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLElement>("[data-clear-filter]");
    if (button) clearReplayFilter(button.dataset.clearFilter ?? "all");
  });
  document.querySelector<HTMLElement>("#activeReplayFilters")?.addEventListener("toggle", event => {
    if (event.target instanceof HTMLDetailsElement && event.target.open) closeBrowserSuggestions();
  }, true);
  document.querySelector<HTMLElement>("#activeReplayFilters")?.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const overflow = document.querySelector<HTMLDetailsElement>("#replayFilterOverflow");
    if (overflow?.open) {
      overflow.open = false;
      overflow.querySelector<HTMLElement>("summary")?.focus();
    }
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
  bindReplayUploadDockEvents();
  document.querySelector<HTMLButtonElement>("#gridWidthToggle")?.addEventListener("click", () => {
    browserGridCapped = !browserGridCapped;
    saveBrowserGridCapped(browserGridCapped);
    const grid = document.querySelector<HTMLElement>("#replayGrid");
    grid?.classList.toggle("is-unlocked", !browserGridCapped);
    grid?.style.setProperty("--replay-card-scale", String(browserGridCardScale()));

    const sizeControl = document.querySelector<HTMLElement>("#gridSizeControl");
    sizeControl?.classList.toggle("is-visible", !browserGridCapped);
    sizeControl?.setAttribute("aria-hidden", String(browserGridCapped));
    const sizeInput = document.querySelector<HTMLInputElement>("#gridCardSize");
    if (sizeInput) sizeInput.disabled = browserGridCapped;

    const button = document.querySelector<HTMLButtonElement>("#gridWidthToggle");
    if (!button) return;
    const title = browserGridCapped
      ? "Grid capped at 3 columns. Click to size replay cards manually."
      : "Manual replay card sizing is on. Click to cap the grid at 3 columns.";
    button.classList.toggle("is-active", browserGridCapped);
    button.setAttribute("aria-pressed", String(browserGridCapped));
    button.setAttribute("aria-label", title);
    button.title = title;
    const label = button.querySelector<HTMLElement>("span");
    if (label) label.textContent = browserGridCapped ? "3 max" : "Manual";
    browserGrid?.relayout();
  });
  document.querySelector<HTMLInputElement>("#gridCardSize")?.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    browserGridCardSize = clamp(Number(input.value), BROWSER_GRID_CARD_SIZE_MIN, BROWSER_GRID_CARD_SIZE_MAX);
    input.setAttribute("aria-valuetext", `${browserGridCardSize} pixels wide`);
    const grid = document.querySelector<HTMLElement>("#replayGrid");
    grid?.style.setProperty("--replay-card-min-width", `${browserGridCardSize}px`);
    grid?.style.setProperty("--replay-card-scale", String(browserGridCardScale()));
    const value = document.querySelector<HTMLOutputElement>("#gridCardSizeValue");
    if (value) value.value = String(browserGridCardSize);
    saveBrowserGridCardSize(browserGridCardSize);
    browserGrid?.relayout();
  });
  bindReplayGridEvents();
  bindReplayDeleteDialogEvents();
  if (!browserDocumentEventsBound) {
    document.addEventListener("pointerdown", handleBrowserOutsidePointerDown);
    browserDocumentEventsBound = true;
  }
}

let playerClickTimer: ReturnType<typeof setTimeout> | undefined;

function bindReplayGridEvents() {
  document.querySelector<HTMLElement>("#replayGrid")?.addEventListener("dblclick", () => {
    clearTimeout(playerClickTimer);
  });
  document.querySelector<HTMLElement>("#replayGrid")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const filterButton = target.closest<HTMLButtonElement>("[data-filter-kind]");
    if (filterButton) {
      if (filterButton.dataset.filterKind === "player") {
        // A double click selects a username. Dragging text must not filter the
        // grid on mouse release either. Keyboard activation stays immediate.
        clearTimeout(playerClickTimer);
        if (event.detail === 0) {
          toggleBrowserPlayer(filterButton.dataset.filterValue ?? "");
          return;
        }
        if (event.detail > 1 || window.getSelection()?.type === "Range") return;
        const filter = () => {
          if (filterButton.isConnected && window.getSelection()?.type !== "Range") {
            toggleBrowserPlayer(filterButton.dataset.filterValue ?? "");
          }
        };
        playerClickTimer = setTimeout(filter, 500);
        return;
      }
      const value = filterButton.dataset.filterValue ?? "";
      if (filterButton.dataset.filterKind === "map") toggleBrowserMap(value, filterButton.dataset.filterLabel ?? value);
      else {
        browserSelectedTypes = toggleMatchType(browserSelectedTypes, value);
        commitBrowserFilters();
      }
      return;
    }

    const selectButton = target.closest<HTMLButtonElement>("[data-replay-select-index]");
    if (selectButton) {
      const replay = browserReplays[Number(selectButton.dataset.replaySelectIndex)];
      if (replay) toggleBrowserReplaySelection(replay, event.shiftKey);
      return;
    }

    if (!BROWSER_REPLAY_PLAYBACK_ENABLED) return;
    const playButton = target.closest<HTMLButtonElement>("[data-replay-index]");
    const replay = playButton ? browserReplays[Number(playButton.dataset.replayIndex)] : null;
    if (replay) void openReplayFromBrowser(replay);
  });
}

function bindReplayDeleteDialogEvents() {
  const deleteModal = document.querySelector<HTMLElement>("#replayDeleteModal");
  deleteModal?.addEventListener("click", (event) => {
    if (event.target === deleteModal && !browserDeleteInFlight) closeReplayDeleteDialog();
  });
  deleteModal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !browserDeleteInFlight) {
      event.preventDefault();
      closeReplayDeleteDialog();
      return;
    }
    if (event.key === "Tab") {
      const buttons = Array.from(deleteModal.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (!buttons.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  document.querySelector<HTMLButtonElement>("#cancelReplayDelete")?.addEventListener("click", closeReplayDeleteDialog);
  document.querySelector<HTMLButtonElement>("#confirmReplayDelete")?.addEventListener("click", () => {
    void deleteReplayFromBrowser();
  });
}

// Opening a replay only changes its Play button; the library stays as it is.
async function openReplayFromBrowser(replay: ReplayBrowserItem) {
  if (browserOpeningPaths.has(replay.filePath)) return;
  browserOpeningPaths.add(replay.filePath);
  browserGrid?.refresh();
  try {
    await invoke<string>("open_replay_window", { fileName: replay.fileName, filePath: replay.filePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Could not open the replay.");
    window.alert(`Could not open the replay.\n\n${message}`);
  } finally {
    browserOpeningPaths.delete(replay.filePath);
    browserGrid?.refresh();
  }
}

function renderReplayDeleteHost() {
  const host = document.querySelector<HTMLElement>("#replayDeleteHost");
  if (!host) return;
  host.innerHTML = renderReplayDeleteDialog();
  bindReplayDeleteDialogEvents();
}

function openReplayDeleteDialog() {
  if (browserDeleteInFlight) return;
  browserDeleteCandidates = selectedBrowserReplays();
  if (!browserDeleteCandidates.length) return;
  browserDeleteError = "";
  renderReplayDeleteHost();
  window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("#cancelReplayDelete")?.focus());
}

function closeReplayDeleteDialog() {
  if (browserDeleteInFlight) return;
  browserDeleteCandidates = [];
  browserDeleteError = "";
  renderReplayDeleteHost();
  window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("#deleteSelectedReplays")?.focus());
}

async function deleteReplayFromBrowser() {
  const candidates = [...browserDeleteCandidates];
  if (!candidates.length || browserDeleteInFlight) return;
  browserDeleteInFlight = true;
  browserDeleteError = "";
  renderReplayDeleteHost();
  refreshBrowserSelectionUi();
  const failures: Array<{ replay: ReplayBrowserItem; message: string }> = [];
  for (const [index, replay] of candidates.entries()) {
    const progress = document.querySelector<HTMLElement>("#confirmReplayDelete span");
    if (progress && candidates.length > 1) progress.textContent = `Deleting ${index + 1}/${candidates.length}`;
    try {
      await invoke<number>("delete_replay", { filePath: replay.filePath });
      browserSelectedReplayPaths.delete(replay.filePath);
    } catch (error) {
      failures.push({
        replay,
        message: error instanceof Error ? error.message : String(error || "Could not delete the replay."),
      });
    }
  }
  browserDeleteInFlight = false;
  browserDeleteCandidates = failures.map(({ replay }) => replay);
  browserDeleteError = failures.length
    ? `${failures.length} ${failures.length === 1 ? "replay could" : "replays could"} not be deleted. ${failures[0].message}`
    : "";
  renderReplayDeleteHost();
  await loadBrowserReplays(true);
  refreshBrowserSelectionUi();
  if (failures.length) {
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("#cancelReplayDelete")?.focus());
  }
}

async function downloadSelectedReplays() {
  const replays = selectedBrowserReplays();
  if (!replays.length || browserBulkDownloadInFlight || browserDeleteInFlight) return;
  browserBulkDownloadInFlight = true;
  refreshBrowserSelectionUi();
  try {
    if (replays.length === 1) {
      const replay = replays[0];
      await invoke<boolean>("download_replay", {
        filePath: replay.filePath,
        fileName: replayDownloadFileName(replay),
      });
    } else {
      await invoke<number>("download_replays", {
        replays: replays.map((replay) => ({
          filePath: replay.filePath,
          fileName: replayDownloadFileName(replay),
        })),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Could not save the selected replays.");
    window.alert(`Could not save the selected ${replays.length === 1 ? "replay" : "replays"}.\n\n${message}`);
  } finally {
    browserBulkDownloadInFlight = false;
    refreshBrowserSelectionUi();
  }
}

function recordSelectedReplays() {
  // Videos are converted in the background; no player window opens.
  void openExportSetup(selectedBrowserReplays());
}

async function uploadBrowserReplays(files: File[]) {
  if (browserUploading || !files.length) return;
  browserUploading = true;
  browserUploadLabel = files.length === 1 ? "Uploading..." : `Uploading 1/${files.length}`;
  renderReplayUploadDock();

  const failures: string[] = [];
  for (const [index, file] of files.entries()) {
    browserUploadLabel = files.length === 1 ? "Uploading..." : `Uploading ${index + 1}/${files.length}`;
    const label = document.querySelector<HTMLElement>("#uploadReplays span");
    if (label) label.textContent = browserUploadLabel;
    try {
      const buffer = await file.arrayBuffer();
      await invoke("upload_replay", {
        fileName: file.name,
        replayBase64: bytesToBase64(new Uint8Array(buffer)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Upload failed.");
      failures.push(`${file.name}: ${message}`);
    }
  }

  browserUploading = false;
  browserUploadLabel = "Upload";
  renderReplayUploadDock();
  await loadBrowserReplays(true);
  if (failures.length) {
    window.alert(`Could not upload ${failures.length} ${failures.length === 1 ? "replay" : "replays"}.\n\n${failures.join("\n\n")}`);
  }
}

function replayListSignature(replays: ReplayBrowserItem[]): string {
  return replays
    .map((replay) =>
      [
        replay.filePath,
        replay.modified,
        replay.durationSeconds,
        replay.thumbnailKey ?? "",
        replay.mapKey ?? "",
        replay.mapLabel ?? "",
        replay.eventLabel ?? "",
        replay.scoreDelta ?? "",
        replay.draw ? "draw" : "",
        replay.players.map((player) => `${player.name}:${player.winner ? "1" : "0"}`).join(","),
      ].join("|"),
    )
    .join("\n");
}

async function loadBrowserReplays(
  preserveControls = false,
  options: { quiet?: boolean } = {},
) {
  if (browserLoading) return;
  browserLoading = true;
  const hadError = Boolean(browserError);
  browserError = "";
  // A refresh keeps the cards on screen; only the controls show it is busy.
  if (!options.quiet && browserPage === "replays") {
    if (hadError) renderBrowserGridArea();
    syncBrowserControls();
  }
  let dataChanged = false;
  try {
    const payload = await invoke<ReplayBrowserPayload>("list_replays", {
      offset: 0,
      limit: 0,
    });
    const replays = payload.replays;
    const nextSignature = replayListSignature(replays);
    dataChanged = nextSignature !== browserReplaySignature;
    if (dataChanged) browserReplays = replays;
    const availablePaths = new Set(replays.map((replay) => replay.filePath));
    browserSelectedReplayPaths = new Set([...browserSelectedReplayPaths].filter((path) => availablePaths.has(path)));
    browserReplaySignature = nextSignature;
    setupBrowserDuration(replays, preserveControls);
  } catch (error) {
    if (!options.quiet) {
      browserError = error instanceof Error ? error.message : String(error || "Could not load replays.");
    }
  } finally {
    browserLoading = false;
    browserIndexProgress = null;
    if (browserPage === "replays") {
      syncBrowserControls();
      if (dataChanged || hadError !== Boolean(browserError) || !document.querySelector("#replayGridCards")) {
        renderBrowserGridArea(dataChanged);
      } else {
        applyBrowserSearch();
      }
      refreshBrowserSelectionUi();
    }
  }
}

// Shows indexing progress while a large or new library is read for the first time.
async function watchReplayIndexProgress() {
  if (exampleMode || !isTauri()) return;
  const show = (progress: ReplayIndexProgress | null) => {
    if (!browserLoading || !progress) return;
    const current = browserIndexProgress;
    // Updates arrive from several threads; never step backwards within a phase.
    if (current && current.phase === progress.phase && current.total === progress.total && current.done > progress.done) return;
    browserIndexProgress = progress;
    if (browserPage === "replays") updateBrowserLoadingProgress();
  };
  try {
    await listen<ReplayIndexProgress>("replay-index-progress", (event) => show(event.payload));
    // Indexing may have started before this window was listening.
    show(await invoke<ReplayIndexProgress | null>("replay_index_progress"));
  } catch {
    // Progress is optional; the loading message stays.
  }
}

async function loadBrowserLeaderboardRanks() {
  try {
    const snapshot = await retrieve<Snapshot>(LATEST_LEADERBOARD_PATH);
    const ranks = leaderboardRankIndex(snapshot);
    const signature = [...ranks].map(([name, rank]) => `${name}:${rank}`).join("|");
    if (signature === browserLeaderboardRankSignature) return;
    browserLeaderboardRanks = ranks;
    browserLeaderboardRankSignature = signature;
    // Rank captions are part of each card's markup.
    browserGrid?.rebuild();
  } catch {
    // Rank badges are optional. Keep replay browsing available while offline.
  }
}

function startBrowserRelativeTimeUpdates() {
  window.clearInterval(browserRelativeTimeTimer);
  browserRelativeTimeTimer = window.setInterval(updateReplayAgeLabels, 15_000);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

  renderReplayBrowser();

  if (!exampleMode) void initializeAppUpdater();
  void watchReplayIndexProgress();
  void loadBrowserReplays();
  void loadBrowserLeaderboardRanks();
  startBrowserRelativeTimeUpdates();
  window.addEventListener("keydown", (event) => {
    const wantsSearch = (event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f";
    if (!wantsSearch) return;
    const input = browserPage === "leaderboard"
      ? document.querySelector<HTMLInputElement>('[aria-label="Search leaderboard"]')
      : document.querySelector<HTMLInputElement>("#playerSearch");
    if (!input) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
