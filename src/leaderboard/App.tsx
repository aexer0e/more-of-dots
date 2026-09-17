import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '../platform';
import { cached, historyPath, retrieve, type Board, type History, type Player, type Snapshot } from './client';
import { Check, Crosshair, Pencil, Plus, RefreshCw, Search, Trophy, X } from 'lucide-react';
import { chartAxis, MAX_COMPARISONS, playerColors, seriesPath, snapshotDelay } from './chart';
import './styles.css';

const LATEST = '/v1/leaderboard';

const number = (value: number) => value.toLocaleString();
const signed = (value: number) => `${value > 0 ? '+' : ''}${number(value)}`;
const date = (stamp: number) => new Date(stamp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function preference(key: string, fallback = '') { try { return localStorage.getItem('mod.lb.' + key) ?? fallback; } catch { return fallback; } }
function remember(key: string, value: string) { try { localStorage.setItem('mod.lb.' + key, value); } catch { /* Optional preferences. */ } }

function ProgressChart({ history, players, colors, metric, onInspect }: { history: History; players: string[]; colors: Map<string, string>; metric: 'value' | 'rank'; onInspect: (stamp: number | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId().replaceAll(':', '');
  const active = hover == null ? null : history.rows[Math.min(hover, history.rows.length - 1)];
  useEffect(() => { onInspect(active?.capturedAt ?? null); return () => onInspect(null); }, [active?.capturedAt, onInspect]);
  const visiblePlayers = players.filter((name) => history.rows.some((row) => row.players.some((p) => p.nickname === name && p[metric] != null)));
  const values = history.rows.flatMap((row) => row.players.filter((p) => players.includes(p.nickname)).map((p) => p[metric])).filter((v): v is number => v != null && Number.isFinite(v));
  if (!values.length) return <div className="lb-empty">No history</div>;
  const axis = chartAxis(values, metric === 'rank');
  const from = history.rows[0]?.capturedAt ?? history.from, to = history.rows.at(-1)?.capturedAt ?? history.to;
  const x = (stamp: number) => 44 + (stamp - from) / Math.max(1, to - from) * 296;
  const y = (v: number) => metric === 'rank' ? 14 + (v - axis.low) / (axis.high - axis.low) * 160 : 174 - (v - axis.low) / (axis.high - axis.low) * 160;
  return <div className="lb-chart-wrap">
    <svg className="lb-chart" viewBox="0 0 356 205" role="img" tabIndex={0} aria-label={`${metric === 'rank' ? 'Rank' : 'Score'} history`}
      onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
      onPointerMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const scale = Math.min(rect.width / 356, rect.height / 205); const chartX = (event.clientX - rect.left - (rect.width - 356 * scale) / 2) / scale; const stamp = from + (chartX - 44) / 296 * (to - from); let best = 0; history.rows.forEach((row, i) => { if (Math.abs(row.capturedAt - stamp) < Math.abs(history.rows[best].capturedAt - stamp)) best = i; }); setHover(best); }}
      onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setHover(Math.max(0, Math.min(history.rows.length - 1, (hover ?? history.rows.length - 1) + (event.key === 'ArrowRight' ? 1 : -1)))); } }}>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colors.get(visiblePlayers[0])} stopOpacity=".15"/><stop offset="100%" stopColor={colors.get(visiblePlayers[0])} stopOpacity="0"/></linearGradient></defs>
      {axis.ticks.map((v) => <g key={v}><line className="lb-gridline" x1="44" x2="340" y1={y(v)} y2={y(v)} /><text x="34" y={y(v) + 3} textAnchor="end">{number(v)}</text></g>)}
      {visiblePlayers.map((name) => {
        const points = history.rows.map((row) => ({ stamp: row.capturedAt, value: row.players.find((p) => p.nickname === name)?.[metric] ?? null }));
        const observed = points.filter((p): p is { stamp: number; value: number } => p.value != null);
        if (!observed.length) return null;
        const path = seriesPath(points, x, y), last = observed.at(-1)!;
        const selected = active ? observed.find((p) => p.stamp === active.capturedAt) : last;
        return <g key={name}>
          {visiblePlayers.length === 1 && <path d={`${path} L${x(last.stamp)},174 L${x(observed[0].stamp)},174 Z`} fill={`url(#${gradientId})`} />}
          <path className="lb-series" d={path} fill="none" stroke={colors.get(name)} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
          {selected && <circle cx={x(selected.stamp)} cy={y(selected.value)} r={active ? 3.5 : 2.5} fill={colors.get(name)} stroke="#141b20" strokeWidth="1.5"/>}
        </g>;
      })}
      {active && <line x1={x(active.capturedAt)} x2={x(active.capturedAt)} y1="14" y2="174" className="lb-crosshair" />}
      {[0, .5, 1].map((fraction) => <text key={fraction} x={44 + 296 * fraction} y="200" textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{date(from + (to - from) * fraction)}</text>)}
    </svg>
    {active && <time className="lb-chart-date">{date(active.capturedAt)}</time>}
  </div>;
}

export function LeaderboardApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => cached<Snapshot>(LATEST)?.data ?? null);
  const [board, setBoard] = useState<Board>('elo');
  const [identity, setIdentity] = useState('');
  const [manualName, setManualName] = useState(() => preference('player'));
  const [search, setSearch] = useState('');
  const [nearMe, setNearMe] = useState(false);
  const [editingMe, setEditingMe] = useState(false);
  const mineRef = useRef<HTMLTableRowElement>(null);
  const [comparisons, setComparisons] = useState<string[]>(() => { try { return (JSON.parse(preference('comparisons', '[]')) as string[]).filter((v) => typeof v === 'string').slice(0, MAX_COMPARISONS); } catch { return []; } });
  const [days, setDays] = useState(0);
  const [metric, setMetric] = useState<'value' | 'rank'>('value');
  const [history, setHistory] = useState<History | null>(null);
  const [inspectedAt, setInspectedAt] = useState<number | null>(null);
  const historyScope = useRef('');
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now);
  const colorMap = useRef(new Map<string, string>());
  const chosenName = manualName.trim() || identity;
  const me = snapshot?.[board].find((p) => p.nickname.toLocaleLowerCase() === chosenName.toLocaleLowerCase())?.nickname ?? chosenName;
  const names = [...new Set([me, ...comparisons].filter(Boolean))].slice(0, MAX_COMPARISONS + 1);
  colorMap.current = playerColors(names, colorMap.current);
  const colors = colorMap.current;
  const nameKey = JSON.stringify(names);
  const delay = snapshot ? snapshotDelay(snapshot.capturedAt, now) : null;
  const rows = snapshot?.[board] ?? [];
  const mine = rows.find((p) => p.nickname === me);
  const scoreLabel = board === 'elo' ? 'Elo' : 'Net victories';

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      setNow(Date.now());
      if (document.hidden) return;
      setLoading(true);
      try { const result = await retrieve<Snapshot>(LATEST); if (active) { setSnapshot(result); setError(''); } }
      catch (cause) { if (active) setError((cause as Error).message); }
      finally { if (active) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [retry]);

  useEffect(() => {
    let active = true;
    void invoke<string | null>('leaderboard_identity').then((name) => { if (active) setIdentity(name ?? ''); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!snapshot || !names.length) { setHistory(null); return; }
    let active = true;
    const path = historyPath(board, names, days, snapshot.capturedAt);
    const scope = `${board}-${days}`;
    const keepHistory = historyScope.current === scope;
    historyScope.current = scope;
    setHistory((previous) => cached<History>(path)?.data ?? (keepHistory ? previous : null));
    setHistoryLoading(true); setHistoryError('');
    void retrieve<History>(path).then((result) => { if (active) setHistory(result); }).catch((cause) => {
      if (active) setHistoryError((cause as Error).message);
    }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [board, nameKey, days, snapshot?.capturedAt, retry]);

  function togglePlayer(player: Player) {
    if (player.nickname === me) return;
    const otherPlayers = comparisons.filter((name) => name !== me);
    const next = otherPlayers.includes(player.nickname) ? otherPlayers.filter((name) => name !== player.nickname) : [...otherPlayers, player.nickname].slice(0, MAX_COMPARISONS);
    setComparisons(next); remember('comparisons', JSON.stringify(next));
  }
  const previousPoint = history?.rows.find((row) => row.players.some((p) => p.nickname === me && p.rank != null));
  const previous = previousPoint?.players.find((p) => p.nickname === me);
  const visibleRows = rows.filter((p) => p.nickname.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (!nearMe || !mine || Math.abs(p.rank - mine.rank) <= 5));
  const rivals = comparisons.filter((name) => name !== me);
  const nextRank = mine ? rows.find((p) => p.rank === mine.rank - 1) : undefined;
  const removePlayer = (name: string) => { const next = comparisons.filter((p) => p !== name); setComparisons(next); remember('comparisons', JSON.stringify(next)); };
  const change = mine && previous?.value != null ? mine.value - previous.value : null;
  const rankChange = mine && previous?.rank != null ? previous.rank - mine.rank : null;
  function findMe() { setSearch(''); setNearMe(false); requestAnimationFrame(() => mineRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })); }

  return <section className="leaderboard-page" aria-label="Leaderboard">
    <header className="lb-heading">
      <div className="lb-title"><Trophy size={18} /><h1>Leaderboard</h1></div>
      <div className="lb-heading-actions"><span className="lb-updated">{snapshot ? `Updated ${new Date(snapshot.capturedAt * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'Loading…'}</span><button className="lb-icon-button" aria-label="Check for updates" disabled={loading} onClick={() => setRetry((v) => v + 1)}><RefreshCw size={14} className={loading ? 'lb-spinning' : ''} /></button></div>
    </header>
    <div className="lb-toolbar"><div className="lb-segment" aria-label="Ranking"><button aria-pressed={board === 'elo'} onClick={() => setBoard('elo')}>Elo rating</button><button aria-pressed={board === 'world'} onClick={() => setBoard('world')}>World victories</button></div></div>
    {error && <p role="alert" className="lb-error">{error} {snapshot && 'Showing saved rankings.'}</p>}
    {snapshot && delay && <p className="lb-error">Snapshot delayed · Last snapshot {delay} · {new Date(snapshot.capturedAt * 1000).toLocaleString()}</p>}
    <section className="lb-self" aria-label="Your standing">
      <div className="lb-self-name"><span className="lb-avatar">{(me || '?').slice(0, 1).toUpperCase()}</span><div><span className="lb-caption">Your player</span><strong>{me || 'Choose a player'}</strong></div><button className="lb-icon-button" aria-label="Change your player" onClick={() => setEditingMe(!editingMe)}><Pencil size={12}/></button></div>
      <div className="lb-self-stat"><span className="lb-caption">Rank</span><strong>{mine ? `#${mine.rank}` : snapshot ? 'Unranked' : '—'}</strong>{rankChange != null && <small className={rankChange > 0 ? 'lb-positive' : rankChange < 0 ? 'lb-negative' : 'lb-muted'}>{rankChange === 0 ? 'No change' : `${rankChange > 0 ? '↑' : '↓'} ${Math.abs(rankChange)} ${Math.abs(rankChange) === 1 ? 'place' : 'places'}`}</small>}</div>
      <div className="lb-self-stat"><span className="lb-caption">{scoreLabel}</span><strong>{mine ? number(mine.value) : '—'}</strong>{change != null && <small className={change > 0 ? 'lb-positive' : change < 0 ? 'lb-negative' : 'lb-muted'}>{signed(change)} since {date(previousPoint!.capturedAt)}</small>}</div>
      <div className="lb-next"><span className="lb-caption">{nextRank ? `To #${nextRank.rank}` : 'Next rank'}</span><strong>{nextRank && mine ? `${number(nextRank.value - mine.value)} ${board === 'elo' ? 'Elo' : 'wins'}` : mine ? 'Leading' : 'Top 100 required'}</strong>{nextRank && <small>{nextRank.nickname}</small>}</div>
    </section>
    {(editingMe || !me) && <form className="lb-identity" onSubmit={(event) => { event.preventDefault(); const input = String(new FormData(event.currentTarget).get('player') ?? '').trim(); setManualName(input); remember('player', input); setEditingMe(false); }}><label htmlFor="lb-player">Track your player</label><input id="lb-player" name="player" defaultValue={me} maxLength={100} placeholder="Exact username" required /><button className="lb-button">Save</button>{identity && <button className="lb-button" type="button" onClick={() => { setManualName(''); remember('player', ''); setEditingMe(false); }}>Use game login</button>}</form>}
    <div className="lb-workspace">
      <section className="lb-rankings" aria-label="Rankings">
        <div className="lb-list-toolbar"><label className="lb-search"><Search size={14}/><input type="search" aria-label="Search leaderboard" placeholder="Find a player…" value={search} onChange={(event) => { setSearch(event.target.value); setNearMe(false); }} /></label><button className="lb-icon-button" aria-label="Find me" disabled={!mine} onClick={findMe}><Crosshair size={16}/></button></div>
        <div className="lb-list-context"><div className="lb-list-tabs"><button aria-pressed={!nearMe} onClick={() => setNearMe(false)}>All players</button><button aria-pressed={nearMe} disabled={!mine} onClick={() => setNearMe(true)}>Near me</button></div><span>{visibleRows.length} players</span></div>
        <div className="lb-ranking-scroll"><table><thead><tr><th className="lb-rank">#</th><th>Player</th><th className="lb-numeric">{scoreLabel}</th><th className="lb-numeric lb-gap">Gap</th><th className="lb-compare-col"><span className="lb-sr-only">Compare</span></th></tr></thead><tbody>{visibleRows.map((p) => { const isMe = p.nickname === me, selected = rivals.includes(p.nickname); return <tr key={p.nickname} ref={isMe ? mineRef : undefined} className={isMe ? 'lb-you' : selected ? 'lb-comparing' : ''}><td className={`lb-rank ${p.rank <= 3 ? 'lb-podium' : ''}`}>{p.rank}</td><td className="lb-player-name"><span className={`lb-faction lb-faction-${p.faction}`} style={colors.has(p.nickname) ? { background: colors.get(p.nickname) } : undefined} /><span>{p.nickname}</span>{isMe && <span className="lb-you-tag">You</span>}</td><td className="lb-numeric lb-score">{number(p.value)}</td><td className="lb-numeric lb-muted lb-gap">{mine && !isMe ? signed(p.value - mine.value) : '—'}</td><td className="lb-compare-col"><button className={`lb-compare ${selected || isMe ? 'is-selected' : ''}`} aria-label={isMe ? 'Your player is included' : `${selected ? 'Remove' : 'Compare'} ${p.nickname}`} aria-pressed={selected || isMe} style={colors.has(p.nickname) ? { color: colors.get(p.nickname), borderColor: colors.get(p.nickname) } : undefined} disabled={isMe || (!selected && rivals.length >= MAX_COMPARISONS)} onClick={() => togglePlayer(p)}>{selected || isMe ? <Check size={13}/> : <Plus size={13}/>}</button></td></tr>; })}</tbody></table>
        {!visibleRows.length && <div className="lb-empty">{loading && !snapshot ? 'Loading rankings…' : search ? 'No players found.' : 'No rankings available.'}{search && <button className="lb-text-button" onClick={() => setSearch('')}>Clear search</button>}</div>}</div>
        <footer className="lb-list-footer"><span>{rivals.length}/{MAX_COMPARISONS}</span></footer>
      </section>
      <aside className="lb-progress" aria-label="Player progress">
        <div className="lb-panel-heading"><h2>Progress</h2><div className="lb-period" aria-label="History period">{[7, 30, 90, 0].map((period) => <button key={period} aria-pressed={days === period} onClick={() => setDays(period)}>{period === 0 ? 'All' : `${period}d`}</button>)}</div></div>
        <div className="lb-chart-controls"><div className="lb-list-tabs" aria-label="Chart metric"><button aria-pressed={metric === 'value'} onClick={() => setMetric('value')}>{scoreLabel}</button><button aria-pressed={metric === 'rank'} onClick={() => setMetric('rank')}>Rank</button></div>{historyLoading && <span className="lb-muted">Updating…</span>}</div>
        {historyError && <p role="alert" className="lb-error">{historyError}</p>}
        {history ? <ProgressChart key={`${board}-${days}`} history={history} players={names} colors={colors} metric={metric} onInspect={setInspectedAt} /> : <div className="lb-empty lb-chart-empty">{historyLoading ? 'Loading history…' : 'Select a player'}</div>}
        <div className="lb-comparison-list">{names.map((name) => { const player = inspectedAt == null ? rows.find((p) => p.nickname === name) : history?.rows.find((r) => r.capturedAt === inspectedAt)?.players.find((p) => p.nickname === name); const first = history?.rows.find((r) => r.players.some((p) => p.nickname === name && p.value != null))?.players.find((p) => p.nickname === name); const delta = player?.value != null && first?.value != null ? player.value - first.value : null; return <div className="lb-comparison-player" key={name}><i style={{ background: colors.get(name) }}/><div><strong>{name}{name === me && <span className="lb-you-tag">You</span>}</strong><small>{player?.rank != null ? `#${player.rank}` : 'Unranked'}{delta != null && <span className={delta > 0 ? 'lb-positive' : delta < 0 ? 'lb-negative' : ''}>{signed(delta)}</span>}</small></div><b>{player?.value != null ? number(player.value) : '—'}</b>{name !== me && <button className="lb-icon-button" aria-label={`Remove ${name} from comparison`} onClick={() => removePlayer(name)}><X size={12}/></button>}</div>; })}</div>

        {rivals.length > 0 && <button className="lb-text-button lb-clear" onClick={() => { setComparisons([]); remember('comparisons', '[]'); }}>Clear comparisons</button>}

      </aside>
    </div>
  </section>;
}
