// The list of every shared replay, for the site's All replays section:
//   GET /replays?sort=&modes=&maps=&player=&map=&q=&refs=&min=&max=&offset=&limit=
//     sort    newest (the default), oldest, shortest or longest
//     modes   match formats to show, comma separated (1v1,2v2,3P,4P,Experiment,Avalanche); all when left out
//     maps    vanilla, custom or both; both when left out
//     player  one player's replays, by exact name in any case
//     map     one map's replays, by its keys, comma separated (an official map can be
//             named by its image or by its number, which gives it more than one key)
//     q       text a player's name contains; "#" and hex digits match a custom map's key
//     refs    official maps whose names the text matches, comma separated: the site knows
//             the maps' names, this worker only the images they are kept in
//     min, max  length in seconds
//   → { total, replays: [...], modes: { <format>: count }, maps: { vanilla, custom }, longest }
//   `modes` counts the replays each format would show with the other filters, and
//   `maps` each kind of map; `longest` is the longest replay in frames, for the length filter.
//   GET /replays/suggest?q=&refs=&(the same filters)
//   → { players: [{ name, count, latest }], maps: [{ key, count, latest }] }
//   the players whose names contain the text and the maps it names, for the search's suggestions.
//   GET /replays/<id>/thumb  → the custom map's picture (PNG)
//   PUT /replays/<id>/troops → keeps the lines of its card (troopsOf)
// Each replay is described once (columns mode, custom, map, map_key and thumb) when it
// is shared. Replays shared before then are described by scripts/describe.mjs, or a few
// at a time as the list is read. Each replay's players and the totals of every player
// and map are kept by triggers (migrations/0005_stats.sql), so suggestions without
// other filters read only those totals.
import { details, fromBase64, replayText } from "./replay.js";

export const MATCH_TYPES = ["1v1", "2v2", "3P", "4P", "Experiment", "Avalanche"];
const MAX_THUMB = 768 << 10;
const MAX_PAGE = 48;
const MAX_KEYS = 200;
const SUGGESTIONS = 8;
const ORDER = {
  newest: "created DESC",
  oldest: "created ASC",
  shortest: "frames IS NULL, frames ASC, created DESC",
  longest: "frames IS NULL, frames DESC, created DESC",
};

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
/// The key of an official map a replay names: its image, lower case, with forward slashes.
export const vanillaKey = (ref) => `vanilla:${String(ref).replaceAll("\\", "/").toLowerCase()}`;

/// The columns a replay's details fill.
export async function columns(text) {
  const { players, frames, version, mode, custom, mapRef, surface } = details(text ?? "");
  let image = null;
  if (surface) {
    try {
      image = fromBase64(surface);
    } catch {
      image = null;
    }
  }
  // A custom map is known by its image, as More of Dots knows it: the SHA-256 of its PNG bytes.
  const mapKey = image ? `custom:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", image)))}` : mapRef ? vanillaKey(mapRef) : null;
  const thumb = image && image.length <= MAX_THUMB ? image : null;
  return { players: JSON.stringify(players), frames, version, mode, custom: custom ? 1 : 0, map: mapRef, mapKey, thumb };
}

/// Reads a stored replay again and fills in its details.
export async function describe(env, id, data) {
  const c = await columns(await replayText(new Uint8Array(data)));
  await env.DB.prepare("UPDATE replays SET players = ?, frames = ?, version = ?, mode = ?, custom = ?, map = ?, map_key = ?, thumb = ? WHERE id = ?")
    .bind(c.players, c.frames, c.version, c.mode, c.custom, c.map, c.mapKey, c.thumb, id)
    .run();
  return c;
}

async function describeSome(env, count) {
  const { results } = await env.DB.prepare("SELECT id, data FROM replays WHERE mode IS NULL OR map_key IS NULL LIMIT ?").bind(count).all();
  for (const row of results) await describe(env, row.id, row.data).catch((error) => console.error(error));
}

/// A card's troop lines as they are kept: one list of whole numbers per side, or null
/// when they are not that. An empty list marks a replay that could not be simulated.
export function troopsOf(value) {
  const ok = Array.isArray(value) && value.length <= 4
    && value.every((side) => Array.isArray(side) && side.length <= 64
      && side.every((n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000));
  return ok ? JSON.stringify(value) : null;
}
const parsed = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};

const listOf = (value, allowed) => {
  if (value === null) return allowed;
  const chosen = value.split(",").filter((item) => allowed.includes(item));
  return [...new Set(chosen)];
};
const seconds = (value) => {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
};
const keysOf = (value, limit) => [...new Set((value ?? "").split(",").filter((key) => key && key.length <= 160))].slice(0, limit);
const like = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const LIKE = "LIKE ? ESCAPE '\\'";
const marks = (list) => list.map(() => "?").join(", ");

/// A player as the stats know them: their name without a title such as " [Champion]", in lower case.
export const playerKey = (name) => name.replace(/\s*\[[^\]]*\]$/, "").trim().toLowerCase();

function filtersOf(params) {
  const query = (params.get("q") ?? "").trim().slice(0, 64);
  // "#a7c91e" names a custom map by the start of its key, as its label shows it.
  const hash = /^#([0-9a-f]{4,64})$/i.exec(query)?.[1]?.toLowerCase() ?? null;
  return {
    modes: listOf(params.get("modes"), MATCH_TYPES),
    maps: listOf(params.get("maps"), ["vanilla", "custom"]),
    player: playerKey(params.get("player") ?? "").slice(0, 64) || null,
    map: keysOf(params.get("map"), MAX_KEYS),
    query,
    hash,
    named: keysOf(params.get("refs")?.toLowerCase(), MAX_KEYS).map(vanillaKey),
    min: seconds(params.get("min")),
    max: seconds(params.get("max")),
  };
}
/// Whether only the text is set, so the kept totals answer for every other filter.
const unfiltered = (f, kind) =>
  f.modes.length === MATCH_TYPES.length && f.maps.length === 2 && f.min === null && f.max === null
  && (kind === "player" || f.player === null) && (kind === "map" || !f.map.length);

/// The conditions of a list, leaving out one filter when asked: a format, a kind of
/// map, a player, a map or the text.
function conditions(f, omit) {
  const where = [],
    values = [];
  if (omit !== "modes" && f.modes.length < MATCH_TYPES.length) {
    where.push(f.modes.length ? `mode IN (${marks(f.modes)})` : "0");
    values.push(...f.modes);
  }
  if (omit !== "maps" && f.maps.length < 2) {
    where.push(f.maps.length ? "custom = ?" : "0");
    if (f.maps.length) values.push(f.maps[0] === "custom" ? 1 : 0);
  }
  if (omit !== "player" && f.player !== null) {
    where.push("replays.id IN (SELECT id FROM replay_players WHERE name_key = ?)");
    values.push(f.player);
  }
  if (omit !== "map" && f.map.length) {
    where.push(`map_key IN (${marks(f.map)})`);
    values.push(...f.map);
  }
  if (omit !== "query" && f.query) {
    // The text matches a player's name, the name of an official map, or a custom map's key.
    const either = [`players ${LIKE}`];
    values.push(like(f.query));
    if (f.named.length) {
      either.push(`map_key IN (${marks(f.named)})`);
      values.push(...f.named);
    }
    if (f.hash) {
      either.push("map_key LIKE ?");
      values.push(`custom:${f.hash}%`);
    }
    where.push(either.length > 1 ? `(${either.join(" OR ")})` : either[0]);
  }
  if (f.min !== null) {
    where.push("frames >= ?");
    values.push(f.min * 30);
  }
  if (f.max !== null) {
    where.push("frames < ?");
    values.push((f.max + 1) * 30);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", values };
}

export async function list(env, ctx, params) {
  const filters = filtersOf(params);
  const order = ORDER[params.get("sort")] ?? ORDER.newest;
  const limit = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(params.get("limit") ?? "", 10) || 12));
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "", 10) || 0);
  const all = conditions(filters),
    byMode = conditions(filters, "modes"),
    byMap = conditions(filters, "maps");
  const [page, total, modes, maps, longest] = await env.DB.batch([
    env.DB.prepare(`SELECT id, players, frames, version, created, size, mode, custom, map, map_key, thumb IS NOT NULL AS thumb, troops
      FROM replays ${all.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...all.values, limit, offset),
    env.DB.prepare(`SELECT count(*) AS n FROM replays ${all.sql}`).bind(...all.values),
    env.DB.prepare(`SELECT mode, count(*) AS n FROM replays ${byMode.sql} GROUP BY mode`).bind(...byMode.values),
    env.DB.prepare(`SELECT custom, count(*) AS n FROM replays ${byMap.sql} GROUP BY custom`).bind(...byMap.values),
    env.DB.prepare("SELECT max(frames) AS frames FROM replays"),
  ]);
  if (page.results.some((row) => row.mode === null || row.map_key === null) || modes.results.some((row) => row.mode === null))
    ctx.waitUntil(describeSome(env, 4));
  return {
    total: total.results[0]?.n ?? 0,
    replays: page.results.map((row) => ({
      id: row.id,
      players: parsed(row.players, []),
      frames: row.frames,
      version: row.version,
      created: row.created,
      size: row.size,
      mode: row.mode,
      custom: row.custom === 1,
      map: row.map,
      mapKey: row.map_key,
      thumb: row.thumb === 1,
      troops: parsed(row.troops, null),
    })),
    modes: Object.fromEntries(modes.results.filter((row) => row.mode !== null).map((row) => [row.mode, row.n])),
    maps: {
      vanilla: maps.results.find((row) => row.custom === 0)?.n ?? 0,
      custom: maps.results.find((row) => row.custom === 1)?.n ?? 0,
    },
    longest: longest.results[0]?.frames ?? 0,
  };
}

/// The players and maps the search's text could mean, with how many replays each has
/// under the other filters. Without other filters the kept totals answer, which reads
/// a row per player or map rather than every replay.
export async function suggest(env, params) {
  const f = filtersOf(params);
  if (!f.query) return { players: [], maps: [] };
  const statements = [];
  if (unfiltered(f, "player")) {
    statements.push(env.DB.prepare(`SELECT name, replays AS count, latest FROM player_stats WHERE name_key ${LIKE}
      ORDER BY replays DESC, latest DESC LIMIT ?`).bind(like(f.query.toLowerCase()), SUGGESTIONS));
  } else {
    const without = conditions({ ...f, query: "" }, "player");
    statements.push(env.DB.prepare(`SELECT min(p.name) AS name, count(*) AS count, max(replays.created) AS latest
      FROM replay_players AS p JOIN replays ON replays.id = p.id
      ${without.sql ? `${without.sql} AND` : "WHERE"} p.name_key ${LIKE}
      GROUP BY p.name_key ORDER BY count DESC, latest DESC LIMIT ?`).bind(...without.values, like(f.query.toLowerCase()), SUGGESTIONS));
  }
  const mapWhere = [],
    mapValues = [];
  if (f.named.length) {
    mapWhere.push(`map_key IN (${marks(f.named)})`);
    mapValues.push(...f.named);
  }
  if (f.hash) {
    mapWhere.push("map_key LIKE ?");
    mapValues.push(`custom:${f.hash}%`);
  }
  if (mapWhere.length) {
    const named = `(${mapWhere.join(" OR ")})`;
    if (unfiltered(f, "map")) {
      statements.push(env.DB.prepare(`SELECT map_key AS key, replays AS count, latest FROM map_stats WHERE ${named}
        ORDER BY replays DESC, latest DESC LIMIT ?`).bind(...mapValues, SUGGESTIONS * 2));
    } else {
      const without = conditions({ ...f, query: "" }, "map");
      statements.push(env.DB.prepare(`SELECT map_key AS key, count(*) AS count, max(created) AS latest FROM replays
        ${without.sql ? `${without.sql} AND` : "WHERE"} ${named} GROUP BY map_key ORDER BY count DESC, latest DESC LIMIT ?`)
        .bind(...without.values, ...mapValues, SUGGESTIONS * 2));
    }
  }
  const [players, maps] = await env.DB.batch(statements);
  return { players: players.results, maps: maps?.results ?? [] };
}

/// A custom map's picture, or null. Replays listed before their picture was kept
/// (scripts/describe.mjs fills in only their text) are read for it here, once.
export async function thumb(env, id) {
  const row = await env.DB.prepare("SELECT thumb, custom, mode FROM replays WHERE id = ?").bind(id).first();
  if (row?.thumb) return new Uint8Array(row.thumb);
  if (!row || (row.mode !== null && row.custom !== 1)) return null;
  const { data } = await env.DB.prepare("SELECT data FROM replays WHERE id = ?").bind(id).first();
  return (await describe(env, id, data)).thumb;
}
