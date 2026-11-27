// The hosted site: a home page with the visitor's own replays, every shared replay and
// the published tournaments, each tournament's bracket and replays, and the player. Pages are
// addressed by paths under the site's folder, so every view can be shared as a
// link with its own preview (share/ serves them):
//   (the folder)          home
//   leaderboard           the Elo and World rankings, as More of Dots shows them
//   <tournament>          bracket; a tournament's earlier ids (its aliases) lead here
//   <tournament>/<match>  bracket with that match's replays open
//   <tournament>/replays  every replay of the tournament
//   <tournament>/<match>/<map>  watch a tournament game
//   mine/<id>             watch a replay kept in this browser
//   r/<id>                watch a shared replay
//   s?=<link>             watch the replay at a link, such as a Discord attachment
// Earlier links put the same paths after #/ and still open.
import "./base.js";
import { embedding } from "../player/main.js";
import { addFile } from "../player/host.js";
// After the player's styles, so the site's win where both style an element.
import "./site.css";
import { addReplay, getReplay, listReplays, refreshDetails, removeReplay, saveReplay } from "./library.js";
import { downloadLink, fetchShared, listShared, suggestShared, thumbLink, unshareReplay } from "./share.js";
import { addTroops, copy, copyShareLink, downloadKept, identityPicture, mapIdentity, mapKeys, mapLabel, mapName, mapPicture, publishedMaps, replayTroops, shareLink } from "./sharing.js";
import { box, connect, layout, nextMatches, roundName, sides } from "./bracket.js";
import { troopLinesMarkup } from "../replays/troop-lines";
import { MATCH_TYPES } from "../replays/filters";
import { cached, leaderboardRankIndex, retrieve, setLeaderboardSource } from "../leaderboard/client";
import { leave as leaveForPlay } from "../play/handoff.js";

const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
// The site's folder as a path, such as /wod-replay-player/; every page is under it.
const root = new URL(document.baseURI).pathname;
// GitHub Pages lets browsers keep every file for hours, so the lists of maps and
// tournaments are checked with the server on each visit; unchanged ones cost a 304.
const revalidate = { cache: "no-cache" };
const site = document.getElementById("site");
const player = () => window.replayPlayer;
const $ = (selector) => site.querySelector(selector);

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (size, paths, className = "") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${className}" style="--size:${size}px" aria-hidden="true">${paths}</svg>`;
const icons = {
  logo: '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="7" cy="11" r="5" fill="#5a92c4"/><circle cx="16" cy="11" r="4" fill="#e0a458"/></svg>',
  file: (size) => icon(size, '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6"/><path d="M9.5 13.5 12 11l2.5 2.5"/>'),
  search: icon(14, '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  close: (size = 14) => icon(size, '<path d="m6 6 12 12M18 6 6 18"/>'),
  link: icon(15, '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>'),
  download: icon(15, '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
  play: (size) => icon(size, '<path d="M7 4.5v15l12-7.5z"/>', "solid"),
  trophy: icon(15, '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  players: icon(15, '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>'),
  bracket: icon(15, '<path d="M4 5h5v6h6M4 19h5v-6M15 11v8h5"/>'),
  calendar: icon(15, '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  chevron: icon(14, '<path d="m6 9 6 6 6-6"/>'),
};

// Long names shrink until they fit their card or match.
function fitNames() {
  for (const element of site.querySelectorAll(".matchup, .match .name span, .fit")) {
    element.style.fontSize = "";
    if (!element.clientWidth) continue;
    // Names keep their full width while measured; past the smallest size they are cut short.
    element.classList.add("fitting");
    let size = parseFloat(getComputedStyle(element).fontSize);
    while (element.scrollWidth > element.clientWidth && size > 9) element.style.fontSize = `${(size -= 0.5)}px`;
    element.classList.remove("fitting");
  }
}
let fitFrame;
addEventListener("resize", () => {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(fitNames);
});
void document.fonts?.ready.then(fitNames);

// Menus in the style of the player's speed menu, in place of the browser's selects.
const dropdowns = new Map();
function dropdown(id, label, options, value, change) {
  dropdowns.set(id, change);
  const current = options.find(([key]) => key === value) ?? options[0];
  return `<div class="dropdown" data-dropdown="${id}">
    <button type="button" class="dropdown-button" aria-haspopup="menu" aria-expanded="false" aria-labelledby="${id}-label ${id}-value"><span class="dropdown-label" id="${id}-label">${escape(label)}:</span><span id="${id}-value" data-current>${escape(current[1])}</span>${icons.chevron}</button>
    <div class="dropdown-menu" role="menu" hidden>${options.map(([key, text]) =>
      `<button type="button" role="menuitemradio" data-value="${key}" aria-checked="${key === current[0]}">${escape(text)}</button>`).join("")}</div></div>`;
}
function closeDropdowns(except) {
  for (const element of site.querySelectorAll(".dropdown")) {
    if (element === except) continue;
    element.querySelector(".dropdown-menu").hidden = true;
    element.querySelector(".dropdown-button").setAttribute("aria-expanded", "false");
  }
}
site.addEventListener("click", (event) => {
  const element = event.target.closest(".dropdown");
  closeDropdowns(element);
  if (!element) return;
  const menu = element.querySelector(".dropdown-menu"),
    button = element.querySelector(".dropdown-button"),
    option = event.target.closest("[data-value]");
  // A checklist's options turn on and off and leave its menu open.
  if (option && element.hasAttribute("data-multi")) {
    const on = option.getAttribute("aria-checked") !== "true";
    option.setAttribute("aria-checked", String(on));
    dropdowns.get(element.dataset.dropdown)?.(option.dataset.value, on);
  } else if (option) {
    for (const item of menu.querySelectorAll("[data-value]")) item.setAttribute("aria-checked", String(item === option));
    button.querySelector("[data-current]").textContent = option.textContent;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.focus();
    dropdowns.get(element.dataset.dropdown)?.(option.dataset.value);
  } else if (event.target.closest(".dropdown-button")) {
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('[aria-checked="true"]')?.focus();
  }
});
site.addEventListener("keydown", (event) => {
  const element = event.target.closest?.(".dropdown");
  const menu = element?.querySelector(".dropdown-menu");
  if (!menu || menu.hidden) return;
  const items = [...menu.querySelectorAll("[data-value]")],
    at = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeDropdowns();
    element.querySelector(".dropdown-button").focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});

const duration = (frames) => {
  const s = Math.floor(frames / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const kilobytes = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
const totalSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : kilobytes(bytes));
const day = (date) => new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric" });
/// When a tournament ran: "September 5 – October 19", or its start while it runs.
const dates = (t) => (t.started ? (t.ended ? `${day(t.started)} – ${day(t.ended)}` : day(t.started)) : "");
// Side colours of the game, lightened to read on the dark plate.
const sideClasses = ["blue", "red", "purple", "orange"];
// Bracket names, followed by the in-game username when it is known and different.
const plain = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const withUsername = (name, username) => (username && plain(username) !== plain(name) ? `${name} (${username})` : name);
const versus = (names) =>
  names.map((name, side) => `<span class="${sideClasses[side] ?? ""}">${escape(name)}</span>`).join(' <span class="vs">vs</span> ');

// Elo ranks under players' names, as on the cards of More of Dots. The site reads the
// copy of the rankings its worker keeps for every visitor (share/src/leaderboard.js).
setLeaderboardSource(new URL("api", document.baseURI).href);
const LATEST = "/v1/leaderboard";
let ranks = leaderboardRankIndex(cached(LATEST)?.data);
const rankKey = (index) => JSON.stringify([...index]);
/// Reads the rankings once they are due to change, and shows new ranks on the cards.
async function loadRanks() {
  try {
    const next = leaderboardRankIndex(await retrieve(LATEST));
    if (rankKey(next) === rankKey(ranks)) return;
    ranks = next;
    if (shown === "home") {
      void renderMine();
      void renderAll();
    }
  } catch {
    // Cards show no ranks while the rankings cannot be read.
  }
}
// Names can carry a title after the username, as in "aexer0e [Champion]"; a player is
// known by the name without it, as the share worker's stats know them.
const baseName = (name) => name.replace(/\s*\[[^\]]*\]$/, "").trim();
const samePlayer = (name, player) => Boolean(player) && baseName(name).toLowerCase() === player.toLowerCase();
const rankOf = (name) => {
  const rank = ranks.get(baseName(name).toLocaleLowerCase());
  return rank ? `<span class="player-rank" title="Elo rank #${rank}">Rank <b>${rank}</b></span>` : "";
};
/// The players of a card in their side colours. Clicking a name shows that player's replays.
function matchup(players, filter, chosen = null) {
  if (!players.length) return '<span class="matchup"><span class="vs">Unknown players</span></span>';
  const name = (text, side) => filter
    ? `<button type="button" class="player-name ${sideClasses[side] ?? ""}" data-filter-player="${escape(text)}" aria-pressed="${samePlayer(text, chosen)}" title="${samePlayer(text, chosen) ? "Show every player" : `Show replays with ${escape(baseName(text))}`}">${escape(text)}</button>`
    : `<span class="player-name ${sideClasses[side] ?? ""}">${escape(text)}</span>`;
  const between = players.length > 2 ? "·" : "vs";
  return `<span class="matchup${players.length > 2 ? " many" : ""}">${players.map((text, side) =>
    `${side ? `<span class="vs">${between}</span>` : ""}<span class="rep-player">${name(text, side)}${rankOf(text)}</span>`).join("")}</span>`;
}
// When a card's replay was added or shared, written as More of Dots writes it: "3h ago · 5:43 PM".
const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
function ago(time, now = Date.now()) {
  const minutes = Math.max(1, Math.floor((now - time) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days <= 7 ? `${days}d ago` : `${Math.floor(days / 7)}w ago`;
}
function when(time, now = new Date()) {
  const date = new Date(time);
  const at = timeFormat.format(date);
  if (date.toDateString() === now.toDateString()) return at;
  if (date.toDateString() === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()) return `Yesterday at ${at}`;
  return `${dateFormat.format(date)}${date.getFullYear() !== now.getFullYear() ? `, ${date.getFullYear()}` : ""} ${at}`;
}
/// A replay card in the layout of More of Dots: the map with its name, length and match
/// format along the top, the players in the middle, and when it was added at the bottom,
/// where Play and the card's buttons show on hover.
function card({ href, label, picture, troops = "", map, mapId = null, length = "", mode = "", players, filter = null, time = 0, title = "", actions = "", corner = "", attrs = "" }) {
  const modeLabel = !mode ? "<span></span>"
    : filter ? `<button type="button" class="rep-label mode" data-filter-mode="${escape(mode)}" title="Show only ${escape(mode)}">${escape(mode)}</button>`
    : `<span class="rep-label mode">${escape(mode)}</span>`;
  const on = filter?.map?.id === mapId;
  const mapLabelMarkup = filter && mapId
    ? `<button type="button" class="rep-label" data-filter-map="${escape(mapId)}" data-map-name="${escape(map)}" aria-pressed="${on}" title="${on ? "Show every map" : `Show replays on ${escape(map)}`}">${escape(map)}</button>`
    : `<span class="rep-label">${escape(map)}</span>`;
  return `<article class="rep-card">
    <div class="rep-picture">${picture ? `<img class="rep-thumb" src="${escape(picture)}" alt="" loading="lazy" onerror="this.remove()">` : ""}<span class="shade"></span>${troops}</div>
    <div class="rep-labels">${mapLabelMarkup}${length ? `<span class="rep-label length">${length}</span>` : "<span></span>"}${modeLabel}</div>
    <div class="rep-players">${matchup(players, Boolean(filter), filter?.player)}</div>
    ${time ? `<time class="rep-age" datetime="${new Date(time).toISOString()}" title="${escape(title)}"><span>${ago(time)}</span><span aria-hidden="true">·</span><span class="rep-date">${when(time)}</span></time>` : ""}
    <div class="rep-actions"><a class="rep-play" href="${href}"${attrs} aria-label="${label}">${icons.play(11)}Play</a>${actions}</div>
    ${corner}
  </article>`;
}
const lengthOf = (frames) => (frames ? padded(Math.floor(frames / 30)) : "");
const counted = (n) => `${n.toLocaleString("en-US")} ${n === 1 ? "replay" : "replays"}`;

let toastTimer;
function toast(message) {
  let element = document.querySelector(".site-toast");
  if (!element) {
    element = Object.assign(document.createElement("div"), { className: "site-toast" });
    element.setAttribute("role", "status");
    document.body.append(element);
  }
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), 6000);
}

// Views: "page" shows the site, "watch" shows the player.
let view = null,
  leaving = null,
  shown = null,
  navigations = 0,
  backTarget = "";
function setView(next) {
  if (view === "watch" && next !== "watch") {
    player().pause();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }
  view = next;
  document.body.dataset.view = next;
}
/// Shows a page, keeping the scroll position only when the same page is redrawn.
function showPage(key, title, html) {
  setView("page");
  document.title = title;
  const fresh = shown !== key;
  if (fresh) {
    leaving?.();
    leaving = null;
    site.innerHTML = html;
    shown = key;
    scrollTo(0, 0);
  }
  return fresh;
}
// The site's tabs, centred as in More of Dots. `active` is the path of the current tab.
const TABS = [["", "Replays"], ["leaderboard", "Leaderboard"]];
const header = (wide = false, active = null) =>
  `<header class="site-header${wide ? " wide" : ""}"><div><a class="brand" href="${root}">${icons.logo}<span>War of Dots Replays</span></a>
    <nav class="site-nav" aria-label="Site">${TABS.map(([path, text]) => `<a href="${root}${path}"${path === active ? ' aria-current="page"' : ""}>${text}</a>`).join("")}</nav>
    <span class="storage" id="storage"></span></div></header>`;
async function showStorage() {
  const list = await listReplays().catch(() => []);
  const element = document.getElementById("storage");
  if (element)
    element.textContent = list.length
      ? `${list.length} ${list.length === 1 ? "replay" : "replays"} · ${totalSize(list.reduce((sum, r) => sum + r.size, 0))} in this browser`
      : "";
}
function notFound(message) {
  showPage("not-found", "Not found · War of Dots Replays", `${header()}<main class="page"><p class="empty">${escape(message)} <a href="${root}">Home</a></p></main>`);
  // Every message is drawn afresh.
  shown = null;
}

// Replays kept in this browser.
async function keepFiles(files) {
  const kept = [],
    failed = [];
  for (const file of files)
    try {
      kept.push(await addReplay(file));
    } catch (error) {
      failed.push(`${file.name}: ${error.message}`);
    }
  if (failed.length) toast(failed.length === 1 ? failed[0] : `${failed.length} files are not War of Dots replays.`);
  if (kept.length === 1) go(`mine/${kept[0].record.id}`);
  else if (kept.length) {
    const added = kept.filter((k) => k.added).length;
    toast(added === kept.length ? `Added ${added} replays.` : `Added ${added} replays. ${kept.length - added} were already here.`);
    if (currentPath()) go("");
    else renderMine();
  }
  void showStorage();
}
/// A web address typed or pasted by the visitor, plain or percent-encoded, or null.
function parseLink(text) {
  text = text.trim();
  try {
    const url = new URL(/^https?%3a/i.test(text) ? decodeURIComponent(text) : text);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
const linkName = (url) => decodeURIComponent(url.pathname.split("/").pop() || "") || "replay.rep";
/// Keeps the replay a link points to, such as a Discord attachment.
async function openLink(text) {
  const url = parseLink(text);
  if (!url) return toast("That is not a link.");
  const button = site.querySelector("#link-form .btn");
  if (button) button.disabled = true;
  toast("Downloading the replay.");
  try {
    const blob = await downloadLink(url);
    document.querySelector(".site-toast")?.setAttribute("hidden", "");
    await keepFiles([new File([blob], linkName(url))]);
    if ($("#link")) $("#link").value = "";
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}
function choose() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".rep", multiple: true });
  input.onchange = () => input.files.length && keepFiles([...input.files]);
  input.click();
}

// Both lists on the home page sort and filter alike, as More of Dots does: by match
// format, kind of map and length. "Your replays" are filtered here; "All replays",
// every replay shared from the site or the app, by the share worker.
const SORTS = [["newest", "Newest"], ["oldest", "Oldest"], ["shortest", "Shortest"], ["longest", "Longest"]];
const MODES = MATCH_TYPES.map((type) => [type, type]);
const MAP_KINDS = [["vanilla", "Vanilla"], ["custom", "Custom"]];
// `min` and `max` are lengths in seconds; `max` is null when the longest replay is
// allowed. `bound` is the length filter's end, from the longest replay listed.
// `player` and `map` are the player and the map chosen from the search's suggestions or
// a card, as in More of Dots: a name, and { id, name } of a map (sharing.js, mapIdentity).
const listState = () => ({ page: 0, query: "", sort: "newest", modes: new Set(MATCH_TYPES), maps: new Set(["vanilla", "custom"]), min: 0, max: null, bound: 60, player: null, map: null });
// The official maps the site publishes, once they are read.
let knownMaps = new Set();
const home = listState(),
  everyone = listState();
const perPage = 8,
  allPerPage = 12;
// Lengths on the slider as More of Dots writes them: 05:00.
const padded = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
const boundOf = (frames) => Math.max(60, Math.ceil((frames || 0) / 1800) * 60);
const kindOf = (record) => (record.custom ? "custom" : "vanilla");
const isFiltered = (state) => state.modes.size < MATCH_TYPES.length || state.maps.size < MAP_KINDS.length || state.min > 0 || state.max !== null;

function summary(selected, options) {
  const chosen = options.filter(([value]) => selected.has(value)).map(([, text]) => text);
  if (chosen.length === options.length) return "All";
  if (!chosen.length) return "None";
  return chosen.length <= 2 ? chosen.join(", ") : `${chosen.length} of ${options.length}`;
}
/// A menu like dropdown() whose options are each turned on or off.
function checklist(id, label, options, selected, change) {
  dropdowns.set(id, change);
  return `<div class="dropdown" data-dropdown="${id}" data-multi>
    <button type="button" class="dropdown-button" aria-haspopup="menu" aria-expanded="false" aria-labelledby="${id}-label ${id}-value"><span class="dropdown-label" id="${id}-label">${escape(label)}:</span><span id="${id}-value" data-current>${escape(summary(selected, options))}</span>${icons.chevron}</button>
    <div class="dropdown-menu" role="menu" hidden>${options.map(([key, text]) =>
      `<button type="button" role="menuitemcheckbox" data-value="${key}" aria-checked="${selected.has(key)}"><span>${escape(text)}</span><span class="count" data-count="${key}"></span></button>`).join("")}</div></div>`;
}

// The length filter's two handles move along a curve, so short lengths can be picked closely.
const STEPS = 1000;
const toSeconds = (position, bound) => Math.round((bound * (position / STEPS) ** 2) / 5) * 5;
const toPosition = (seconds, bound) => Math.round(Math.sqrt(Math.min(seconds, bound) / bound) * STEPS);
// The search, as in More of Dots: the text filters the list as it is typed, and the box
// suggests the players and maps it could mean, with how many replays each has under the
// other filters. Choosing one filters by that player or map, shown as a chip in the box.
const PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg>';
const SUGGESTED = 8;
function marked(text, query) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return at < 0 ? escape(text) : `${escape(text.slice(0, at))}<mark>${escape(text.slice(at, at + query.length))}</mark>${escape(text.slice(at + query.length))}`;
}
function searchBox(key) {
  return `<div class="search-combobox">
    <div class="search">${icons.search}<input type="search" id="${key}-search" placeholder="Search players or maps" aria-label="Search players or maps" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${key}-suggestions">
      <span class="active-filters" id="${key}-chips"></span>
      <button type="button" class="search-clear" id="${key}-search-clear" aria-label="Clear search and filters" title="Clear search and filters" hidden>×</button></div>
    <div class="suggestion-panel" hidden><div class="suggestion-list" id="${key}-suggestions" role="listbox" aria-label="Player and map suggestions"></div></div>
  </div>`;
}
/// Shows a list's chosen player and map as chips in its search box.
function showChips(key) {
  const state = lists[key].state;
  const chips = [state.player && ["player", state.player], state.map && ["map", state.map.name]].filter(Boolean);
  $(`#${key}-chips`).innerHTML = chips.map(([kind, name]) =>
    `<button type="button" class="filter-chip" data-unfilter="${kind}" aria-label="Remove the ${kind} filter ${escape(name)}" title="Remove this filter"><span class="filter-chip-name">${escape(name)}</span><span aria-hidden="true">×</span></button>`).join("");
  $(`#${key}-search-clear`).hidden = !(state.query || chips.length);
}
/// Filters a list by a player or a map, or by none when `value` is null.
function setFilter(key, kind, value) {
  const state = lists[key].state;
  state[kind] = value;
  state.page = 0;
  showChips(key);
  lists[key].render();
}
function wireSearch(key) {
  const state = lists[key].state;
  const input = $(`#${key}-search`),
    clear = $(`#${key}-search-clear`),
    chips = $(`#${key}-chips`),
    list = $(`#${key}-suggestions`),
    panel = list.parentElement;
  const found = { items: [], active: -1, ticket: 0, timer: 0 };
  const close = () => {
    found.ticket++;
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    found.active = -1;
  };
  const search = (text) => {
    state.query = text;
    state.page = 0;
    showChips(key);
    lists[key].render();
  };
  const paint = () => {
    const query = state.query.trim();
    const option = (item, index) => {
      const chosen = item.kind === "player" ? samePlayer(item.name, state.player) : item.id === state.map?.id;
      return `<button type="button" tabindex="-1" role="option" id="${key}-suggestion-${index}" class="suggestion${index === found.active ? " is-active" : ""}" data-suggestion="${index}" aria-selected="${index === found.active}" title="${chosen ? "Clear" : "Filter by"} ${item.kind}: ${escape(item.name)}">
        <span class="suggestion-icon">${item.picture ? `<img src="${escape(item.picture)}" alt="" loading="lazy" onerror="this.remove()">` : item.kind === "player" ? PERSON : '<span class="suggestion-hash">#</span>'}</span>
        <span class="suggestion-body"><span class="suggestion-primary"><span class="suggestion-name">${marked(item.name, query)}</span><span class="suggestion-meta">${counted(item.count)}</span></span>
        ${item.detail ? `<span class="suggestion-detail">${escape(item.detail)}</span>` : ""}</span>${chosen ? '<span class="suggestion-clear">✓ Clear</span>' : ""}</button>`;
    };
    const groups = [["player", "Players"], ["map", "Maps"]].map(([kind, title]) => {
      const items = found.items.map((item, index) => [item, index]).filter(([item]) => item.kind === kind);
      return items.length ? `<div class="suggestion-group" role="group" aria-label="${title}"><div class="suggestion-heading" aria-hidden="true">${title} (${items.length})</div>${items.map(([item, index]) => option(item, index)).join("")}</div>` : "";
    }).join("");
    list.innerHTML = groups || '<div class="suggestion-empty" role="status">No players or maps match these filters.</div>';
    if (found.active >= 0) {
      input.setAttribute("aria-activedescendant", `${key}-suggestion-${found.active}`);
      $(`#${key}-suggestion-${found.active}`)?.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const refresh = async () => {
    const query = state.query.trim();
    if (!query || document.activeElement !== input) return close();
    const ticket = ++found.ticket;
    let items;
    try {
      items = await lists[key].suggest(query);
    } catch {
      items = [];
    }
    if (ticket !== found.ticket || document.activeElement !== input) return;
    found.items = items;
    found.active = items.length ? 0 : -1;
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    paint();
  };
  // Choosing a suggestion filters by it, or clears that filter when it is the one set.
  const choose = (index) => {
    const item = found.items[index];
    if (!item) return;
    close();
    input.value = "";
    state.query = "";
    if (item.kind === "player") setFilter(key, "player", samePlayer(item.name, state.player) ? null : baseName(item.name));
    else setFilter(key, "map", item.id === state.map?.id ? null : { id: item.id, name: item.name });
  };
  input.value = state.query;
  showChips(key);
  input.oninput = () => {
    search(input.value);
    clearTimeout(found.timer);
    found.timer = setTimeout(refresh, 150);
  };
  input.onfocus = () => void refresh();
  input.onblur = () => close();
  input.onkeydown = (event) => {
    // Backspace in an empty box removes the last chip, as in a field of tags.
    if (event.key === "Backspace" && !input.value && (state.map || state.player)) {
      event.preventDefault();
      return setFilter(key, state.map ? "map" : "player", null);
    }
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      return close();
    }
    if (panel.hidden || !found.items.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const n = found.items.length;
      found.active = event.key === "ArrowDown" ? (found.active + 1) % n : found.active <= 0 ? n - 1 : found.active - 1;
      paint();
    } else if (event.key === "Enter" && found.active >= 0) {
      event.preventDefault();
      choose(found.active);
    }
  };
  // The input keeps the focus while a suggestion is clicked.
  panel.onmousedown = (event) => event.preventDefault();
  panel.onclick = (event) => {
    const option = event.target.closest("[data-suggestion]");
    if (option) choose(Number(option.dataset.suggestion));
  };
  chips.onclick = (event) => {
    const chip = event.target.closest("[data-unfilter]");
    if (chip) setFilter(key, chip.dataset.unfilter, null);
  };
  clear.onmousedown = (event) => event.preventDefault();
  clear.onclick = () => {
    input.value = "";
    Object.assign(state, { query: "", player: null, map: null });
    search("");
    close();
    input.focus();
  };
}
const leading = (item, text) => (item.name.toLowerCase().startsWith(text) ? 0 : 1);
/// Suggestions for the visitor's replays, read from the replays themselves.
async function suggestMine(query) {
  const [list, maps] = await Promise.all([listReplays().catch(() => []), publishedMaps()]);
  knownMaps = maps;
  const text = query.toLowerCase();
  const players = new Map(),
    places = new Map();
  for (const r of list) {
    if (keepMine(r, "player"))
      r.players.forEach((full, side) => {
        const name = baseName(full);
        if (!name.toLowerCase().includes(text)) return;
        const item = players.get(name.toLowerCase()) ?? { kind: "player", name, count: 0, latest: 0, against: new Map() };
        item.count++;
        item.latest = Math.max(item.latest, r.added);
        r.players.forEach((other, at) => at !== side && item.against.set(baseName(other), (item.against.get(baseName(other)) ?? 0) + 1));
        players.set(name.toLowerCase(), item);
      });
    const id = mapIdentity(r.mapKey, maps);
    const name = mapLabelOf(r, maps);
    if (!id || !keepMine(r, "map") || !name.toLowerCase().includes(text)) continue;
    const item = places.get(id) ?? { kind: "map", id, name, count: 0, latest: 0, picture: r.custom ? r.thumb : identityPicture(id, maps), detail: r.custom ? "Custom" : "Vanilla" };
    item.count++;
    item.latest = Math.max(item.latest, r.added);
    places.set(id, item);
  }
  const order = (a, b) => leading(a, text) - leading(b, text) || b.count - a.count || b.latest - a.latest || a.name.localeCompare(b.name);
  return [
    ...[...players.values()].sort(order).slice(0, SUGGESTED).map(({ against, ...item }) => ({
      ...item,
      detail: against.size ? `vs ${[...against].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name).join(", ")}` : "",
    })),
    ...[...places.values()].sort(order).slice(0, SUGGESTED),
  ];
}
/// Suggestions for every shared replay, counted by the share worker from the totals it keeps.
async function suggestAll(query) {
  const maps = (knownMaps = await publishedMaps());
  const text = query.toLowerCase();
  const data = await suggestShared({ ...sharedFilters(everyone, maps), q: query, ...refsParam(query, maps) });
  // An official map named by its image and by its number is one map.
  const places = new Map();
  for (const m of data.maps) {
    const id = mapIdentity(m.key, maps);
    const custom = m.key.startsWith("custom:");
    const item = places.get(id) ?? { kind: "map", id, name: mapLabel(m.key, maps), count: 0, latest: 0, picture: identityPicture(id, maps), detail: custom ? "Custom" : "Vanilla" };
    item.count += m.count;
    item.latest = Math.max(item.latest, m.latest);
    places.set(id, item);
  }
  const order = (a, b) => leading(a, text) - leading(b, text) || b.count - a.count || b.latest - a.latest;
  return [
    ...data.players.map((p) => ({ kind: "player", name: p.name, count: p.count, latest: p.latest, detail: `Latest ${dateFormat.format(new Date(p.latest))}` })).sort(order),
    ...[...places.values()].sort(order).slice(0, SUGGESTED),
  ];
}
/// The ways replays name the official maps whose names contain the text: by image or by
/// number, so the share worker, which knows only images, can match map names.
function refsParam(query, maps) {
  const text = query.trim().toLowerCase();
  if (text.length < 2) return {};
  const refs = new Set();
  for (const file of maps) {
    if (!mapName(file, maps)?.toLowerCase().includes(text)) continue;
    for (const key of mapKeys(`vanilla:${file}`, maps)) refs.add(key.slice(8));
  }
  return refs.size ? { refs: [...refs].slice(0, 200).join(",") } : {};
}
/// The filters of "All replays" other than its text, as the share worker reads them.
function sharedFilters(s, maps) {
  const params = {};
  if (s.modes.size < MATCH_TYPES.length) params.modes = [...s.modes].join(",");
  if (s.maps.size < MAP_KINDS.length) params.maps = [...s.maps].join(",");
  if (s.min > 0) params.min = s.min;
  if (s.max !== null) params.max = s.max;
  if (s.player) params.player = s.player;
  if (s.map) params.map = mapKeys(s.map.id, maps).join(",");
  return params;
}

/// A list's search and filters in one row, as the replay browser of More of Dots has them.
function toolbar(key, state) {
  return `<div class="toolbar" id="${key}-filters">
    ${searchBox(key)}
    <div class="filter-controls">
      ${checklist(`${key}-modes`, "Mode", MODES, state.modes, (value, on) => toggleFilter(key, "modes", value, on))}
      ${checklist(`${key}-maps`, "Map", MAP_KINDS, state.maps, (value, on) => toggleFilter(key, "maps", value, on))}
      <div class="length-filter" role="group" aria-label="Length">
        <span class="length-value" id="${key}-min-label"></span>
        <span class="length-slider"><span class="length-track"></span><span class="length-fill" id="${key}-fill"></span>
          <input type="range" id="${key}-min" min="0" max="${STEPS}" step="1" value="0" aria-label="Shortest length">
          <input type="range" id="${key}-max" min="0" max="${STEPS}" step="1" value="${STEPS}" aria-label="Longest length"></span>
        <span class="length-value" id="${key}-max-label"></span></div>
      ${dropdown(`${key}-sort`, "Sort", SORTS, state.sort, (sort) => {
        state.sort = sort;
        state.page = 0;
        lists[key].render();
      })}
      <button type="button" class="btn clear-filters is-off" id="${key}-clear" disabled>Clear filters</button>
    </div>
  </div>`;
}
const lists = {
  mine: { state: home, render: () => renderMine(), suggest: (query) => suggestMine(query) },
  all: { state: everyone, render: () => renderAllSoon(), suggest: (query) => suggestAll(query) },
};
const secondsOf = (r) => Math.floor(r.frames / 30);
/// Whether one of the visitor's replays passes the filters, leaving out one when asked.
const keepMine = (r, omit) =>
  (omit === "modes" || home.modes.has(r.mode)) && (omit === "maps" || home.maps.has(kindOf(r)))
  && secondsOf(r) >= home.min && (home.max === null || secondsOf(r) <= home.max)
  && (omit === "player" || !home.player || r.players.some((name) => samePlayer(name, home.player)))
  && (omit === "map" || !home.map || mapIdentity(r.mapKey, knownMaps) === home.map.id);
const mapLabelOf = (r, maps) => (r.mapKey ? mapLabel(r.mapKey, maps) : r.custom ? "Custom map" : (mapName(r.mapRef, maps) ?? "Unknown map"));
function filtersChanged(key) {
  lists[key].state.page = 0;
  showFilters(key);
  lists[key].render();
}
function toggleFilter(key, group, value, on) {
  const chosen = lists[key].state[group];
  if (on) chosen.add(value);
  else chosen.delete(value);
  filtersChanged(key);
}
/// Shows a list's filters as its state has them.
function showFilters(key) {
  const state = lists[key].state;
  for (const [group, options] of [["modes", MODES], ["maps", MAP_KINDS]]) {
    const menu = $(`[data-dropdown="${key}-${group}"]`);
    if (!menu) return;
    for (const item of menu.querySelectorAll("[data-value]")) item.setAttribute("aria-checked", String(state[group].has(item.dataset.value)));
    $(`#${key}-${group}-value`).textContent = summary(state[group], options);
  }
  $(`#${key}-min`).value = toPosition(state.min, state.bound);
  $(`#${key}-max`).value = state.max === null ? STEPS : toPosition(state.max, state.bound);
  paintLength(key);
  showClear(key);
}
/// Clear filters keeps its place while hidden, so the bar does not move as filters change.
function showClear(key) {
  const button = $(`#${key}-clear`);
  button.classList.toggle("is-off", !isFiltered(lists[key].state));
  button.disabled = !isFiltered(lists[key].state);
}
function paintLength(key) {
  const state = lists[key].state;
  const min = $(`#${key}-min`),
    max = $(`#${key}-max`);
  $(`#${key}-min-label`).textContent = padded(state.min);
  $(`#${key}-max-label`).textContent = padded(state.max ?? state.bound);
  $(`#${key}-fill`).style.cssText = `left:${(min.value / STEPS) * 100}%;right:${100 - (max.value / STEPS) * 100}%`;
}
function wireFilters(key) {
  const state = lists[key].state;
  const min = $(`#${key}-min`),
    max = $(`#${key}-max`);
  const moved = (handle) => {
    if (Number(min.value) > Number(max.value)) handle.value = handle === min ? max.value : min.value;
    state.min = Number(min.value) === 0 ? 0 : toSeconds(Number(min.value), state.bound);
    state.max = Number(max.value) === STEPS ? null : toSeconds(Number(max.value), state.bound);
    state.page = 0;
    paintLength(key);
    showClear(key);
    lists[key].render();
  };
  min.oninput = () => moved(min);
  max.oninput = () => moved(max);
  $(`#${key}-clear`).onclick = () => {
    Object.assign(state, { modes: new Set(MATCH_TYPES), maps: new Set(MAP_KINDS.map(([kind]) => kind)), min: 0, max: null });
    filtersChanged(key);
  };
  showFilters(key);
}
/// How many replays each option would show, given the other filters.
function showCounts(key, counts) {
  for (const [group, values] of Object.entries(counts))
    for (const element of site.querySelectorAll(`[data-dropdown="${key}-${group}"] [data-count]`))
      element.textContent = String(values[element.dataset.count] ?? 0);
}
/// Sets the length filter's end from the longest replay listed, keeping what the visitor chose.
function setBound(key, frames) {
  const state = lists[key].state,
    bound = boundOf(frames);
  if (bound === state.bound) return;
  state.bound = bound;
  if (state.max !== null && state.max >= bound) state.max = null;
  state.min = Math.min(state.min, bound);
  showFilters(key);
}
/// Page buttons around the current page, with the first and last.
function pager(state, total, per, label) {
  const pages = Math.ceil(total / per);
  if (pages <= 1) return "";
  const first = state.page * per;
  const near = [...new Set([0, state.page - 1, state.page, state.page + 1, pages - 1])].filter((i) => i >= 0 && i < pages).sort((a, b) => a - b);
  let numbers = "",
    previous = -1;
  for (const i of near) {
    if (i > previous + 1) numbers += '<span class="page-gap" aria-hidden="true">…</span>';
    numbers += `<button type="button" class="btn page-number" data-page="${i}" aria-label="Page ${i + 1}"${i === state.page ? ' aria-current="page"' : ""}>${i + 1}</button>`;
    previous = i;
  }
  return `<nav class="pager" aria-label="${label}"><span class="note">Showing ${first + 1} to ${Math.min(total, first + per)} of ${total}</span><div>
    <button type="button" class="btn" data-page="${state.page - 1}"${state.page === 0 ? " disabled" : ""}>Previous</button>${numbers}
    <button type="button" class="btn" data-page="${state.page + 1}"${state.page === pages - 1 ? " disabled" : ""}>Next</button></div></nav>`;
}
const listHead = (key, title) => `<div class="section-head"><h2 id="${key}-title">${title}</h2><span class="section-count" id="${key}-count"></span></div>
  ${toolbar(key, lists[key].state)}`;
function wireList(key, onClick) {
  const state = lists[key].state;
  wireSearch(key);
  wireFilters(key);
  $(`#${key}`).onclick = (event) => {
    const name = event.target.closest("[data-filter-player]");
    if (name) {
      const player = baseName(name.dataset.filterPlayer);
      return setFilter(key, "player", samePlayer(player, state.player) ? null : player);
    }
    const map = event.target.closest("[data-filter-map]");
    if (map) {
      const id = map.dataset.filterMap;
      return setFilter(key, "map", state.map?.id === id ? null : { id, name: map.dataset.mapName });
    }
    const mode = event.target.closest("[data-filter-mode]");
    if (mode) {
      state.modes = new Set([mode.dataset.filterMode]);
      return filtersChanged(key);
    }
    const page = event.target.closest("[data-page]");
    if (!page) return onClick(event);
    state.page = Number(page.dataset.page);
    lists[key].render();
    $(`#${key}-title`).scrollIntoView({ block: "start" });
  };
}

function showHome() {
  const fresh = showPage(
    "home",
    "War of Dots Replays",
    `${header(false, "")}<main class="page">
      <section class="dropzone" aria-label="Add replays">
        <span class="drop-icon">${icons.file(24)}</span>
        <span class="drop-copy"><h1>Drop a .rep to watch it</h1><span>Replays you add stay in this browser until you share them.</span></span>
        <button type="button" class="btn btn-primary" id="choose">Choose files</button>
        <form class="link-form" id="link-form">
          <label class="search">${icons.link}<span class="sr-only">Replay link</span><input type="url" id="link" placeholder="Or paste a link to a .rep" required></label>
          <button type="submit" class="btn">Open</button>
        </form>
      </section>
      <section class="stack" aria-labelledby="mine-title">${listHead("mine", "Your replays")}<div id="mine"></div></section>
      <section class="stack" aria-labelledby="all-title">${listHead("all", "All replays")}<div id="all"></div></section>
      <section class="stack" id="tournaments" aria-labelledby="tournaments-title"></section>
      <button type="button" class="world-egg" id="world-egg" title="Play the world map" aria-label="Play the world map"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="8" cy="8" r="6.4"/><ellipse cx="8" cy="8" rx="2.8" ry="6.4"/><path d="M1.6 8h12.8"/></svg></button>
    </main>`,
  );
  if (fresh) {
    $("#choose").onclick = choose;
    $("#world-egg").onclick = (event) => void openWorldRoom(event.currentTarget);
    $("#link-form").onsubmit = (event) => {
      event.preventDefault();
      void openLink($("#link").value);
    };
    wireList("mine", (event) => {
      const remove = event.target.closest("[data-remove]");
      const shareButton = event.target.closest("[data-share]");
      const downloadButton = event.target.closest("[data-download]");
      if (remove) void forget(remove);
      else if (shareButton) void share(shareButton);
      else if (downloadButton) void download(downloadButton.dataset.download);
    });
    wireList("all", (event) => {
      const watch = event.target.closest("[data-browse]");
      const downloadButton = event.target.closest("[data-download]");
      const linkButton = event.target.closest("[data-link]");
      // Watching a replay from this list does not keep it in "Your replays".
      if (watch) browsing.add(watch.dataset.browse);
      else if (downloadButton) void downloadShared(downloadButton);
      else if (linkButton) void copyLink(linkButton.dataset.link);
      else if (event.target.closest("[data-retry]")) void renderAll();
    });
  }
  void renderMine();
  void renderAll();
  void renderTournaments();
  void showStorage();
  void loadRanks();
}
/// Removes a replay from this browser and, when this browser shared it, stops sharing it.
async function forget(button) {
  const id = button.dataset.remove;
  const record = await getReplay(id);
  const token = record?.shared?.token;
  if (token) {
    button.disabled = true;
    try {
      await unshareReplay(id, token);
    } catch (error) {
      button.disabled = false;
      return toast(error.message);
    }
  }
  await removeReplay(id);
  void renderMine();
  if (token) void renderAll();
  void showStorage();
  const what = record?.players.join(" vs ") || "the replay";
  toast(token ? `Removed ${what} and stopped sharing it.` : `Removed ${what}.`);
}
/// Uploads a replay the first time it is shared, then copies its link.
async function share(button) {
  button.disabled = true;
  try {
    toast(await copyShareLink(button.dataset.share));
  } catch (error) {
    toast(error.message);
  }
  void renderMine();
  void renderAll();
}
async function download(id) {
  const record = await getReplay(id);
  if (record) downloadKept(record);
}
/// Draws a replay's troop lines on its card once they are simulated.
const showTroops = (record) =>
  void replayTroops(record).then((troops) => {
    if (troops) for (const element of site.querySelectorAll(`[data-troops="${record.id}"]`)) element.innerHTML = troopLinesMarkup(troops);
  });

async function renderMine() {
  const element = $("#mine");
  if (!element) return;
  let list = await listReplays().catch(() => []);
  // Replays kept before the site read their match format get it once.
  const older = list.filter((r) => !("mapKey" in r));
  if (older.length) {
    const refreshed = await Promise.all(older.map((r) => refreshDetails(r).catch(() => r)));
    list = list.filter((r) => !older.includes(r)).concat(refreshed);
  }
  const maps = (knownMaps = await publishedMaps());
  if ($("#mine") !== element) return;
  const total = list.length;
  $("#mine-filters").hidden = !total;
  setBound("mine", Math.max(0, ...list.map((r) => r.frames)));
  const query = home.query.trim().toLowerCase();
  const found = query ? list.filter((r) => [...r.players, r.name, mapLabelOf(r, maps)].some((text) => text.toLowerCase().includes(query))) : list;
  const keep = keepMine;
  const count = (omit, value) => found.reduce((counts, r) => {
    if (keep(r, omit)) counts[value(r)] = (counts[value(r)] ?? 0) + 1;
    return counts;
  }, {});
  showCounts("mine", { modes: count("modes", (r) => r.mode), maps: count("maps", kindOf) });
  list = found.filter((r) => keep(r));
  const order = {
    newest: (a, b) => b.added - a.added,
    oldest: (a, b) => a.added - b.added,
    longest: (a, b) => b.frames - a.frames || b.added - a.added,
    shortest: (a, b) => a.frames - b.frames || b.added - a.added,
  };
  list.sort(order[home.sort]);
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  home.page = Math.min(home.page, pages - 1);
  const first = home.page * perPage,
    page = list.slice(first, first + perPage);
  const mineCard = (r) => {
    const what = escape(r.players.join(" vs "));
    const removal = r.shared?.token ? "Remove from this browser and stop sharing" : "Remove from this browser";
    return card({
      href: `${root}mine/${r.id}`,
      label: `Watch ${what}, ${duration(r.frames)}`,
      picture: r.thumb ?? mapPicture(r.mapRef, maps),
      troops: `<span class="replay-troops" data-troops="${r.id}">${r.troops ? troopLinesMarkup(r.troops) : ""}</span>`,
      map: mapLabelOf(r, maps),
      mapId: mapIdentity(r.mapKey, maps),
      filter: home,
      length: lengthOf(r.frames),
      mode: r.mode,
      players: r.players,
      time: r.added,
      title: [`Added ${new Date(r.added).toLocaleString()}`, r.version && `v${r.version}`, kilobytes(r.size)].filter(Boolean).join(" · "),
      actions: `<button type="button" class="rep-round" data-download="${r.id}" aria-label="Download: ${what}" title="Download">${icons.download}</button>
        <button type="button" class="rep-round${r.shared ? " shared" : ""}" data-share="${r.id}" aria-label="${r.shared ? "Copy link" : "Share"}: ${what}" title="${r.shared ? "Copy link" : "Share"}">${icons.link}</button>`,
      corner: `<button type="button" class="rep-round rep-remove" data-remove="${r.id}" aria-label="${removal}: ${what}" title="${removal}">${icons.close(14)}</button>`,
    });
  };
  element.innerHTML = !total
    ? '<p class="empty">No replays yet.</p>'
    : !page.length
      ? `<p class="empty">${query ? `No replays match “${escape(home.query)}”${isFiltered(home) ? " with these filters" : ""}.` : "No replays match these filters."}</p>`
      : `<div class="cards">${page.map(mineCard).join("")}</div>${pager(home, list.length, perPage, "Your replay pages")}`;
  $("#mine-count").textContent = total ? (list.length === total ? counted(total) : `${list.length.toLocaleString("en-US")} of ${counted(total)}`) : "";
  fitNames();
  page.forEach((r) => r.troops || showTroops(r));
  list.filter((r) => r.shared?.token && !r.shared.troops).forEach((r) => void addTroops(r.id));
}

// Shared replays watched from "All replays", which are not kept in this browser.
const browsing = new Set();
// The replays "All replays" shows, by id, and the latest request for them.
let shownShared = new Map(),
  allRequest = 0,
  allTimer;
/// Asks for the list once typing or dragging pauses.
function renderAllSoon() {
  clearTimeout(allTimer);
  allTimer = setTimeout(() => void renderAll(), 200);
}
async function renderAll() {
  clearTimeout(allTimer);
  const element = $("#all");
  if (!element) return;
  const ticket = ++allRequest;
  const s = everyone;
  element.setAttribute("aria-busy", "true");
  let data, maps;
  try {
    maps = knownMaps = await publishedMaps();
    const params = { sort: s.sort, offset: s.page * allPerPage, limit: allPerPage, ...sharedFilters(s, maps) };
    if (s.query.trim()) Object.assign(params, { q: s.query.trim() }, refsParam(s.query, maps));
    data = await listShared(params);
  } catch (error) {
    if (ticket === allRequest && $("#all") === element) {
      element.removeAttribute("aria-busy");
      element.innerHTML = `<p class="empty">${escape(error.message)} <button type="button" class="btn" data-retry>Try again</button></p>`;
    }
    return;
  }
  if (ticket !== allRequest || $("#all") !== element) return;
  // A filter that leaves fewer pages shows the last of them.
  const pages = Math.max(1, Math.ceil(data.total / allPerPage));
  if (s.page > pages - 1) {
    s.page = pages - 1;
    return renderAll();
  }
  element.removeAttribute("aria-busy");
  setBound("all", data.longest);
  showCounts("all", { modes: data.modes, maps: data.maps });
  shownShared = new Map(data.replays.map((r) => [r.id, r]));
  const sharedCard = (r) => {
    const what = escape(r.players.join(" vs ") || "a shared replay");
    return card({
      href: `${root}r/${r.id}`,
      attrs: ` data-browse="${r.id}"`,
      label: `Watch ${what}${r.frames ? `, ${duration(r.frames)}` : ""}`,
      // A custom map's picture is read from the replay the first time it is asked for.
      picture: r.thumb || r.custom ? thumbLink(r.id) : mapPicture(r.map, maps),
      troops: r.troops?.length ? `<span class="replay-troops">${troopLinesMarkup(r.troops)}</span>` : "",
      map: r.mapKey ? mapLabel(r.mapKey, maps) : r.custom ? "Custom map" : (mapName(r.map, maps) ?? "Unknown map"),
      mapId: mapIdentity(r.mapKey, maps),
      filter: everyone,
      length: lengthOf(r.frames),
      mode: r.mode,
      players: r.players,
      time: r.created,
      title: [`Shared ${new Date(r.created).toLocaleString()}`, r.version && `v${r.version}`, kilobytes(r.size)].filter(Boolean).join(" · "),
      actions: `<button type="button" class="rep-round" data-download="${r.id}" aria-label="Download: ${what}" title="Download">${icons.download}</button>
        <button type="button" class="rep-round" data-link="${r.id}" aria-label="Copy link: ${what}" title="Copy link">${icons.link}</button>`,
    });
  };
  $("#all-count").textContent = counted(data.total);
  element.innerHTML = data.replays.length
    ? `<div class="cards">${data.replays.map(sharedCard).join("")}</div>${pager(s, data.total, allPerPage, "All replay pages")}`
    : `<p class="empty">${s.query.trim() || isFiltered(s) ? "No shared replays match." : "No replays have been shared yet."}</p>`;
  fitNames();
}
/// Saves a shared replay as a file named after its players.
async function downloadShared(button) {
  const id = button.dataset.download;
  button.disabled = true;
  try {
    const blob = await fetchShared(id);
    if (!blob) throw new Error("This replay is no longer shared.");
    downloadKept({ blob, name: `${id}.rep`, players: shownShared.get(id)?.players ?? [] });
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}
async function copyLink(id) {
  try {
    await copy(Promise.resolve(shareLink(id)));
    toast("Link copied.");
  } catch {
    toast(`Link: ${shareLink(id)}`);
  }
}

// Published tournaments.
let index;
const tournamentIndex = () =>
  (index ??= fetch(`${base}tournaments/index.json`, revalidate).then((r) => (r.ok ? r.json() : [])).catch(() => []));
const tournaments = new Map();
function tournament(id) {
  if (!/^[\w-]+$/.test(id)) return Promise.reject(new Error("No such tournament."));
  if (!tournaments.has(id))
    tournaments.set(id, fetch(`${base}tournaments/${id}/tournament.json`, revalidate)
      .then((r) => {
        if (!r.ok) throw new Error("No such tournament.");
        return r.json();
      })
      .then(prepare));
  return tournaments.get(id);
}
/// Indexes a published tournament for the pages that show it.
function prepare(t) {
  const players = new Map(t.players.map((p) => [p.name, p]));
  const byUsername = new Map(t.players.filter((p) => p.username).map((p) => [p.username.toLowerCase(), p.name]));
  t.display = (name) => withUsername(name, players.get(name)?.username);
  t.seed = (name) => players.get(name)?.seed ?? "";
  t.match = new Map(t.matches.map((m) => [m.id, m]));
  t.games = new Map();
  for (const r of t.replays) {
    r.names = r.players.map((username) => t.display(byUsername.get(username.toLowerCase()) ?? username));
    if (!t.games.has(r.match)) t.games.set(r.match, []);
    t.games.get(r.match).push(r);
  }
  // The order maps were played in is not recorded, so a match lists them by name.
  for (const games of t.games.values()) {
    games.sort((a, b) => String(a.map).localeCompare(String(b.map), undefined, { numeric: true }));
    const used = new Map();
    for (const r of games) {
      const slug = (r.map ?? "game").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      used.set(slug, (used.get(slug) ?? 0) + 1);
      r.slug = used.get(slug) > 1 ? `${slug}-${used.get(slug)}` : slug;
    }
  }
  t.sides = sides(t.matches);
  return t;
}
// The world map (written by scripts/big-maps.py) is not listed yet: a faint globe at
// the foot of the home page opens a room for it, as Play from here does for a replay.
async function openWorldRoom(button) {
  button.disabled = true;
  try {
    const list = await fetch(`${base}play-assets/maps/index.json`, revalidate).then((response) => (response.ok ? response.json() : []));
    const map = list[0],
      layout = map?.layouts?.[0];
    if (!layout) throw new Error("The world map is not available.");
    const response = await fetch(`${base}play-assets/maps/${layout.id}.rep`);
    if (!response.ok) throw new Error("The world map could not be loaded.");
    const id = await leaveForPlay({ replay: await response.arrayBuffer(), frame: 0, name: `${map.name}, ${layout.name}` });
    location.href = new URL(`play?from=${id}`, document.baseURI).href;
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

async function renderTournaments() {
  const element = $("#tournaments");
  const list = await tournamentIndex();
  if (!element || !list.length) return;
  element.innerHTML = `<div class="section-head"><h2 id="tournaments-title">Tournaments</h2></div>
    <div class="tournament-cards">${list.map((t) => `<a class="tournament-card" href="${root}${t.id}">
      <span class="cover">${t.cover ? `<img src="${base}tournaments/${t.id}/${escape(t.cover)}" alt="">` : ""}
        ${t.champion ? `<span class="champion"><span style="color:var(--gold);display:flex">${icons.trophy}</span>${escape(withUsername(t.champion.name, t.champion.username))}</span>` : ""}</span>
      <span class="body"><span><b>${escape(t.name)}</b><br><span class="note">${escape(t.format)} · ${t.players} players${t.started ? ` · ${dates(t)}` : ""}</span></span>
        <span class="stats"><span>Matches<b>${t.matches}</b></span><span>Games<b>${t.games}</b></span><span class="replays">Replays<b>${t.replays}</b></span></span></span>
    </a>`).join("")}</div>`;
}

function tournamentHead(t, tab) {
  const colors = ["#e0a458", "#c4cdc8", "#b98a62"];
  return `${header(true)}<section class="t-head">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="${root}">Home</a> / <span>${escape(t.name)}</span></nav>
    <div class="t-title"><div><h1>${escape(t.name)}</h1><ul class="facts">
      <li>${icons.players}${t.players.length} Players</li><li>${icons.bracket}${escape(t.format)}</li>
      ${t.started ? `<li>${icons.calendar}${dates(t)}</li>` : ""}</ul></div>
      ${t.results?.length ? `<div><span class="results-label">Final results</span><ol class="results">${t.results.map((r, i) =>
        `<li><span class="place" style="background:${colors[i] ?? "#4a5250"}">${i + 1}</span><span><b>${escape(t.display(r.player))}</b><small>${escape(r.record ?? "")}</small></span></li>`).join("")}</ol></div>` : ""}
    </div>
    <nav class="tabs" aria-label="Tournament">
      <a href="${root}${t.id}"${tab === "bracket" ? ' aria-current="page"' : ""}>Bracket</a>
      <a href="${root}${t.id}/replays"${tab === "replays" ? ' aria-current="page"' : ""}>Replays <span class="count">${t.replays.length}</span></a>
    </nav></section>`;
}

/// A match as Challonge draws it: seeds, names, scores, and a tab for its replays.
function matchBox(t, m, style, open, numbered = false) {
  const games = t.games.get(m.id) ?? [];
  const row = (n) => {
    const name = m[`player${n}`];
    return `<span class="row${m.winner === n ? " won" : ""}"><span class="seed">${t.seed(name)}</span><span class="name"><span>${escape(t.display(name))}</span></span><span class="score">${m.scores[n - 1]}</span></span>`;
  };
  const inner = `${numbered ? `<span class="number-cell">${m.id}</span>` : ""}<span class="rows">${row(1)}${row(2)}</span>${games.length ? `<span class="tab">${icons.play(9)}${games.length}</span>` : ""}`;
  if (!games.length) return `<div class="match" style="${style}">${inner}</div>`;
  const label = `Match ${m.id}: ${t.display(m.player1)} ${m.scores[0]}, ${t.display(m.player2)} ${m.scores[1]}, ${games.length} ${games.length === 1 ? "replay" : "replays"}`;
  return `<a class="match${open === m.id ? " open" : ""}" data-match="${m.id}" href="${root}${t.id}/${m.id}" style="${style}" aria-label="${escape(label)}">${inner}</a>`;
}
function popover(t, m, className, style = "") {
  const games = t.games.get(m.id) ?? [];
  return `<div class="match-pop ${className}" role="dialog" aria-label="Match ${m.id} replays" style="${style}">
    <div class="top"><span><span class="note">Match ${m.id} · ${escape(roundName(m.round, t.sides))}</span>
      <b>${escape(t.display(m.player1))} ${m.scores[0]} : ${m.scores[1]} ${escape(t.display(m.player2))}</b></span>
      <a class="close" href="${root}${t.id}" aria-label="Close">${icons.close(14)}</a></div>
    ${games.length ? `<ul class="map-list">${games.map((r) => `<li><a href="${root}${t.id}/${m.id}/${r.slug}">
        ${r.thumb ? `<span class="map-thumb"><img src="${base}tournaments/${t.id}/${escape(r.thumb)}" alt=""><span class="replay-troops">${r.troops ? troopLinesMarkup(r.troops) : ""}</span></span>` : ""}
        <span class="what"><b>${escape(r.map ?? "Unknown map")}</b><span class="fit">${versus(r.names)}</span><span class="note">${duration(r.frames)}${r.version ? ` · v${escape(r.version)}` : ""}</span></span>
        <span class="play-dot" aria-hidden="true">${icons.play(12)}</span></a></li>`).join("")}</ul>`
      : '<p class="note">No replays for this match.</p>'}
  </div>`;
}

const step = box.width + box.gap;
let positions = new Map();
function bracketBoards(t) {
  positions = new Map();
  const boards = [];
  const { winners, losers, finals } = t.sides;
  const upper = layout(t.matches, winners, { spacing: 124, offset: 31 });
  let previous = upper.boxes.filter((b) => b.match.round === winners.at(-1)).at(-1);
  finals.forEach((match, i) => {
    const at = { match, x: box.left + (winners.length + i) * step, y: previous.y, from: [previous] };
    connect(upper.lines, at, [previous]);
    upper.boxes.push(at);
    previous = at;
  });
  const heads = [...winners, ...finals.map((m) => m.round)].map((r, i) => (i > winners.length ? "" : roundName(r, t.sides)));
  boards.push({ side: "winners", title: losers.length ? "Winners bracket" : "Bracket", heads, laid: upper, width: box.left + heads.length * step });
  if (losers.length) {
    const lower = layout(t.matches, losers, { spacing: 68, offset: 0 });
    boards.push({ side: "losers", title: "Losers bracket", heads: losers.map((r) => roundName(r, t.sides)), laid: lower, width: box.left + losers.length * step });
  }
  return boards.map(({ side, title, heads, laid, width }) => {
    for (const b of laid.boxes) positions.set(b.match.id, { side, x: b.x, y: b.y, width });
    return `<section class="bracket-side" aria-label="${title}"><h2>${title}</h2><div class="board-scroll"><div class="board" data-board="${side}" style="width:${width}px;height:${laid.height}px">
      <div class="strip"></div>
      ${heads.map((h, i) => `<div class="round-head" style="left:${box.left - box.gap / 2 + i * step}px;width:${step}px">${escape(h)}</div>`).join("")}
      ${laid.lines.map((l) => `<span class="line" style="left:${Math.round(l.x)}px;top:${Math.round(l.y)}px;width:${Math.round(l.w)}px;height:${Math.round(l.h)}px"></span>`).join("")}
      ${laid.boxes.map((b) => `<span class="number" style="left:${b.x - 25}px;top:${Math.round(b.y - 7)}px">${b.match.id}</span>${matchBox(t, b.match, `left:${b.x}px;top:${Math.round(b.y - box.height / 2)}px`, null)}`).join("")}
    </div></div></section>`;
  }).join("");
}

// Phones show one round at a time.
const mobile = { side: "winners", round: null };
function renderRounds(t) {
  const element = $("#rounds");
  if (!element) return;
  const { winners, losers, finals } = t.sides;
  const rounds = mobile.side === "losers" ? losers : [...winners, ...(finals.length ? [finals[0].round] : [])];
  if (!rounds.includes(mobile.round)) mobile.round = rounds[0];
  const matches = t.matches.filter((m) => m.round === mobile.round).sort((a, b) => a.id - b.id);
  const where = (m) => {
    const next = nextMatches(m, t.matches);
    const winner = next.winner ? `Winner to match ${next.winner}` : finals.includes(m) ? "Final match" : "Winner advances";
    return m.round > 0 && !finals.includes(m) ? `${winner} · loser to match ${next.loser ?? "out"}` : `${winner}${m.round < 0 ? " · loser is out" : ""}`;
  };
  element.innerHTML = `${losers.length ? `<div class="side-switch" role="tablist" aria-label="Bracket side">
      <button type="button" role="tab" data-side="winners" aria-selected="${mobile.side === "winners"}">Winners</button>
      <button type="button" role="tab" data-side="losers" aria-selected="${mobile.side === "losers"}">Losers</button></div>` : ""}
    <div class="round-chips" role="tablist" aria-label="Round">${rounds.map((r) =>
      `<button type="button" role="tab" data-round="${r}" aria-selected="${r === mobile.round}">${escape(roundName(r, t.sides))}</button>`).join("")}</div>
    <ol class="round-list">${matches.map((m) => `<li>${matchBox(t, m, "", null, true)}<span class="where">${where(m)}</span></li>`).join("")}</ol>`;
}

async function showBracket(id, open) {
  let t;
  try {
    t = await tournament(id);
  } catch {
    return notFound("Tournament not found.");
  }
  if (open && !t.match.has(open)) return notFound("Match not found.");
  if (open) {
    const m = t.match.get(open);
    mobile.side = m.round < 0 ? "losers" : "winners";
    mobile.round = m.round;
  }
  const fresh = showPage(`${id}/bracket`, `${t.name} · War of Dots Replays`,
    `${tournamentHead(t, "bracket")}<div class="bracket-page">
      <p class="legend"><span class="replay-key">${icons.play(9)}</span>Has replays</p>
      ${bracketBoards(t)}<div class="rounds" id="rounds"></div><div id="sheet"></div></div>`);
  if (fresh) {
    $("#rounds").onclick = (event) => {
      const side = event.target.closest("[data-side]"),
        round = event.target.closest("[data-round]");
      if (side) mobile.side = side.dataset.side;
      if (round) mobile.round = Number(round.dataset.round);
      if (side || round) {
        renderRounds(t);
        fitNames();
      }
    };
  }
  renderRounds(t);
  showOpen(t, open, fresh);
  fitNames();
}
/// Opens one match's replays beside it, or closes them, without redrawing the bracket.
function showOpen(t, open, scroll) {
  site.querySelectorAll(".match-pop, .scrim").forEach((element) => element.remove());
  site.querySelectorAll("a.match.open").forEach((element) => element.classList.remove("open"));
  const where = open && positions.get(open);
  if (!where) return;
  const m = t.match.get(open);
  site.querySelectorAll(`a.match[data-match="${open}"]`).forEach((element) => element.classList.add("open"));
  const left = where.x + box.width + 14 + 340 > where.width ? where.x - 354 : where.x + box.width + 14;
  $(`[data-board="${where.side}"]`).insertAdjacentHTML("beforeend", popover(t, m, "beside", `left:${left}px;top:${Math.max(40, Math.round(where.y - 60))}px`));
  $("#sheet").innerHTML = `<a class="scrim" href="${root}${t.id}" aria-label="Close"></a>${popover(t, m, "sheet")}`;
  if (scroll) site.querySelector(`.board a.match[data-match="${open}"]`)?.scrollIntoView({ block: "center", inline: "center" });
}

const filters = { query: "", side: "all" };
async function showReplays(id) {
  let t;
  try {
    t = await tournament(id);
  } catch {
    return notFound("Tournament not found.");
  }
  const fresh = showPage(`${id}/replays`, `${t.name} replays · War of Dots Replays`,
    `${tournamentHead(t, "replays")}<main class="groups">
      <div class="section-head replay-tools">
        <label class="search">${icons.search}<span class="sr-only">Search players</span><input type="search" id="group-search" placeholder="Search players"></label>
        ${t.sides.losers.length ? dropdown("group-side", "Bracket", [["all", "Winners and losers"], ["winners", "Winners only"], ["losers", "Losers only"]], filters.side, (side) => {
          filters.side = side;
          renderGroups(t);
        }) : ""}
        <span class="spacer"></span><span class="note">${t.replays.length} replays from ${t.games.size} matches</span>
      </div>
      <div id="groups" class="groups-list"></div></main>`);
  if (fresh) {
    $("#group-search").value = filters.query;
    $("#group-search").oninput = (event) => {
      filters.query = event.target.value;
      renderGroups(t);
    };
  }
  renderGroups(t);
}
function renderGroups(t) {
  const query = filters.query.trim().toLowerCase();
  const groups = [...t.games.keys()].sort((a, b) => b - a).map((id) => t.match.get(id)).filter((m) => {
    if (filters.side !== "all" && (m.round < 0) !== (filters.side === "losers")) return false;
    const names = [t.display(m.player1), t.display(m.player2), ...t.games.get(m.id).flatMap((r) => r.players)];
    return !query || names.some((name) => name.toLowerCase().includes(query));
  });
  $("#groups").innerHTML = groups.length ? groups.map((m) => {
    const games = t.games.get(m.id);
    return `<section class="group"><div class="group-head"><div><span class="label">${escape(roundName(m.round, t.sides))} · Match ${m.id}</span><h2>
        <span class="${m.winner === 1 ? "won" : ""}">${escape(t.display(m.player1))}</span> <span class="score-box">${m.scores[0]} : ${m.scores[1]}</span>
        <span class="${m.winner === 2 ? "won" : ""}">${escape(t.display(m.player2))}</span></h2></div>
        <span class="links"><span>${games.length} of ${m.scores[0] + m.scores[1]} replays</span><a href="${root}${t.id}/${m.id}">Show in bracket</a></span></div>
      <div class="cards small">${games.map((r) => card({
        href: `${root}${t.id}/${m.id}/${r.slug}`,
        label: `Watch ${escape(r.map ?? "")}, ${escape(r.names.join(" vs "))}, ${duration(r.frames)}`,
        picture: r.thumb ? `${base}tournaments/${t.id}/${r.thumb}` : null,
        troops: `<span class="replay-troops">${r.troops ? troopLinesMarkup(r.troops) : ""}</span>`,
        map: r.map ?? "Unknown map",
        length: lengthOf(r.frames),
        players: r.names,
      })).join("")}</div></section>`;
  }).join("") : `<p class="empty">No replays match “${escape(filters.query)}”.</p>`;
  fitNames();
}

// The Leaderboard tab of More of Dots, loaded the first time it is opened.
let leaderboardPage = null;
async function showLeaderboard() {
  const fresh = showPage("leaderboard", "Leaderboard · War of Dots Replays",
    `${header(true, "leaderboard")}<main class="site-leaderboard" id="leaderboard"><p class="empty">Loading the leaderboard.</p></main>`);
  if (!fresh) return;
  const element = $("#leaderboard");
  try {
    leaderboardPage ??= import("./leaderboard.js");
    const page = await leaderboardPage;
    if ($("#leaderboard") !== element) return;
    page.mount(element);
    leaving = page.unmount;
  } catch {
    leaderboardPage = null;
    if ($("#leaderboard") === element) element.innerHTML = '<p class="empty">The leaderboard could not be loaded. Reload the page to try again.</p>';
  }
}

// Watching.
function enterPlayer(back) {
  leaving?.();
  leaving = null;
  shown = null;
  setView("watch");
  backTarget = back;
  for (const id of ["back", "welcome-back"]) document.getElementById(id).hidden = false;
}
async function watchTournament(id, matchId, slug) {
  let t;
  try {
    t = await tournament(id);
  } catch {
    return notFound("Tournament not found.");
  }
  const game = (t.games.get(matchId) ?? []).find((r) => r.slug === slug);
  if (!game) return notFound("Game not found.");
  enterPlayer(`${id}/${matchId}`);
  void player().loadReplay(`${base}tournaments/${id}/${encodeURIComponent(game.file)}`);
}
async function watchMine(id) {
  const record = await getReplay(id).catch(() => null);
  if (!record)
    return notFound("This replay is only on the device that added it.");
  await play(record);
}
/// Opens a shared replay, keeping it in this browser the first time unless it was
/// opened from "All replays".
async function watchShared(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) return notFound("Replay not found.");
  let record = await getReplay(id).catch(() => null);
  if (!record) {
    let blob;
    try {
      blob = await fetchShared(id);
    } catch (error) {
      return notFound(error.message);
    }
    if (!blob) return notFound("This replay is no longer shared.");
    if (browsing.has(id)) return play({ id, blob });
    try {
      ({ record } = await addReplay(new File([blob], `${id}.rep`), { shared: { token: null } }));
    } catch (error) {
      return notFound(error.message);
    }
  }
  await play(record);
}
/// Opens the replay at a link, keeping it in this browser: s?=<link>.
async function watchLink(text) {
  const url = parseLink(text);
  if (!url) return notFound("That is not a link.");
  showPage("downloading", "War of Dots Replays", `${header()}<main class="page"><p class="empty">Downloading the replay.</p></main>`);
  shown = null;
  let record;
  try {
    ({ record } = await addReplay(new File([await downloadLink(url)], linkName(url))));
  } catch (error) {
    return notFound(error.message);
  }
  // The visitor may have gone elsewhere while it downloaded.
  if (linkText() === text) await play(record);
}
async function play(record) {
  enterPlayer("");
  const name = `${record.id}.rep`;
  await addFile(new File([record.blob], name));
  void player().loadReplay(name);
}

embedding.active = () => view === "watch";
embedding.files = (files) => void keepFiles(files);
// Back returns to the page the visitor came from, or to the replay's parent page
// when they arrived through a shared link.
embedding.back = () => (navigations ? history.back() : go(backTarget));

const currentPath = () => (location.pathname.startsWith(root) ? location.pathname.slice(root.length) : "");
// The link of an s?=<link> address, as it was written.
const linkText = () => (currentPath() === "s" && /^\?(url)?=/.test(location.search) ? location.search.slice(location.search.indexOf("=") + 1) : null);
/// Shows the page at a path under the site's folder, as a new step in the browser's history.
function go(path, replace = false) {
  history[replace ? "replaceState" : "pushState"](null, "", `${root}${path}`);
  if (!replace) navigations++;
  void route();
}
/// Moves an earlier #/ address to its path in place.
function fromHash() {
  if (!location.hash.startsWith("#/")) return false;
  history.replaceState(null, "", `${root}${location.hash.slice(2)}`);
  return true;
}

async function route() {
  fromHash();
  const text = linkText();
  if (text) return watchLink(text);
  const parts = currentPath().split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return showHome();
  if (parts[0] === "leaderboard" && parts.length === 1) return showLeaderboard();
  if (parts[0] === "mine") return parts[1] ? watchMine(parts[1]) : showHome();
  if (parts[0] === "r") return parts[1] ? watchShared(parts[1]) : showHome();
  // A tournament's earlier address leads to its current one, keeping the rest of the link.
  const address = location.href;
  const renamed = (await tournamentIndex()).find((t) => t.aliases?.includes(parts[0]));
  if (location.href !== address) return;
  if (renamed) {
    history.replaceState(history.state, "", `${root}${[renamed.id, ...parts.slice(1)].map(encodeURIComponent).join("/")}`);
    return route();
  }
  const [id, second, third] = parts;
  if (!second) return showBracket(id, null);
  if (second === "replays") return showReplays(id);
  const match = Number(second);
  if (!Number.isInteger(match)) return notFound("Page not found.");
  return third ? watchTournament(id, match, third) : showBracket(id, match);
}
addEventListener("popstate", () => {
  navigations = Math.max(0, navigations - 1);
  void route();
});
addEventListener("hashchange", () => {
  if (fromHash()) void route();
});
// Links to pages of the site open in place.
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest?.("a[href]");
  if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith(root) || /\.[a-z0-9]+$/i.test(url.pathname)) return;
  event.preventDefault();
  if (url.pathname + url.search !== location.pathname + location.search) go(url.pathname.slice(root.length) + url.search);
});
addEventListener("keydown", (event) => {
  if (view === "page" && event.key === "Escape" && site.querySelector(".match-pop")) go(shown.split("/")[0]);
});
// A click outside an open match's replays closes them.
addEventListener("click", (event) => {
  if (view !== "page" || !site.querySelector(".match-pop.beside") || matchMedia("(max-width: 720px)").matches) return;
  if (!event.target.closest(".match-pop, a.match")) go(shown.split("/")[0]);
});

// Dropping replays anywhere on a page keeps them; the player handles drops while it shows.
let dragDepth = 0;
const carriesFiles = (event) => view === "page" && event.dataTransfer?.types.includes("Files");
addEventListener("dragenter", (event) => carriesFiles(event) && document.body.classList.toggle("dragging", ++dragDepth > 0));
addEventListener("dragleave", (event) => carriesFiles(event) && document.body.classList.toggle("dragging", --dragDepth > 0));
addEventListener("drop", (event) => {
  if (view !== "page") return;
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) void keepFiles(files);
});

// Pasting a link anywhere on a page outside a field opens it, as does pasting copied files.
addEventListener("paste", (event) => {
  if (view !== "page" || event.target.closest?.("input, textarea")) return;
  const files = [...(event.clipboardData?.files ?? [])];
  const text = event.clipboardData?.getData("text") ?? "";
  if (files.length) void keepFiles(files);
  else if (/^https?:\/\/\S+$/.test(text.trim())) void openLink(text);
  else return;
  event.preventDefault();
});

// Older links name a replay file to play: ?replay=<url>. The player opens those itself.
if (new URLSearchParams(location.search).has("replay")) enterPlayer("");
else void route();
