// Sharing replays through the wod-replays worker (share/), the service the hosted
// player uses. A replay is kept under the first 16 hex characters of its SHA-256,
// so sharing the same file twice, from here or from the site, gives the same link.
import { drawCard, type CardDetails } from "../site/card.js";

const API = import.meta.env.VITE_SHARE_API ?? "https://wod-replays.moreofdots.workers.dev";
export const SITE = "https://aexer0e.dev/wod-replay-player/";
// The replays this app shared, by id, with the token that lets it add the link
// preview's picture (null when someone had already shared the same file).
const SHARED_KEY = "wodSharedReplays";

type SharedRecord = { token: string | null; card?: boolean };

function readShared(): Record<string, SharedRecord> {
  try {
    const value = JSON.parse(window.localStorage.getItem(SHARED_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
const shared = readShared();
function saveShared() {
  try {
    window.localStorage.setItem(SHARED_KEY, JSON.stringify(shared));
  } catch {
    // The replay stays shared; only its green button is forgotten on restart.
  }
}

/** The id a replay is shared under, from the SHA-256 the library lists. */
export const shareId = (hash: string | null | undefined) => (hash && /^[0-9a-f]{64}$/.test(hash) ? hash.slice(0, 16) : null);
export const shareLink = (id: string) => `${SITE}r/${id}`;
export const isShared = (id: string | null) => Boolean(id && Object.hasOwn(shared, id));

async function request(path: string, options?: RequestInit): Promise<Response> {
  let response;
  try {
    response = await fetch(`${API}${path}`, options);
  } catch {
    throw new Error("Could not reach the replay service.");
  }
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error ?? "The replay service is not available right now."), { status: response.status });
  }
  return response;
}

/** Uploads a replay, or finds the copy already shared, and remembers it. */
export async function uploadReplay(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const { id, token } = (await (await request("/replays", { method: "POST", body: bytes })).json()) as { id: string; token?: string };
  shared[id] = { ...shared[id], token: token ?? shared[id]?.token ?? null };
  saveShared();
  return id;
}

/** Gives a replay this app shared the picture its link preview shows, once. */
export async function addCard(id: string, details: () => Promise<CardDetails>) {
  const record = shared[id];
  if (!record?.token || record.card) return;
  try {
    const card = await drawCard(await details(), SITE);
    await request(`/replays/${id}/card`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${record.token}`, "Content-Type": "image/jpeg" },
      body: card,
    });
    shared[id] = { ...shared[id], card: true };
    saveShared();
  } catch {
    // The preview shows the replay's details without a picture until the next share.
  }
}

/** Copies text that may still be on its way, while the click that asked for it counts. */
export async function copyText(text: Promise<string>) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
    return;
  } catch {
    // Some webviews only offer writeText, or neither.
  }
  const value = await text;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = Object.assign(document.createElement("textarea"), { value, readOnly: true });
    field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    focused?.focus();
    if (!copied) throw new Error("Could not copy the link.");
  }
}

/** A web address typed or pasted, plain or percent-encoded, or null. */
export function parseLink(text: string): URL | null {
  text = text.trim();
  try {
    const url = new URL(/^https?%3a/i.test(text) ? decodeURIComponent(text) : text);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

// A filename the game's replay folder accepts.
function replayName(name: string) {
  const stem = name.replace(/\.(rep|json)$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  return `${stem || "replay"}.rep`;
}

/**
 * The replay a link points to: one shared on the site (r/<id>, or s?=<link>), or
 * any other file, such as a Discord attachment, which the worker downloads since
 * most sites do not let other pages read their files.
 */
export async function downloadLink(url: URL): Promise<{ bytes: Uint8Array; name: string }> {
  if (url.hostname === new URL(SITE).hostname) {
    const id = /\/r\/([0-9a-f]{16})\/?$/.exec(url.pathname)?.[1] ?? /^#\/r\/([0-9a-f]{16})/.exec(url.hash)?.[1];
    if (id) {
      const response = await request(`/replays/${id}`).catch((error) => {
        throw error.status === 404 ? new Error("This replay is no longer shared.") : error;
      });
      return { bytes: new Uint8Array(await response.arrayBuffer()), name: `replay-${id}.rep` };
    }
    const inner = /\/s\/?$/.test(url.pathname) && /^\?(url)?=/.test(url.search) ? parseLink(url.search.slice(url.search.indexOf("=") + 1)) : null;
    if (inner) return downloadLink(inner);
  }
  const response = await request(`/fetch?url=${encodeURIComponent(url.href)}`);
  let name = url.pathname.split("/").pop() || "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the name as the link writes it.
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), name: replayName(name) };
}
