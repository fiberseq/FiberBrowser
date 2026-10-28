/**
 * The hub's overlay tab (DESIGN §8, V1): a mark layer over many loci, aligned at the anchor, an edge or scaled, pooled
 * per observation (each shown dataset panel, haplotype pop-out or graph path: the nucleosome panel's planner), with the
 * denominator (molecules measured at each position) under every profile. Views: overlaid profiles, facets, a pile.
 * Graph paths count a locus only where they carry it. Exports TSV and SVG.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { AnalysisButton } from '../../components/controls/shared/AnalysisControls';
import { fetchJson } from '../../api/sharedFetch';
import { downloadTextFile, formatTsv } from '../../utils/analysisExport';
import { nucObservations } from '../nucleosomes/planner';
import type { NucObservation } from '../nucleosomes/types';
import { hubGeneration, useHubData } from './hubData';
import type { FeatureHit, FeatureSet, GraphAlias } from './types';
import { DEFAULT_OVERLAY, OVERLAY_LAYERS, type OverlayAlign, type OverlayLayer, type OverlayLocus, type OverlayResult, type OverlaySeries, type OverlayState } from './overlayTypes';
import { displaySpan } from './frames';

export interface OverlaySeed { loci: 'selection' | 'patches'; at: number }

let overlaySeq = 0;

const ALIGN_LABEL: Record<OverlayAlign, string> = { anchor: 'Anchor (with strand)', left: 'Left edge', right: 'Right edge', scaled: 'Scaled (each patch 0–1)' };

/** A hub hit as an overlay locus: this genome's coordinates (a lifted hit's placement), its source coordinates, and its
 * graph paths' statuses. */
const flip = (s?: '+' | '-') => (s === '+' ? '-' : s === '-' ? '+' : undefined);
const pathsOf = (g?: GraphAlias) => (g ? { paths: Object.fromEntries(Object.entries(g.paths).map(([k, p]) =>
  [k, { status: p.status, ...(p.hap ? { hap: p.hap } : {}), datasets: p.datasets }])) } : {});

export function locusOfHit(h: FeatureHit, setId: string): OverlayLocus | null {
  const here = displaySpan(h);
  if (!here) return null;
  // On this genome a hit of an assembly scan has the strand its lift gives it (a flipped chain reverses it); its own
  // source coordinates keep the original strand.
  const strand = h.frame?.kind === 'source' && h.lift?.flipped ? flip(h.strand) : h.strand;
  return {
    key: `${setId}|${h.hitId}`, chrom: here.chrom, start: here.start, end: Math.max(here.end, here.start + 1), anchor: here.anchor,
    ...(here.insertion ? { insertion: true } : {}),
    ...(strand ? { strand } : {}), ...(h.label ? { label: h.label } : {}), hitId: h.hitId, setId, ...pathsOf(h.graph),
    ...(h.source && h.frame?.kind === 'source' ? { source: { ...h.source, ...(h.strand ? { strand: h.strand } : {}),
      ...(h.frame.hapLabel ?? h.frame.hap ? { hap: h.frame.hapLabel ?? h.frame.hap } : {}),
      ...(h.frame.datasetId ? { datasetId: h.frame.datasetId } : {}) } } : {}),
  };
}

export { sendToOverlay } from './overlayHandoff';

const density = (s: OverlaySeries, i: number) => (s.den?.[i] > 0 ? s.num[i] / s.den[i] : null);

function seriesColour(obs: NucObservation | undefined, i: number, dark: boolean): string {
  if (obs?.color) return obs.color;
  const light = ['#2a78d6', '#1baf7a', '#6250d6', '#e87ba4'];
  const darkP = ['#3987e5', '#199e70', '#9085e9', '#d55181'];
  return (dark ? darkP : light)[i % 4];
}

function xFmt(x: number, align: OverlayAlign): string {
  if (align === 'scaled' && x >= 0 && x <= 1) return x.toFixed(1);
  return Math.abs(x) >= 1000 ? `${(x / 1000).toFixed(1)} kb` : `${Math.round(x)}`;
}

function Profile({ result, series, colours, svgRef, facet }: { result: OverlayResult; series: OverlaySeries[]; colours: Record<string, string>;
  svgRef?: React.MutableRefObject<SVGSVGElement | null>; facet?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const axisX = result.x ?? result.series.find(s => s.x)?.x ?? [];
  const n = axisX.length;
  const W = 520, H = facet ? 128 : 198, L = 36, R = facet ? 10 : 104, T = 18, DEN = 36, B = 22;
  const plotH = H - T - B - DEN;
  const maxDen = Math.max(1, ...series.flatMap(s => s.den));
  // The density axis fits the data (a step of 0.05 / 0.1 / 0.25 / 0.5 / 1), so low densities stay readable.
  const top = Math.max(0, ...series.flatMap(s => s.x.map((_v, i) => density(s, i) ?? 0)));
  const ymax = [0.05, 0.1, 0.25, 0.5, 1].find(v => top <= v) ?? 1;
  const x = (i: number) => L + (i + 0.5) / Math.max(1, n) * (W - L - R);
  const y = (v: number) => T + (1 - v / ymax) * plotH;
  // x ticks: round values for bp axes; the patch's 0, 0.5 and 1 (and the flanks' ends) for a scaled axis.
  const xs = axisX;
  const half = result.binBp / 2;
  const lo = (xs[0] ?? 0) - half, hi = (xs[n - 1] ?? 1) + half;
  const xAt = (v: number) => L + (v - lo) / Math.max(1e-9, hi - lo) * (W - L - R);
  const ticksX: Array<{ at: number; label: string }> = (() => {
    if (result.align === 'scaled') {
      const nf = (n - (result.scaledBins ?? 100)) / 2;
      const at = (i: number) => L + i / Math.max(1, n) * (W - L - R);
      return [{ at: at(0), label: `−${result.flank} bp` }, { at: at(nf), label: '0' }, { at: at(nf + (result.scaledBins ?? 100) / 2), label: '0.5' },
        { at: at(nf + (result.scaledBins ?? 100)), label: '1' }, { at: at(n), label: `+${result.flank} bp` }];
    }
    const raw = (hi - lo) / 5;
    const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw) ?? raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push({ at: xAt(v), label: xFmt(v, result.align) });
    return out;
  })();
  // Direct labels at the lines' ends, pushed apart so they never overlap.
  const ends = series.map(s => { const i = [...s.x.keys()].reverse().find(k => density(s, k) != null); return i == null ? null : { s, i, y: y(density(s, i)!) }; })
    .filter((e): e is { s: OverlaySeries; i: number; y: number } => e != null).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 11) ends[k].y = ends[k - 1].y + 11;
  return <svg ref={el => { if (svgRef) svgRef.current = el; }} viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[900px]" role="img"
    aria-label={`${OVERLAY_LAYERS.find(l => l.key === result.layer)?.label} density by ${result.xLabel}`}
    onMouseLeave={() => setHover(null)}
    onMouseMove={e => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * W;
      const i = Math.round((px - L) / (W - L - R) * n - 0.5); setHover(i >= 0 && i < n ? i : null); }}>
    {[0, ymax / 2, ymax].map(t => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={0.12} />
      <text x={L - 4} y={y(t) + 3} textAnchor="end" className="fill-current text-[9px] opacity-70">{t}</text></g>)}
    <text x={4} y={9} className="fill-current text-[9px] opacity-70">density</text>
    {series.map(s => {
      const pts = s.x.map((_v, i) => (density(s, i) == null ? null : `${x(i)},${y(density(s, i)!)}`));
      const segs: string[][] = [[]];
      for (const p of pts) { if (p) segs[segs.length - 1].push(p); else if (segs[segs.length - 1].length) segs.push([]); }
      return <g key={s.obsId}>
        {segs.filter(g => g.length).map((g, k) => <polyline key={k} fill="none" stroke={colours[s.obsId]} strokeWidth={2} points={g.join(' ')} />)}
      </g>;
    })}
    {!facet && series.length <= 4 && ends.map(e => <text key={`lab-${e.s.obsId}`} x={x(e.i) + 5} y={e.y + 3} className="fill-current text-[9px]">
      {e.s.label.length > 22 ? `…${e.s.label.slice(-21)}` : e.s.label}</text>)}
    {/* Denominators: molecules measured per position, each observation its own row of bars. */}
    {series.map((s, k) => {
      const rowH = DEN / series.length;
      const top = T + plotH + 4 + k * rowH;
      return <g key={`den-${s.obsId}`}>
        {s.den.map((d, i) => d > 0 ? <rect key={i} x={x(i) - (W - L - R) / n / 2} y={top + rowH * (1 - d / maxDen)} width={Math.max(0.5, (W - L - R) / n - 0.5)}
          height={rowH * d / maxDen} fill={colours[s.obsId]} fillOpacity={0.35} /> : null)}
      </g>;
    })}
    <text x={4} y={T + plotH + 4 + DEN / 2 + 3} className="fill-current text-[8px] opacity-70">n</text>
    {ticksX.map(t => <text key={`${t.at}-${t.label}`} x={t.at} y={H - 6} textAnchor="middle" className="fill-current text-[9px] opacity-70">{t.label}</text>)}
    {hover != null && <g pointerEvents="none">
      <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + plotH + DEN} stroke="currentColor" strokeOpacity={0.3} />
      <rect x={Math.min(W - 170, x(hover) + 6)} y={T} width={164} height={14 + 12 * series.length} rx={4} className="fill-white stroke-gray-300 dark:fill-gray-800 dark:stroke-gray-600" />
      <text x={Math.min(W - 170, x(hover) + 6) + 5} y={T + 11} className="fill-current text-[9px]">x = {xFmt(axisX[hover], result.align)} ({result.xLabel})</text>
      {series.map((s, k) => <text key={s.obsId} x={Math.min(W - 170, x(hover) + 6) + 5} y={T + 23 + 12 * k} className="fill-current text-[9px]">
        {s.label.slice(0, 18)}: {density(s, hover) == null ? '—' : density(s, hover)!.toFixed(2)} ({s.num[hover].toFixed(0)}/{s.den[hover].toFixed(0)})</text>)}
    </g>}
  </svg>;
}

function Pile({ result, colours, sort }: { result: OverlayResult; colours: Record<string, string>; sort: 'length' | 'group' }) {
  const rows = useMemo(() => [...result.pile].sort((a, b) => (sort === 'length' ? b.length - a.length : a.obsId.localeCompare(b.obsId) || b.length - a.length)), [result, sort]);
  const xs = result.x ?? result.series.find(s => s.x)?.x ?? [];
  const lo = result.align === 'scaled' ? -result.flank : (xs[0] ?? 0) - result.binBp / 2;
  const hi = result.align === 'scaled' ? 1 + result.flank : (xs[xs.length - 1] ?? 1) + result.binBp / 2;
  const W = 520, L = 8, R = 8, rowH = rows.length > 200 ? 1.5 : 3;
  const H = Math.max(20, rows.length * rowH + 4);
  const sx = (v: number) => {
    if (result.align !== 'scaled') return L + (v - lo) / (hi - lo) * (W - L - R);
    // scaled: flank bp on each side take a quarter of the width each, the patch the middle half
    const q = (W - L - R) / 4;
    if (v < 0) return L + q * (1 + v / Math.max(1, result.flank));
    if (v <= 1) return L + q + v * 2 * q;
    return L + 3 * q + Math.min(1, (v - 1) / Math.max(1, result.flank)) * q;
  };
  return <figure className="space-y-1">
    <figcaption className="text-[11px] text-ink-secondary">{rows.length} of {result.pileTotal.toLocaleString()} molecule × locus rows (a seeded sample, stable across reloads), sorted by {sort === 'length' ? 'mark length in the patch' : 'observation'}. Grey: measured; colour: the mark.</figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[900px]" role="img" aria-label="Pile of molecules" data-testid="overlay-pile">
      {rows.map((r, i) => <g key={`${r.obsId}-${r.locus}-${r.molecule}-${i}`}>
        {r.measured.map(([a, b], k) => <rect key={`m${k}`} x={sx(a)} y={2 + i * rowH} width={Math.max(0.5, sx(b) - sx(a))} height={rowH * 0.8} fill="currentColor" fillOpacity={0.12} />)}
        {r.marks.map(([a, b], k) => <rect key={`k${k}`} x={sx(a)} y={2 + i * rowH} width={Math.max(0.5, sx(b) - sx(a))} height={rowH * 0.8} fill={colours[r.obsId] ?? '#6250d6'} />)}
      </g>)}
    </svg>
  </figure>;
}

export function OverlayTab({ sets, seed }: { sets: FeatureSet[]; seed?: OverlaySeed | null }) {
  const hub = useBrowserStore(s => s.featureHub);
  const setHub = useBrowserStore(s => s.setFeatureHub);
  const dark = useBrowserStore(s => s.darkMode);
  const panels = useBrowserStore(s => s.panels);
  const datasets = useBrowserStore(s => s.datasets);
  const scans = useHubData(s => s.scans);
  const st = hub.overlay ?? DEFAULT_OVERLAY;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const patch = (p: Partial<OverlayState>) => setHub(h => ({ overlay: { ...(h.overlay ?? DEFAULT_OVERLAY), ...p } }));
  useEffect(() => { if (seed) patch({ loci: seed.loci }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [seed]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const observations = useMemo(() => nucObservations(useBrowserStore.getState() as never, dark), [panels, datasets, dark]);
  const setsWithHits = sets.filter(s => s.source.kind === 'inline' && s.source.hits.length > 0);
  const nucScan = scans.some(s => s.modules.nuc);

  const loci: OverlayLocus[] = useMemo(() => {
    if (st.loci === 'patches') return st.handed ?? [];
    if (st.loci === 'anchors') {
      const a = hub.anchors.find(x => x.id === st.anchorSetId);
      // Placed anchors only; a lifted anchor keeps its source coordinates and haplotype, an insertion anchor its flag.
      return (a?.anchors ?? []).filter(p => !p.frame || p.frame.kind !== 'source' || p.source).map((p, i) => {
        const fr = p.frame?.kind === 'source' ? p.frame : undefined;
        const hap = fr ? (fr.hapLabel ?? fr.hap) : undefined;
        // a lifted anchor: this genome's strand on the axis, its own strand and anchor on its source contig
        const strand = fr ? p.targetStrand : p.strand;
        return { key: `${a!.id}|${i}`, chrom: p.chrom, start: p.start ?? p.pos, end: Math.max(p.end ?? p.pos + 1, (p.start ?? p.pos) + 1), anchor: p.pos,
          ...(strand ? { strand } : {}), label: p.label, hitId: p.hitId, ...(p.insertion ? { insertion: true } : {}), ...(p.paths ? { paths: p.paths } : {}),
          ...(p.source ? { source: { chrom: p.source.chrom, start: p.source.start, end: p.source.end,
            anchor: p.source.anchor ?? Math.floor((p.source.start + p.source.end) / 2), ...(p.strand ? { strand: p.strand } : {}),
            ...(hap ? { hap } : {}), ...(fr?.datasetId ? { datasetId: fr.datasetId } : {}) } } : {}) };
      });
    }
    if (st.loci === 'set') {
      const set = sets.find(s => s.setId === st.setId);
      return (set && set.source.kind === 'inline' ? set.source.hits : []).map(h => locusOfHit(h, set!.setId)).filter((l): l is OverlayLocus => Boolean(l));
    }
    const out: OverlayLocus[] = [];
    for (const sel of hub.selected) {
      const set = sets.find(s => s.setId === sel.setId);
      const hit = set?.source.kind === 'inline' ? set.source.hits.find(h => h.hitId === sel.hitId) : undefined;
      const l = hit ? locusOfHit(hit, sel.setId) : null;
      if (l) out.push(l);
      else if (!sel.frame || sel.frame.kind !== 'source') {
        out.push({ key: `${sel.setId}|${sel.hitId}`, chrom: sel.chrom, start: sel.start, end: Math.max(sel.end, sel.start + 1), anchor: sel.anchor,
          ...(sel.strand ? { strand: sel.strand } : {}), label: sel.label, hitId: sel.hitId, ...pathsOf(sel.graph) });
      } else if (sel.target) {
        // A hit of an assembly scan whose set isn't in view any more: its placement, source and graph carriage.
        const hap = sel.frame.hapLabel ?? sel.frame.hap;
        out.push({ key: `${sel.setId}|${sel.hitId}`, chrom: sel.target.chrom, start: sel.target.start, end: Math.max(sel.target.end, sel.target.start + 1),
          anchor: sel.target.anchor, label: sel.label, hitId: sel.hitId, ...(sel.target.insertion ? { insertion: true } : {}), ...pathsOf(sel.graph),
          ...(sel.targetStrand ? { strand: sel.targetStrand } : {}),
          source: { chrom: sel.chrom, start: sel.start, end: sel.end, anchor: sel.anchor, ...(sel.strand ? { strand: sel.strand } : {}), ...(hap ? { hap } : {}),
            ...(sel.frame.datasetId ? { datasetId: sel.frame.datasetId } : {}) } });
      }
    }
    return out;
  }, [st.loci, st.handed, st.anchorSetId, st.setId, hub.anchors, hub.selected, sets]);

  const run = async () => {
    if (!loci.length) { setNotice('No loci: select hits in the Hits tab, choose a set or an anchor set, or send patches from the Nucleosomes panel.'); return; }
    if (!observations.length) { setNotice('No dataset panel is shown to measure.'); return; }
    setBusy(true); setNotice('');
    // the session and request this overlay belongs to: an import or a newer overlay meanwhile wins
    const born = hubGeneration();
    const seq = ++overlaySeq;
    try {
      const result = await fetchJson<OverlayResult>('/api/hub/overlay', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loci, layer: st.layer, align: st.align, flank: st.flank, observations,
          includeDuplicates: Boolean(useBrowserStore.getState().showDuplicateReads) }) });
      if (born === hubGeneration() && seq === overlaySeq) patch({ result });
    } catch (e) {
      if (born === hubGeneration() && seq === overlaySeq) setNotice(String((e as Error).message ?? e).replace(/^API error \d+: /, ''));
    } finally { setBusy(false); }
  };

  const result = st.result ?? null;
  const colours = useMemo(() => Object.fromEntries((result?.series ?? []).map((s, i) => [s.obsId, seriesColour(observations.find(o => o.obsId === s.obsId), i, dark)])), [result, observations, dark]);
  const shownSeries = (result?.series ?? []).filter(s => !s.error);
  const exportTsv = () => {
    if (!result) return;
    const head = ['x', ...shownSeries.flatMap(s => [`${s.label} marked`, `${s.label} measured`, `${s.label} density`])];
    const xs = result.x ?? shownSeries[0]?.x ?? [];
    const body = xs.map((x, i) => [x, ...shownSeries.flatMap(s => [s.num[i], s.den[i], density(s, i) ?? ''])]);
    downloadTextFile(formatTsv([[`# overlay layer=${result.layer} align=${result.align} flank=${result.flank} bin=${result.binBp} loci=${result.loci}`], head, ...body]),
      `overlay-${result.layer}-${result.align}.tsv`, 'text/tab-separated-values');
  };
  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg) return;
    downloadTextFile(new XMLSerializer().serializeToString(svg), `overlay-${result?.layer}-${result?.align}.svg`, 'image/svg+xml');
  };

  return <div className="space-y-2" data-testid="overlay-tab">
    <section className="space-y-1 rounded-fb border border-line px-2 py-1.5 text-[11px] dark:border-white/10" data-testid="overlay-builder">
      <div className="flex flex-wrap items-center gap-1"><span className="w-14 shrink-0 font-medium">Loci</span>
        <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" value={st.loci} onChange={e => patch({ loci: e.target.value as OverlayState['loci'] })} data-testid="overlay-loci" aria-label="Loci">
          <option value="selection">The hub selection ({hub.selected.length})</option>
          <option value="set" disabled={!setsWithHits.length}>All hits of a set in view</option>
          <option value="anchors" disabled={!hub.anchors.length}>An anchor set</option>
          <option value="patches" disabled={!st.handed?.length}>Sent from the Nucleosomes panel ({st.handed?.length ?? 0})</option>
        </select>
        {st.loci === 'set' && <select className="input-tool min-h-0 min-w-0 flex-1 rounded px-1.5 py-0.5 text-[11px]" value={st.setId ?? ''} onChange={e => patch({ setId: e.target.value })} data-testid="overlay-set" aria-label="Set">
          <option value="">Choose…</option>{setsWithHits.map(s => <option key={s.setId} value={s.setId}>{s.type.plural} ({s.source.kind === 'inline' ? s.source.hits.length : 0} in view)</option>)}
        </select>}
        {st.loci === 'anchors' && <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" value={st.anchorSetId ?? ''} onChange={e => patch({ anchorSetId: e.target.value })} aria-label="Anchor set">
          <option value="">Choose…</option>{hub.anchors.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>}
        <span className="text-ink-muted" data-testid="overlay-loci-count">{loci.length} loci</span>
      </div>
      <div className="flex flex-wrap items-center gap-1"><span className="w-14 shrink-0 font-medium">Layer</span>
        <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" value={st.layer} onChange={e => patch({ layer: e.target.value as OverlayLayer })} data-testid="overlay-layer" aria-label="Layer">
          {OVERLAY_LAYERS.map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
        </select>
        <span className="ml-2 font-medium">Align</span>
        <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" value={st.align} onChange={e => patch({ align: e.target.value as OverlayAlign })} data-testid="overlay-align" aria-label="Align">
          {(Object.keys(ALIGN_LABEL) as OverlayAlign[]).map(a => <option key={a} value={a}>{ALIGN_LABEL[a]}</option>)}
        </select>
        <span className="ml-2">flanks</span>
        <input type="number" min={0} max={20000} step={250} className="input-tool w-20 text-[11px]" value={st.flank} onChange={e => patch({ flank: Math.max(0, Math.min(20000, Number(e.target.value) || 0)) })} data-testid="overlay-flank" aria-label="Flank" /> bp
      </div>
      <div className="text-ink-muted" data-testid="overlay-observations">Measured in: {observations.map(o => o.label).join(' · ') || 'no dataset panel shown'}
        {observations.some(o => o.kind === 'graph') ? ' (graph paths: carriers only)' : ''}</div>
      {!nucScan && <div className="text-amber-800 dark:text-amber-300">Nucleosome layers need nucleosome outputs: Compute in view in the Nucleosomes panel, or Scan… with nuc.</div>}
      <div className="flex items-center gap-2">
        <AnalysisButton theme="indigo" variant="primary" disabled={busy} onClick={() => { void run(); }} data-testid="overlay-run">{busy ? 'Overlaying…' : 'Overlay'}</AnalysisButton>
        {notice && <span role="status" className="text-amber-800 dark:text-amber-300" data-testid="overlay-notice">{notice}</span>}
      </div>
    </section>
    {result && <section className="space-y-1" data-testid="overlay-result" data-series={shownSeries.length}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <strong>{OVERLAY_LAYERS.find(l => l.key === result.layer)?.label}</strong>
        <span className="text-ink-muted">{result.loci} loci · aligned: {ALIGN_LABEL[result.align].toLowerCase()} · flanks {result.flank.toLocaleString()} bp · {result.binBp} bp bins</span>
        <span className="ml-auto flex gap-1">
          {(['profile', 'facets', 'pile'] as const).map(v => <button key={v} type="button" data-testid={`overlay-view-${v}`}
            className={`rounded px-1.5 ${st.view === v ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-100' : 'text-ink-muted hover:underline'}`}
            onClick={() => patch({ view: v })}>{v === 'profile' ? 'Overlaid' : v === 'facets' ? 'Facets' : 'Pile'}</button>)}
          <AnalysisButton onClick={exportTsv} data-testid="overlay-export-tsv">TSV</AnalysisButton>
          <AnalysisButton onClick={exportSvg} disabled={st.view === 'pile'} data-testid="overlay-export-svg">SVG</AnalysisButton>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-[11px]" data-testid="overlay-legend">
        {result.series.map(s => <span key={s.obsId} className="inline-flex items-center gap-1" data-testid="overlay-legend-item">
          <span className="inline-block h-2 w-3 rounded-sm" style={{ background: colours[s.obsId] }} />
          {s.label}: {s.error ? <em className="text-amber-700 dark:text-amber-300">{s.error}</em>
            : <>{s.molecules} molecules over {s.loci} loci{Object.keys(s.lociSkipped ?? {}).length ? ` · left out: ${Object.entries(s.lociSkipped ?? {}).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}` : ''}
              {s.den.length ? ` · up to ${Math.round(Math.max(...s.den))} measured per position` : ''}</>}
        </span>)}
      </div>
      {st.view === 'profile' && <Profile result={result} series={shownSeries} colours={colours} svgRef={svgRef} />}
      {st.view === 'facets' && <div className="grid gap-1" data-testid="overlay-facets">{shownSeries.map((s, i) => <div key={s.obsId}>
        <div className="text-[11px] font-medium" style={{ color: colours[s.obsId] }}>{s.label}</div>
        <Profile result={result} series={[s]} colours={colours} facet svgRef={i === 0 ? svgRef : undefined} />
      </div>)}</div>}
      {st.view === 'pile' && <>
        <label className="text-[11px]">Sort <select className="input-tool min-h-0 rounded px-1 py-0.5 text-[11px]" value={st.pileSort} onChange={e => patch({ pileSort: e.target.value as 'length' | 'group' })}>
          <option value="length">by mark length</option><option value="group">by observation</option></select></label>
        <Pile result={result} colours={colours} sort={st.pileSort} />
      </>}
      <p className="text-[10px] text-ink-muted">Density = molecules with the mark / molecules measured at each position (measured: inside the molecule's decoded segments, outside low-information ones). The bars under the profile are those denominators. x: {result.xLabel}.</p>
      {(result.notes ?? []).map(n => <p key={n} className="text-[11px] text-ink-secondary" data-testid="overlay-note">{n}</p>)}
    </section>}
  </div>;
}
