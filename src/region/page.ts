// Region page: shows whether War of Dots is running and steers its matchmaking
// to one region. The page polls while it is open so it notices the game starting
// or closing.
import { invoke } from "../platform";
import "./styles.css";

type RegionName = "NA" | "EU" | "ASIA";
// One of the game's servers, as the probe found it when a region was applied.
type ServerInfo = {
  host: string | null;
  cloudRegion: string | null;
  region: RegionName | null;
  reachable: boolean;
  ms: number | null;
};
type RegionStatus = {
  gameRunning: boolean;
  selectedRegion?: RegionName | null;
  selectedAt?: number | null;
  servers?: ServerInfo[] | null;
  unavailable?: string | null;
  pending?: boolean | null;
};

// The game lists servers in these two cities. The probe still chooses by
// region, so a server added in the same region is used without changes here.
const REGIONS: { name: RegionName; label: string; code: string }[] = [
  { name: "EU", label: "Frankfurt", code: "EU" },
  { name: "ASIA", label: "Singapore", code: "ASIA" },
];
const POLL_MS = 5000;

const ICONS = {
  globe: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
};

let host: HTMLElement | null = null;
let status: RegionStatus | null = null;
let checkedAt = 0;
let loading = false;
let applying: RegionName | null = null;
let error = "";
let pollTimer = 0;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : String(value || fallback);
}

function checkedLabel(): string {
  return checkedAt ? `Checked ${new Date(checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
}

function regionLabel(name: RegionName | null | undefined): string {
  return REGIONS.find((region) => region.name === name)?.label ?? "Automatic";
}

// The fastest server that answered in a region, null when the game has none
// there, or undefined before any server has been checked.
function regionServer(region: RegionName): ServerInfo | null | undefined {
  const servers = status?.gameRunning ? status.servers : null;
  if (!servers?.length) return undefined;
  const reachable = servers.filter((server) => server.region === region && server.reachable);
  return reachable.sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity))[0] ?? null;
}

function renderOption(region: (typeof REGIONS)[number], selected: RegionName | null, gameRunning: boolean): string {
  const isSelected = selected === region.name;
  const isApplying = applying === region.name;
  const server = regionServer(region.name);
  const disabled = !gameRunning || Boolean(applying) || isSelected || server === null;
  const state = isApplying
    ? "Applying"
    : isSelected
      ? "Selected"
      : server === null
        ? "No server"
        : gameRunning ? "Select" : "Unavailable";
  return `
    <button
      class="region-option ${isSelected ? "is-selected" : ""} ${isApplying ? "is-applying" : ""}"
      type="button"
      role="radio"
      aria-checked="${isSelected}"
      data-region="${region.name}"
      ${disabled ? "disabled" : ""}
    >
      <span class="region-option-code">${region.code}</span>
      <strong class="region-option-label">${region.label}</strong>
      ${server?.ms != null ? `<small class="region-option-server">${server.ms} ms</small>` : ""}
      <span class="region-option-state">
        ${isSelected ? ICONS.check : isApplying ? `<span class="region-spinner" aria-hidden="true"></span>` : ""}
        <span>${state}</span>
      </span>
    </button>
  `;
}

function render() {
  if (!host) return;
  const gameRunning = Boolean(status?.gameRunning);
  const selected = gameRunning ? status?.selectedRegion ?? null : null;
  const known = status !== null;
  const title = !known ? "Checking for War of Dots" : gameRunning ? "War of Dots is running" : "War of Dots is not running";
  const detail = !known
    ? "This takes a moment."
    : !gameRunning
      ? "Start the game to choose a server."
      : selected && status?.pending
        ? "Waiting for the game's server list. Reopen Play in the game if nothing changes."
        : selected
          ? "Player counts and ping on the Play screen now come from this server."
          : "Choose a server, then queue normally.";

  host.innerHTML = `
    <section class="region-page" aria-label="Region">
      <header class="region-heading">
        <div class="region-title">${ICONS.globe}<h1>Region</h1></div>
        <div class="region-heading-actions">
          <span class="region-checked">${checkedLabel()}</span>
          <button
            id="refreshRegion"
            class="region-icon-button ${loading ? "is-loading" : ""}"
            type="button"
            aria-label="Check again"
            title="Check again"
            ${loading || applying ? "disabled" : ""}
          >${ICONS.refresh}</button>
        </div>
      </header>
      <div class="region-status ${gameRunning ? "is-online" : known ? "is-offline" : ""}" aria-live="polite">
        <span class="region-status-dot" aria-hidden="true"></span>
        <span class="region-status-copy">
          <strong>${title}</strong>
          <small>${detail}</small>
        </span>
        ${gameRunning ? `
          <span class="region-current">
            <small>Current server</small>
            <strong>${regionLabel(selected)}</strong>
          </span>
        ` : ""}
      </div>
      ${error ? `<div class="region-error" role="alert">${escapeHtml(error)}</div>` : ""}
      <div class="region-options" role="radiogroup" aria-label="Servers">
        ${REGIONS.map((region) => renderOption(region, selected, gameRunning)).join("")}
      </div>
    </section>
  `;
  host.querySelector<HTMLButtonElement>("#refreshRegion")?.addEventListener("click", () => void loadStatus());
  host.querySelectorAll<HTMLButtonElement>("[data-region]").forEach((button) => {
    button.addEventListener("click", () => void selectRegion(button.dataset.region as RegionName));
  });
}

async function loadStatus(quiet = false) {
  if (loading || applying) return;
  loading = true;
  if (!quiet) {
    error = "";
    render();
  }
  const previous = JSON.stringify(status);
  try {
    status = await invoke<RegionStatus>("region_status");
    checkedAt = Date.now();
  } catch (reason) {
    if (!quiet) error = errorMessage(reason, "Could not check for War of Dots.");
  } finally {
    loading = false;
    // Quiet checks re-render only when something changed, so hover and focus stay put.
    const changed = JSON.stringify(status) !== previous;
    if (quiet && status?.gameRunning !== (JSON.parse(previous ?? "null") as RegionStatus | null)?.gameRunning) error = "";
    if (!quiet || changed) render();
    else host?.querySelector(".region-checked")?.replaceChildren(checkedLabel());
  }
}

async function selectRegion(region: RegionName) {
  if (applying || !REGIONS.some((option) => option.name === region)) return;
  applying = region;
  error = "";
  render();
  try {
    const { unavailable, ...next } = await invoke<RegionStatus>("select_region", { region });
    status = next;
    checkedAt = Date.now();
    if (unavailable) error = unavailable;
  } catch (reason) {
    error = errorMessage(reason, "Could not apply the region.");
  } finally {
    applying = null;
    render();
  }
}

export function mountRegionPage(element: HTMLElement) {
  host = element;
  render();
  void loadStatus(status !== null);
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => void loadStatus(true), POLL_MS);
}

export function unmountRegionPage() {
  window.clearInterval(pollTimer);
  pollTimer = 0;
  host = null;
}
