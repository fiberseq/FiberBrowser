import { fetchJson } from '../../api/sharedFetch';
import type { WorkspaceCalls } from './api';
import { setupHighDpiCanvas } from '../../utils/canvasUtils';
import { usePanOffsetTransform } from '../../hooks/usePanOffsetTransform';
import { DifferenceTable } from './DifferenceTable';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset, PanelConfig } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelDisplayStore } from '../../hooks/usePanelDisplayStore';
import { getDifferences } from '../liveLift/api';
import { useLiveLiftStore } from '../liveLift/store';
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { liftHapLabels } from '../liveLift/types';
import { differenceDescription, differenceGlyph, differenceLanes, MIN_SIZES, nextDifference, stripModel } from '../liveLift/differencesModel';
import { expandDifference, useDifferenceSelection } from '../liveLift/inspectionStore';
import type { DifferencesResponse } from '../liveLift/differenceTypes';
import { useLiveLiftAxis } from '../liveLift/useLiveLiftAxis';
import { DifferencePopover } from '../liveLift/DifferencePopover';
import { CIGAR_COLORS } from '../../components/tracks/read-track/constants';
import { rememberDifferences } from '../liveLift/differenceCache';
const BIN_KINDS = ['snv', 'mnv', 'insertion', 'deletion', 'replacement', 'aligned_bubble', 'inversion', 'no_correspondence'];

export function differenceLanesHeight(panel: PanelConfig, dataset: Dataset) {
  return 24 + differenceLanes(liftHapLabels(dataset.live_lift), panel.liftHap).length * 20;
}
/** This is map evidence, independent of the sampled read cohort and SV view.
 * Abort on every key change, including settings (lift_key) and haplotype. */
export function DifferenceLanes({ panel, dataset, width, gutter = 0, height }: {
  panel: PanelConfig; dataset: Dataset; width: number; gutter?: number; height?: number;
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
  const sources=panel.differenceSources??{assembly:true,reads:false};
  const liftKey = dataset.live_lift?.key ?? '';
  const { axis, viewKey } = useLiveLiftAxis(chrom, start, end, Math.max(1, width - gutter), reversed);
  const lanes = [...(sources.assembly?differenceLanes(liftHapLabels(dataset.live_lift), panel.liftHap):[]),...(sources.reads?['Reads']:[])];
  const [data, setData] = useState<DifferencesResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigation = useRef<AbortController | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [table, setTable] = useState(false);
  usePanOffsetTransform(canvas, { scope: viewKey });
  const query = useMemo(() => ({ datasetId: dataset.id, liftKey, chrom, start, end, liftHap: panel.liftHap,
    minBp }), [dataset.id, liftKey, chrom, start, end, panel.liftHap, minBp, native]);
  useEffect(() => {
    setData(null); setError(''); setBusy(false); navigation.current?.abort();
    if (!enabled || !sources.assembly) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void getDifferences(query, controller.signal).then(r => { if (!controller.signal.aborted) { rememberDifferences(r); setData(r); } })
        .catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); navigation.current?.abort(); };
  }, [query, enabled, sources.assembly]);
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
  const [readItems,setReadItems]=useState<import('../liveLift/differenceTypes').Difference[]>([]);
  const [readScope,setReadScope]=useState('');
  useEffect(()=>{
    setReadItems([]);setReadScope('');if(!sources.reads||!enabled)return;
    const controller=new AbortController();
    const timer=setTimeout(()=>{void fetchJson<WorkspaceCalls>('/api/lift/analysis/summary',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
      body:JSON.stringify({dataset_id:dataset.id,chrom,start:Math.floor(start),end:Math.ceil(end),analysis_scope:'lifted_only'}),
    }).then(r=>{if(controller.signal.aborted)return;
      setReadScope(r.status?`${r.status}: ${r.reason}`:r.scope.search_complete?'Read discovery complete in loaded cohort':'Read discovery partial');
      setReadItems((r.targets??[]).map(({target:t})=>({id:t.target_id,target:t,hap:'',hap_label:'Reads',source:'reads',
        kind:t.ref_end>t.ref_start?(t.alt_bp?'replacement':'deletion'):'insertion',reason:'composed_geometry',t_start:t.ref_start,t_end:t.ref_end,ref_bp:t.ref_end-t.ref_start,alt_bp:t.alt_bp,
        src:{contig:null,start:null,end:null},chain:null,strand:null,grch38:null,alt:null})));
    }).catch(e=>{if(!controller.signal.aborted)setReadScope(String(e.message??e));});},140);
    return()=>{clearTimeout(timer);controller.abort();};
  },[dataset.id,liftKey,chrom,start,end,sources.reads,enabled]);
  const model = useMemo(() => {
    const assembly=sources.assembly&&data?stripModel(data,minBp):{items:[],bins:[]};
    return {bins:assembly.bins,items:[...assembly.items,...readItems.filter(d=>Math.max(d.ref_bp,d.alt_bp)>=minBp)]};
  }, [data,minBp,sources.assembly,readItems]);
  const bandHeight = Math.max(20, (height ?? differenceLanesHeight(panel, dataset)) - 24);
  const laneHeight = bandHeight / Math.max(1, lanes.length);
  useEffect(() => {
    if (!canvas.current) return;
    const ctx = setupHighDpiCanvas(canvas.current, width, bandHeight);
    if (!ctx) return;
    ctx.clearRect(0, 0, width, bandHeight);
    for (let i = 0; i < lanes.length; i++) {
      const hap = lanes[i], y = i*laneHeight;
      ctx.fillStyle = liveLiftHaplotypeColor(hap, dark); ctx.strokeStyle = ctx.fillStyle;
      ctx.font = '9px sans-serif'; ctx.fillText(hap, gutter+2, y+10);
      for (const b of model.bins.filter(b => b.hap_label === hap)) {
        ctx.globalAlpha = Math.min(.95, .2+Math.log2(b.count+1)*.15);
        for (const span of axis.spans(Math.max(start, b.start), Math.min(end, b.end)))
          ctx.fillRect(gutter+span.x, y+BIN_KINDS.indexOf(b.kind)*Math.max(1,laneHeight/10), Math.max(1, span.w), 2);
      }
      ctx.globalAlpha = 1;
      for (const d of model.items.filter(d => d.hap_label === hap)) {
        const g = differenceGlyph(d), x = gutter+axis.toX(d.t_start), z = gutter+axis.toX(d.t_end);
        const left = Math.min(x,z), w = Math.max(3,Math.abs(z-x));
        ctx.beginPath();
        if (g.shape === 'wedge') { ctx.moveTo(x-4,y+2); ctx.lineTo(x+4,y+2); ctx.lineTo(x,y+laneHeight-3); ctx.closePath(); ctx.fill(); }
        else if (g.shape === 'bracket') { ctx.moveTo(left,y+laneHeight-3); ctx.lineTo(left,y+4); ctx.lineTo(left+w,y+4); ctx.lineTo(left+w,y+laneHeight-3); ctx.stroke(); }
        else { for (const span of axis.spans(d.t_start, Math.max(d.t_start+1,d.t_end))) ctx.fillRect(gutter+span.x,y+3,Math.max(2,span.w),Math.max(2,laneHeight-6)); }
      }
    }
  }, [axis, width, bandHeight, laneHeight, model, lanes.join(','), gutter, dark, start, end]);
  if (!enabled) return null;
  const inspect = (d: import('../liveLift/differenceTypes').Difference) => useDifferenceSelection.getState().select({
    panelId: panel.id, datasetId: dataset.id, viewKey, chrom, difference: d, target:d.target });
  return <div ref={anchor} data-testid="live-lift-diff-strip" data-panel-id={panel.id}
    className="relative text-[10px] bg-slate-50 dark:bg-slate-900" style={{ height: height ?? differenceLanesHeight(panel, dataset), width }}>
    <div className="flex gap-2 items-center h-6 px-2">
      <strong>Differences</strong>
      {(['assembly','reads'] as const).map(source=><label key={source}><input type="checkbox" checked={sources[source]} onChange={e=>useBrowserStore.setState(s=>({panels:s.panels.map(p=>p.id===panel.id?{...p,differenceSources:{...sources,[source]:e.target.checked}}:p)}))}/>{source}</label>)}
      <button data-testid="live-lift-diff-prev" disabled={busy} onClick={() => void navigate(-1)}>◀</button>
      <button data-testid="live-lift-diff-next" disabled={busy} onClick={() => void navigate(1)}>▶</button>
      <select aria-label="Minimum difference size" value={minBp} onChange={e => useBrowserStore.setState(s => ({
        panels: s.panels.map(p => p.id === panel.id ? { ...p, liveLiftMinBp: Number(e.target.value) } : p),
      }))}>{MIN_SIZES.map(n => <option key={n} value={n}>{n ? `≥${n} bp` : 'All sizes'}</option>)}</select>
      <button aria-expanded={table} onClick={() => setTable(t => !t)}>Table</button>
      <span role={error ? 'status' : undefined}>{error || (busy ? 'Finding difference…' : readScope || (data ? data.mode==='bins'?'Density; zoom for individual differences':'Click a difference to inspect it · map discovery':'Loading…'))}</span>
    </div>
    <canvas ref={canvas} width={width} height={bandHeight} aria-label="Assembly differences" />
    {model.items.map(d => {
      const x=axis.toX(d.t_start), z=axis.toX(d.t_end), i=lanes.indexOf(d.hap_label);
      return <button key={d.id} data-testid="live-lift-diff-item" data-kind={d.kind} data-difference-id={d.id}
        aria-label={differenceDescription(d, chrom)} title={differenceDescription(d, chrom)}
        // Above the row's resize grip (z-20), which would otherwise take clicks on the bottom lane.
        className="absolute z-30 cursor-pointer bg-transparent focus:ring-1 focus:ring-violet-500"
        style={{ left: gutter+Math.min(x,z)-4, top:24+i*laneHeight, width:Math.max(9,Math.abs(z-x)+8), height:laneHeight }}
        // A click opens the inspector; Shift/⌘/Ctrl-click only selects (the guide line, no inspector).
        onClick={e => e.shiftKey || e.metaKey || e.ctrlKey
          ? useDifferenceSelection.getState().select({panelId:panel.id,datasetId:dataset.id,viewKey,chrom,difference:d,target:d.target,inspect:false})
          : inspect(d)}
        onKeyDown={e => { if(e.key==='Enter') inspect(d); }} />;
    })}
    {table && <div className="absolute left-0 right-0 top-full z-40 bg-white dark:bg-slate-900 max-h-64 overflow-auto border p-2"><DifferenceTable items={model.items} chrom={chrom} inspect={inspect} /></div>}
    <DifferencePopover panel={panel} dataset={dataset} anchor={anchor} />
  </div>;
}
