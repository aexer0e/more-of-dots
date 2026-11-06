// Saves a match continued from a replay as a replay of its own: the original's
// commands up to the frame the match started from, then the commands the players
// gave, in the game's replay format. The replay player shows it like any other.

async function text(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/** The match as .rep bytes (gzip JSON, as the game writes them). */
export async function matchReplay({ replay, startFrame, log, end, result, names }) {
  const root = JSON.parse(await text(replay));
  for (const key of Object.keys(root)) if (/^\d+$/.test(key) && Number(key) >= startFrame) delete root[key];
  for (const { tick, commands } of log) {
    const entry = {};
    let productions = 0;
    for (const command of commands) {
      for (const [id, points] of command.orders || []) entry[String(id)] = points;
      for (const production of command.production || []) entry[`production${productions++}`] = { color: command.side, ...production };
      if (command.message) entry[`message${command.side}`] = command.message;
    }
    if (Object.keys(entry).length) root[String(tick)] = entry;
  }
  root.end = end;
  root.result = result;
  if (names?.some((team) => team.length)) root.player_usernames = names;
  const json = new Blob([JSON.stringify(root)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(json).arrayBuffer());
}
