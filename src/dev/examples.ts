import type { Snapshot, History, Board } from '../leaderboard/client';
import type { StoredMap } from '../map-editor/lib/types';

type Examples = { generatedAt: number; identity: string; replays: { filePath: string }[]; maps: StoredMap[]; leaderboard: { latest: Snapshot; history: Snapshot[] } };
let pending: Promise<Examples> | undefined;
export function examples() {
  return pending ??= fetch('/__examples/data.json').then(async (response) => {
    if (!response.ok) throw new Error('Example data is missing. Restart npm run dev.');
    return response.json() as Promise<Examples>;
  });
}
export async function exampleLeaderboard<T>(url: string): Promise<T> {
  const data = await examples();
  if (url === '/v1/leaderboard') return structuredClone(data.leaderboard.latest) as T;
  const query = new URL(url, 'http://localhost').searchParams;
  if (url.startsWith('/v1/leaderboard/history?')) return { rows: data.leaderboard.history.filter((row) => row.capturedAt >= Number(query.get('from')) && row.capturedAt <= Number(query.get('to'))) } as T;
  const board = query.get('board') as Board, names = query.getAll('player');
  const to = Number(query.get('to')), days = Number(query.get('days')), from = days === 0 ? 0 : to - days * 86400, step = 120;
  const rows = data.leaderboard.history.filter((row) => row.capturedAt >= from && row.capturedAt <= to).map((row) => ({ capturedAt: row.capturedAt, players: names.map((nickname) => { const player = row[board].find((p) => p.nickname === nickname); return { nickname, rank: player?.rank ?? null, value: player?.value ?? null }; }) }));
  const result: History = { from, to, step, rows: rows.filter((row, index) => index === 0 || JSON.stringify(row.players) !== JSON.stringify(rows[index - 1].players)) };
  return result as T;
}
// `?replays=2000` repeats the examples to profile a large library in the browser.
function stressReplays<T extends { filePath: string }>(replays: T[]): T[] {
  const count = Math.min(20_000, Number(new URLSearchParams(location.search).get('replays')) || 0);
  if (!replays.length || count <= replays.length) return replays;
  return Array.from({ length: count }, (_, index) => {
    const replay = replays[index % replays.length];
    return index < replays.length ? replay : { ...replay, filePath: `${replay.filePath}#${index}` };
  });
}
// Two armies wearing down, varied by replay, for the troop lines on cards.
function exampleTroops(seed: string) {
  let state = [...seed].reduce((hash, character) => (Math.imul(hash, 31) + character.charCodeAt(0)) | 0, 7);
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) | 0) >>> 16 & 0xff;
  return [0, 1].map(() => {
    let troops = 2600;
    return Array.from({ length: 30 }, () => (troops = Math.max(100, troops - 90 + next() / 2 - 20)) | 0);
  });
}
let exampleRegion: string | null = null;
// The servers the game listed when this was written: one in Singapore, two in Frankfurt, one of them down.
const EXAMPLE_SERVERS = [
  { host: '13.212.239.74', cloudRegion: 'ap-southeast-1', region: 'ASIA', reachable: true, ms: 443 },
  { host: '3.64.57.116', cloudRegion: 'eu-central-1', region: 'EU', reachable: false, ms: null },
  { host: '3.122.195.131', cloudRegion: 'eu-central-1', region: 'EU', reachable: true, ms: 91 },
];
let exampleServers: typeof EXAMPLE_SERVERS | null = null;
export async function exampleInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const data = await examples();
  let result: unknown;
  switch (command) {
    case 'leaderboard_identity': result = data.identity; break;
    case 'list_replays': result = { replays: stressReplays(data.replays.slice(0, 100)) }; break;
    case 'replay_thumbnail_paths': result = []; break;
    case 'replay_troop_store': result = new URLSearchParams(location.search).has('notroops') ? '' : data.replays.slice(0, 100).map((replay) => JSON.stringify({ h: (replay as { hash?: string }).hash ?? replay.filePath, s: exampleTroops(replay.filePath) })).join('\n'); break;
    case 'replay_troop_lines': result = (args.filePaths as string[]).map((filePath) => ({ filePath, sides: new URLSearchParams(location.search).has('notroops') ? [] : exampleTroops(filePath) })); break;
    // The export dialog asks for a default folder and the game's sounds; examples never write videos.
    case 'recording_default_directory': result = 'C:\\Users\\Player\\Videos'; break;
    case 'game_audio': result = { files: {}, music: 0.3, sfx: 0.3 }; break;
    case 'list_maps': result = data.maps; break;
    case 'read_map': result = data.maps.find((m) => m.id === args.fileName); break;
    case 'save_map': {
      const map = data.maps.find((m) => m.id === args.fileName);
      if (!map) throw new Error('Example map not found.');
      const incoming = args.data as StoredMap['data'];
      if (args.publish && incoming.infantry.some((units, i) => units.length + incoming.tanks[i].length + incoming.motorised[i].length === 0)) {
        throw new Error('Each team needs at least one unit before saving to the game. You can save this map as a draft.');
      }
      map.data = args.data as StoredMap['data'];
      map.status = args.publish ? 'published' : 'draft';
      const header = Uint8Array.from(atob(map.data.map_surface).slice(0, 24), (char) => char.charCodeAt(0));
      if (header.length >= 24) { const view = new DataView(header.buffer); map.width = view.getUint32(16); map.height = view.getUint32(20); }
      map.teamCount = Math.max(2, map.data.infantry.length, map.data.tanks.length, map.data.motorised.length);
      map.updatedAt = Date.now(); result = map; break;
    }
    case 'create_map': {
      const { emptyMapData } = await import('../map-editor/lib/mapCodec');
      const id = `example-${Date.now()}.txt`;
      const map: StoredMap = { id, fileName: id, name: String(args.name), data: emptyMapData(args.mode as '1v1'), width: 960, height: 540, teamCount: args.mode === 'v4' ? 4 : args.mode === 'v3' ? 3 : 2, createdAt: Date.now(), updatedAt: Date.now() };
      map.status = 'draft';
      data.maps.unshift(map); result = map; break;
    }
    case 'delete_maps': data.maps = data.maps.filter((m) => !(args.fileNames as string[]).includes(m.id)); result = args.fileNames; break;
    // A pretend running game; example mode never touches the real one.
    case 'region_status': result = { gameRunning: true, selectedRegion: exampleRegion, selectedAt: exampleRegion ? Date.now() / 1000 : null, servers: exampleServers }; break;
    case 'select_region': {
      await new Promise((resolve) => setTimeout(resolve, 700));
      exampleServers = EXAMPLE_SERVERS;
      const available = EXAMPLE_SERVERS.some((server) => server.region === args.region && server.reachable);
      if (available) exampleRegion = String(args.region);
      result = {
        gameRunning: true, selectedRegion: exampleRegion, selectedAt: Date.now() / 1000, servers: exampleServers,
        unavailable: available ? null : 'War of Dots has no reachable North America server right now. Available: Asia, Europe.',
      };
      break;
    }
    case 'delete_replay':data.replays = data.replays.filter((r) => r.filePath !== args.filePath); result = 1; break;
    // Sharing reads the copied replay; adding one only reports success, so nothing leaves this session.
    case 'read_replay_file': {
      const response = await fetch(String(args.filePath));
      if (!response.ok) throw new Error('Replay file is not readable.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      result = btoa(binary);
      break;
    }
    case 'upload_replay': result = { fileName: args.fileName, alreadyAdded: data.replays.some((r) => r.filePath.endsWith(`/${String(args.fileName)}`)) }; break;
    default: throw new Error('This action needs the desktop app. Example mode never launches the game or changes your Steam files.');
  }
  return structuredClone(result) as T;
}
