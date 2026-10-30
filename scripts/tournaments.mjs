// Publishes tournaments for the hosted site. Each tournament is a folder holding its
// .rep files and a hand-written tournament.json (bracket, seeds, results and the
// in-game username of each player whose name is known). This copies the replays,
// assigns each one to the bracket match its two players played, and writes:
//   tournaments/index.json             one summary per tournament, for the home page
//   tournaments/<id>/tournament.json    the bracket plus every replay's details
//   tournaments/<id>/thumbs/<hash>.png  one map image per distinct map
// `troops` gives each replay's lines for its cards: the troops of each side.
// A replay whose players met more than once names its match in tournament.json:
//   "replays": { "file.rep": 113 }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const lower = (name) => String(name ?? '').trim().toLowerCase();

/// The details the site shows for a replay, read without simulating it.
export function readReplayHeader(bytes) {
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
  const replay = JSON.parse(text);
  const map = replay.map && typeof replay.map === 'object' ? replay.map : replay.custom_map;
  const teams = (replay.player_usernames ?? replay.player_names ?? []).map((team) =>
    (Array.isArray(team) ? team : [team]).map((player) => (typeof player === 'string' ? player : player?.username ?? '')));
  const cities = Array.isArray(map?.cities) ? map.cities.length : 0;
  return {
    players: teams.map((team) => team.join(' & ')),
    version: replay.version ?? null,
    frames: Number(replay.end) || 0,
    // Maps are named after their cities per player: 12 cities is "6 City".
    map: cities ? `${cities / 2} City` : null,
    surface: typeof map?.map_surface === 'string' ? map.map_surface : null,
  };
}

function publishTournament(source, target, id, troops) {
  const tournament = JSON.parse(fs.readFileSync(path.join(source, 'tournament.json'), 'utf8'));
  const usernames = new Map(tournament.players.filter((p) => p.username).map((p) => [lower(p.username), p.name]));
  const overrides = tournament.replays ?? {};
  fs.mkdirSync(path.join(target, 'thumbs'), { recursive: true });
  const replays = [];
  for (const file of fs.readdirSync(source).filter((name) => name.toLowerCase().endsWith('.rep')).sort()) {
    const bytes = fs.readFileSync(path.join(source, file));
    const header = readReplayHeader(bytes);
    const names = header.players.map((player) => usernames.get(lower(player)));
    let match = overrides[file];
    if (match === undefined) {
      if (names.some((name) => !name))
        throw new Error(`${id}/${file}: add the username of ${header.players.filter((_, i) => !names[i]).join(' and ')} to tournament.json.`);
      const played = tournament.matches.filter((m) =>
        [m.player1, m.player2].sort().join('\n') === [...names].sort().join('\n'));
      if (played.length !== 1)
        throw new Error(`${id}/${file}: ${names.join(' and ')} played ${played.length} matches; name this replay's match under "replays".`);
      match = played[0].id;
    }
    let thumb = null;
    if (header.surface) {
      const image = Buffer.from(header.surface, 'base64');
      thumb = `thumbs/${crypto.createHash('sha1').update(image).digest('hex').slice(0, 12)}.png`;
      fs.writeFileSync(path.join(target, thumb), image);
    }
    fs.copyFileSync(path.join(source, file), path.join(target, file));
    replays.push({ file, match, players: header.players, version: header.version, frames: header.frames, map: header.map, thumb, size: bytes.length, troops: troops?.(path.join(source, file)) ?? null });
  }
  for (const m of tournament.matches) {
    const count = replays.filter((r) => r.match === m.id).length;
    if (count > m.scores[0] + m.scores[1])
      throw new Error(`${id}: match ${m.id} has ${count} replays but only ${m.scores[0] + m.scores[1]} games.`);
  }
  fs.writeFileSync(path.join(target, 'tournament.json'), JSON.stringify({ id, ...tournament, replays }));
  const played = tournament.matches.filter((m) => m.scores[0] + m.scores[1] > 0);
  const champion = tournament.players.find((p) => p.name === tournament.results?.[0]?.player);
  return {
    id,
    // Earlier ids of the tournament, whose links the site still opens.
    aliases: tournament.aliases ?? [],
    name: tournament.name,
    format: tournament.format,
    started: tournament.started,
    ended: tournament.ended ?? null,
    players: tournament.players.length,
    champion: champion ? { name: champion.name, username: champion.username ?? null } : null,
    matches: played.length,
    games: played.reduce((sum, m) => sum + m.scores[0] + m.scores[1], 0),
    replays: replays.length,
    cover: replays.find((r) => r.thumb)?.thumb ?? null,
  };
}

/// Publishes every tournament folder under `source` into `target`.
export function publishTournaments(source, target, troops) {
  const summaries = [];
  for (const id of fs.readdirSync(source).sort()) {
    if (!fs.existsSync(path.join(source, id, 'tournament.json'))) continue;
    summaries.push(publishTournament(path.join(source, id), path.join(target, id), id, troops));
  }
  // Newest first.
  summaries.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'index.json'), JSON.stringify(summaries));
  return summaries;
}
