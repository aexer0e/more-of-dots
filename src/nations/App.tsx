import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Flag, Maximize, Minus, Plus, RefreshCw } from 'lucide-react';
import { invoke } from '../platform';
import { cached, retrieve, type Player, type Snapshot } from '../leaderboard/client';
import { ensureHistory, loadEconomy, loadMap, stored, sync, type Economy, type MapPayload, type Store } from './client';
import { blueShare, DAY_SECONDS, slopeStops, nextCheckDelay, rangeRows, RANGES, shareAxis, type Latest, type Range, type Row } from './data';
import './styles.css';

const WIDE_QUERY = '(min-width: 1100px)';
/** Deep enough that single map pixels show as clear squares. */
const MAX_ZOOM = 16;
const TERRAIN_URL = '/nations/world_map.png';
const MASK_URL = '/nations/playable-mask.bitset.zlib';
/** Nation indexes follow the game's colour order: 0 is Blue, 1 is Red. */
const NATION_INDEX = { red: 1, blue: 0 } as const;
type Side = 'red' | 'blue';
type Series = 'land' | 'cities' | 'both';

const number = (value: number) => value.toLocaleString();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumSignificantDigits: 3 });
const percent = (value: number) => `${value.toFixed(1)}%`;
const clock = (stamp: number) => new Date(stamp * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function preference(key: string, fallback: string) { try { return localStorage.getItem('mod.nations.' + key) ?? fallback; } catch { return fallback; } }
function remember(key: string, value: string) { try { localStorage.setItem('mod.nations.' + key, value); } catch { /* Optional preference. */ } }

// Map decoding runs in a worker; one is shared by every mount of the tab.
let mapWorker: Worker | null = null;
let mapJob = 0;
const mapJobs = new Map<number, { resolve: (rgba: Uint8ClampedArray<ArrayBuffer>) => void; reject: (error: Error) => void }>();
function paintMap(payload: MapPayload): Promise<Uint8ClampedArray<ArrayBuffer>> {
  if (!mapWorker) {
    mapWorker = new Worker(new URL('./map-worker.ts', import.meta.url), { type: 'module' });
    mapWorker.onmessage = (event: MessageEvent<{ id: number; rgba?: ArrayBuffer; error?: string }>) => {
      const job = mapJobs.get(event.data.id);
      if (!job) return;
      mapJobs.delete(event.data.id);
      if (event.data.rgba) job.resolve(new Uint8ClampedArray(event.data.rgba));
      else job.reject(new Error(event.data.error ?? 'The map could not be decoded.'));
    };
  }
  const id = ++mapJob;
  const bytes = payload.bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    mapJobs.set(id, { resolve, reject });
    mapWorker!.postMessage({
      id, encoding: payload.encoding, width: payload.width, height: payload.height, bytes,
      terrainUrl: new URL(TERRAIN_URL, location.href).href, maskUrl: new URL(MASK_URL, location.href).href,
    }, [bytes]);
  });
}

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function MapView({ latest }: { latest: Latest | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameRef, frame] = useSize<HTMLDivElement>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const hash = latest?.mapHash;

  useEffect(() => {
    if (!latest) return;
    let active = true;
    setState((current) => current === 'ready' ? 'ready' : 'loading');
    loadMap(latest).then(paintMap).then((rgba) => {
      const canvas = canvasRef.current;
      if (!active || !canvas) return;
      canvas.width = latest.width; canvas.height = latest.height;
      canvas.getContext('2d')?.putImageData(new ImageData(rgba, latest.width, latest.height), 0, 0);
      setState('ready');
    }).catch((cause: Error) => { if (active) { setError(cause.message); setState('error'); } });
    return () => { active = false; };
  }, [hash]);

  const clampView = useCallback((scale: number, x: number, y: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(1, scale));
    return {
      scale: next,
      x: Math.min(0, Math.max(frame.width - frame.width * next, x)),
      y: Math.min(0, Math.max(frame.height - frame.height * next, y)),
    };
  }, [frame.width, frame.height]);
  const zoomAt = (factor: number, px = frame.width / 2, py = frame.height / 2) => setView((current) => {
    const scale = Math.min(MAX_ZOOM, Math.max(1, current.scale * factor));
    const ratio = scale / current.scale;
    return clampView(scale, px - (px - current.x) * ratio, py - (py - current.y) * ratio);
  });
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;
  // React wheel listeners are passive, so the page would scroll while the map zooms.
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomRef.current(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [frameRef]);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || view.scale === 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: view.x, startY: view.y };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    setView((value) => clampView(value.scale, current.startX + event.clientX - current.x, current.startY + event.clientY - current.y));
  };

  return <div className="nt-map" ref={frameRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    data-zoomed={view.scale > 1 ? 'true' : undefined}
    data-pixelated={frame.width * view.scale >= (latest?.width ?? 1920) ? 'true' : undefined}>
    <canvas ref={canvasRef} width={1920} height={1080} role="img" aria-label="Campaign map: Red and Blue territory"
      style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, opacity: state === 'ready' ? 1 : 0 }} />
    {state !== 'ready' && <div className="nt-map-status">{state === 'error' ? error : latest ? 'Decoding map…' : 'Waiting for the first snapshot…'}</div>}
    <div className="nt-map-tools">
      <button className="nt-icon-button" aria-label="Zoom in" onClick={() => zoomAt(1.5)}><Plus size={13} /></button>
      <button className="nt-icon-button" aria-label="Zoom out" disabled={view.scale === 1} onClick={() => zoomAt(1 / 1.5)}><Minus size={13} /></button>
      <button className="nt-icon-button" aria-label="Fit map" disabled={view.scale === 1} onClick={() => setView({ scale: 1, x: 0, y: 0 })}><Maximize size={12} /></button>
    </div>
  </div>;
}

function axisLabel(stamp: number, range: Range) {
  const date = new Date(stamp * 1000);
  if (range === '24h') return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (range === 'all' || range === '30d') return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

function MomentumChart({ rows, range, series }: { rows: Row[]; range: Range; series: Series }) {
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useRef(`nt-${Math.random().toString(36).slice(2)}`).current;
  const width = Math.max(200, size.width), height = Math.max(140, size.height);
  const left = 54, right = width - 10, top = 12, bottom = height - 26;
  const points = rows.map((row) => ({ t: row.t, ...blueShare(row) }));
  if (points.length < 2) return <div className="nt-chart" ref={wrapRef}><div className="nt-empty">Not enough history for this range yet.</div></div>;
  const values = points.flatMap((point) => series === 'land' ? [point.land] : series === 'cities' ? [point.cities] : [point.land, point.cities]);
  const axis = shareAxis(values);
  const from = points[0].t, to = points.at(-1)!.t;
  const x = (t: number) => left + (t - from) / Math.max(1, to - from) * (right - left);
  const y = (value: number) => bottom - (value - axis.low) / (axis.high - axis.low) * (bottom - top);
  const line = (key: 'land' | 'cities') => points.map((point, index) => `${index ? 'L' : 'M'}${x(point.t).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
  // The axis fits the data, so 50% is often off the chart; the split then sits on the nearer edge.
  const middle = Math.min(bottom, Math.max(top, y(50)));
  const showMiddle = axis.low <= 50 && axis.high >= 50;
  const area = `M${x(from).toFixed(1)},${middle.toFixed(1)} ${points.map((point) => `L${x(point.t).toFixed(1)},${y(point.land).toFixed(1)}`).join(' ')} L${x(to).toFixed(1)},${middle.toFixed(1)} Z`;
  const daily = RANGES.find((entry) => entry.id === range)?.daily;
  const active = hover == null ? null : points[hover];
  const labels = [0, 0.25, 0.5, 0.75, 1].map((fraction) => from + (to - from) * fraction);
  const inspect = (clientX: number, rect: DOMRect) => {
    const t = from + (clientX - rect.left - left) / (right - left) * (to - from);
    let best = 0;
    for (let index = 1; index < points.length; index++) if (Math.abs(points[index].t - t) < Math.abs(points[best].t - t)) best = index;
    setHover(best);
  };
  return <div className="nt-chart" ref={wrapRef}>
    <svg width={width} height={height} role="img" tabIndex={0} aria-label={`Blue land share ${percent(points[0].land)} to ${percent(points.at(-1)!.land)} over the selected range`}
      onPointerMove={(event) => inspect(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        setHover((current) => Math.max(0, Math.min(points.length - 1, (current ?? points.length - 1) + (event.key === 'ArrowRight' ? 1 : -1))));
      }}>
      <defs>
        <clipPath id={`${clipId}-above`}><rect x="0" y="0" width={width} height={Math.max(0, middle)} /></clipPath>
        <clipPath id={`${clipId}-below`}><rect x="0" y={middle} width={width} height={Math.max(0, height - middle)} /></clipPath>
        {(['land', 'cities'] as const).map((key) => <linearGradient key={key} id={`${clipId}-${key}`} gradientUnits="userSpaceOnUse" x1={left} y1="0" x2={right} y2="0">
          {slopeStops(points.map((point) => point.t), points.map((point) => point[key])).map((stop, index) => <stop key={index} offset={stop.offset} stopColor={stop.color} />)}
        </linearGradient>)}
      </defs>
      {axis.ticks.map((tick) => <g key={tick}>
        <line className={Math.abs(tick - 50) < 1e-9 ? 'nt-midline' : 'nt-gridline'} x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
        <text x={left - 6} y={y(tick) + 4} textAnchor="end">{tick.toFixed(axis.decimals)}%</text>
      </g>)}
      {showMiddle && !axis.ticks.some((tick) => Math.abs(tick - 50) < 1e-9) && <line className="nt-midline" x1={left} x2={right} y1={middle} y2={middle} />}
      {series !== 'cities' && <>
        <path d={area} className="nt-area-blue" clipPath={`url(#${clipId}-above)`} />
        <path d={area} className="nt-area-red" clipPath={`url(#${clipId}-below)`} />
      </>}
      <text className="nt-side-label nt-blue" x={right - 4} y={top + 12} textAnchor="end">Blue ↑</text>
      <text className="nt-side-label nt-red" x={right - 4} y={bottom - 5} textAnchor="end">Red ↓</text>
      {series !== 'land' && <path className="nt-line-cities" d={line('cities')} stroke={`url(#${clipId}-cities)`} />}
      {series !== 'cities' && <path className="nt-line-land" d={line('land')} stroke={`url(#${clipId}-land)`} />}
      {daily && points.length <= 45 && series !== 'cities' && points.map((point) => <circle key={point.t} className="nt-dot" cx={x(point.t)} cy={y(point.land)} r="2.4" />)}
      {active && <>
        <line className="nt-crosshair" x1={x(active.t)} x2={x(active.t)} y1={top} y2={bottom} />
        {series !== 'cities' && <circle className="nt-focus" cx={x(active.t)} cy={y(active.land)} r="4" />}
        {series !== 'land' && <circle className="nt-focus" cx={x(active.t)} cy={y(active.cities)} r="3.5" />}
      </>}
      {labels.map((stamp, index) => <text key={index} x={x(stamp)} y={height - 7} textAnchor={index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'}>{axisLabel(stamp, range)}</text>)}
    </svg>
    {active && <div className="nt-tooltip" style={{ left: Math.min(Math.max(x(active.t) - 100, 4), width - 204) }}>
      <strong>{new Date(active.t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</strong>
      <span>Land <b><i className="nt-red">{(100 - active.land).toFixed(2)}%</i> / <i className="nt-blue">{active.land.toFixed(2)}%</i></b></span>
      <span>Cities <b><i className="nt-red">{number(rows[hover!].rc)}</i> / <i className="nt-blue">{number(rows[hover!].bc)}</i></b></span>
    </div>}
  </div>;
}

function SideColumn({ side, row, previous, economy, players, me }: { side: Side; row: Row | null; previous: Row | null; economy: Economy | null; players: Player[]; me: string }) {
  const red = side === 'red';
  const share = row ? blueShare(row).land : null;
  const value = share == null ? null : red ? 100 - share : share;
  const before = previous ? blueShare(previous).land : null;
  const change = value == null || before == null ? null : value - (red ? 100 - before : before);
  const nation = economy?.nations.find((entry) => entry.nation === NATION_INDEX[side]);
  const stats = [
    { label: 'Cities', value: row ? number(red ? row.rc : row.bc) : '—' },
    { label: 'Players', value: nation ? number(nation.players) : '—' },
    { label: 'Cash', value: nation ? compact.format(nation.cash) : '—' },
    { label: 'Net worth', value: nation ? compact.format(nation.netWorth) : '—' },
  ];
  const name = red ? 'Red Empire' : 'Blue Republic';
  return <section className={`nt-side nt-side-${side}`} aria-label={name}>
    <div className="nt-hero">
      <span className="nt-hero-name">{name}</span>
      <div className="nt-hero-value"><strong>{value == null ? '—' : percent(value)}</strong>{change != null && <span>{change >= 0 ? '+' : ''}{change.toFixed(1)} in 24 h</span>}</div>
      <small>{row ? `${number(red ? row.rp : row.bp)} px of land` : 'Waiting for data'}</small>
    </div>
    <div className="nt-card nt-stats">{stats.map((stat) => <div key={stat.label}><span>{stat.label}</span><strong>{stat.value}</strong></div>)}</div>
    <div className="nt-card nt-players">
      <div className="nt-card-head"><h2>Top 10 players</h2><span>World wins</span></div>
      {players.length ? <ol>{players.map((player) => <li key={player.nickname} className={player.nickname.toLocaleLowerCase() === me.toLocaleLowerCase() ? 'nt-you' : undefined}>
        <span className="nt-rank">#{player.rank}</span><span className="nt-name" title={player.nickname}>{player.nickname}</span><strong>{number(player.value)}</strong>
      </li>)}</ol> : <div className="nt-empty">No ranked players yet.</div>}
    </div>
  </section>;
}

export function NationsApp() {
  const wide = useWide();
  const [store, setStore] = useState<Store>(stored);
  const [range, setRange] = useState<Range>(() => { const saved = preference('range', '1w'); return RANGES.some((entry) => entry.id === saved) ? saved as Range : '1w'; });
  const [series, setSeries] = useState<Series>(() => { const saved = preference('series', 'both'); return saved === 'land' || saved === 'cities' ? saved : 'both'; });
  const [checking, setChecking] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState('');
  const [economy, setEconomy] = useState<Economy | null>(() => stored().economy);
  const [board, setBoard] = useState<Snapshot | null>(() => cached<Snapshot>('/v1/leaderboard')?.data ?? null);
  const [me, setMe] = useState(() => { try { return localStorage.getItem('mod.lb.player') ?? ''; } catch { return ''; } });
  const [nextCheck, setNextCheck] = useState<number | null>(null);

  const fail = useCallback((cause: unknown) => {
    setError((cause as Error).message || 'The campaign map is unavailable. Try again shortly.');
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try { setStore(await sync()); setError(''); } catch (cause) { fail(cause); } finally { setChecking(false); }
  }, [fail]);

  // One check per capture while the tab is shown; hidden windows send nothing.
  useEffect(() => {
    let timer = 0;
    let active = true;
    const schedule = () => {
      clearTimeout(timer);
      if (!active || document.hidden) return;
      const current = stored();
      const delay = nextCheckDelay(current.latest?.capturedAt ?? null, current.lastAttempt, Date.now());
      setNextCheck(Date.now() + delay);
      timer = window.setTimeout(() => { void check().finally(schedule); }, delay);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', schedule); };
  }, [check]);

  // Longer ranges load their one-per-day history once.
  useEffect(() => {
    if (!store.latest || (range !== '30d' && range !== 'all')) return;
    let active = true;
    setHistoryLoading(true);
    ensureHistory(range).then((next) => { if (active) setStore(next); }).catch(fail).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [range, store.latest?.capturedAt, fail]);

  // Economy and rankings only load while the side columns are on screen.
  useEffect(() => {
    if (!wide || !store.latest) return;
    let active = true;
    loadEconomy().then((next) => { if (active) setEconomy(next); }).catch(() => undefined);
    retrieve<Snapshot>('/v1/leaderboard').then((next) => { if (active) setBoard(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [wide, store.latest?.capturedAt]);

  useEffect(() => {
    if (me) return;
    let active = true;
    void invoke<string | null>('leaderboard_identity').then((name) => { if (active && name) setMe(name); }).catch(() => undefined);
    return () => { active = false; };
  }, [me]);

  const latestRow = store.recent.at(-1) ?? null;
  const dayAgo = useMemo(() => {
    if (!latestRow) return null;
    return store.recent.find((row) => row.t >= latestRow.t - DAY_SECONDS) ?? null;
  }, [store.recent, latestRow]);
  const chartRows = useMemo(() => rangeRows(store.recent, store.daily, range), [store.recent, store.daily, range]);
  const players = (side: Side) => (board?.world ?? []).filter((player) => player.faction === side).slice(0, 10);
  const share = latestRow ? blueShare(latestRow).land : 50;

  const statusText = store.latest
    ? `Snapshot ${clock(store.latest.capturedAt)}${nextCheck ? ` · next check ${clock(nextCheck / 1000)}` : ''}`
    : checking ? 'Loading campaign…' : 'No snapshot yet';
  const late = store.latest && Date.now() / 1000 - store.latest.capturedAt > 4000;

  return <section className="nt-page" aria-label="Nations">
    <div className="nt-grid">
      <SideColumn side="red" row={latestRow} previous={dayAgo} economy={economy} players={players('red')} me={me} />
      <section className="nt-center" aria-label="Front">
        <header className="nt-heading">
          <div className="nt-title"><Flag size={18} /><h1>Nations</h1></div>
          <div className="nt-heading-actions">
            <span className="nt-status"><i className={late ? 'nt-late' : undefined} />{statusText}</span>
            <button className="nt-icon-button" aria-label="Check for a new snapshot" disabled={checking} onClick={() => void check()}><RefreshCw size={14} className={checking ? 'nt-spinning' : ''} /></button>          </div>
        </header>
        {error && <p role="alert" className="nt-error">{error}{store.latest ? ' Showing saved data.' : ''}</p>}
        <div className="nt-bar-row">
          <span className="nt-bar-label"><strong className="nt-red">{percent(100 - share)}</strong> Red{latestRow ? ` · ${number(latestRow.rc)} cities` : ''}</span>
          <div className="nt-bar" role="img" aria-label={`Land: Red ${percent(100 - share)}, Blue ${percent(share)}`}>
            <div className="nt-bar-red" style={{ width: `${100 - share}%` }} /><div className="nt-bar-blue" /><i />
          </div>
          <span className="nt-bar-label">{latestRow ? `${number(latestRow.bc)} cities · ` : ''}Blue <strong className="nt-blue">{percent(share)}</strong></span>
        </div>
        <MapView latest={store.latest} />
        <section className="nt-card nt-momentum" aria-label="Momentum">
          <div className="nt-card-head">
            <h2>Momentum</h2>
            {historyLoading && <span className="nt-loading" role="status">Loading history…</span>}
            <div className="nt-controls">
              <div className="nt-segment" aria-label="Series">{(['land', 'cities', 'both'] as const).map((value) => <button key={value} aria-pressed={series === value} onClick={() => { setSeries(value); remember('series', value); }}>{value === 'land' ? 'Land' : value === 'cities' ? 'Cities' : 'Both'}</button>)}</div>
              <div className="nt-segment" aria-label="Range">{RANGES.map((entry) => <button key={entry.id} aria-pressed={range === entry.id} onClick={() => { setRange(entry.id); remember('range', entry.id); }}>{entry.label}</button>)}</div>
            </div>
          </div>
          <MomentumChart rows={chartRows} range={range} series={series} />
        </section>
      </section>
      <SideColumn side="blue" row={latestRow} previous={dayAgo} economy={economy} players={players('blue')} me={me} />
    </div>
  </section>;
}
