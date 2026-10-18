import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset, PanelConfig } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelDisplayStore } from '../../hooks/usePanelDisplayStore';
import { getDifferences } from './api';
import { useLiveLiftStore } from './store';
import { liveLiftHaplotypeColor } from './palette';
import { liftHapLabels } from './types';
import { differenceDescription, differenceGlyph, differenceLanes, MIN_SIZES, nextDifference, stripModel } from './differencesModel';
import { expandDifference, useDifferenceSelection } from './inspectionStore';
import type { DifferencesResponse } from './differenceTypes';
import { useLiveLiftAxis } from './useLiveLiftAxis';
import { DifferencePopover } from './DifferencePopover';
import { CIGAR_COLORS } from '../../components/tracks/read-track/constants';
import { rememberDifferences } from './differenceCache';
const BIN_KINDS = ['snv', 'mnv', 'insertion', 'deletion', 'replacement', 'aligned_bubble', 'inversion', 'no_correspondence'];

export function differencesStripHeight(panel: PanelConfig, dataset: Dataset) {
  return 24 + differenceLanes(liftHapLabels(dataset.live_lift), panel.liftHap).length * 20;
}
/** This is map evidence, independent of the sampled read cohort and SV view.
 * Abort on every key change, including settings (lift_key) and haplotype. */
export function DifferencesStrip({ panel, dataset, width, gutter = 0 }: {
  panel: PanelConfig; dataset: Dataset; width: number; gutter?: number;
}) {
  const enabled = useLiveLiftStore(s => s.enabled);
  const chrom = useBrowserStore(s => panel.viewportOverride?.chrom ?? s.chrom);
  const start = useBrowserStore(s => panel.viewportOverride?.start ?? s.start);
  const end = useBrowserStore(s => panel.viewportOverride?.end ?? s.end);
  const dark = useBrowserStore(s => s.darkMode);
  const reversed = usePanelDisplayStore(s => s.isReversed);
  const native = useBrowserStore(s => s.panels.filter(p => !p.genome && p.datasetId).map(p => s.datasets.find(d => d.id === p.datasetId))
    .find(d => d?.data_type === 'bam')?.id);
  const minBp = panel.liveLiftMinBp ?? 0;
  const liftKey = dataset.live_lift?.key ?? '';
  const { axis, viewKey } = useLiveLiftAxis(chrom, start, end, Math.max(1, width - gutter), reversed);
  const lanes = differenceLanes(liftHapLabels(dataset.live_lift), panel.liftHap);
  const [data, setData] = useState<DifferencesResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigation = useRef<AbortController | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const query = useMemo(() => ({ datasetId: dataset.id, liftKey, chrom, start, end, liftHap: panel.liftHap,
    minBp, nativeDatasetId: native }), [dataset.id, liftKey, chrom, start, end, panel.liftHap, minBp, native]);
  useEffect(() => {
    setData(null); setError(''); setBusy(false); navigation.current?.abort();
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void getDifferences(query, controller.signal).then(r => { if (!controller.signal.aborted) { rememberDifferences(r); setData(r); } })
        .catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); navigation.current?.abort(); };
  }, [query, enabled]);
  const navigate = async (direction: -1 | 1) => {
    navigation.current?.abort();
    const controller = new AbortController(); navigation.current = controller;
    setBusy(true); setError('');
    try {
      let found = nextDifference(data?.items ?? [], start, end, direction, minBp);
      let edge = direction > 0 ? end : start;
      const chromEnd = useBrowserStore.getState().chroms.find(c => c.name === chrom)?.size ?? 300_000_000;
      // Fetch map-only geometry ahead. Force detail so the minimum-size filter
      // also works for SNVs in a wide search window; never open native BAMs here.
      for (let span = Math.max(10_000, end - start); !found && edge >= 0 && edge < chromEnd; span = Math.min(4_000_000, span * 4)) {
        const lo = direction > 0 ? edge : Math.max(0, edge - span);
        const hi = direction > 0 ? Math.min(chromEnd, edge + span) : edge;
        if (hi <= lo) break;
        const ahead = await getDifferences({ ...query, start: lo, end: hi, nativeDatasetId: undefined, detailBp: hi - lo + 1 }, controller.signal);
        if (controller.signal.aborted) return;
        found = nextDifference(ahead.items, start, end, direction, minBp);
        edge = direction > 0 ? hi : lo;
        if (lo === 0 && direction < 0) break;
      }
      if (!found) { setError('No further difference on this chromosome.'); return; }
      const size = end - start;
      const lo = Math.max(0, Math.round((found.t_start + found.t_end - size) / 2));
      const st = useBrowserStore.getState();
      if (panel.viewportOverride) st.setPanelViewport(panel.id, lo, lo + size);
      else st.setViewport(chrom, lo, lo + size);
    } catch (e) { if (!controller.signal.aborted) setError(String((e as Error).message)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  if (!enabled) return null;
  const model = data ? stripModel(data, minBp) : { items: [], bins: [] };
  return <div ref={anchor} data-testid="live-lift-diff-strip" data-panel-id={panel.id}
    className="relative border-b border-slate-300 bg-slate-50 dark:bg-slate-900 dark:border-slate-700 text-[10px]" style={{ height: differencesStripHeight(panel, dataset), width }}>
    <div className="flex items-center gap-2 h-6 px-2">
      <strong className="text-slate-700 dark:text-slate-200">Differences vs GRCh38</strong>
      <button data-testid="live-lift-diff-prev" title="Previous difference beyond the view" disabled={busy} onClick={() => void navigate(-1)}>◀</button>
      <button data-testid="live-lift-diff-next" title="Next difference beyond the view" disabled={busy} onClick={() => void navigate(1)}>▶</button>
      <select aria-label="Minimum difference size" value={minBp} onChange={e => useBrowserStore.setState(s => ({
        panels: s.panels.map(p => p.id === panel.id ? { ...p, liveLiftMinBp: Number(e.target.value) } : p),
      }))} className="bg-transparent">
        {MIN_SIZES.map(n => <option key={n} value={n}>{n === 0 ? 'All sizes' : n === 1000 ? '≥1 kb' : `≥${n} bp`}</option>)}
      </select>
      <span className="truncate text-slate-500" role={error ? 'status' : undefined}>{error || (busy ? 'Finding difference…' : data ? data.mode === 'bins' ? 'Density per kind' : 'Click to inspect · insertions open in place' : 'Loading…')}</span>
    </div>
    <svg width={width} height={lanes.length * 20} className="block" aria-label="Assembly differences">
      <defs><pattern id={`hatch-${panel.id}`} width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 5L5 0" stroke="currentColor" strokeWidth="1" /></pattern></defs>
      {lanes.map((hap, i) => <g key={hap} transform={`translate(${gutter},${i * 20})`} style={{ color: liveLiftHaplotypeColor(hap, dark) }}>
        <line x1="0" x2={width - gutter} y1="17" y2="17" stroke="currentColor" opacity=".15" />
        <text x="2" y="12" fontSize="9" fill="currentColor">{hap}</text>
        {model.bins.filter(b => b.hap_label === hap).map((b, j) => axis.spans(Math.max(start, b.start), Math.min(end, b.end)).map((span, k) => <rect key={`${j}-${k}`} x={span.x} y={1 + BIN_KINDS.indexOf(b.kind) * 2}
          width={Math.max(1, span.w)} height="2" fill="currentColor" opacity={Math.min(.95, .2 + Math.log2(b.count + 1) * .15)}>
          <title>{`${hap} · ${b.kind.replace(/_/g, ' ')} · ${b.count} differences · ${b.bp.toLocaleString()} bp`}</title></rect>))}
        {model.items.filter(d => d.hap_label === hap).map(d => {
          const g = differenceGlyph(d), x = axis.toX(d.t_start), z = axis.toX(d.t_end);
          const left = Math.min(x, z), w = Math.max(3, Math.abs(z - x));
          const base = (d.alt ?? d.grch38)?.[0];
          const color = g.shape === 'tick' && base ? CIGAR_COLORS[base as keyof typeof CIGAR_COLORS] ?? 'currentColor' : d.kind === 'no_correspondence' ? '#94a3b8' : 'currentColor';
          return <g key={d.id} data-testid="live-lift-diff-item" data-kind={d.kind} data-difference-id={d.id} role="button" tabIndex={0} aria-label={differenceDescription(d, chrom)}
            className="cursor-pointer" onClick={() => {
              const selection = { panelId: panel.id, datasetId: dataset.id, viewKey, chrom, difference: d };
              useDifferenceSelection.getState().select(selection); if (d.kind === 'insertion') expandDifference(selection);
            }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.currentTarget.dispatchEvent(new MouseEvent('click', { bubbles: true })); }}>
            <title>{differenceDescription(d, chrom)}</title>
            <rect x={left - 4} y="0" width={Math.max(9, w + 8)} height="20" fill="transparent" />
            {g.shape === 'wedge' ? <path d={`M${x - g.width / 2} 2H${x + g.width / 2}L${x} 15Z`} fill={color} />
              : g.shape === 'bracket' ? <path d={`M${left} 14V5H${left + w}V14`} stroke={color} fill="none" strokeWidth="2" />
              : g.shape === 'chevron' ? <><rect x={left} y="5" width={w} height="7" fill={color} opacity=".35" /><text x={left + w / 2} y="12" fill={color} textAnchor="middle">❮❮</text></>
              : g.shape === 'hatch' ? <rect x={left} y="3" width={w} height="12" fill={`url(#hatch-${panel.id})`} stroke={color} />
              : <rect x={left} y="2" width={w} height="13" fill={color} />}
            {g.label && <text x={x + g.width / 2 + 2} y="12" fontSize="10" fill="currentColor">{g.label}</text>}
          </g>;
        })}
      </g>)}
      {(data?.novel ?? []).map((d, i) => <path key={i} d={`M${gutter + axis.toX(d.ref)} 1v12`} stroke="#9333ea" strokeDasharray="2 2"><title>{`Read-only ${d.t === 'I' ? 'insertion' : 'deletion'} · ${d.len} bp · ${d.support ?? '?'} native reads`}</title></path>)}
    </svg>
    <DifferencePopover panel={panel} dataset={dataset} anchor={anchor} />
  </div>;
}
