// Replays a visitor chooses to share go to the wod-replays worker (share/), which
// keeps them under the same id as the library does, so a link opens them anywhere.
// The worker also downloads replays from links, which a page often cannot read itself.
const API = import.meta.env.VITE_SHARE_API ?? "https://wod-replays.moreofdots.workers.dev";

async function request(path, options) {
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

/// Every shared replay, a page at a time: `params` sorts and filters them (share/src/listing.js).
export const listShared = async (params) => (await request(`/replays?${new URLSearchParams(params)}`)).json();
/// The players and maps a search's text could mean among every shared replay.
export const suggestShared = async (params) => (await request(`/replays/suggest?${new URLSearchParams(params)}`)).json();
/// The picture of a shared replay's custom map.
export const thumbLink = (id) => `${API}/replays/${id}/thumb`;

/// Uploads a replay. Resolves to `{ id, token }`; `token` lets this browser stop
/// sharing it and is missing when someone had already shared the same file.
export const shareReplay = async (blob) => (await request("/replays", { method: "POST", body: blob })).json();

/// A shared replay's file, or null when it is no longer shared.
export async function fetchShared(id) {
  try {
    return await (await request(`/replays/${id}`)).blob();
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/// Adds the picture a shared replay's link preview shows; only its sharer can.
export const uploadCard = (id, token, blob) =>
  request(`/replays/${id}/card`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg" }, body: blob });

/// Keeps the troop lines of a shared replay's card with it, so visitors need not simulate it.
export const uploadTroops = (id, token, troops) =>
  request(`/replays/${id}/troops`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(troops) });

export async function unshareReplay(id, token) {
  try {
    await request(`/replays/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

/// Downloads the replay at a link through the worker, since most sites, Discord
/// included, do not let other pages read their files.
export const downloadLink = async (url) => (await request(`/fetch?url=${encodeURIComponent(url.href)}`)).blob();
