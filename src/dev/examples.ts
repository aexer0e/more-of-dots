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
export async function exampleInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const data = await examples();
  let result: unknown;
  switch (command) {
    case 'leaderboard_identity': result = data.identity; break;
    case 'list_replays': result = { replays: stressReplays(data.replays.slice(0, 100)) }; break;
    case 'replay_thumbnail_paths': result = []; break;
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
    case 'delete_replay': data.replays = data.replays.filter((r) => r.filePath !== args.filePath); result = 1; break;
    default: throw new Error('This action needs the desktop app. Example mode never launches the game or changes your Steam files.');
  }
  return structuredClone(result) as T;
}
