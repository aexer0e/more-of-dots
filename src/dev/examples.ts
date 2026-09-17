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
  const board = query.get('board') as Board, names = query.getAll('player');
  const to = Number(query.get('to')), days = Number(query.get('days')), from = days === 0 ? 0 : to - days * 86400, step = days === 7 ? 21600 : 86400;
  const buckets = new Map<number, Snapshot>();
  for (const row of data.leaderboard.history) if (row.capturedAt >= from && row.capturedAt <= to) buckets.set(Math.floor(row.capturedAt / step), row);
  const result: History = { from, to, step, rows: [...buckets.values()].map((row) => ({ capturedAt: row.capturedAt, players: names.map((nickname) => { const player = row[board].find((p) => p.nickname === nickname); return { nickname, rank: player?.rank ?? null, value: player?.value ?? null }; }) })) };
  return result as T;
}
export async function exampleInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const data = await examples();
  let result: unknown;
  switch (command) {
    case 'leaderboard_identity': result = data.identity; break;
    case 'list_replays': result = { replays: data.replays.slice(0, 100) }; break;
    case 'replay_thumbnail_paths': result = []; break;
    case 'list_maps': result = data.maps; break;
    case 'read_map': result = data.maps.find((m) => m.fileName === args.fileName); break;
    case 'save_map': {
      const map = data.maps.find((m) => m.fileName === args.fileName);
      if (!map) throw new Error('Example map not found.');
      map.data = args.data as StoredMap['data'];
      const header = Uint8Array.from(atob(map.data.map_surface).slice(0, 24), (char) => char.charCodeAt(0));
      if (header.length >= 24) { const view = new DataView(header.buffer); map.width = view.getUint32(16); map.height = view.getUint32(20); }
      map.teamCount = Math.max(2, map.data.infantry.length, map.data.tanks.length, map.data.motorised.length);
      map.updatedAt = Date.now(); result = map; break;
    }
    case 'create_map': {
      const { emptyMapData } = await import('../map-editor/lib/mapCodec');
      const id = `example-${Date.now()}.txt`;
      const map: StoredMap = { id, fileName: id, name: String(args.name), data: emptyMapData(args.mode as '1v1'), width: 960, height: 540, teamCount: args.mode === 'v4' ? 4 : args.mode === 'v3' ? 3 : 2, createdAt: Date.now(), updatedAt: Date.now() };
      data.maps.unshift(map); result = map; break;
    }
    case 'delete_maps': data.maps = data.maps.filter((m) => !(args.fileNames as string[]).includes(m.fileName)); result = args.fileNames; break;
    case 'delete_replay': data.replays = data.replays.filter((r) => r.filePath !== args.filePath); result = 1; break;
    default: throw new Error('This action needs the desktop app. Example mode never launches the game or changes your Steam files.');
  }
  return structuredClone(result) as T;
}
