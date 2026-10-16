import type { MemberChoice } from './blockSelection';
import { useEffect, useId, useState, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { WindowBadge, windowIdentity, formatInterval, formatNumber, type WindowIdentity } from './presentation';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import {
  ribbonPoints, insideRibbon, drawnBlocks, proposalBlocks, splitForBars, statusLabels, chromatinOnly, orderWindows, pairProposals, byQuality,
  type Block, type FrameWindow, type Interval, type MultiBlock, type Selection, type SyncResult, type SyncWindow, type Proposal, type Status
} from './model';
export interface MapFeature { name: string; start: number; end: number }
export type MapMode = 'lanes' | 'all';
export const statusColors: Record<Status, string> = { agreement: '#0d9488', 'single-metric': '#5eead4', disagreement: '#d97706', weak: '#94a3b8' };
const PAD = 12, LABEL = 18, FEAT = 12, BAR = 10, GAP = 46, LANE = LABEL + FEAT + BAR + GAP + BAR + FEAT + 10;
const BADGE = 26;   // all-windows mode: the window badge left of each bar
const ROW_ALL = 64; // all-windows mode: bar to bar
/** Indels at least this long are labelled on the focused, selected or best ribbon of a link. */
const LABELLED_INDEL = 100;
/** Smallest clickable width of a stretch on a bar (px). */
const MIN_TARGET = 8;
interface Bar { key: string; window: SyncWindow; y: number; x0: number; featuresBelow: boolean; label?: ReactNode; highlight: Interval[] }
interface Link { key: string; top: Bar; bottom: Bar; proposals: Proposal[]; lane?: string }
interface Stretch { interval: Interval; ids: string[] }
/** Group intervals that overlap into stretches, each with the proposals it carries. */
function stretchesOf(items: { interval: Interval; id: string }[]): Stretch[] {
  const out: Stretch[] = [];
  for (const it of [...items].sort((a, b) => a.interval[0] - b.interval[0])) {
    const last = out[out.length - 1];
    if (last && it.interval[0] < last.interval[1]) {
      last.interval = [last.interval[0], Math.max(last.interval[1], it.interval[1])];
      if (!last.ids.includes(it.id))
        last.ids.push(it.id);
    }
    else
      out.push({ interval: [it.interval[0], it.interval[1]], ids: [it.id] });
  }
  return out;
}
/**
 * The comparison map. 'lanes': each window under its own copy of the template bar. 'all': every
 * window stacked once, ordered by similarity, ribbons only between neighbours, with the
 * multi-way blocks bracketed. Ribbons are chains of blocks (gaps and notches are indels;
 * crossed = reversed; hatched = chromatin only). Region-first selection: click (or Enter on) a
 * stretch of a bar to light up its counterparts on the other bars, then pick one there.
 */
export function SyncMap({ result, selection, frame = [], onSelect, onRefine, identities = {}, proposals, focusedId, features = {}, otherPairs = [], mode = 'lanes', blocks = [], onSelectBlock, members = [], selectedMembers = [], onMembersChange }: {
  members?: MemberChoice[];
  selectedMembers?: string[];
  onMembersChange?: (keys: string[]) => void;
  result: SyncResult;
  identities?: Record<string, WindowIdentity>;
  selection: Selection | null;
  /** The frame windows of the selection (highlighted on the bars). */
  frame?: FrameWindow[];
  /** Proposals to draw (already limited to the top ones unless "show all"); defaults to all. */
  proposals?: Proposal[];
  focusedId?: string | null;
  features?: Record<string, MapFeature[]>;
  /** Proposals between non-template windows, drawn in extra lanes (or between neighbours in 'all'). */
  otherPairs?: Proposal[];
  mode?: MapMode;
  /** Multi-way blocks, bracketed in 'all' mode. */
  blocks?: MultiBlock[];
  onSelectBlock?: (block: MultiBlock) => void;
  onSelect: (p: Proposal) => void;
  onRefine: (a: number, b: number) => void;
}) {
  const dragStart = useRef<{ x: number; y: number; additive: boolean } | null>(null);
  const dragged = useRef(false);
  const [drag, setDrag] = useState<{ x: number; y: number; endX: number; endY: number } | null>(null);
  const [width, ref] = useContainerWidth(380);
  const clipId = useId(), hatchId = useId();
  const [armed, setArmed] = useState<{ bar: string; ids: string[] } | null>(null);
  const [cursor, setCursor] = useState<Record<string, number>>({});
  const [cycle, setCycle] = useState<{ key: string; n: number } | null>(null);
  const byId = Object.fromEntries(result.windows.map((w, i) => [w.panelId, { w, i }]));
  const identity = (id: string) => identities[id] ?? windowIdentity(byId[id]?.i ?? 0);
  const drawn = proposals ?? result.proposals;
  const original = (p: Proposal) => result.proposals.find(o => o.id === p.id) ?? p;
  const template = result.windows[0];
  const span = Math.max(...result.windows.map(w => w.end - w.start));
  const size = (id: string) => result.circular?.[id];
  const all = mode === 'all' && result.windows.length >= 3;
  const x0 = all ? PAD + BADGE : PAD;
  const scale = Math.max(1, width - x0 - PAD) / span;
  const templateFrame = frame.find(w => w.panelId === (selection?.templateId ?? template.panelId) && (!w.copy || w.provenance.metric.split(' + ')[0] === 'template'));
  const highlightOf = (w: SyncWindow, isTemplateCopy: boolean) => isTemplateCopy
    ? (templateFrame ? templateFrame.blocks.map(b => b.genomic) : [])
    : frame.filter(f => f.panelId === w.panelId).flatMap(f => f.blocks.map(b => b.genomic));
  // Bars and the links (ribbon sets) between them.
  const bars: Bar[] = [], links: Link[] = [];
  if (all) {
    const order = orderWindows(result);
    const pool = [...drawn, ...otherPairs];
    order.forEach((w, i) => bars.push({ key: `all-${w.panelId}`, window: w, y: 8 + i * ROW_ALL, x0, featuresBelow: true, highlight: highlightOf(w, false) }));
    for (let i = 0; i + 1 < order.length; i++)
      links.push({ key: `${order[i].panelId}~${order[i + 1].panelId}`, top: bars[i], bottom: bars[i + 1], proposals: pairProposals(pool, order[i].panelId, order[i + 1].panelId) });
  }
  else {
    const lanes = [
      ...result.windows.slice(1).map(w => ({ top: template, bottom: w, template: true, proposals: drawn.filter(p => p.partnerId === template.panelId && p.panelId === w.panelId) })),
      ...result.windows.slice(1).flatMap((a, i) => result.windows.slice(i + 2).map(b => ({ top: a, bottom: b, template: false, proposals: otherPairs.filter(p => p.partnerId === a.panelId && p.panelId === b.panelId) })))
        .filter(l => l.proposals.length)
    ];
    lanes.forEach((lane, li) => {
      const base = li * LANE;
      const yTop = base + LABEL + FEAT, yBottom = yTop + BAR + GAP;
      const bottomFrames = lane.template ? frame.filter(w => w.panelId === lane.bottom.panelId) : [];
      const reversed = bottomFrames.length > 0 && !!templateFrame && bottomFrames.every(w => w.strand !== templateFrame.strand);
      const label = <div className="truncate text-[10px] leading-[16px] text-ink" title={`${lane.top.label} ${formatInterval(lane.top)} ↔ ${lane.bottom.label} ${formatInterval(lane.bottom)}`}>
        <WindowBadge identity={identity(lane.top.panelId)} />{lane.template ? ' template' : ''} ↔ <WindowBadge identity={identity(lane.bottom.panelId)} /> · {lane.bottom.label} · {formatInterval(lane.bottom)}{size(lane.bottom.panelId) ? ' · circular' : ''}{bottomFrames.length > 1 ? ` · ${bottomFrames.length} copies` : ''}{reversed ? ' · reversed' : ''}{lane.template ? '' : ' · other pair'}
      </div>;
      const top: Bar = { key: `lane${li}-top`, window: lane.top, y: yTop, x0, featuresBelow: false, label, highlight: lane.template ? highlightOf(lane.top, true) : [] };
      const bottom: Bar = { key: `lane${li}-bottom`, window: lane.bottom, y: yBottom, x0, featuresBelow: true, highlight: lane.template ? highlightOf(lane.bottom, false) : [] };
      bars.push(top, bottom);
      links.push({ key: `${lane.top.panelId}~${lane.bottom.panelId}`, top, bottom, proposals: lane.proposals, lane: lane.bottom.panelId + (lane.template ? '' : `-${lane.top.panelId}`) });
    });
  }
  // Repeats have one bar: both ends of each ribbon return to copies on that lane.
  let nextY = bars.length ? Math.max(...bars.map(b => b.y)) + GAP + LABEL + FEAT : LABEL + FEAT;
  for (const w of result.windows) {
    const ps = [...drawn, ...otherPairs].filter(p => p.panelId === w.panelId && p.partnerId === w.panelId);
    if (!ps.length) continue;
    if (all) {
      const existing = bars.find(b => b.window.panelId === w.panelId);
      if (existing) { links.push({ key: `repeat-${w.panelId}`, top: existing, bottom: existing, proposals: ps, lane: `repeat-${w.panelId}` }); continue; }
    }
    const bar: Bar = { key: `repeat-${w.panelId}`, window: w, y: nextY, x0, featuresBelow: false,
      label: <div className="truncate text-[10px] leading-[16px] text-ink"><WindowBadge identity={identity(w.panelId)} /> · Repeats within this window · {formatInterval(w)}</div>, highlight: highlightOf(w, false) };
    bars.push(bar);
    links.push({ key: `repeat-${w.panelId}`, top: bar, bottom: bar, proposals: ps, lane: `repeat-${w.panelId}` });
    nextY += LANE;
  }
  const height = Math.max(40, ...bars.map(b => b.y + BAR + GAP + FEAT + 10));
  const x = (bar: Bar, pos: number) => bar.x0 + (pos - bar.window.start) * scale;
  /** A position on a circular window moved by whole turns into its drawn bar. */
  const onBar = (w: SyncWindow, pos: number) => {
    const s = size(w.panelId);
    if (!s)
      return pos;
    while (pos >= w.end) pos -= s;
    while (pos < w.start) pos += s;
    return pos;
  };
  const joinBp = Math.max(10, 2 / scale);
  const ribbons = (p: Proposal, link: Link): Block[] => drawnBlocks({ ...p, blocks: proposalBlocks(p).flatMap(b => splitForBars(b, p.strand, link.top.window, size(link.top.window.panelId), link.bottom.window, size(link.bottom.window.panelId))) }, joinBp);
  const area = (p: Proposal) => (p.template[1] - p.template[0]) + (p.window[1] - p.window[0]);
  const yRibbon = (link: Link) => [link.top.y + BAR + (link.top.featuresBelow && !all ? FEAT : 1), link.bottom.y - (link.bottom.featuresBelow ? 1 : FEAT)] as const;
  // Stretches: each bar's matched intervals from the links that touch it.
  const sideItems = (bar: Bar) => links.flatMap(l => [...(l.top === bar ? l.proposals.map(p => ({ interval: p.template, id: p.id })) : []), ...(l.bottom === bar ? l.proposals.map(p => ({ interval: p.window, id: p.id })) : [])]);
  const stretches = Object.fromEntries(bars.map(b => [b.key, stretchesOf(sideItems(b).map(it => ({ ...it, interval: [onBar(b.window, it.interval[0]), onBar(b.window, it.interval[0]) + it.interval[1] - it.interval[0]] as Interval })))]));
  // Lit: the counterparts of the armed stretch's proposals on the bars linked to it.
  const lit: Record<string, Stretch[]> = {};
  if (armed) {
    for (const l of links) {
      const from = l.top.key === armed.bar ? 'top' : l.bottom.key === armed.bar ? 'bottom' : null;
      if (!from)
        continue;
      const other = from === 'top' ? l.bottom : l.top;
      const items = l.proposals.filter(p => armed.ids.includes(p.id)).flatMap(p => (l.top === l.bottom ? [p.template, p.window] : [from === 'top' ? p.window : p.template]).map(interval => ({ interval, id: p.id })));
      lit[other.key] = [...(lit[other.key] ?? []), ...stretchesOf(items.map(it => ({ ...it, interval: [onBar(other.window, it.interval[0]), onBar(other.window, it.interval[0]) + it.interval[1] - it.interval[0]] as Interval })))];
    }
  }
  const armedIds = armed?.ids ?? null;
  useEffect(() => { setArmed(null); setCycle(null); }, [result, mode]);
  const tooltip = (bar: Bar, st: Stretch) => st.ids.map(id => {
    const p = original(drawn.find(d => d.id === id) ?? otherPairs.find(d => d.id === id) ?? result.proposals.find(d => d.id === id)!);
    const feats = (features[bar.window.panelId] ?? []).filter(f => f.start < st.interval[1] && f.end > st.interval[0]).slice(0, 2).map(f => f.name);
    const seq = p.metrics.sequence?.verdict === 'supports' && p.metrics.sequence.score != null ? `seq ${Math.round(p.metrics.sequence.score * 100)}%` : null;
    const shape = p.metrics.shape?.score != null ? `chromatin r ${p.metrics.shape.score.toFixed(2)}` : null;
    return [`${identity(p.partnerId).label} ↔ ${identity(p.panelId).label}`, ...feats, seq, shape, chromatinOnly(p) ? 'chromatin only' : null].filter(Boolean).join(' · ');
  }).join('\n');
  function pick(barKey: string, st: Stretch) {
    const candidates = st.ids.map(id => original(result.proposals.find(p => p.id === id)!)).filter(Boolean).sort(byQuality);
    if (!candidates.length)
      return;
    const key = `${barKey}:${st.interval[0]}`;
    const n = cycle?.key === key ? cycle.n + 1 : 0;
    setCycle({ key, n });
    onSelect(candidates[n % candidates.length]);
  }
  function activate(bar: Bar, index: number, litTarget: boolean) {
    const list = litTarget ? lit[bar.key] ?? [] : stretches[bar.key] ?? [];
    const st = list[index];
    if (!st)
      return;
    if (litTarget)
      pick(bar.key, st);
    else {
      setArmed(armed?.bar === bar.key && armed.ids.join() === st.ids.join() ? null : { bar: bar.key, ids: st.ids });
      setCycle(null);
    }
  }
  function barKey(e: ReactKeyboardEvent, bar: Bar) {
    const useLit = !!lit[bar.key]?.length;
    const list = useLit ? lit[bar.key] : stretches[bar.key] ?? [];
    const at = Math.min(cursor[bar.key] ?? 0, Math.max(0, list.length - 1));
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setCursor({ ...cursor, [bar.key]: list.length ? (at + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length : 0 });
    }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(bar, at, useLit);
    }
    else if (e.key === 'Escape') {
      setArmed(null);
    }
  }
  function laneClick(e: ReactMouseEvent<SVGElement>, link: Link, y1: number, y2: number, fallback: Proposal) {
    e.stopPropagation();
    if (link.top === link.bottom) { onSelect(original(fallback)); return; }
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box) {
      onSelect(original(fallback));
      return;
    }
    const px = (e.clientX - box.left) * (width / Math.max(1, box.width)), py = (e.clientY - box.top) * (height / Math.max(1, box.height));
    const under = [...link.proposals].sort((a, b) => area(a) - area(b)).filter(p => ribbons(p, link).some(piece =>
      insideRibbon([x(link.top, piece.template[0]), x(link.top, piece.template[1])], [x(link.bottom, piece.window[0]), x(link.bottom, piece.window[1])], y1, y2, p.strand, px, py)));
    if (!under.length) {
      onSelect(original(fallback));
      return;
    }
    // Clicking again where ribbons overlap steps to the next one underneath.
    const current = under.findIndex(p => p.id === focusedId);
    onSelect(original(under[current < 0 ? 0 : (current + 1) % under.length]));
  }
  /** Feature names, those inside the focused proposal first, then the longest, wherever a label fits. */
  const featureLabels = (feats: MapFeature[], bar: Bar) => {
    const w = bar.window;
    const out: { name: string; x: number; end: number }[] = [];
    const focus = drawn.concat(otherPairs).find(p => p.id === focusedId);
    const extent = focus ? (focus.panelId === w.panelId ? focus.window : focus.partnerId === w.panelId ? focus.template : null) : null;
    const inFocus = (f: MapFeature) => !!extent && f.start < extent[1] && f.end > extent[0] ? 0 : 1;
    for (const f of [...feats].sort((a, b) => inFocus(a) - inFocus(b) || (b.end - b.start) - (a.end - a.start))) {
      const fx = x(bar, Math.max(w.start, f.start)), fw = (Math.min(w.end, f.end) - Math.max(w.start, f.start)) * scale;
      const tw = f.name.length * 4.6 + 4;
      const lx = Math.min(Math.max(bar.x0, fx + fw / 2 - tw / 2), bar.x0 + (w.end - w.start) * scale - tw);
      if (fw < 3 || tw > fw + 60 || out.some(o => (lx < o.end + 4 && lx + tw + 4 > o.x) || (o.name === f.name && Math.abs(o.x - lx) < 80)))
        continue;
      out.push({ name: f.name, x: lx, end: lx + tw });
    }
    return out;
  };
  const memberRects = bars.flatMap(bar => members.filter(m => m.panelId === bar.window.panelId).map(member => ({
    member, bar, x: x(bar, onBar(bar.window, member.interval[0])), y: bar.y - 3,
    width: Math.max(MIN_TARGET, (member.interval[1] - member.interval[0]) * scale),
  })));
  const eventPoint = (e: { clientX: number; clientY: number }, svg: SVGSVGElement) => {
    const box = svg.getBoundingClientRect();
    return { x: (e.clientX - box.left) * width / box.width, y: (e.clientY - box.top) * height / box.height };
  };
  const renderBar = (bar: Bar) => {
    const w = bar.window;
    const feats = features[w.panelId] ?? [];
    const fy = bar.featuresBelow ? bar.y + BAR + 2 : bar.y - FEAT;
    const own = stretches[bar.key] ?? [];
    const lighted = lit[bar.key] ?? [];
    const cur = cursor[bar.key] ?? 0;
    const target = (st: Stretch) => {
      const a = x(bar, st.interval[0]), b = x(bar, st.interval[1]);
      const wpx = Math.max(MIN_TARGET, b - a);
      return { x: (a + b) / 2 - wpx / 2, w: wpx };
    };
    return <g key={bar.key} data-testid={`sync-bar-${bar.key}`}>
      {all && <foreignObject x={2} y={bar.y - 3} width={BADGE} height={16}>
        <div className="text-[10px] leading-[16px] text-ink" title={`${w.label} · ${formatInterval(w)}`}><WindowBadge identity={identity(w.panelId)} /></div>
      </foreignObject>}
      <rect x={bar.x0} y={bar.y} width={(w.end - w.start) * scale} height={BAR} rx={3} fill="#cbd5e1" className="dark:fill-gray-600" />
      {bar.highlight.map(([a, b], i) => <rect key={i} data-testid={i ? undefined : `sync-selected-${w.panelId}`} x={x(bar, onBar(w, a))} y={bar.y} width={Math.max(1.5, (b - a) * scale)} height={BAR} fill="#0f766e" pointerEvents="none" />)}
      {feats.map((f, i) => <rect key={i} x={x(bar, Math.max(w.start, f.start))} y={bar.featuresBelow ? fy : fy + FEAT - 4} width={Math.max(1.5, (Math.min(w.end, f.end) - Math.max(w.start, f.start)) * scale)} height={3} fill="#64748b" className="dark:fill-gray-400" pointerEvents="none" />)}
      {!all && featureLabels(feats, bar).map(l => <text key={l.name + l.x} x={l.x} y={bar.featuresBelow ? fy + FEAT - 1 : fy + 6} fontSize={8.5} className="fill-ink-secondary" aria-hidden="true">{l.name}</text>)}
      {/* Region-first targets: the bar is one keyboard stop; arrows move between its stretches. */}
      <g role="group" tabIndex={0} data-testid={`sync-stretches-${bar.key}`}
        aria-label={`${identity(w.panelId).label} bar: ${lighted.length ? `${lighted.length} matching stretch${lighted.length === 1 ? '' : 'es'} lit; arrows move, Enter picks` : `${own.length} matched stretch${own.length === 1 ? '' : 'es'}; arrows move, Enter shows their matches`}. Escape clears.`}
        onKeyDown={e => barKey(e, bar)} className="focus:outline-none [&:focus>.sync-cursor]:opacity-100">
        {own.map((st, i) => {
          const t = target(st);
          const isArmed = armed?.bar === bar.key && armed.ids.join() === st.ids.join();
          return <rect key={`s${i}`} data-testid={`sync-stretch-${bar.key}-${i}`} x={t.x} y={bar.y - 2} width={t.w} height={BAR + 4} rx={2}
            fill={isArmed ? '#14b8a6' : bar.key.startsWith('repeat-') ? '#5eead4' : 'transparent'} fillOpacity={isArmed || bar.key.startsWith('repeat-') ? .35 : 0} stroke={isArmed ? '#0f766e' : 'transparent'}
            className="cursor-pointer hover:stroke-teal-600" onClick={e => { e.stopPropagation(); activate(bar, i, false); }}>
            <title>{tooltip(bar, st)}</title>
          </rect>;
        })}
        {lighted.map((st, i) => {
          const t = target(st);
          return <rect key={`l${i}`} data-testid={`sync-lit-${bar.key}-${i}`} x={t.x} y={bar.y - 3} width={t.w} height={BAR + 6} rx={2}
            fill="#f59e0b" fillOpacity={.35} stroke="#b45309" strokeWidth={1.5} className="cursor-pointer" onClick={e => { e.stopPropagation(); activate(bar, i, true); }}>
            <title>{`Pick: ${tooltip(bar, st)}`}</title>
          </rect>;
        })}
        {(lighted.length ? lighted : own).length > 0 && (() => {
          const list = lighted.length ? lighted : own;
          const t = target(list[Math.min(cur, list.length - 1)]);
          return <rect className="sync-cursor opacity-0" x={t.x - 2} y={bar.y - 5} width={t.w + 4} height={BAR + 10} rx={3} fill="none" stroke="#134e4a" strokeWidth={2} strokeDasharray="3 2" pointerEvents="none" />;
        })()}
      </g>
    </g>;
  };
  const renderLink = (link: Link) => {
    const [y1, y2] = yRibbon(link);
    const best = [...link.proposals].sort(byQuality)[0];
    return <g key={link.key} data-testid={link.lane ? `sync-lane-${link.lane}` : `sync-link-${link.key}`} clipPath={`url(#${clipId})`}>
      {link.top.label && <foreignObject x={PAD} y={link.top.y - LABEL - FEAT} width={Math.max(1, width - 2 * PAD)} height={LABEL}>{link.top.label}</foreignObject>}
      {[...link.proposals].sort((a, b) => area(b) - area(a)).map(p => {
        const active = selection?.matches.some(m => m.id === p.id);
        const focused = focusedId === p.id;
        const dim = armedIds && !armedIds.includes(p.id);
        const chromatin = chromatinOnly(p);
        const label = `${identity(link.top.window.panelId).label} ↔ ${identity(link.bottom.window.panelId).label} · ${link.bottom.window.label}: ${formatNumber(p.template[0])}–${formatNumber(p.template[1])} ↔ ${formatNumber(p.window[0])}–${formatNumber(p.window[1])}${p.strand === '-' ? ', reversed' : ''}${p.blocks && p.blocks.length > 1 ? `, ${p.blocks.length} blocks across indels` : ''}${chromatin ? ', chromatin only (no shared sequence)' : ''}, ${statusLabels[p.status].toLowerCase()} (${p.supports} of ${p.assessed} metrics support), confidence ${p.confidence.toFixed(2)}${p.flags?.includes('crosses-origin') ? ', crosses an origin' : ''}`;
        const pieces = ribbons(p, link);
        const gaps = active || focused || p === best ? (p.gaps ?? []).filter(g => Math.max(g.inserted, g.deleted) >= LABELLED_INDEL) : [];
        return <g key={p.id} opacity={dim ? .12 : 1}>
          {pieces.map((piece, i) => <path
            key={i}
            data-testid={i ? undefined : `sync-ribbon-${p.id}`}
            role={i ? undefined : 'button'}
            tabIndex={i ? -1 : 0}
            aria-hidden={i ? true : undefined}
            aria-label={i ? undefined : label}
            aria-pressed={i ? undefined : !!(active || focused)}
            d={link.top === link.bottom ? (() => {
              const a = x(link.top, piece.template[0]), b = x(link.top, piece.template[1]);
              const c = x(link.bottom, piece.window[p.strand === '+' ? 0 : 1]), d = x(link.bottom, piece.window[p.strand === '+' ? 1 : 0]);
              const y = link.top.y + BAR, bend = y + GAP;
              return `M ${a} ${y} C ${a} ${bend} ${c} ${bend} ${c} ${y} L ${d} ${y} C ${d} ${bend} ${b} ${bend} ${b} ${y} Z`;
            })() : `M ${ribbonPoints([x(link.top, piece.template[0]), x(link.top, piece.template[1])], [x(link.bottom, piece.window[0]), x(link.bottom, piece.window[1])], y1, y2, p.strand).trim().split(/\s+/).join(' L ')} Z`}
            fill={chromatin ? `url(#${hatchId})` : statusColors[p.status]}
            fillOpacity={active || focused ? .75 : chromatin ? .9 : .08 + .45 * p.confidence * p.confidence}
            stroke={active || focused ? '#134e4a' : chromatin ? '#7c3aed' : statusColors[p.status]}
            strokeWidth={active || focused ? 1 : chromatin ? 1 : .5}
            strokeDasharray={chromatin ? '3 2' : undefined}
            className="cursor-pointer focus:outline focus:outline-2 focus:outline-teal-600"
            onClick={e => laneClick(e, link, y1, y2, p)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(original(p));
              }
              if (e.key.startsWith('Arrow')) {
                e.preventDefault();
                const nodes = [...(e.currentTarget.ownerSVGElement?.querySelectorAll<SVGElement>('[data-testid^="sync-ribbon-"]') ?? [])];
                const at = nodes.indexOf(e.currentTarget);
                nodes[(at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + nodes.length) % nodes.length]?.focus();
              }
            }}>
            <title>{label}</title>
          </path>)}
          {gaps.map((g, i) => {
            const xt = x(link.top, onBar(link.top.window, g.template)), xw = x(link.bottom, onBar(link.bottom.window, g.window));
            const text = g.inserted >= g.deleted ? `+${formatNumber(g.inserted)} bp in ${identity(link.bottom.window.panelId).label}` : `−${formatNumber(g.deleted)} bp in ${identity(link.bottom.window.panelId).label}`;
            return <text key={`gap${i}`} data-testid={i ? undefined : `sync-gap-${p.id}`} x={Math.max(PAD, Math.min(width - PAD - text.length * 5, (xt + xw) / 2 + 3))} y={(y1 + y2) / 2 + 3}
              fontSize={9} className="fill-ink stroke-white dark:stroke-gray-900" strokeWidth={2.5} paintOrder="stroke" pointerEvents="none">{text}</text>;
          })}
        </g>;
      })}
    </g>;
  };
  // Common blocks (all-windows mode): outlined on every member bar, a bracket with "in N of M".
  const renderBlocks = () => all ? blocks.slice(0, 4).map((blk, k) => {
    const memberBars = bars.filter(b => blk.members.some(m => m.panelId === b.window.panelId));
    if (memberBars.length < 2)
      return null;
    const xs = 6 + k * 5;
    const yTop = Math.min(...memberBars.map(b => b.y)), yBottom = Math.max(...memberBars.map(b => b.y)) + BAR;
    const label = `in ${blk.coverage} of ${blk.total}${blk.inconsistent.length ? ' · inconsistent' : ''}${blk.chromatinOnly ? ' · chromatin only' : ''}`;
    return <g key={blk.id} data-testid={`sync-block-${blk.id}`} className="cursor-pointer focus:outline-none focus-visible:[&>path]:stroke-[3px]" role="button" tabIndex={0}
      aria-label={`Use the common block ${label}`}
      onClick={e => { e.stopPropagation(); onSelectBlock?.(blk); }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectBlock?.(blk); } }}>
      {memberBars.flatMap(b => blk.members.find(m => m.panelId === b.window.panelId)!.intervals.map((iv, i) =>
        <rect key={`${b.key}${i}`} x={x(b, onBar(b.window, iv[0])) - 1} y={b.y - 2} width={Math.max(3, (iv[1] - iv[0]) * scale + 2)} height={BAR + 4} rx={2}
          fill="none" stroke={blk.inconsistent.length ? '#d97706' : '#0f766e'} strokeWidth={1.2} strokeDasharray={k ? '2 2' : undefined} pointerEvents="none" />))}
      <path d={`M ${width - xs} ${yTop} h -4 M ${width - xs} ${yTop} V ${yBottom} M ${width - xs} ${yBottom} h -4`} stroke={blk.inconsistent.length ? '#d97706' : '#0f766e'} strokeWidth={1.5} fill="none" />
      <text x={width - xs - 6} y={yTop + 9 + k * 10} fontSize={9} textAnchor="end" className="fill-ink stroke-white dark:stroke-gray-900" strokeWidth={2.5} paintOrder="stroke">{label}</text>
      <title>{`Common block ${label}: ${blk.members.map(m => `${identity(m.panelId).label} ${m.intervals.map(iv => `${formatNumber(iv[0])}–${formatNumber(iv[1])}`).join(', ')}`).join(' · ')}. Click to use it.`}</title>
    </g>;
  }) : null;
  return <div ref={ref} data-testid="sync-map" className="min-w-0 w-full"
    onKeyDown={e => { if (e.key === 'Escape') { setArmed(null); onMembersChange?.([]); } }}>
    <svg data-testid="sync-map-svg" width="100%" viewBox={`0 0 ${width} ${height}`} height={height} role="group"
      onPointerDownCapture={e => {
        if (!onMembersChange || e.button !== 0 || (e.target as Element).getAttribute('role') === 'slider') return;
        dragged.current = false;
        dragStart.current = { ...eventPoint(e, e.currentTarget), additive: e.shiftKey || e.metaKey || e.ctrlKey };
      }}
      onPointerMove={e => {
        const from = dragStart.current;
        if (!from) return;
        const to = eventPoint(e, e.currentTarget);
        if (!dragged.current && Math.hypot(to.x - from.x, to.y - from.y) < 5) return;
        dragged.current = true; e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ ...from, endX: to.x, endY: to.y });
      }}
      onPointerUp={e => {
        const from = dragStart.current; dragStart.current = null;
        if (from && dragged.current && onMembersChange) {
          const to = eventPoint(e, e.currentTarget);
          const keys = memberRects.filter(r => r.x < Math.max(from.x, to.x) && r.x + r.width > Math.min(from.x, to.x)
            && r.y < Math.max(from.y, to.y) && r.y + BAR + 6 > Math.min(from.y, to.y)).map(r => r.member.key);
          onMembersChange([...new Set([...(from.additive ? selectedMembers : []), ...keys])]);
        }
        setDrag(null);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => { dragStart.current = null; setDrag(null); }}
      aria-label={all ? 'Comparable regions: all windows stacked, ribbons between neighbours' : 'Comparable regions: each window under the template, in native coordinates'}
      onClick={() => { if (armed) setArmed(null); }}>
      <defs>
        <clipPath id={clipId}><rect x={0} y={0} width={width} height={height} /></clipPath>
        <pattern id={hatchId} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={5} height={5} fill="#ede9fe" className="dark:fill-violet-950" /><line x1={0} y1={0} x2={0} y2={5} stroke="#7c3aed" strokeWidth={1.5} />
        </pattern>
      </defs>
      {links.map(renderLink)}
      {bars.map(renderBar)}
      {!onMembersChange && renderBlocks()}
      {onMembersChange && memberRects.map(({ member, bar, x, y, width: w }) => <foreignObject key={`${bar.key}-${member.key}`} x={x} y={y} width={w} height={BAR + 6}>
        <button type="button" data-testid={`sync-map-member-${bar.key}-${member.key}`} aria-pressed={selectedMembers.includes(member.key)}
          aria-label={`${identity(member.panelId).label}${member.copy ?? ''} ${formatNumber(member.interval[0])}–${formatNumber(member.interval[1])}`}
          className={`block h-full w-full rounded-fb border border-teal-700 focus-visible:shadow-focus ${selectedMembers.includes(member.key) ? 'bg-teal-600 dark:bg-teal-500' : 'bg-teal-50 dark:bg-teal-950'}`}
          onClick={e => { e.stopPropagation(); if (dragged.current) { dragged.current = false; return; } onMembersChange(selectedMembers.includes(member.key) ? selectedMembers.filter(k => k !== member.key) : [...selectedMembers, member.key]); }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') dragged.current = false;
            if (e.key === 'Escape') { e.preventDefault(); onMembersChange([]); }
            if (e.key.startsWith('Arrow')) {
              e.preventDefault();
              const nodes = [...(e.currentTarget.closest('svg')?.querySelectorAll<HTMLButtonElement>('[data-testid^="sync-map-member-"]') ?? [])];
              const at = nodes.indexOf(e.currentTarget);
              nodes[(at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? nodes.length - 1 : 1)) % nodes.length]?.focus();
            }
          }} />
      </foreignObject>)}
      {drag && <rect data-testid="sync-map-drag" x={Math.min(drag.x, drag.endX)} y={Math.min(drag.y, drag.endY)} width={Math.abs(drag.endX - drag.x)} height={Math.abs(drag.endY - drag.y)} fill="#14b8a6" fillOpacity={.15} stroke="#0f766e" pointerEvents="none" />}
      {selection && (() => {
        const lane = bars.find(b => b.window.panelId === (selection.templateId ?? template.panelId));
        if (!lane)
          return null;
        return (['start', 'end'] as const).map(edge => <rect
          key={edge}
          data-testid={`sync-edge-${edge}`}
          role="slider"
          tabIndex={0}
          aria-label={`Template ${edge}`}
          aria-valuenow={selection[edge]}
          aria-valuemin={Math.max(...selection.matches.map(p => p.template[0]))}
          aria-valuemax={Math.min(...selection.matches.map(p => p.template[1]))}
          x={x(lane, onBar(lane.window, selection[edge] - (edge === 'end' ? 1 : 0))) - 3}
          y={lane.y - 4}
          width={6}
          height={BAR + 8}
          rx={2}
          fill="#134e4a"
          className="cursor-ew-resize touch-none"
          onClick={e => e.stopPropagation()}
          onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={e => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId))
              return;
            const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
            const pos = lane.window.start + ((e.clientX - box.left) * (width / Math.max(1, box.width)) - lane.x0) / scale;
            onRefine(edge === 'start' ? pos : selection.start, edge === 'end' ? pos : selection.end);
          }}
          onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)}
          onKeyDown={e => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')
              return;
            e.preventDefault();
            const pos = selection[edge] + (e.key === 'ArrowRight' ? 10 : -10);
            onRefine(edge === 'start' ? pos : selection.start, edge === 'end' ? pos : selection.end);
          }} />);
      })()}
    </svg>
    {armed && <p data-testid="sync-armed" className="text-[11px] text-amber-800 dark:text-amber-200">Showing the matches of the chosen stretch: pick a lit stretch on another bar (Escape clears).</p>}
    <div data-testid="sync-map-legend" className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-secondary">
      {(Object.keys(statusColors) as Status[]).map(s => <span key={s} className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ backgroundColor: statusColors[s] }} />{statusLabels[s]}</span>)}
      <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-2 w-3 rounded-sm border border-dashed border-violet-600 bg-violet-100 dark:bg-violet-950" />Chromatin only</span>
      <span title="An indel shows as a gap on one bar and a notch on the other; crossed ribbons are reversed.">Gap = indel · crossed = reversed</span>
    </div>
  </div>;
}
