// The site's leaderboard, read through this worker so that every visitor shares one
// copy of each snapshot:
//   GET <site>/api/v1/leaderboard                  the latest Elo and World top 100
//   GET <site>/api/v1/leaderboard/refresh?board=&days=&player=...
//                                                  the same, with the history of up to 11 players
// The rankings come from the service More of Dots reads, which takes a snapshot every
// two minutes. Each answer is kept at the edge and in this isolate until the next
// snapshot is due, so the service is asked at most once per snapshot for each question,
// however many people are reading. Visitors who ask for more than their share of
// uncached questions are turned away for a minute.
const UPSTREAM = "https://wod-nations-map.moreofdots.workers.dev";
const LATEST = "/v1/leaderboard";
const REFRESH = "/v1/leaderboard/refresh";
const BOARDS = ["elo", "world"];
const DAYS = ["0", "1", "7", "30"];
const MAX_PLAYERS = 11;
const MAX_NAME = 64;
// Seconds: how long after a snapshot is due to ask for it, and the shortest a copy is kept.
const SLACK = 10;
const MIN_TTL = 20;
const DEFAULT_INTERVAL = 120;
const MAX_KEPT = 200;

const kept = new Map();
const pending = new Map();

/// The one form of a question, so the same question shares one copy, or null.
export function canonical(path, params) {
  if (path === LATEST) return LATEST;
  if (path !== REFRESH) return null;
  const board = BOARDS.includes(params.get("board")) ? params.get("board") : "elo";
  const days = DAYS.includes(params.get("days")) ? params.get("days") : "0";
  const players = [...new Set(params.getAll("player").map((name) => name.trim()).filter(Boolean))].sort();
  if (players.length > MAX_PLAYERS || players.some((name) => name.length > MAX_NAME)) return null;
  // `since` is left out: the full history is shared, where a delta would be one visitor's.
  const query = new URLSearchParams({ board, days });
  for (const name of players) query.append("player", name);
  return `${REFRESH}?${query}`;
}

/// When the snapshot after this one should be ready, in milliseconds.
export function expiry(data, now = Date.now()) {
  const interval = Number(data?.refreshIntervalSeconds);
  const step = Number.isFinite(interval) && interval >= 60 && interval <= 86400 ? interval : DEFAULT_INTERVAL;
  const captured = Number(data?.capturedAt);
  const due = Number.isFinite(captured) ? (captured + step + SLACK) * 1000 : now + step * 1000;
  return Math.max(now + MIN_TTL * 1000, Math.min(now + step * 1000, due));
}

function keep(key, entry) {
  kept.delete(key);
  kept.set(key, entry);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
}

function answer(request, entry, stale = false) {
  const age = stale ? 15 : Math.max(1, Math.round((entry.expires - Date.now()) / 1000));
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${age}`,
    ETag: entry.etag,
  };
  if (request.headers.get("If-None-Match") === entry.etag) return new Response(null, { status: 304, headers });
  return new Response(entry.body, { headers });
}

const failure = (status, error) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function ask(key, env, ctx, cacheKey) {
  const response = await fetch(UPSTREAM + key, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The leaderboard answered ${response.status}.`);
  const body = await response.text();
  const data = JSON.parse(body);
  if (!Number.isFinite(data?.capturedAt) || !Array.isArray(data.elo) || !Array.isArray(data.world)) throw new Error("The leaderboard sent an unexpected answer.");
  const entry = { body, etag: response.headers.get("ETag") ?? `"${data.capturedAt}-${body.length}"`, expires: expiry(data) };
  keep(key, entry);
  const ttl = Math.max(1, Math.round((entry.expires - Date.now()) / 1000));
  ctx.waitUntil(
    caches.default
      .put(cacheKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}`, ETag: entry.etag, "X-Expires": String(entry.expires) } }))
      .catch(() => {}),
  );
  return entry;
}

export async function leaderboard(request, env, ctx, path, params) {
  if (request.method !== "GET") return failure(405, "Method not allowed.");
  if (path !== LATEST && path !== REFRESH) return failure(404, "Not found.");
  const key = canonical(path, params);
  if (!key) return failure(400, "Ask for at most 11 players.");
  const known = kept.get(key);
  if (known && known.expires > Date.now()) return answer(request, known);
  if (pending.has(key)) {
    try {
      return answer(request, await pending.get(key));
    } catch {
      return known ? answer(request, known, true) : failure(502, "The leaderboard is not available right now. Try again shortly.");
    }
  }
  const cacheKey = new Request(new URL(`/wod-replay-player/api${key}`, request.url).href);
  const task = (async () => {
    const cached = await caches.default.match(cacheKey).catch(() => undefined);
    const expires = Number(cached?.headers.get("X-Expires"));
    if (cached && expires > Date.now()) {
      const entry = { body: await cached.text(), etag: cached.headers.get("ETag") ?? "", expires };
      keep(key, entry);
      return entry;
    }
    const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (env.LEADERBOARD && !(await env.LEADERBOARD.limit({ key: address })).success) throw Object.assign(new Error("limited"), { limited: true });
    return ask(key, env, ctx, cacheKey);
  })();
  pending.set(key, task);
  try {
    return answer(request, await task);
  } catch (error) {
    if (known) return answer(request, known, true);
    if (error.limited) return failure(429, "Too many leaderboard requests. Try again in a minute.");
    console.error(error);
    return failure(502, "The leaderboard is not available right now. Try again shortly.");
  } finally {
    pending.delete(key);
  }
}
