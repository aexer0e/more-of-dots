// Sharing and downloading the replays kept in this browser, for the site's pages
// and the play page. A replay is uploaded the first time it is shared; its link
// preview then gets a picture drawn here (card.js).
import { getReplay, saveReplay } from "./library.js";
import { shareReplay, unshareReplay, uploadCard } from "./share.js";
import { CARD_VERSION, drawCard } from "./card.js";
import { reduceTroops } from "../replays/troop-lines";

const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
const revalidate = { cache: "no-cache" };

export const shareLink = (id) => new URL(`r/${id}`, base).href;

/// Copies text that may still be on its way, while the click that asked for it counts.
export async function copy(text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
  } catch {
    await navigator.clipboard.writeText(await text);
  }
}

/// Uploads a kept replay the first time it is shared. Resolves once it is shared.
export async function shareKept(id) {
  const record = await getReplay(id);
  if (!record) throw new Error("The replay is no longer in this browser.");
  if (record.shared) return;
  const { token } = await shareReplay(record.blob);
  const current = await getReplay(id);
  if (current) return void (await saveReplay({ ...current, shared: { token: token ?? null } }));
  // Removed while it uploaded.
  if (token) await unshareReplay(id, token);
  throw new Error("The replay was removed before it was shared.");
}

/// Shares a kept replay and copies its link. `id` may still be on its way; the
/// copy starts at once so the click that asked for it counts. Resolves to the
/// message to show.
export async function copyShareLink(id) {
  const uploaded = Promise.resolve(id).then(async (resolved) => {
    await shareKept(resolved);
    return resolved;
  });
  try {
    await copy(uploaded.then(shareLink));
    return "Link copied.";
  } catch {
    const failed = await uploaded.then(() => null, (error) => error);
    if (failed) throw failed;
    return `Link: ${shareLink(await uploaded)}`;
  } finally {
    void uploaded.then(addCard, () => {});
  }
}

/// Saves a kept replay as a file, under its own name or its players' names.
export function downloadKept(record) {
  const own = /^[0-9a-f]{16}\.rep$/i.test(record.name ?? "") ? "" : record.name;
  const name = (own || `${record.players.join(" vs ") || "replay"}.rep`).replace(/[\\/:*?"<>|]+/g, "_");
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(record.blob), download: /\.rep$/i.test(name) ? name : `${name}.rep` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

/// Gives a replay this browser shared the picture its link preview shows, once per card design.
export async function addCard(id) {
  const record = await getReplay(id);
  const token = record?.shared?.token;
  if (!token || record.shared.card === CARD_VERSION) return;
  try {
    const picture = record.thumb ?? mapPicture(record.mapRef, await publishedMaps());
    const troops = await replayTroops(record);
    await uploadCard(id, token, await drawCard({ players: record.players, frames: record.frames, version: record.version, picture, troops }, base));
    const current = await getReplay(id);
    if (current?.shared) await saveReplay({ ...current, shared: { ...current.shared, card: CARD_VERSION } });
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
/// The troop lines of a kept replay, or null when it cannot be simulated.
export function replayTroops(record) {
  if (record.troops) return Promise.resolve(record.troops);
  if (!troopRequests.has(record.id)) {
    const request = troopQueue.then(() => simulateTroops(record)).then(async (troops) => {
      const current = await getReplay(record.id);
      if (current) await saveReplay({ ...current, troops });
      return troops;
    }).catch(() => null);
    troopRequests.set(record.id, request);
    troopQueue = request;
  }
  return troopRequests.get(record.id);
}

// The official map images the site publishes, as listed by the build.
let mapIndex;
export const publishedMaps = () =>
  (mapIndex ??= fetch(`${base}maps/index.json`, revalidate).then((r) => (r.ok ? r.json() : [])).catch(() => []).then((list) => new Set(list)));
/// The picture of an official map a replay names, found the way More of Dots
/// finds it in the game: by its image path, or by number in each map set.
/// Zolamare comes first because the game gives it the numbers both sets use.
export function mapPicture(ref, maps) {
  if (!ref) return null;
  const name = ref.replaceAll("\\", "/").toLowerCase();
  const candidates = /^\d+$/.test(name)
    ? ["zolamare", "fahero", "eronion"].map((set) => `assets/${set}_maps/map${name}.png`).concat(`map${name}.png`)
    : [name, name.split("/").pop()];
  const found = candidates.find((candidate) => maps.has(candidate));
  return found ? `${base}maps/${found}` : null;
}
