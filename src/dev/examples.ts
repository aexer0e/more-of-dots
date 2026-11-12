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
// A generated Nations campaign: 115 days of 30-minute captures over the real playable area.
type ExampleCapture = { capturedAt: number; share: number; cities: number };
let exampleCampaign: ExampleCapture[] | null = null;
function nationsCampaign() {
  if (exampleCampaign) return exampleCampaign;
  const latest = Math.floor(Date.now() / 1000 / 1800) * 1800 - 1800;
  const count = 115 * 48;
  let state = 17, share = 50;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) | 0) >>> 8 & 0xffff;
  exampleCampaign = Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    const target = 50 + 3 * t + 1.6 * Math.sin(t * Math.PI * 2.3) * (1 - t);
    share += (target - share) * 0.02 + (next() / 0xffff - 0.5) * 0.12;
    return { capturedAt: latest - (count - 1 - index) * 1800, share, cities: Math.round(295 * (share - 0.6 + Math.sin(index / 37)) / 100) };
  });
  return exampleCampaign;
}
const PLAYABLE = 983237;
function exampleRow(capture: ExampleCapture, index: number) {
  const bluePixels = Math.round(PLAYABLE * capture.share / 100);
  return {
    id: index + 1, capturedAt: capture.capturedAt, mapHash: `example-${Math.round(capture.share * 10)}`, width: 1920, height: 1080,
    encoding: 'playable-bitset-zlib-v1', playablePixels: PLAYABLE, mapUrl: `/v1/snapshots/${index + 1}/map`,
    redPixels: PLAYABLE - bluePixels, bluePixels, redCities: 295 - capture.cities, blueCities: capture.cities,
  };
}
async function deflate(bytes: Uint8Array<ArrayBuffer>, mode: 'compress' | 'decompress') {
  const stream = new Response(bytes).body!.pipeThrough(mode === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** Blue holds the west and north of a wavy front, Red the rest. Bit 1 is Red. */
async function exampleOwnership(share: number) {
  const mask = await deflate(new Uint8Array(await (await fetch('/nations/playable-mask.bitset.zlib')).arrayBuffer()), 'decompress');
  const bits = new Uint8Array(Math.ceil(PLAYABLE / 8));
  let index = 0;
  const front = 1920 * (0.32 + share / 100 * 0.5);
  for (let pixel = 0; pixel < 1920 * 1080; pixel++) {
    if (!((mask[pixel >> 3] >> (pixel & 7)) & 1)) continue;
    const x = pixel % 1920, y = Math.floor(pixel / 1920);
    if (x > front + 140 * Math.sin(y / 90) + 60 * Math.sin(y / 23)) bits[index >> 3] |= 1 << (index & 7);
    index++;
  }
  return deflate(bits, 'compress');
}
export async function exampleNations(path: string): Promise<Response> {
  const url = new URL(path, 'http://localhost');
  const campaign = nationsCampaign();
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/v1/timeline/summary') {
    const after = Number(url.searchParams.get('after')) || 0;
    return json({ rows: campaign.map(exampleRow).filter((row) => row.capturedAt >= after), oldestCapturedAt: campaign[0].capturedAt, latestCapturedAt: campaign.at(-1)!.capturedAt });
  }
  if (url.pathname === '/v1/timeline') {
    const from = Number(url.searchParams.get('from')) || 0, to = Number(url.searchParams.get('to')) || Infinity;
    const before = Number(url.searchParams.get('before')) || Infinity, limit = Math.min(1000, Number(url.searchParams.get('limit')) || 336);
    const rows = campaign.map(exampleRow).filter((row) => row.capturedAt >= from && row.capturedAt <= to && row.capturedAt < before).reverse();
    return json({ rows: rows.slice(0, limit), nextBefore: rows.length > limit ? rows[limit - 1].capturedAt : null });
  }
  if (/^\/v1\/snapshots\/\d+\/map$/.test(url.pathname)) {
    const capture = campaign[Number(url.pathname.split('/')[3]) - 1] ?? campaign.at(-1)!;
    return new Response(await exampleOwnership(capture.share));
  }
  if (url.pathname === '/v1/nations') {
    return json({ capturedAt: campaign.at(-1)!.capturedAt, nations: [
      { nation: 0, cash: 355_210, net_worth: 1_310_400, players: 236 },
      { nation: 1, cash: 410_880, net_worth: 1_420_150, players: 212 },
    ] });
  }
  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
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
    // The map a replay records, for the import dialog's cards. The desktop app reads
    // official maps from the game; examples use the replay's map image instead.
    case 'replay_map_preview': {
      const filePath = String(args.filePath);
      const bytes = new Uint8Array(await (await fetch(filePath)).arrayBuffer());
      const text = bytes[0] === 0x1f && bytes[1] === 0x8b
        ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
        : new TextDecoder().decode(bytes);
      const raw = JSON.parse(text) as { mode?: string; map?: unknown; custom_map?: unknown };
      const map = (typeof raw.map === 'object' && raw.map ? raw.map : raw.custom_map) as Record<string, unknown> | undefined;
      if (!map || !Array.isArray(map.infantry)) throw new Error('This example replay names an official map; the desktop app reads its layout from the game.');
      let surface = typeof map.map_surface === 'string' ? map.map_surface : '';
      if (!surface) {
        const thumbnail = (data.replays.find((replay) => replay.filePath === filePath) as { thumbnailDataUrl?: string } | undefined)?.thumbnailDataUrl;
        if (!thumbnail) throw new Error('No map image for this example replay.');
        const png = new Uint8Array(await (await fetch(thumbnail)).arrayBuffer());
        let binary = '';
        for (let at = 0; at < png.length; at += 0x8000) binary += String.fromCharCode(...png.subarray(at, at + 0x8000));
        surface = btoa(binary);
      }
      const header = Uint8Array.from(atob(surface).slice(0, 24), (character) => character.charCodeAt(0));
      const view = new DataView(header.buffer);
      result = { data: { ...map, map_surface: surface }, width: view.getUint32(16), height: view.getUint32(20), mode: raw.mode ?? '' };
      break;
    }
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
      if (args.publish && incoming.infantry.some((units, i) => units.length + incoming.tanks[i].length === 0)) {
        throw new Error('Each team needs at least one unit before saving to the game. You can save this map as a draft.');
      }
      map.data = args.data as StoredMap['data'];
      map.status = args.publish ? 'published' : 'draft';
      const header = Uint8Array.from(atob(map.data.map_surface).slice(0, 24), (char) => char.charCodeAt(0));
      if (header.length >= 24) { const view = new DataView(header.buffer); map.width = view.getUint32(16); map.height = view.getUint32(20); }
      map.teamCount = Math.max(2, map.data.infantry.length, map.data.tanks.length);
      map.updatedAt = Date.now(); result = map; break;
    }
    case 'create_map': {
      const { emptyMapData } = await import('../map-editor/lib/mapCodec');
      const id = `example-${Date.now()}.txt`;
      const [width, height] = args.large ? [1920, 1080] : [960, 540];
      const map: StoredMap = { id, fileName: `${String(args.name)}.txt`, name: String(args.name), data: emptyMapData(Number(args.teams) || 2, width, height), width, height, teamCount: Number(args.teams) || 2, createdAt: Date.now(), updatedAt: Date.now() };
      map.status = 'draft';
      data.maps.unshift(map); result = map; break;
    }
    case 'rename_map': {
      const map = data.maps.find((m) => m.id === args.fileName);
      if (!map) throw new Error('Map not found.');
      const name = String(args.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
      if (!name) throw new Error('Enter a map name with letters or numbers.');
      if (data.maps.some((m) => m !== map && m.name.toLowerCase() === name.toLowerCase())) throw new Error(`A map named ${name} already exists.`);
      map.name = name;
      map.fileName = `${name}.txt`;
      map.updatedAt = Date.now(); result = map; break;
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
