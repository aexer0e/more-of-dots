// Adding replays to the game's replay folder: a dialog to choose files or paste a
// link, and a frame over the window while files are dragged onto it. Dropped
// files open the dialog, which lists how each one went.
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "../platform";
import { downloadLink, parseLink } from "./share";

type AddResult = { fileName: string; alreadyAdded: boolean };
type Row = { name: string; state: "working" | "added" | "present" | "failed"; detail: string };

const ICONS = {
  file: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6"/><path d="M9.5 13.5 12 11l2.5 2.5"/></svg>',
  link: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>',
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  added: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  present: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  failed: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  working: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 8 8"/></svg>',
};

let rows: Row[] = [];
let dialogRoot: HTMLDivElement | null = null;
let returnFocus: HTMLElement | null = null;
let queue = Promise.resolve();
let pending = 0;
let addedSinceReload = false;
let onAdded = () => {};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error || "Could not add this replay."));
const isReplayName = (name: string) => /\.rep$/i.test(name);

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** Runs each addition in turn and reloads the library once the last one is done. */
function enqueue(name: string, add: () => Promise<AddResult>) {
  const row: Row = { name, state: "working", detail: "Adding" };
  rows.push(row);
  pending += 1;
  renderRows();
  queue = queue.then(async () => {
    try {
      const result = await add();
      row.state = result.alreadyAdded ? "present" : "added";
      row.detail = result.alreadyAdded ? "Already in your library" : "Added";
      addedSinceReload ||= !result.alreadyAdded;
    } catch (error) {
      row.state = "failed";
      row.detail = message(error);
    }
    pending -= 1;
    renderRows();
    if (!pending && addedSinceReload) {
      addedSinceReload = false;
      onAdded();
    }
  });
}

/** Adds replay files chosen in the dialog or dropped on a browser window. */
export function addReplayFiles(files: File[]) {
  openAddReplays();
  for (const file of files) {
    if (!isReplayName(file.name)) {
      rows.push({ name: file.name, state: "failed", detail: "Not a .rep file" });
      continue;
    }
    enqueue(file.name, async () =>
      invoke<AddResult>("upload_replay", { fileName: file.name, replayBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) }));
  }
  renderRows();
}

/** Adds replay files dropped on the app's window. */
function addReplayPaths(paths: string[]) {
  openAddReplays();
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() || path;
    if (!isReplayName(name)) {
      rows.push({ name, state: "failed", detail: "Not a .rep file" });
      continue;
    }
    enqueue(name, () => invoke<AddResult>("add_replay_file", { filePath: path }));
  }
  renderRows();
}

function addLink(text: string) {
  const url = parseLink(text);
  if (!url) {
    rows.push({ name: text.trim() || "Link", state: "failed", detail: "That is not a link." });
    renderRows();
    return;
  }
  const name = `${url.hostname}${url.pathname}`;
  enqueue(name, async () => {
    const { bytes, name: fileName } = await downloadLink(url);
    return invoke<AddResult>("upload_replay", { fileName, replayBase64: bytesToBase64(bytes) });
  });
}

export function openAddReplays() {
  if (dialogRoot) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialogRoot = document.createElement("div");
  dialogRoot.innerHTML = `
    <div class="add-replays-backdrop" role="presentation">
      <section class="add-replays-dialog" role="dialog" aria-modal="true" aria-labelledby="addReplaysTitle">
        <header class="add-replays-header">
          <h2 id="addReplaysTitle">Add replays</h2>
          <button class="recording-setup-close" type="button" data-add-action="close" aria-label="Close">${ICONS.close}</button>
        </header>
        <div class="add-replays-dropzone">
          ${ICONS.file}
          <strong>Drop .rep files here</strong>
          <button class="add-replays-choose" type="button" data-add-action="choose">Choose files</button>
          <input type="file" accept=".rep" multiple hidden data-add-input>
        </div>
        <form class="add-replays-link" data-add-link>
          <label class="add-replays-link-field">${ICONS.link}<span class="add-replays-sr">Replay link</span><input type="text" inputmode="url" placeholder="Or paste a link to a replay" autocomplete="off" spellcheck="false" required></label>
          <button class="refresh-button" type="submit">Add</button>
        </form>
        <ul class="add-replays-results" aria-live="polite" hidden></ul>
        <footer class="add-replays-footer" hidden>
          <span class="add-replays-summary"></span>
          <button class="refresh-button" type="button" data-add-action="close">Done</button>
        </footer>
      </section>
    </div>`;
  document.body.appendChild(dialogRoot);
  bindDialog(dialogRoot);
  renderRows();
  dialogRoot.querySelector<HTMLButtonElement>('[data-add-action="choose"]')?.focus();
}

function closeAddReplays() {
  dialogRoot?.remove();
  dialogRoot = null;
  // Replays still being added stay listed for the next time the dialog opens.
  rows = rows.filter((row) => row.state === "working");
  returnFocus?.focus();
}

function renderRows() {
  const list = dialogRoot?.querySelector<HTMLUListElement>(".add-replays-results");
  if (!list) return;
  list.hidden = !rows.length;
  list.innerHTML = rows
    .map((row) => `<li class="is-${row.state}">${ICONS[row.state]}<span class="add-replays-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span><span class="add-replays-detail">${escapeHtml(row.detail)}</span></li>`)
    .join("");
  list.scrollTop = list.scrollHeight;
  const count = (state: Row["state"]) => rows.filter((row) => row.state === state).length;
  const parts = [
    count("added") && `${count("added")} added`,
    count("present") && `${count("present")} already in your library`,
    count("failed") && `${count("failed")} failed`,
    count("working") && `${count("working")} in progress`,
  ].filter(Boolean);
  const summary = dialogRoot?.querySelector(".add-replays-summary");
  if (summary) summary.textContent = parts.join(", ");
  const footer = dialogRoot?.querySelector<HTMLElement>(".add-replays-footer");
  if (footer) footer.hidden = !rows.length;
}

function bindDialog(root: HTMLElement) {
  const input = root.querySelector<HTMLInputElement>("[data-add-input]")!;
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) addReplayFiles(files);
  });
  root.querySelector<HTMLFormElement>("[data-add-link]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const field = (event.currentTarget as HTMLFormElement).querySelector("input")!;
    addLink(field.value);
    field.value = "";
  });
  root.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.classList.contains("add-replays-backdrop")) return closeAddReplays();
    const action = target.closest<HTMLElement>("[data-add-action]")?.dataset.addAction;
    if (action === "close") closeAddReplays();
    else if (action === "choose") input.click();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAddReplays();
    } else if (event.key === "Tab") {
      const focusable = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), input:not([hidden])")];
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

let overlay: HTMLDivElement | null = null;
function showDropOverlay(count: number | null) {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "add-replays-drop";
    overlay.setAttribute("role", "status");
    document.body.appendChild(overlay);
  }
  const title = count === 0 ? "No .rep files to add" : count ? `Drop to add ${count} ${count === 1 ? "replay" : "replays"}` : "Drop to add replays";
  overlay.innerHTML = `${ICONS.file}<strong>${title}</strong><small>They are saved to your War of Dots replays folder. Files that are not .rep are skipped.</small>`;
  overlay.classList.toggle("is-empty", count === 0);
}
function hideDropOverlay() {
  overlay?.remove();
  overlay = null;
}

/**
 * Lets replay files be dropped anywhere on the window while `active` says the
 * library shows; `added` runs after new replays reach the replay folder.
 */
export function installReplayDrop({ active, added }: { active: () => boolean; added: () => void }) {
  onAdded = added;
  if (isTauri()) {
    // The app's window receives dropped files as paths rather than browser drop events.
    void getCurrentWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        if (active()) showDropOverlay(payload.paths.filter((path) => isReplayName(path)).length);
      } else if (payload.type === "leave") hideDropOverlay();
      else if (payload.type === "drop") {
        const shown = Boolean(overlay);
        hideDropOverlay();
        const paths = payload.paths.filter((path) => isReplayName(path));
        if (shown && paths.length) addReplayPaths(paths);
      }
    });
    return;
  }
  // The frame shows only while files are over the window. Entering a child
  // element fires dragenter before the dragleave of the one just left.
  const carriesFiles = (event: DragEvent) => active() && Boolean(event.dataTransfer?.types.includes("Files"));
  let depth = 0;
  addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    if (++depth === 1) showDropOverlay(null);
  });
  addEventListener("dragleave", (event) => {
    if (carriesFiles(event) && --depth <= 0) {
      depth = 0;
      hideDropOverlay();
    }
  });
  addEventListener("dragover", (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
  addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    hideDropOverlay();
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => isReplayName(file.name));
    if (files.length) addReplayFiles(files);
  });
}
