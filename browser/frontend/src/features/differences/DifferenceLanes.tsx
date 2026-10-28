import { fetchJson, waitForReadRequests } from '../../api/sharedFetch';
import type { WorkspaceCalls } from './api';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { usePanOffsetTransform } from '../../hooks/usePanOffsetTransform';
import { DifferenceTable } from './DifferenceTable';
import { compareWithAssembly, comparisonFor, comparisonKey, LABEL_MARK, useComparisonStore, type ComparisonResponse } from './comparison';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset, PanelConfig } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelDisplayStore } from '../../hooks/usePanelDisplayStore';
import { getDifferences } from '../liveLift/api';
import { useLiveLiftStore } from '../liveLift/store';
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { liftHapLabels } from '../liveLift/types';
import { differenceDescription, differenceGlyph, differenceLanes, MIN_SIZES, nextDifference, stripModel } from '../liveLift/differencesModel';
import { useDifferenceSelection, type DifferenceSelection } from '../liveLift/inspectionStore';
import { clickDifference, differenceHint, differenceMenuEntries, runDifferenceMenuAction } from './differenceActions';
import { analysisMinMapq, READ_BADGE_MODES, readBadgeMode, setDifferenceRowOptions, setReadBadgeMode } from './displayOptions';
import { useTrackMenuStore } from '../../stores/trackMenuStore';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import type { ContextMenuEntry } from '../../components/tracks/read-track/ReadContextMenu';
import type { DifferencesResponse } from '../liveLift/differenceTypes';
import { useLiveLiftAxis } from '../liveLift/useLiveLiftAxis';
import { DifferencePopover } from '../liveLift/DifferencePopover';
import { CIGAR_COLORS } from '../../components/tracks/read-track/constants';
import { rememberDifferences } from '../liveLift/differenceCache';
const BIN_KINDS = ['snv', 'mnv', 'insertion', 'deletion', 'replacement', 'aligned_bubble', 'inversion', 'no_correspondence'];

export function differenceLanesHeight(panel: PanelConfig, dataset: Dataset) {
  const sources = panel.differenceSources ?? { assembly: true, reads: false };
  const lanes = (sources.assembly ? differenceLanes(liftHapLabels(dataset.live_lift), panel.liftHap).length : 0) + (sources.reads ? 1 : 0);
  return 24 + Math.max(1, lanes) * 20;
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
  const badges = useBrowserStore(s => readBadgeMode(s));
  const minMapq = useBrowserStore(s => analysisMinMapq(s));
  const readsInView = useTrackFeedStore(s => s.byStateKey[panel.stateKey ?? panel.datasetId ?? '']?.reads?.length ?? 0);
  usePanOffsetTransform(canvas, { scope: viewKey });
  const query = useMemo(() => ({ datasetId: dataset.id, liftKey, chrom, start, end, liftHap: panel.liftHap,
    minBp }), [dataset.id, liftKey, chrom, start, end, panel.liftHap, minBp, native]);
  useEffect(() => {
    setData(null); setError(''); setBusy(false); navigation.current?.abort();
    if (!enabled || !sources.assembly) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      // Map queries contend with read projection. Keep the pan debounce, then
      // yield to visible reads through body decode, without delaying any panel's draw.
      await waitForReadRequests(controller.signal);
      if (controller.signal.aborted) return;
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
      // A jump to the next difference: Back (Alt+←) returns to where the view was.
      st.recordJump(panel.viewportOverride ? panel.id : null, { likePan: true, to: { chrom, start: lo, end: lo + size } });
      if (panel.viewportOverride) st.setPanelViewport(panel.id, lo, lo + size);
      else st.setViewport(chrom, lo, lo + size);
    } catch (e) { if (!controller.signal.aborted) setError(String((e as Error).message)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const [readItems,setReadItems]=useState<import('../liveLift/differenceTypes').Difference[]>([]);
  const [readScope,setReadScope]=useState('');
  const [readComplete,setReadComplete]=useState(false);
  useEffect(()=>{
    setReadItems([]);setReadScope('');setReadComplete(false);if(!sources.reads||!enabled)return;
    const controller=new AbortController();
    const timer=setTimeout(()=>{void fetchJson<WorkspaceCalls>('/api/lift/analysis/summary',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
      body:JSON.stringify({dataset_id:dataset.id,chrom,start:Math.floor(start),end:Math.ceil(end),analysis_scope:'lifted_only',
        projection_policy:{min_mapq:analysisMinMapq(useBrowserStore.getState())}}),
    }).then(r=>{if(controller.signal.aborted)return;
      setReadScope(r.status?`${r.status}: ${r.reason}`:r.scope.search_complete?'Read discovery complete in loaded cohort':'Read discovery partial');
      setReadComplete(!r.status&&Boolean(r.scope.search_complete));
      setReadItems((r.targets??[]).map(({target:t})=>({id:t.target_id,target:t,hap:'',hap_label:'Reads',source:'reads',
        kind:t.ref_end>t.ref_start?(t.alt_bp?'replacement':'deletion'):'insertion',reason:'composed_geometry',t_start:t.ref_start,t_end:t.ref_end,ref_bp:t.ref_end-t.ref_start,alt_bp:t.alt_bp,
        src:{contig:null,start:null,end:null},chain:null,strand:null,grch38:null,alt:null})));
    }).catch(e=>{if(!controller.signal.aborted)setReadScope(String(e.message??e));});},140);
    return()=>{clearTimeout(timer);controller.abort();};
  },[dataset.id,liftKey,chrom,start,end,sources.reads,enabled,minMapq]);
  // Assembly comparison of the read lane (labels, typed links, novelty; the ledger is saved with the session).
  const [comparison,setComparison]=useState<ComparisonResponse|null>(null);
  useEffect(()=>{
    setComparison(null);
    if(!enabled||!sources.assembly||!sources.reads||!data||data.mode!=='items'||!readItems.length||end-start>2_000_000)return;
    const controller=new AbortController();
    const timer=setTimeout(()=>{void compareWithAssembly({dataset_id:dataset.id,chrom,start,end,
      reads:readItems.slice(0,256).map(d=>({id:d.id,ref_start:d.t_start,ref_end:d.t_end,alt_bp:d.alt_bp,
        geometry_members:(d.target as {geometry_members?:{ref_start:number;ref_end:number;alt_bp:number}[]}|undefined)?.geometry_members?.map(m=>[m.ref_start,m.ref_end,m.alt_bp])})),
      read_scope:{search_complete:readComplete,dataset_id:dataset.id,analysis_scope:'lifted_only'}},controller.signal)
      .then(r=>{if(controller.signal.aborted||r.status)return;useComparisonStore.getState().put(comparisonKey(dataset.id,chrom,`row:${panel.id}`),r);setComparison(r);})
      .catch(()=>{});},200);
    return()=>{clearTimeout(timer);controller.abort();};
  },[enabled,sources.assembly,sources.reads,data,readItems,readComplete,dataset.id,chrom,start,end,panel.id]);
  // Labels come from the newest comparison covering each read difference (the row's, or an inspector's consensus).
  const byKey = useComparisonStore(s => s.byKey);
  const readLabel = (d: import('../liveLift/differenceTypes').Difference) => d.source === 'reads' ? comparisonFor(byKey, `${dataset.id}|${chrom}|`, d) : null;
  const model = useMemo(() => {
    const assembly=sources.assembly&&data?stripModel(data,minBp):{items:[],bins:[]};
    return {bins:assembly.bins,items:[...assembly.items,...readItems.filter(d=>Math.max(d.ref_bp,d.alt_bp)>=minBp)]};
  }, [data,minBp,sources.assembly,readItems]);
  const bandHeight = Math.max(20, (height ?? differenceLanesHeight(panel, dataset)) - 24);
  const laneHeight = bandHeight / Math.max(1, lanes.length);
  // Export raises the canvas render scale and waits for every canvas to draw at it.
  const canvasRenderVersion = useCanvasRenderVersion();
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
        const entry = readLabel(d);
        const mark = entry?.kind === 'reads' ? LABEL_MARK[entry.value.label] : undefined;
        if (mark) { ctx.save(); ctx.font='bold 10px sans-serif'; ctx.fillStyle=dark?'#e2e8f0':'#0f172a'; ctx.fillText(mark, Math.max(left,x)+5, y+10); ctx.restore(); }
      }
    }
  }, [axis, width, bandHeight, laneHeight, model, lanes.join(','), gutter, dark, start, end, comparison, byKey, canvasRenderVersion]);
  if (!enabled) return null;
  const statusText = error || (busy ? 'Finding difference…' : readScope || (data ? data.mode === 'bins'
    ? 'Density; zoom for individual differences' : 'Click a difference to expand or highlight it; ⌘-click to inspect' : 'Loading…'));
  const selectionOf = (d: import('../liveLift/differenceTypes').Difference): DifferenceSelection => ({
    panelId: panel.id, datasetId: dataset.id, viewKey, chrom, difference: d, target: d.target });
  const inspect = (d: import('../liveLift/differenceTypes').Difference) => useDifferenceSelection.getState().select(selectionOf(d));
  // The row's right-click menu: the difference's actions (on a marker), then the row's options.
  const openMenu = (e: React.MouseEvent, d?: import('../liveLift/differenceTypes').Difference) => {
    e.preventDefault(); e.stopPropagation();
    const check = (on: boolean) => (on ? '✓ ' : '\u2003');
    const own: ContextMenuEntry[] = [
      ...(d ? [...differenceMenuEntries(selectionOf(d)), { kind: 'separator' as const }] : []),
      { kind: 'heading', label: 'Differences row' },
      { kind: 'item', action: 'opt:assembly', label: `${check(sources.assembly)}Assembly differences (the map)`, icon: 'layers' },
      { kind: 'item', action: 'opt:reads', label: `${check(sources.reads)}Read-supported edits`, icon: 'reads' },
      { kind: 'submenu', id: 'diff-min', label: `Minimum size: ${minBp ? `≥${minBp} bp` : 'all'}`, icon: 'search',
        entries: MIN_SIZES.map(n => ({ kind: 'item' as const, action: `opt:min:${n}`, label: `${check(minBp === n)}${n ? `≥${n} bp` : 'All sizes'}`, icon: 'search' })) },
      { kind: 'item', action: 'opt:table', label: table ? 'Hide the table' : 'Show the table', icon: 'layers' },
      { kind: 'submenu', id: 'diff-badges', label: `Insertions on reads: ${READ_BADGE_MODES.find(m => m.mode === badges)!.label.toLowerCase()}`, icon: 'reads',
        entries: READ_BADGE_MODES.map(m => ({ kind: 'item' as const, action: `opt:badges:${m.mode}`, label: `${check(badges === m.mode)}${m.label}`, icon: 'reads', title: m.title })) },
      { kind: 'item', action: 'opt:settings', label: 'Live-lift settings…', icon: 'settings' },
    ];
    useTrackMenuStore.getState().openMenu({ panelId: panel.id, type: 'sv', x: e.clientX, y: e.clientY, own, title: 'Differences',
      onOwn: action => {
        if (d && action.startsWith('diff:')) { void runDifferenceMenuAction(action, selectionOf(d), readsInView); return; }
        if (action === 'opt:assembly' || action === 'opt:reads') {
          const key = action === 'opt:assembly' ? 'assembly' : 'reads';
          setDifferenceRowOptions(panel.id, { sources: { ...sources, [key]: !sources[key] } });
        } else if (action.startsWith('opt:min:')) setDifferenceRowOptions(panel.id, { minBp: Number(action.slice(8)) });
        else if (action === 'opt:table') setTable(t => !t);
        else if (action.startsWith('opt:badges:')) setReadBadgeMode(action.slice(11) as typeof badges);
        else if (action === 'opt:settings') void import('../liveLift/LiveLiftSettingsDialog').then(m => m.useLiftSettingsDialog.getState().open(dataset.id));
      } });
  };
  return <div ref={anchor} data-testid="live-lift-diff-strip" data-panel-id={panel.id}
    className="relative text-[10px] bg-slate-50 dark:bg-slate-900" style={{ height: height ?? differenceLanesHeight(panel, dataset), width }}
    onContextMenu={e => openMenu(e)}>
    {/* Like FiberBrowser's other rows: a compact label and the prev/next arrows; the options (sources, size, table,
        insertions on reads) are in its right-click menu and the Live-lift settings. */}
    <div className="flex gap-1 items-center h-6 px-2 whitespace-nowrap overflow-hidden" data-testid="live-lift-diff-header">
      <span className="flex-shrink-0 font-semibold text-slate-600 dark:text-slate-300" data-testid="live-lift-diff-label"
        title={`Differences between ${panel.liftHap ?? 'the haplotypes'} and this genome. ${statusText}. Right-click for sources, size, table and insertions on reads.`}>
        Differences</span>
      <button className="flex-shrink-0 px-0.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100" data-testid="live-lift-diff-prev" disabled={busy}
        title="Previous difference" aria-label="Previous difference" onClick={() => void navigate(-1)}>◀</button>
      <button className="flex-shrink-0 px-0.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100" data-testid="live-lift-diff-next" disabled={busy}
        title="Next difference" aria-label="Next difference" onClick={() => void navigate(1)}>▶</button>
      {(error || busy) && <span className="min-w-0 truncate text-slate-500 dark:text-slate-400" role={error ? 'status' : undefined} title={statusText}>{statusText}</span>}
    </div>
    <canvas ref={canvas} width={width} height={bandHeight} aria-label="Assembly differences" />
    {model.items.map(d => {
      // An expanded insertion's marker covers its column (a click there collapses it).
      const block = axis.blocks.find(b => b.ins.ins_id === d.id || b.ins.alleles?.some(a => a.ins_id === d.id));
      const x = block ? block.x0 : axis.toX(d.t_start), z = block ? block.x1 : axis.toX(d.t_end), i = lanes.indexOf(d.hap_label);
      const found = readLabel(d);
      const label = found?.kind === 'reads' ? found.value : undefined;
      return <button key={d.id} data-testid="live-lift-diff-item" data-kind={d.kind} data-difference-id={d.id}
        data-assembly-label={label?.label}
        aria-label={differenceDescription(d, chrom)} title={`${differenceDescription(d, chrom)}${label ? `\n${label.label_text}` : ''}\n${differenceHint(d)}`}
        // Above the row's resize grip (z-20), which would otherwise take clicks on the bottom lane.
        className="absolute z-30 cursor-pointer bg-transparent focus:ring-1 focus:ring-violet-500"
        // Close marks overlap (each is at least 9 px wide): a larger difference sits on top, so a 1 bp SNV next to a
        // 2 kb insertion never takes the insertion's clicks (z 31-39, under the table's z-40; tab order unchanged).
        style={{ left: gutter+Math.min(x,z)-4, top:24+i*laneHeight, width:Math.max(9,Math.abs(z-x)+8), height:laneHeight,
          zIndex: 30 + Math.min(9, Math.max(1, Math.round(Math.log2(1 + Math.max(d.ref_bp, d.alt_bp)) / 2))) }}
        // Click: expand an insertion / highlight carriers; Shift: select; ⌘/Ctrl or right-click: inspect (differenceActions).
        onClick={e => clickDifference(e, selectionOf(d), readsInView)}
        onContextMenu={e => openMenu(e, d)}
        // Enter inspects; preventDefault stops the button's own synthetic click (which would close it again or expand).
        onKeyDown={e => { if(e.key==='Enter') { e.preventDefault(); e.stopPropagation(); inspect(d); } }} />;
    })}
    {table && <div className="absolute left-0 right-0 top-full z-40 bg-white dark:bg-slate-900 max-h-64 overflow-auto border p-2"><DifferenceTable items={model.items} chrom={chrom} inspect={inspect} comparison={comparison}
      readText={d => { const e = readLabel(d); return e?.kind === 'reads' ? e.value.label_text : undefined; }} /></div>}
    <DifferencePopover panel={panel} dataset={dataset} anchor={anchor} />
  </div>;
}
