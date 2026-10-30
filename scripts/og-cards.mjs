// Link previews for the hosted site. Chat apps read a page's preview from its
// HTML, so the share worker (share/) serves each page with tags it looks up in
// og/pages.json. This writes that file and, for tournament games and matches
// with replays, the card picture each preview shows (og/<path>.png).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { roundName, sides } from '../src/site/bracket.js';
import { troopCurves } from '../src/replays/troop-lines.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const WIDTH = 1200, HEIGHT = 630;
const BLUE = '#8cc0ee', RED = '#ff8a8a', MUTED = '#c4cdc8', TEXT = '#eef4f0';
const SIDE_COLORS = [BLUE, RED, '#c084fc', '#ffa25c'];

const HOME = { title: 'War of Dots Replays', description: 'Watch War of Dots replays in the browser.' };

const plain = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const withUsername = (name, username) => (username && plain(username) !== plain(name) ? `${name} (${username})` : name);
const day = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
// When a tournament ran, as its page shows it: "September 5 – October 19".
const dates = (t) => (t.started ? (t.ended ? `${day(t.started)} – ${day(t.ended)}` : day(t.started)) : null);
const clock = (frames) => {
  const s = Math.floor(frames / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// satori takes plain element objects; every box with several children is a flex box.
const h = (type, style, ...children) => ({ type, props: { style: { display: 'flex', ...style }, children: children.flat().filter((c) => c !== null && c !== false) } });
const img = (src, style) => ({ type: 'img', props: { src, style } });

const logo = () => h('div', { alignItems: 'center', gap: 16 },
  h('div', { width: 30, height: 30, borderRadius: 15, background: '#5a92c4' }),
  h('div', { width: 24, height: 24, borderRadius: 12, background: '#e0a458', marginLeft: -6 }),
  h('div', { fontSize: 30, fontWeight: 500, color: MUTED, marginLeft: 8 }, 'War of Dots Replays'));
const chip = (text, accent) => h('div', {
  padding: '8px 20px', borderRadius: 14, fontSize: 30, fontWeight: 500, color: TEXT,
  background: accent ? 'rgba(90,146,196,0.45)' : 'rgba(9,11,10,0.82)',
}, text);
const shadow = '0 2px 6px rgba(0,0,0,0.65)';
// Long names get a smaller size so a line fits the card.
const fit = (text, largest, width = 1080) => Math.max(36, Math.min(largest, Math.floor(width / (text.length * 0.56))));

// Each side's troops over the match, as a picture laid over a map.
function troopLines(troops, width, height, stroke) {
  const paths = troopCurves(troops ?? [], width, height)
    .map((d, side) => (d ? `<path d="${d}" fill="none" stroke="${SIDE_COLORS[side]}" stroke-opacity="0.8" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round"/>` : ''))
    .join('');
  if (!paths) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths}</svg>`;
  return img(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, { position: 'absolute', left: 0, top: 0, width, height });
}

const frame = (background, lines, ...children) => h('div', { width: WIDTH, height: HEIGHT, position: 'relative', background: '#0e1110', fontFamily: 'Inter' },
  background ? img(background, { position: 'absolute', left: 0, top: 0, width: WIDTH, height: HEIGHT, objectFit: 'cover' }) : null,
  h('div', { position: 'absolute', left: 0, top: 0, width: WIDTH, height: HEIGHT, background: 'rgba(8,10,9,0.55)' }),
  lines,
  h('div', { position: 'absolute', left: 0, top: 0, width: WIDTH, height: HEIGHT, padding: '44px 52px', flexDirection: 'column', justifyContent: 'space-between' }, ...children));

function gameCard({ map, names, length, place, troops }) {
  const line = `${names[0]} vs ${names[1]}`;
  const size = fit(line, 78);
  return frame(map, troopLines(troops, WIDTH, HEIGHT, 4),
    logo(),
    h('div', { flexDirection: 'column', gap: 28 },
      h('div', { alignItems: 'baseline', gap: size * 0.28, fontSize: size, fontWeight: 700, textShadow: shadow, letterSpacing: -1 },
        h('span', { color: BLUE }, names[0]), h('span', { color: MUTED, fontWeight: 500 }, 'vs'), h('span', { color: RED }, names[1])),
      h('div', { gap: 14, flexWrap: 'wrap' }, [place.map, length, place.where].map((t, i) => chip(t, i === 0)))));
}

function matchCard({ winner, loser, score, games }) {
  const size = fit(`${winner} ${score} ${loser}`, 70, 1000);
  const thumbWidth = (WIDTH - 104 - 14 * 4) / 5;
  return frame(games.find((g) => g.map)?.map ?? null, null,
    logo(),
    h('div', { flexDirection: 'column', gap: 30 },
      h('div', { alignItems: 'center', gap: 22, fontSize: size, fontWeight: 700, letterSpacing: -1, textShadow: shadow },
        h('span', { color: BLUE }, winner),
        h('div', { padding: '4px 20px', borderRadius: 14, background: 'rgba(9,11,10,0.82)', color: TEXT, fontSize: size * 0.75 }, score),
        h('span', { color: MUTED }, loser)),
      h('div', { gap: 14 }, games.map((g) => h('div', { flexDirection: 'column', gap: 10, width: thumbWidth },
        h('div', { position: 'relative', width: '100%', height: 126 },
          g.map
            ? img(g.map, { width: '100%', height: 126, objectFit: 'cover', borderRadius: 8, border: '2px solid rgba(238,244,240,0.25)' })
            : h('div', { width: '100%', height: 126, borderRadius: 8, background: '#1e2321' }),
          troopLines(g.troops, Math.round(thumbWidth), 126, 2)),
        h('div', { fontSize: 24, fontWeight: 500, color: MUTED }, `${g.name} · ${g.length}`))))));
}

let fonts;
async function render(tree) {
  fonts ??= ['500', '700'].map((weight) => ({ name: 'Inter', weight: Number(weight), style: 'normal', data: fs.readFileSync(path.join(here, 'og', `Inter-${weight}.ttf`)) }));
  const svg = await satori(tree, { width: WIDTH, height: HEIGHT, fonts });
  return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH }, font: { loadSystemFonts: false } }).render().asPng();
}

/// Writes og/pages.json and the card pictures for every published tournament under `site`.
export async function writeLinkPreviews(site) {
  const pages = { '': HOME };
  const aliases = {};
  const write = async (page, tree) => {
    const file = path.join(site, 'og', `${page}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await render(tree));
    return `og/${page}.png`;
  };
  const indexFile = path.join(site, 'tournaments', 'index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : [];
  let cards = 0;
  for (const summary of index) {
    const id = summary.id;
    for (const alias of summary.aliases ?? []) aliases[alias] = id;
    const folder = path.join(site, 'tournaments', id);
    const t = JSON.parse(fs.readFileSync(path.join(folder, 'tournament.json'), 'utf8'));
    const players = new Map(t.players.map((p) => [p.name, p]));
    const byUsername = new Map(t.players.filter((p) => p.username).map((p) => [p.username.toLowerCase(), p.name]));
    const display = (name) => withUsername(name, players.get(name)?.username);
    const bracketSides = sides(t.matches);
    const picture = (thumb) => (thumb ? `data:image/png;base64,${fs.readFileSync(path.join(folder, thumb)).toString('base64')}` : null);

    pages[id] = { title: t.name, description: [dates(t), `${t.replays.length} replays`].filter(Boolean).join(' · ') };
    pages[`${id}/replays`] = { title: `${t.name} replays`, description: `${t.replays.length} replays from ${new Set(t.replays.map((r) => r.match)).size} matches` };

    // Games are named after their map, numbered when a match repeats one, as the site does.
    const games = new Map();
    for (const r of t.replays) (games.get(r.match) ?? games.set(r.match, []).get(r.match)).push(r);
    for (const m of t.matches) {
      if (m.scores[0] + m.scores[1] === 0) continue;
      const round = roundName(m.round, bracketSides);
      const [winner, loser] = m.winner === 2 ? [m.player2, m.player1] : [m.player1, m.player2];
      const score = m.winner === 2 ? `${m.scores[1]}-${m.scores[0]}` : `${m.scores[0]}-${m.scores[1]}`;
      const place = `${round}, match ${m.id} · ${t.name}`;
      const played = (games.get(m.id) ?? []).sort((a, b) => String(a.map).localeCompare(String(b.map), undefined, { numeric: true }));
      const page = { title: `${display(winner)} ${score} ${display(loser)}`, description: place };
      if (played.length) {
        page.image = await write(`${id}/${m.id}`, matchCard({
          winner, loser, score: score.replace('-', ' : '),
          games: played.slice(0, 5).map((r) => ({ map: picture(r.thumb), name: r.map ?? 'Map', length: clock(r.frames), troops: r.troops })),
        }));
        cards++;
      }
      pages[`${id}/${m.id}`] = page;
      const used = new Map();
      for (const r of played) {
        const base = (r.map ?? 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        used.set(base, (used.get(base) ?? 0) + 1);
        const slug = used.get(base) > 1 ? `${base}-${used.get(base)}` : base;
        const names = r.players.map((u) => byUsername.get(u.toLowerCase()) ?? u);
        pages[`${id}/${m.id}/${slug}`] = {
          title: `${names.map(display).join(' vs ')} · ${r.map ?? 'Unknown map'}`,
          description: t.name,
          image: await write(`${id}/${m.id}/${slug}`, gameCard({
            map: picture(r.thumb), names, length: clock(r.frames), troops: r.troops,
            place: { map: r.map ?? 'Unknown map', where: `${round} · Match ${m.id}` },
          })),
        };
        cards++;
      }
    }
  }
  fs.mkdirSync(path.join(site, 'og'), { recursive: true });
  fs.writeFileSync(path.join(site, 'og', 'pages.json'), JSON.stringify({ pages, aliases }));
  // The shared replay card is drawn in the visitor's browser with the same font.
  for (const weight of ['500', '700']) fs.copyFileSync(path.join(here, 'og', `Inter-${weight}.ttf`), path.join(site, 'og', `Inter-${weight}.ttf`));
  fs.copyFileSync(path.join(here, 'og', 'OFL.txt'), path.join(site, 'og', 'Inter-OFL.txt'));
  return { pages: Object.keys(pages).length, cards };
}
