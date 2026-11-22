/**
 * Quantify a window: the compact header (Measure(s) × Bounds × Comparison, plus the reference group, in the Plots
 * builder's pattern), the options (every method choice a parameter with a default), the result (QuantResultView),
 * Keep / Open in Plots, and the link back to the reads (a bar or row → those reads as the panel's filter, with a chip
 * that undoes it in one click).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { PrereqButton } from '../plots/prereqActions';
import { useWindowQuant } from './useWindowQuant';
import { liftedLeftOutNotice } from '../plots/usePlotTargets';
import { QuantResultView } from './QuantResultView';
import { keepQuant, openQuantInPlots, type QuantCardInput } from './quantPlots';
import { boundsText, isMetaChrom, relText, windowGenomic, type QuantSpec } from './spec';
import { AxisFrameControl, SelectWindowButton, useAxisAnchor } from './AxisControls';
import { genomicToRelative } from './axisFrame';
import { axisLabelOf, measureColor, measuresLine } from './labels';
import { useLayerColorVersion } from '../layerColours/state';
import type { MeasureDef } from './measures';
import type { ReadFilterSource } from '../../stores/clusterSlice';

const sel = 'input-tool min-h-0 py-0.5 text-[11px]';
const btn = 'rounded border border-gray-200 px-1.5 py-0.5 text-[11px] hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800';

/** The window's start and end, typed in the axis's frame (bp from the anchor on a relative axis, genome bp
 *  otherwise), its length and Clear: the cluster profiles' window bar and the metaprofile row's own small bar. */
export function WindowFields({ view, compact = false, testId = 'quant-window-fields' }: { view: { chrom: string; start: number; end: number }; compact?: boolean; testId?: string }) {
  const win = useBrowserStore(s => s.windowQuant?.window ?? null);
  const setWindow = useBrowserStore(s => s.setQuantWindow);
  const { frame, anchor, reason } = useAxisAnchor(view);
  const relAxis = frame.mode === 'relative';
  const rel = relAxis && !!anchor;
  const g = windowGenomic(win, view.chrom, anchor);
  // What the inputs show: bp from the anchor on a relative axis, genome bp otherwise.
  const shownWin = g ? (rel ? genomicToRelative(g[0], g[1], anchor!) : g) : null;
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const num = (t: string) => Number(t.replace(/,/g, '').replace(/[−–]/g, '-').replace(/^\+/, ''));
  /** One edge typed: commit with the other (typed, or the current window's) when the pair is a window; a start past
   *  the current end (or an end before its start) waits for the other edge to be typed. On a relative axis whose
   *  anchor does not resolve here nothing is stored (the numbers would be read as genome positions). */
  const edge = (a: string, b: string, cur: [number, number] | null): boolean => {
    if (relAxis && !anchor) return false;
    const x = a ? num(a) : cur?.[0], y = b ? num(b) : cur?.[1];
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y) || !(y > x)) return false;
    setWindow(rel ? { chrom: view.chrom, from: Math.round(x), to: Math.round(y), relative: true } : { chrom: view.chrom, from: Math.round(x), to: Math.round(y) });
    return true;
  };
  const fmt = (v: number) => (rel && v > 0 ? `+${v.toLocaleString('en-US')}` : v.toLocaleString('en-US'));
  const w = compact ? 'w-20' : 'w-24';
  const text = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${text}`} data-testid={testId} data-relative={win?.relative ? 'true' : 'false'}>
      <span className="font-medium">Window{rel ? ` (bp from the ${anchor!.name})` : relAxis ? '' : ' (genome bp)'}</span>
      <input aria-label="Window start" data-testid="quant-window-from" className={`${sel} ${w}`} placeholder={shownWin ? fmt(shownWin[0]) : rel ? 'e.g. -200' : 'start'}
        disabled={relAxis && !anchor} value={from} onChange={e => setFrom(e.target.value)}
        onBlur={() => { if (from && edge(from, to, shownWin)) { setFrom(''); setTo(''); } }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setFrom(''); (e.target as HTMLInputElement).blur(); } }} />
      <span>–</span>
      <input aria-label="Window end" data-testid="quant-window-to" className={`${sel} ${w}`} placeholder={shownWin ? fmt(shownWin[1]) : rel ? 'e.g. +50' : 'end'}
        disabled={relAxis && !anchor} value={to} onChange={e => setTo(e.target.value)}
        onBlur={() => { if (to && edge(from, to, shownWin)) { setFrom(''); setTo(''); } }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setTo(''); (e.target as HTMLInputElement).blur(); } }} />
      {relAxis && !anchor ? <span className="text-amber-800 dark:text-amber-200" role="status" data-testid="quant-window-no-anchor">{reason ?? 'The anchor does not resolve here'}: pick an anchor to type a relative window</span>
        : g ? <span className="text-ink-muted" data-testid="quant-window-text">{(g[1] - g[0]).toLocaleString('en-US')} bp{win?.relative && anchor ? ` · ${relText(win.from, win.to)} from the ${anchor.name}` : ''}</span>
          : win ? <span className="text-ink-muted" data-testid="quant-window-text">outside this view</span>
            : <span className="text-ink-muted" data-testid="quant-window-text">none set</span>}
      {win && <button type="button" className={btn} data-testid="quant-window-clear" title="Clear the window" onClick={() => setWindow(null)}>Clear</button>}
    </span>
  );
}

/** The window bar: the x-axis frame, Select window, the window's coordinates (typed or dragged) and Quantify. */
export function QuantWindowBar({ view, origin, testId = 'quant-window-bar' }: { view: { chrom: string; start: number; end: number }; origin: 'cluster' | 'track'; testId?: string }) {
  const win = useBrowserStore(s => s.windowQuant?.window ?? null);
  const openIn = useBrowserStore(s => s.windowQuant?.openIn ?? null);
  const setOpen = useBrowserStore(s => s.setQuantOpen);
  const { anchor } = useAxisAnchor(view);
  const g = windowGenomic(win, view.chrom, anchor);
  return (
    <div className="flex flex-col gap-1" data-testid={`${testId}-wrap`}>
      <AxisFrameControl view={view} testId={origin === 'track' ? 'quant-host-axis-frame' : 'quant-axis-frame'} />
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid={testId} data-relative={win?.relative ? 'true' : 'false'}>
        <SelectWindowButton testId={origin === 'track' ? 'quant-host-select-window' : 'quant-select-window'} cluster={origin === 'cluster'} />
        <WindowFields view={view} />
        {openIn !== origin && (
          <button type="button" data-testid="quant-open" className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
            title={g ? 'Quantify each measure in the window per group, with intervals' : 'Quantify each measure over the whole view per group (set a window to narrow it)'}
            onClick={() => setOpen(origin)}>{g ? 'Quantify window' : 'Quantify whole view'}</button>
        )}
      </div>
    </div>
  );
}

function MeasurePicker({ catalog, picked, onChange }: { catalog: Array<{ source: string; label: string; measures: MeasureDef[] }>; picked: string[]; onChange: (ids: string[]) => void }) {
  useLayerColorVersion();   // layer swatches follow Labels → Layer colours
  const [open, setOpen] = useState(false);
  // Sources sharing a label (geometries and regularity: Nucleosomes) are listed together.
  const byLabel = useMemo(() => {
    const m = new Map<string, MeasureDef[]>();
    for (const c of catalog) m.set(c.label, [...(m.get(c.label) ?? []), ...c.measures]);
    return [...m];
  }, [catalog]);
  const all = byLabel.flatMap(([, ms]) => ms);
  const label = picked.length ? `${picked.length} measure${picked.length === 1 ? '' : 's'}` : 'Active layers';
  return (
    <div className="relative">
      <button type="button" className={btn} data-testid="quant-measures-button" aria-expanded={open} onClick={() => setOpen(o => !o)}
        title={picked.length ? picked.map(id => all.find(m => m.id === id)?.label ?? id).join(', ') : 'The active layers (as the default metaprofile shows them)'}>
        Measure: <b>{label}</b> ▾</button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 max-h-96 w-80 overflow-auto rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900" data-testid="quant-measures-menu">
          <label className="flex items-center gap-1.5 py-0.5 text-[11px]">
            <input type="checkbox" checked={!picked.length} data-testid="quant-measure-follow" onChange={() => onChange([])} />
            <span>Active layers (follow the Tracks layer switches)</span>
          </label>
          {byLabel.map(([lab, ms]) => (
            <div key={lab} className="mt-1.5" data-testid="quant-measure-group" data-source={lab}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{lab}</div>
              {ms.map(m => {
                const ok = m.available === true;
                const why = ok ? null : (m.available as Exclude<MeasureDef['available'], true>);
                return (
                  <div key={m.id} className={`flex flex-wrap items-center gap-1.5 py-0.5 text-[11px] ${ok ? '' : 'text-gray-400 dark:text-gray-500'}`} data-testid="quant-measure-item" data-measure={m.id} data-available={ok ? 'true' : 'false'}>
                    {!m.id.endsWith(':none') && (
                      <input type="checkbox" disabled={!ok} checked={picked.includes(m.id)} aria-label={m.label}
                        onChange={e => onChange(e.target.checked ? [...picked, m.id] : picked.filter(x => x !== m.id))} />
                    )}
                    {measureColor(m) && <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: measureColor(m) }} />}
                    <span title={why?.reason}>{m.label}</span>
                    {why && <span className="basis-full pl-5 text-[10px]">{why.reason}</span>}
                    {why?.step && (why.step.prereq ? <span className="pl-5"><PrereqButton kind={why.step.prereq} testId={`quant-step-${why.step.prereq}`} /></span>
                      : <button type="button" className="ml-5 rounded bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-700" title={why.step.title}
                        data-testid="quant-step" onClick={() => { void why.step!.run(); }}>{why.step.label}</button>)}
                  </div>
                );
              })}
            </div>
          ))}
          <div className="mt-2 flex justify-end"><button type="button" className={btn} onClick={() => setOpen(false)}>Done</button></div>
        </div>
      )}
    </div>
  );
}

export function QuantifyCard({ origin, width, extras, activeLayers, testId = 'quant-card' }: {
  origin: 'cluster' | 'track'; width: number; extras?: Record<string, unknown>; testId?: string;
  /** The layers the plots above show ("Active layers" then means these). */
  activeLayers?: string[];
}) {
  const wq = useBrowserStore(s => s.windowQuant);
  const update = useBrowserStore(s => s.updateQuantSpec);
  const setOpen = useBrowserStore(s => s.setQuantOpen);
  const dark = useBrowserStore(s => s.darkMode);
  const datasets = useBrowserStore(s => s.datasets);
  const spec = wq.spec;
  const q = useWindowQuant({ enabled: true, spec, window: wq.window, extras, activeLayers });
  const [link, setLink] = useState<{ measure: string; group: string; label: string; n: number; prev: Record<string, { ids: Set<string> | null; source: ReadFilterSource | null }> } | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const dsLabel = (id: string) => datasets.find(d => d.id === id)?.label ?? id;
  const view = q.ctx?.view;
  const bText = view && q.bounds ? `${boundsText(view.chrom, q.bounds.from, q.bounds.to)}${wq.window?.relative && q.anchor && q.bounds.kind === 'window' ? `, ${relText(wq.window.from, wq.window.to)} from the ${q.anchor.name}` : ''}` : '';
  const liftedNote = liftedLeftOutNotice(q.liftedLeftOut);
  const measuresBase = q.result && q.bounds ? measuresLine(q.result, q.spec, { boundsText: bText, sampled: q.sampled, datasetLabel: dsLabel, readSource: q.readSource, binBp: q.binBp, windowMissing: q.bounds.windowMissing && spec.bounds === 'window' }) : '';
  // The TSV header and a kept card say what was left out too.
  const measures = measuresBase && liftedNote ? `${measuresBase} ${liftedNote}` : measuresBase;

  const cardInput = (): QuantCardInput | null => (q.result && q.bounds && view ? {
    result: q.result, spec: q.spec, window: wq.window, bounds: { chrom: view.chrom, from: q.bounds.from, to: q.bounds.to, kind: q.bounds.kind },
    axis: q.frame, anchor: q.anchor ? { pos: q.anchor.pos, strand: q.anchor.strand, name: q.anchor.name } : null,
    name: `Quantify · ${q.result.measures.map(m => m.label).slice(0, 3).join(', ')}${q.result.measures.length > 3 ? '…' : ''}`, measures,
    yLabel: q.result.measures.map(m => axisLabelOf(m, spec)).filter((x, i, a) => a.indexOf(x) === i).join(' | '),
    datasets: [...new Set(q.ctx!.allReads.panels.map(p => p.datasetId))], genome: view.genome, origin: origin === 'cluster' ? 'Clusters › Profiles · Quantify window' : 'Metaprofile · Quantify window',
  } : null);

  const pick = (measure: string, group: string) => {
    const st = useBrowserStore.getState();
    if (link && link.measure === measure && link.group === group) { undoLink(); return; }
    const prev = link?.prev ?? {};
    const reads = q.readsFor(measure, group);
    const m = q.result?.measures.find(x => x.id === measure), g = q.result?.groups.find(x => x.id === group);
    const label = `Quantify: ${m?.label ?? measure} · ${g?.title ?? group}`;
    let n = 0;
    const next: typeof prev = { ...prev };
    for (const p of q.ctx?.allReads.panels ?? []) {
      if (!(p.key in next)) next[p.key] = { ids: st.filteredReadIds[p.key] ?? null, source: st.readFilterSources?.[p.key] ?? null };
      const ids = new Set(reads[p.datasetId] ?? []);
      n += ids.size;
      st.setFilteredReadIds(p.key, ids, { target: 'window-quant', label });
    }
    setLink({ measure, group, label, n, prev: next });
  };
  const undoLink = () => {
    if (!link) return;
    const st = useBrowserStore.getState();
    for (const [key, p] of Object.entries(link.prev)) st.setFilteredReadIds(key, p.ids, p.source);
    setLink(null);
  };

  // The chip lives with the card: closing it (or leaving the tab) puts the panels' previous filters back.
  const linkRef = useRef(link);
  linkRef.current = link;
  useEffect(() => () => {
    const l = linkRef.current;
    if (!l) return;
    const st = useBrowserStore.getState();
    // Only where Quantify's own filter is still on: a filter set since by another control stays.
    for (const [key, p] of Object.entries(l.prev)) if (st.readFilterSources?.[key]?.target === 'window-quant') st.setFilteredReadIds(key, p.ids, p.source);
  }, []);

  const groupsForRef = q.groups;
  const enrichable = q.measures.some(m => m.enrichment && m.kind !== 'group');
  const meta = view ? isMetaChrom(view.chrom) : false;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-300/70 bg-amber-50/30 p-2 dark:border-amber-800/60 dark:bg-amber-950/10" data-testid={testId}
      data-state={q.loading ? 'loading' : q.result ? 'ready' : q.blocker ? 'blocked' : 'idle'} data-request-key={q.requestKey}>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="quant-header">
        <span className="text-[11px] font-semibold">Quantify</span>
        <MeasurePicker catalog={q.catalog} picked={spec.measures} onChange={ids => update({ measures: ids })} />
        <label className="flex items-center gap-1 text-[11px]">in
          <select className={sel} value={spec.bounds} aria-label="Bounds" data-testid="quant-bounds" onChange={e => update({ bounds: e.target.value as QuantSpec['bounds'] })}>
            <option value="window">the window{wq.window ? '' : ' (none: the whole view)'}</option>
            <option value="region">the whole region in view</option>
            <option value="sites" disabled={!meta}>meta-locus sites{meta ? '' : ' (open a meta-locus)'}</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-[11px]">across
          <select className={sel} value={spec.comparison} aria-label="Comparison" data-testid="quant-comparison" onChange={e => update({ comparison: e.target.value as QuantSpec['comparison'], reference: null })}>
            <option value="clusters">clusters</option>
            <option value="datasets">datasets</option>
            <option value="clusters-datasets">clusters × datasets</option>
            <option value="pools" disabled={!meta}>meta-locus pools{meta ? '' : ' (open a meta-locus)'}</option>
          </select>
        </label>
        {q.spec.comparison !== spec.comparison && <span className="text-[11px] text-ink-muted" data-testid="quant-comparison-fallback">(nothing clustered here: per dataset)</span>}
        <label className="flex items-center gap-1 text-[11px]">reference
          <select className={sel} value={spec.reference ?? ''} aria-label="Reference group" data-testid="quant-reference" onChange={e => update({ reference: e.target.value || null })}>
            <option value="">first group</option>
            {groupsForRef.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        </label>
        <button type="button" className="ml-auto text-[11px] text-ink-muted hover:underline" data-testid="quant-close" onClick={() => setOpen(null)}>Close</button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="quant-scale">
        <select className={sel} value={spec.value} aria-label="Value" data-testid="quant-value" disabled={!enrichable} title={enrichable ? undefined : 'No measure here has a meaningful ratio to a baseline'}
          onChange={e => update({ value: e.target.value as QuantSpec['value'] })}>
          <option value="raw">Value (raw)</option><option value="enrichment">Enrichment</option>
        </select>
        {spec.value === 'enrichment' && (<>
          <select className={sel} value={spec.baseline} aria-label="Baseline" data-testid="quant-baseline" onChange={e => update({ baseline: e.target.value as QuantSpec['baseline'] })}>
            <option value="auto">baseline: auto (layers: the y-scale's; shares: pooled)</option>
            <option value="pooled">the groups shown, pooled</option><option value="rest">the rest</option><option value="reference">the reference group</option>
            <option value="region">all reads in the dataset</option><option value="flank">own flank (layers)</option><option value="dataset">dataset mean over the view (layers)</option>
          </select>
          <select className={sel} value={spec.form} aria-label="Enrichment form" data-testid="quant-form" onChange={e => update({ form: e.target.value as QuantSpec['form'] })}>
            <option value="log2">log2</option><option value="ratio">ratio</option><option value="percent">%</option>
          </select>
        </>)}
        <select className={sel} value={spec.compare} aria-label="Versus reference" data-testid="quant-compare" onChange={e => update({ compare: e.target.value as QuantSpec['compare'] })}>
          <option value="off">no comparison</option><option value="diff">difference vs reference</option><option value="log2ratio">log2 ratio vs reference</option>
        </select>
        <select className={sel} value={spec.stat} aria-label="Statistic" data-testid="quant-stat" onChange={e => update({ stat: e.target.value as QuantSpec['stat'] })}>
          <option value="mean">mean</option><option value="area">area (mean × bp)</option>
        </select>
        <details className="relative">
          <summary className="cursor-pointer text-[11px] text-ink-muted" data-testid="quant-options">Options</summary>
          <div className="absolute z-30 mt-1 grid w-72 grid-cols-2 gap-1 rounded-md border border-gray-200 bg-white p-2 text-[11px] shadow-lg dark:border-gray-700 dark:bg-gray-900">
            <label>Interval<select className={sel} value={spec.ci} onChange={e => update({ ci: e.target.value as QuantSpec['ci'] })}>
              <option value="auto">auto</option><option value="bootstrap">bootstrap</option><option value="wilson">Wilson (shares)</option><option value="none">none</option></select></label>
            <label>Resamples<input type="number" className={sel} value={spec.resamples} min={50} max={10000} onChange={e => update({ resamples: Number(e.target.value) })} /></label>
            <label>Bootstrap seed<input type="number" className={sel} value={spec.bootSeed ?? spec.seed} min={0} onChange={e => update({ bootSeed: Number(e.target.value) })} /></label>
            <label>Few reads under<input type="number" className={sel} value={spec.minReads} min={0} data-testid="quant-min-reads" onChange={e => update({ minReads: Number(e.target.value) })} /></label>
            <label>Test<select className={sel} value={spec.test} onChange={e => update({ test: e.target.value as QuantSpec['test'] })}>
              <option value="chi2">chi-squared</option><option value="g">G (likelihood ratio)</option><option value="off">off</option></select></label>
            <label>Adjust p<select className={sel} value={spec.adjust} onChange={e => update({ adjust: e.target.value as QuantSpec['adjust'] })}>
              <option value="bh">BH</option><option value="none">none</option></select></label>
            <label>Reads per dataset<input type="number" className={sel} value={spec.readCap} min={50} max={20000} onChange={e => update({ readCap: Number(e.target.value) })} /></label>
            <label>Sample seed<input type="number" className={sel} value={spec.seed} min={0} onChange={e => update({ seed: Number(e.target.value) })} /></label>
            <label>Layer units<select className={sel} value={spec.layerUnits} data-testid="quant-layer-units" title="Curve units: the profile's own bins and mean (the card matches the curve). Exact bp: each read's layer bp over its bp (short calls read lower than the curve)." onChange={e => update({ layerUnits: e.target.value as QuantSpec['layerUnits'] })}>
              <option value="curve">curve units (as drawn)</option><option value="exact">exact bp</option></select></label>
            <label>Layer reads<select className={sel} value={spec.readSource} data-testid="quant-read-source" onChange={e => update({ readSource: e.target.value as QuantSpec['readSource'] })}>
              <option value="panel">the panel's curve reads</option><option value="fetch">a fresh sample</option></select></label>
            <label>Size band from (bp)<input type="number" className={sel} value={spec.sizeFrom} min={0} data-testid="quant-size-from" onChange={e => update({ sizeFrom: Number(e.target.value) })} /></label>
            <label>Size band to (bp)<input type="number" className={sel} value={spec.sizeTo} min={1} data-testid="quant-size-to" onChange={e => update({ sizeTo: Number(e.target.value) })} /></label>
            <label>Flank (share of view)<input type="number" step={0.01} className={sel} value={spec.flankFraction} min={0.02} max={0.45} onChange={e => update({ flankFraction: Number(e.target.value) })} /></label>
          </div>
        </details>
      </div>
      {link && (
        <div className="flex items-center gap-1.5 self-start rounded-full border border-cyan-400 bg-cyan-50 px-2 py-0.5 text-[11px] text-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-100" data-testid="quant-link-chip">
          <span>Showing {link.n.toLocaleString('en-US')} reads: {link.label.replace(/^Quantify: /, '')}</span>
          <button type="button" aria-label="Show all reads again" data-testid="quant-link-undo" className="font-semibold hover:underline" onClick={undoLink}>×</button>
        </div>
      )}
      {liftedNote && (
        <div className="text-[11px] text-amber-700 dark:text-amber-300" role="status" data-testid="quant-lifted-left-out">{liftedNote}</div>
      )}
      {q.blocker ? <div className="text-[11px] text-ink-secondary" role="status" data-testid="quant-blocker">{q.blocker}</div>
        : q.error ? <div className="text-[11px] text-red-700 dark:text-red-300" role="status">Could not quantify: {q.error}</div>
          : !q.result ? <div className="text-[11px] text-ink-secondary" role="status" data-testid="quant-loading">Quantifying…</div>
            : (
              <QuantResultView result={q.result} spec={q.spec} width={width} dark={dark} measuresText={measures} filename={`quantify_${view?.chrom ?? ''}_${q.bounds?.from ?? ''}_${q.bounds?.to ?? ''}`}
                onDisplay={patch => update(patch)} selected={link ? { measure: link.measure, group: link.group } : null} onPick={pick} />
            )}
      {q.result && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={btn} data-testid="quant-keep" title="Keep this result in the Plots Gallery (the window, the spec and the sampling are recorded)"
            onClick={() => { const i = cardInput(); const e = i ? keepQuant(i) : null; setKept(e ? e.id : null); }}>Keep</button>
          <button type="button" className={btn} data-testid="quant-open-in-plots" onClick={() => { const i = cardInput(); if (i) openQuantInPlots(i); }}>Open in Plots</button>
          {kept && <span className="text-[11px] text-ink-muted" data-testid="quant-kept">Kept in the Gallery</span>}
        </div>
      )}
    </div>
  );
}
