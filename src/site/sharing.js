// Sharing and downloading the replays kept in this browser, for the site's pages
// and the play page. A replay is uploaded the first time it is shared; its link
// preview then gets a picture drawn here (card.js).
import { getReplay, saveReplay } from "./library.js";
import { shareReplay, unshareReplay, uploadCard, uploadTroops } from "./share.js";
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
    void uploaded.then(async (resolved) => {
      await addCard(resolved);
      await addTroops(resolved);
    }, () => {});
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

/// Gives a replay this browser shared its troop lines, once, so All replays can draw them
/// without simulating it.
export async function addTroops(id) {
  const record = await getReplay(id);
  const token = record?.shared?.token;
  if (!token || record.shared.troops) return;
  try {
    const troops = await replayTroops(record);
    if (!troops) return;
    await uploadTroops(id, token, troops);
    const current = await getReplay(id);
    if (current?.shared) await saveReplay({ ...current, shared: { ...current.shared, troops: true } });
  } catch {
    // Sent again the next time the visitor's replays are shown.
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
  const found = officialMap(ref, maps);
  return found ? `${base}maps/${found}` : null;
}
function officialMap(ref, maps) {
  if (!ref) return null;
  const name = String(ref).replaceAll("\\", "/").toLowerCase();
  const candidates = /^\d+$/.test(name)
    ? ["zolamare", "fahero", "eronion"].map((set) => `assets/${set}_maps/map${name}.png`).concat(`map${name}.png`)
    : [name, name.split("/").pop()];
  return candidates.find((candidate) => maps.has(candidate)) ?? null;
}
// Maps are told apart as More of Dots tells them apart: an official map by its image,
// whichever way a replay names it, and a custom map by the SHA-256 of its image. A
// replay's key (library.js, share/src/listing.js) is "vanilla:<image or number>" or
// "custom:<hash>"; its identity names an official map by the image it resolves to.
export function mapIdentity(key, maps) {
  if (!key) return null;
  if (!key.startsWith("vanilla:")) return key;
  const file = officialMap(key.slice(8), maps);
  return file ? `vanilla:${file}` : key;
}
/// A map's label: "Fahero 12", or "#" and the start of a custom map's hash.
export function mapLabel(key, maps) {
  if (key?.startsWith("custom:")) return `#${key.slice(7, 17)}`;
  return (key && mapName(key.slice(8), maps)) ?? "Unknown map";
}
/// The keys replays can give the map of this identity.
export function mapKeys(id, maps) {
  if (!id?.startsWith("vanilla:")) return id ? [id] : [];
  const file = id.slice(8);
  const keys = new Set([id, `vanilla:${file.split("/").pop()}`]);
  const number = /map(\d+)\.png$/.exec(file)?.[1];
  if (number && officialMap(number, maps) === file) keys.add(`vanilla:${number}`);
  return [...keys];
}
/// The picture of the map of this identity, when it is an official one.
export const identityPicture = (id, maps) => (id?.startsWith("vanilla:") ? mapPicture(id.slice(8), maps) : null);

/// An official map's name as More of Dots labels it, such as "Fahero 12".
export function mapName(ref, maps) {
  const found = officialMap(ref, maps);
  const match = found && /(?:(\w+?)_maps\/)?map(\d+)\.png$/.exec(found);
  if (!match) return null;
  return match[1] ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}` : `Map ${match[2]}`;
}
