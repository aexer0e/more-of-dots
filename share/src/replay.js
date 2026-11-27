// Reading .rep files: gzip or plain JSON. Replays are checked and described
// without JSON.parse, which would cost too much time on a large one.
export const MAX_SIZE = 1 << 20;
const MAX_TEXT = 32 << 20;

/// The replay's text, or null when it is not gzip or text or is too large.
export async function replayText(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const decoder = new TextDecoder();
  let text = "";
  try {
    for await (const chunk of new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > MAX_TEXT) return null;
    }
  } catch {
    return null;
  }
  return text;
}

/// Whether the text is a War of Dots replay: JSON with a map, as the site reads them.
export function isReplay(text) {
  const trimmed = text?.trim() ?? "";
  return trimmed.startsWith("{") && trimmed.endsWith("}") && (trimmed.includes('"map"') || trimmed.includes('"custom_map"'));
}

/// The end of the JSON value that starts at `at`: past a string, an object or
/// array with everything inside it, or a number or literal.
function valueEnd(text, at) {
  const first = text[at];
  if (first === '"') {
    for (let i = at + 1; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') return i + 1;
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    for (let i = at, depth = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      } else if (c === "{" || c === "[") depth++;
      else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
    }
    return text.length;
  }
  let i = at;
  while (i < text.length && !/[,}\]\s]/.test(text[i])) i++;
  return i;
}

const WANTED = new Set(["version", "mode", "player_usernames", "player_names", "end", "map", "custom_map"]);

/// The replay's own fields that describe it, parsed, and its highest frame number.
/// Every other field (the orders of each frame) is skipped without parsing it.
function topLevel(text) {
  const fields = {};
  let lastFrame = 0;
  let i = text.indexOf("{") + 1;
  const space = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  while (i > 0 && i < text.length) {
    space();
    if (text[i] !== '"') break;
    const keyEnd = valueEnd(text, i);
    let key;
    try {
      key = JSON.parse(text.slice(i, keyEnd));
    } catch {
      break;
    }
    i = keyEnd;
    space();
    if (text[i] !== ":") break;
    i++;
    space();
    const end = valueEnd(text, i);
    if (WANTED.has(key)) {
      try {
        fields[key] = JSON.parse(text.slice(i, end));
      } catch {
        // A field that does not parse describes nothing.
      }
    } else if (/^\d+$/.test(key)) lastFrame = Math.max(lastFrame, Number(key));
    i = end;
    space();
    if (text[i] !== ",") break;
    i++;
  }
  return { fields, lastFrame };
}

// The game's mode names, as the match formats the site and More of Dots filter by.
const MODES = { "1v1": "1v1", "2v2": "2v2", v3: "3P", v4: "4P", experiment: "Experiment", avalanche: "Avalanche" };

/// The match format: the replay's own mode, or, for free-for-all lobbies and older
/// replays, its number of sides and players per side.
export function matchType(mode, sides, teamSize) {
  if (MODES[mode]) return MODES[mode];
  if (sides <= 2) return teamSize > 1 ? "2v2" : "1v1";
  return sides >= 4 ? "4P" : "3P";
}

/// What a replay records about itself: its players (one name per side, teammates
/// joined with " & "), length in frames, game version, match format, and its map:
/// whether it is a custom map, the official map it names, and the custom map's picture
/// (base64 PNG).
export function details(text) {
  const { fields, lastFrame } = topLevel(text);
  const sides = fields.player_usernames ?? fields.player_names;
  const teams = (Array.isArray(sides) ? sides : []).map((team) =>
    (Array.isArray(team) ? team : [team]).map((p) => (typeof p === "string" ? p : typeof p?.username === "string" ? p.username : "")));
  const map = fields.map && typeof fields.map === "object" ? fields.map : fields.custom_map;
  const surface = typeof map?.map_surface === "string" && /^[A-Za-z0-9+/=]+$/.test(map.map_surface) ? map.map_surface : null;
  // Official maps are only named: by their image in the game (assets/fahero_maps/map4.png) or by number.
  const named = fields.map && typeof fields.map === "object" ? fields.map.path : fields.map;
  const end = Number(fields.end);
  return {
    players: teams.map((team) => team.join(" & ")),
    frames: Number.isFinite(end) && end > 0 ? Math.round(end) : lastFrame || null,
    version: typeof fields.version === "string" ? fields.version.slice(0, 32) : null,
    mode: matchType(typeof fields.mode === "string" ? fields.mode : null, teams.length, Math.max(1, ...teams.map((team) => team.length))),
    custom: surface !== null,
    mapRef: !surface && (typeof named === "string" || typeof named === "number") ? String(named).trim().slice(0, 200) || null : null,
    surface,
  };
}

/// The bytes of a base64 picture.
export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
