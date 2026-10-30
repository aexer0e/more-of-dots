// The hosted site: a home page with the visitor's own replays and the published
// tournaments, each tournament's bracket and replays, and the player. Pages are
// addressed by paths under the site's folder, so every view can be shared as a
// link with its own preview (share/ serves them):
//   (the folder)          home
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
import { downloadLink, fetchShared, shareReplay, unshareReplay, uploadCard } from "./share.js";
import { drawCard } from "./card.js";
import { box, connect, layout, nextMatches, roundName, sides } from "./bracket.js";
import { reduceTroops, troopLinesMarkup } from "../replays/troop-lines";

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
  play: (size) => icon(size, '<path d="M7 4.5v15l12-7.5z"/>', "solid"),
  trophy: icon(15, '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  players: icon(15, '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>'),
  bracket: icon(15, '<path d="M4 5h5v6h6M4 19h5v-6M15 11v8h5"/>'),
  calendar: icon(15, '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  chevron: icon(14, '<path d="m6 9 6 6 6-6"/>'),
};

// Long names shrink until they fit their card or match.
function fitNames() {
  for (const element of site.querySelectorAll(".versus, .match .name span, .fit")) {
    element.style.fontSize = "";
    if (!element.clientWidth) continue;
    let size = parseFloat(getComputedStyle(element).fontSize);
    while (element.scrollWidth > element.clientWidth && size > 9) element.style.fontSize = `${(size -= 0.5)}px`;
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
  return `<div class="dropdown" data-dropdown="${id}"><span class="dropdown-label" id="${id}-label">${escape(label)}</span>
    <button type="button" class="dropdown-button" aria-haspopup="menu" aria-expanded="false" aria-labelledby="${id}-label ${id}-value"><span id="${id}-value">${escape(current[1])}</span>${icons.chevron}</button>
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
  if (option) {
    for (const item of menu.querySelectorAll("[data-value]")) item.setAttribute("aria-checked", String(item === option));
    button.querySelector("span").textContent = option.textContent;
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
    site.innerHTML = html;
    shown = key;
    scrollTo(0, 0);
  }
  return fresh;
}
const header = (wide = false) =>
  `<header class="site-header${wide ? " wide" : ""}"><div><a class="brand" href="${root}">${icons.logo}<span>War of Dots Replays</span></a><span class="storage" id="storage"></span></div></header>`;
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

const home = { page: 0, query: "", sort: "added" };
const perPage = 8;
function showHome() {
  const fresh = showPage(
    "home",
    "War of Dots Replays",
    `${header()}<main class="page">
      <section class="dropzone" aria-label="Add replays">${icons.file(52)}
        <h1>Drop a .rep to watch it</h1>
        <button type="button" class="btn btn-primary large" id="choose">Choose files</button>
        <form class="link-form" id="link-form">
          <label class="search">${icons.link}<span class="sr-only">Replay link</span><input type="url" id="link" placeholder="Or paste a link to a .rep" required></label>
          <button type="submit" class="btn">Open</button>
        </form>
      </section>
      <section class="stack" aria-labelledby="mine-title">
        <div class="section-head"><h2 id="mine-title">Your replays</h2><span class="spacer"></span>
          <label class="search">${icons.search}<span class="sr-only">Search players</span><input type="search" id="mine-search" placeholder="Search players"></label>
          ${dropdown("mine-sort", "Sort", [["added", "Recently added"], ["longest", "Longest"], ["shortest", "Shortest"]], home.sort, (sort) => {
            home.sort = sort;
            home.page = 0;
            renderMine();
          })}
        </div>
        <div id="mine"></div>
      </section>
      <section class="stack" id="tournaments" aria-labelledby="tournaments-title"></section>
    </main>`,
  );
  if (fresh) {
    $("#choose").onclick = choose;
    $("#link-form").onsubmit = (event) => {
      event.preventDefault();
      void openLink($("#link").value);
    };
    $("#mine-search").value = home.query;
    $("#mine-search").oninput = (event) => {
      home.query = event.target.value;
      home.page = 0;
      renderMine();
    };
    $("#mine").onclick = (event) => {
      const remove = event.target.closest("[data-remove]");
      const shareButton = event.target.closest("[data-share]");
      const page = event.target.closest("[data-page]");
      if (remove) void forget(remove);
      else if (shareButton) void share(shareButton);
      else if (page) {
        home.page = Number(page.dataset.page);
        renderMine();
        $("#mine-title").scrollIntoView({ block: "start" });
      }
    };
  }
  void renderMine();
  void renderTournaments();
  void showStorage();
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
  void showStorage();
  const what = record?.players.join(" vs ") || "the replay";
  toast(token ? `Removed ${what} and stopped sharing it.` : `Removed ${what}.`);
}
const shareLink = (id) => new URL(`${root}r/${id}`, location.href).href;
/// Copies text that may still be on its way, while the click that asked for it counts.
async function copy(text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
  } catch {
    await navigator.clipboard.writeText(await text);
  }
}
/// Uploads a replay the first time it is shared, then copies its link.
async function share(button) {
  const id = button.dataset.share;
  const record = await getReplay(id);
  if (!record) return;
  button.disabled = true;
  const uploaded = record.shared
    ? Promise.resolve()
    : shareReplay(record.blob).then(async ({ token }) => {
        const current = await getReplay(id);
        if (current) return saveReplay({ ...current, shared: { token: token ?? null } });
        // Removed while it uploaded.
        if (token) await unshareReplay(id, token);
        throw new Error("The replay was removed before it was shared.");
      });
  try {
    await copy(uploaded.then(() => shareLink(id)));
    toast("Link copied.");
  } catch {
    const failed = await uploaded.then(() => null, (error) => error);
    toast(failed ? failed.message : `Link: ${shareLink(id)}`);
  }
  void renderMine();
  void uploaded.then(() => addCard(id), () => {});
}
/// Gives a replay this browser shared the picture its link preview shows, once.
async function addCard(id) {
  const record = await getReplay(id);
  const token = record?.shared?.token;
  if (!token || record.shared.card) return;
  try {
    const picture = record.thumb ?? mapPicture(record.mapRef, await publishedMaps());
    const troops = await replayTroops(record);
    await uploadCard(id, token, await drawCard({ players: record.players, frames: record.frames, version: record.version, picture, troops }, base));
    const current = await getReplay(id);
    if (current?.shared) await saveReplay({ ...current, shared: { ...current.shared, card: true } });
  } catch {
    // The preview shows the replay's details without a picture until the next share.
  }
}
// Lines for the visitor's own replays are simulated once, one replay at a time,
// and kept with the replay. A replay that cannot be simulated has none this visit.
const troopRequests = new Map();
let troopWorker;
let troopQueue = Promise.resolve();
const simulateTroops = (record) =>
  new Promise((resolve, reject) => {
    troopWorker ??= new Worker(new URL("../player/web-engine.js", import.meta.url), { type: "module" });
    troopWorker.onerror = () => reject(new Error("The replay engine could not be started."));
    troopWorker.onmessage = ({ data }) => {
      if (data.kind === "troops") resolve(data.strength.map((side) => reduceTroops(side)));
      else reject(new Error(data.error));
    };
    troopWorker.postMessage({ troops: true, file: record.blob, base });
  });
function replayTroops(record) {
  if (record.troops) return Promise.resolve(record.troops);
  if (!troopRequests.has(record.id)) {
    const request = troopQueue.then(() => simulateTroops(record)).then(async (troops) => {
      const current = await getReplay(record.id);
      if (current) await saveReplay({ ...current, troops });
      for (const element of site.querySelectorAll(`[data-troops="${record.id}"]`)) element.innerHTML = troopLinesMarkup(troops);
      return troops;
    }).catch(() => null);
    troopRequests.set(record.id, request);
    troopQueue = request;
  }
  return troopRequests.get(record.id);
}
// The official map images the site publishes, as listed by the build.
let mapIndex;
const publishedMaps = () =>
  (mapIndex ??= fetch(`${base}maps/index.json`, revalidate).then((r) => (r.ok ? r.json() : [])).catch(() => []).then((list) => new Set(list)));
/// The picture of an official map a replay names, found the way More of Dots
/// finds it in the game: by its image path, or by number in each map set.
/// Zolamare comes first because the game gives it the numbers both sets use.
function mapPicture(ref, maps) {
  if (!ref) return null;
  const name = ref.replaceAll("\\", "/").toLowerCase();
  const candidates = /^\d+$/.test(name)
    ? ["zolamare", "fahero", "eronion"].map((set) => `assets/${set}_maps/map${name}.png`).concat(`map${name}.png`)
    : [name, name.split("/").pop()];
  const found = candidates.find((candidate) => maps.has(candidate));
  return found ? `${base}maps/${found}` : null;
}

async function renderMine() {
  const element = $("#mine");
  if (!element) return;
  let list = await listReplays().catch(() => []);
  // Replays kept before the site read map names get them once.
  const older = list.filter((r) => !r.thumb && !("mapRef" in r));
  if (older.length) {
    const refreshed = await Promise.all(older.map((r) => refreshDetails(r).catch(() => r)));
    list = list.filter((r) => !older.includes(r)).concat(refreshed);
  }
  const maps = await publishedMaps();
  const total = list.length;
  const query = home.query.trim().toLowerCase();
  if (query) list = list.filter((r) => [...r.players, r.name].some((text) => text.toLowerCase().includes(query)));
  const order = { added: (a, b) => b.added - a.added, longest: (a, b) => b.frames - a.frames, shortest: (a, b) => a.frames - b.frames };
  list.sort(order[home.sort]);
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  home.page = Math.min(home.page, pages - 1);
  const first = home.page * perPage,
    page = list.slice(first, first + perPage);
  const card = (r) => {
    const picture = r.thumb ?? mapPicture(r.mapRef, maps);
    const what = escape(r.players.join(" vs "));
    const removal = r.shared?.token ? "Remove from this browser and stop sharing" : "Remove from this browser";
    return `<div class="rep-card">
      <a href="${root}mine/${r.id}" aria-label="Watch ${what}, ${duration(r.frames)}">
        ${picture ? `<img src="${escape(picture)}" alt="">` : ""}<span class="shade"></span>
        <span class="replay-troops" data-troops="${r.id}">${r.troops ? troopLinesMarkup(r.troops) : ""}</span>
        <span class="versus">${versus(r.players)}</span>
        <span class="tag bl">${r.version ? `v${escape(r.version)} · ` : ""}${kilobytes(r.size)}</span>
        <span class="tag br">${duration(r.frames)}</span>
      </a>
      <button type="button" class="rep-action rep-remove" data-remove="${r.id}" aria-label="${removal}: ${what}" title="${removal}">${icons.close(14)}</button>
      <button type="button" class="rep-action rep-share${r.shared ? " shared" : ""}" data-share="${r.id}" aria-label="${r.shared ? "Copy link" : "Share"}: ${what}" title="${r.shared ? "Copy link" : "Share"}">${icons.link}</button>
    </div>`;
  };
  const numbers = Array.from({ length: pages }, (_, i) =>
    `<button type="button" class="btn page-number" data-page="${i}" aria-label="Page ${i + 1}"${i === home.page ? ' aria-current="page"' : ""}>${i + 1}</button>`).join("");
  element.innerHTML = !total
    ? '<p class="empty">No replays yet.</p>'
    : !page.length
      ? `<p class="empty">No replays match “${escape(home.query)}”.</p>`
      : `<div class="cards">${page.map(card).join("")}</div>${pages > 1
        ? `<nav class="pager" aria-label="Replay pages"><span class="note">Showing ${first + 1} to ${first + page.length} of ${list.length}</span><div>
            <button type="button" class="btn" data-page="${home.page - 1}"${home.page === 0 ? " disabled" : ""}>Previous</button>${numbers}
            <button type="button" class="btn" data-page="${home.page + 1}"${home.page === pages - 1 ? " disabled" : ""}>Next</button></div></nav>`
        : ""}`;
  fitNames();
  page.forEach((r) => void replayTroops(r));
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
      <div class="cards small">${games.map((r) => `<div class="rep-card"><a href="${root}${t.id}/${m.id}/${r.slug}" aria-label="Watch ${escape(r.map ?? "")}, ${escape(r.names.join(" vs "))}, ${duration(r.frames)}">
        ${r.thumb ? `<img src="${base}tournaments/${t.id}/${escape(r.thumb)}" alt="">` : ""}<span class="shade"></span>
        <span class="replay-troops">${r.troops ? troopLinesMarkup(r.troops) : ""}</span>
        <span class="versus">${versus(r.names)}</span><span class="tag bl">${escape(r.map ?? "Unknown map")}</span><span class="tag br">${duration(r.frames)}</span></a></div>`).join("")}</div></section>`;
  }).join("") : `<p class="empty">No replays match “${escape(filters.query)}”.</p>`;
  fitNames();
}

// Watching.
function enterPlayer(back) {
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
/// Opens a shared replay, keeping it in this browser the first time.
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
