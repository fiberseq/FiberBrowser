/**
 * Differential features in the Plots workspace: one test per feature between A and B (differentialData.ts), shown
 * as a volcano (delta vs −log10 q, with the threshold lines) and an MA plot (mean fraction vs log2 OR) that share one
 * selection, and a sortable table. Clicking a point or a row's locus moves the browser there (a following plot pins
 * itself first, so it stays); shift-click selects. The selection goes to the Feature hub, the read Filter or Cluster.
 * Same stale-state guard, Gallery hand-off and export as the other plots.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import type { FootprintSizesClusters, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { AnalysisStatus } from '../../components/controls/shared';
import { asClusterRegions, asFilter } from '../hub/actions';
import { useHubWorkspaceEnabled } from './hubWorkspaceFlag';
import { PrereqButton } from './prereqActions';
import type { HubSelected } from '../hub/hubState';
import { plotFreshness } from './follow';
import { formatLocus, plotDisplayName, DIFF_FEATURES, type DiffSettings, type PlotSpec } from './plotModel';
import type { ReadGroupDef } from './readGroups';
import {
  callOf, diffTsv, featureKeyOf, sortDiffRows, useDifferentialData, type DiffEntry, type DiffRow, type DiffSortKey,
} from './differentialData';
import { CALL_COLOURS, diffFigureDraw, diffThumbnail, drawMA, drawVolcano, nearestPoint, type DiffPoint } from './diffCharts';
import { setWorkspace } from './workspace';
import { runAppCommand } from '../../utils/appCommands';

export interface DifferentialResult { entry: DiffEntry; plot: PlotSpec; thumb: string }

export interface DifferentialPlotProps {
  plot: PlotSpec;
  target: FootprintSizesTarget;
  clusters: FootprintSizesClusters | null;
  pending: boolean;
  width: number;
  settingsKey: string;
  wanted?: { chrom: string; start: number; end: number } | null;
  seed?: DiffEntry | null;
  onResult?: (r: DifferentialResult) => void;
  onChange: (patch: Partial<Pick<PlotSpec, 'compareAB' | 'pinned'>> & { diff?: Partial<DiffSettings> }) => void;
  /** Go to a feature (the workspace pins a following plot first). */
  onLocus: (chrom: string, start: number, end: number) => void;
  readGroups?: ReadGroupDef[] | null;
  groupsSig?: string;
  groupsBlocker?: string | null;
}

const pct = (v: number | null, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const signed = (v: number | null, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);
const qText = (q: number | null) => (q == null ? '—' : q < 1e-4 ? q.toExponential(1) : q.toPrecision(2));

function Chart({ rows, kind, width, height, settings, selected, hover, dark, onHover, onPick }: {
  rows: DiffRow[]; kind: 'volcano' | 'ma'; width: number; height: number; settings: DiffSettings; selected: ReadonlySet<string>;
  hover: string | null; dark: boolean; onHover: (key: string | null) => void; onPick: (key: string, additive: boolean) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const points = useRef<DiffPoint[]>([]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr; c.height = height * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const o = { width, height, qMax: settings.qMax, deltaMin: settings.deltaMin, dark, selected, hover, title: kind === 'volcano' ? 'Volcano' : 'MA' };
    points.current = kind === 'volcano' ? drawVolcano(ctx, rows, o) : drawMA(ctx, rows, o);
    // Where the most significant called point is (tests and screen readers find it by this).
    const top = points.current.filter(p => p.call === 'up' || p.call === 'down').sort((a, b) => a.y - b.y)[0];
    c.dataset.top = top ? `${Math.round(top.x)},${Math.round(top.y)},${top.key}` : '';
  }, [rows, kind, width, height, settings.qMax, settings.deltaMin, selected, hover, dark]);
  const at = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return nearestPoint(points.current, e.clientX - r.left, e.clientY - r.top);
  };
  return (
    <canvas ref={ref} style={{ width, height }} data-testid={`plots-diff-${kind}`} data-points={rows.length}
      className="cursor-crosshair rounded" aria-label={kind === 'volcano' ? 'Volcano plot: Δ fraction against −log10 q' : 'MA plot: mean fraction against log2 odds ratio'}
      onMouseMove={e => onHover(at(e)?.key ?? null)} onMouseLeave={() => onHover(null)}
      onClick={e => { const p = at(e); if (p) onPick(p.key, e.shiftKey || e.metaKey || e.ctrlKey); }} />
  );
}

const COLUMNS: Array<{ key: DiffSortKey; label: string; title: string }> = [
  { key: 'feature', label: 'Feature', title: 'The feature (click its locus to go there)' },
  { key: 'locus', label: 'Locus', title: 'Where it is' },
  { key: 'fracA', label: 'A', title: 'Fraction of evaluated reads in A that are open / members / carrying' },
  { key: 'fracB', label: 'B', title: 'Fraction of evaluated reads in B' },
  { key: 'delta', label: 'Δ (95% CI)', title: 'Fraction A − fraction B, with its 95% interval' },
  { key: 'log2or', label: 'log2 OR', title: 'log2 odds ratio, A over B (95% interval in the tooltip)' },
  { key: 'q', label: 'q', title: 'Benjamini-Hochberg q over the tested features' },
  { key: 'n', label: 'n reads', title: 'Evaluated reads, A / B' },
];

export function DifferentialPlot({ plot, target, clusters, pending, width, settingsKey, wanted, seed, onResult, onChange, onLocus, readGroups = null, groupsSig = '', groupsBlocker = null }: DifferentialPlotProps) {
  const dark = useBrowserStore(s => s.darkMode);
  const byCluster = plot.groupBy === 'cluster';
  // Differential features waits for the Feature hub (experimental flag): with it off, a stored result shows read-only.
  const hubOn = useHubWorkspaceEnabled();
  const { entry, requestKey, loading, error, features, sides } = useDifferentialData({
    plot, target, clusters: byCluster ? clusters : null, readGroups, groupsSig, settingsKey, enabled: !pending && hubOn, seed,
  });
  const fresh = plotFreshness({ resultKey: entry?.key ?? null, wantKey: requestKey, pending, loading, error });
  const d = plot.diff;
  const rows = useMemo(() => (fresh.showResult && entry ? entry.rows : []), [fresh.showResult, entry]);
  const [sort, setSort] = useState<{ key: DiffSortKey; dir: 'asc' | 'desc' }>({ key: 'q', dir: 'asc' });
  const sorted = useMemo(() => sortDiffRows(rows, sort.key, sort.dir), [rows, sort]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const hubAllowed = hubOn;
  const [hover, setHover] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { setSelected(new Set()); }, [entry?.key]);
  const byKey = useMemo(() => new Map(features.map(h => [featureKeyOf(h), h])), [features]);
  const rowByKey = useMemo(() => new Map(rows.map(r => [r.key, r])), [rows]);
  const tested = rows.filter(r => r.testable).length;
  const up = rows.filter(r => callOf(r, d.qMax, d.deltaMin) === 'up').length;
  const down = rows.filter(r => callOf(r, d.qMax, d.deltaMin) === 'down').length;
  const labels = { A: entry?.groups.A.label ?? sides.A?.label ?? 'A', B: entry?.groups.B.label ?? sides.B?.label ?? 'B' };
  const chartW = Math.max(240, Math.floor((width - 10) / 2));
  const chartH = 260;
  const locusText = formatLocus(entry?.locus ?? null);
  const whole = useMemo(() => diffFigureDraw(rows, { chartWidth: chartW, chartHeight: chartH, qMax: d.qMax, deltaMin: d.deltaMin, dark, labels,
    heading: `${plotDisplayName(plot)} · ${locusText}` }), [rows, chartW, d.qMax, d.deltaMin, dark, labels.A, labels.B, plot, locusText]); // eslint-disable-line react-hooks/exhaustive-deps
  const tsv = useCallback(() => (entry ? diffTsv(entry, d.qMax, d.deltaMin) : ''), [entry, d.qMax, d.deltaMin]);

  // A result lands in the Gallery once per request (thresholds only redraw).
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fresh.state !== 'current' || !entry || entry.seeded || !onResult || !entry.rows.length) return;
    const id = `${plot.id}|${entry.key}`;
    if (reported.current === id) return;
    reported.current = id;
    onResult({ entry, plot, thumb: diffThumbnail(entry.rows, d.qMax, d.deltaMin) });
  }, [fresh.state, entry, plot, onResult, d.qMax, d.deltaMin]);

  const goTo = useCallback((key: string) => {
    const r = rowByKey.get(key);
    if (r?.chrom != null && r.start != null && r.end != null) onLocus(r.chrom, r.start, r.end);
  }, [rowByKey, onLocus]);
  const toggle = useCallback((key: string) => setSelected(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }), []);
  const onPick = useCallback((key: string, additive: boolean) => { if (additive) toggle(key); else goTo(key); }, [toggle, goTo]);

  const chosen = (): HubSelected[] => [...selected].map(k => byKey.get(k)).filter((h): h is HubSelected => !!h);
  const missing = () => [...selected].filter(k => !byKey.has(k)).length;
  const act = async (what: 'hub' | 'filter' | 'cluster') => {
    const hits = chosen();
    if (!hits.length) { setNote('Select features first (tick rows, or shift-click points).'); return; }
    const skipped = missing();
    let err: string | null = null;
    if (what === 'hub') {
      useBrowserStore.getState().setFeatureHub({ selected: hits });
      setWorkspace('hub');
    } else if (what === 'filter') {
      err = await asFilter(hits);
      if (!err) setWorkspace('browser');
    } else {
      err = await asClusterRegions(hits);
      if (!err) setWorkspace('browser');
    }
    setNote(err ?? `${hits.length} feature${hits.length === 1 ? '' : 's'} sent${skipped ? ` (${skipped} no longer in view, skipped)` : ''}.`);
  };

  const shownWanted = pending && wanted ? wanted : target;
  const featureLabel = DIFF_FEATURES.find(f => f.value === d.features)?.label ?? 'Features';
  const blocker = groupsBlocker && readGroups ? groupsBlocker : sides.blocker;

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-diff-plot" data-state={fresh.state}
      data-computed-for={entry && fresh.state === 'current' ? locusText : ''} data-features={features.length} data-tested={fresh.showResult ? tested : ''}
      data-up={fresh.showResult ? up : ''} data-down={fresh.showResult ? down : ''} data-test={entry?.test ?? ''}
      data-seeded={entry?.seeded && fresh.state === 'current' ? 'true' : undefined}>
      {!hubOn && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" data-testid="plots-diff-waiting" role="status">
          Differential features waits for the Feature hub (Settings › Read Display › Experimental: Feature hub workspace).{entry?.seeded ? ' This card shows its stored result, read-only.' : ' Nothing is computed while it is off.'}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {fresh.state === 'current' && entry && (
          <span className="text-ink-secondary" data-testid="plots-computed-for">{entry.seeded ? 'From the Gallery · ' : ''}Computed for <b className="font-semibold">{locusText}</b></span>
        )}
        {fresh.state === 'updating' && <span className="font-medium text-amber-700 dark:text-amber-300" data-testid="plots-updating" role="status">Updating… → {formatLocus(shownWanted)}</span>}
        {fresh.state === 'error' && <span className="text-red-600" data-testid="plots-error">{error}</span>}
        {rows.length > 0 && !fresh.stale && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="plots-export">
            <span className="text-ink-secondary">Export</span>
            <ChartSaveButton inline filename={`${plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80)}_${target.chrom}_${target.start + 1}`}
              drawFn={ctx => whole.draw(ctx)} width={whole.w} height={whole.h} dataTsv={tsv} />
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-700 dark:text-gray-200" data-testid="plots-diff-sides">
        <span className="font-medium">Compare</span>
        {sides.multi ? sides.options.map(o => {
          const on = sides.A?.datasets.includes(o.id) ? 'A' : sides.B?.datasets.includes(o.id) ? 'B' : '';
          const set = (side: 'A' | 'B' | '') => {
            const A = (sides.A?.datasets ?? []).filter(x => x !== o.id), B = (sides.B?.datasets ?? []).filter(x => x !== o.id);
            if (side === 'A') A.push(o.id);
            if (side === 'B') B.push(o.id);
            onChange({ diff: { sideA: A, sideB: B } });
          };
          return (
            <span key={o.id} className="inline-flex items-center gap-0.5 rounded border border-gray-200 px-1 dark:border-gray-700" data-testid={`plots-diff-side-${o.id}`} data-side={on}>
              <span className="max-w-[10rem] truncate">{o.label}</span>
              {(['A', 'B', ''] as const).map(s => (
                <button key={s || 'none'} type="button" aria-pressed={on === s} onClick={() => set(s)} data-testid={`plots-diff-side-${o.id}-${s || 'none'}`}
                  className={`rounded px-1 ${on === s ? 'bg-amber-100 font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-100' : 'text-gray-500'}`}
                  title={s ? `Put this dataset in ${s}` : 'Leave this dataset out'}>{s || '—'}</button>
              ))}
            </span>
          );
        }) : sides.options.length >= 2 && (
          <>
            <span>A</span>
            <select aria-label="Group A" data-testid="plots-diff-a" value={sides.A?.id ?? ''} className="input-tool min-h-0 py-0.5 text-[11px]"
              onChange={e => onChange({ compareAB: [e.target.value, e.target.value === sides.B?.id ? sides.A!.id : sides.B!.id] })}>
              {sides.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <span>vs B</span>
            <select aria-label="Group B" data-testid="plots-diff-b" value={sides.B?.id ?? ''} className="input-tool min-h-0 py-0.5 text-[11px]"
              onChange={e => onChange({ compareAB: [e.target.value === sides.A?.id ? sides.B!.id : sides.A!.id, e.target.value] })}>
              {sides.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </>
        )}
        {sides.A && sides.B && (
          <button type="button" data-testid="plots-diff-swap" className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            title="Swap A and B: flips the signs of Δ and log2 OR"
            onClick={() => (sides.multi ? onChange({ diff: { sideA: sides.B!.datasets, sideB: sides.A!.datasets } }) : onChange({ compareAB: [sides.B!.id, sides.A!.id] }))}>Swap</button>
        )}
      </div>

      {blocker && <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" data-testid="plots-diff-blocker" role="status">
        <span>{blocker}</span>
        {plot.groupBy === 'cluster' && !clusters && <PrereqButton kind="cluster" done={!!clusters} />}
        {(plot.groupBy === 'read-groups' || plot.groupBy === 'classes') && !readGroups && <PrereqButton kind="groups" />}
      </div>}
      {!blocker && !features.length && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
          data-testid="plots-diff-empty" role="status">
          {d.features === 'peaks' ? (
            <><b>No peaks in this view to test.</b><PrereqButton kind="peaks" done={features.length > 0} testId="plots-diff-scan" /></>
          ) : d.features === 'classes' ? <><b>No footprint classes in this view.</b><PrereqButton kind="classes" done={features.length > 0} /></>
            : d.features === 'geometries' ? <><b>No shared geometries in this view.</b><PrereqButton kind="geometries" done={features.length > 0} /></>
              : d.features === 'hub-selection' ? <><b>The Feature hub selection is empty.</b> Select hits in the Feature hub.</>
                : <><b>No features with per-read states in this view.</b><PrereqButton kind="peaks" done={features.length > 0} /><PrereqButton kind="classes" done={features.length > 0} /><PrereqButton kind="geometries" done={features.length > 0} /></>}
          {note && <span data-testid="plots-diff-note">{note}</span>}
        </div>
      )}
      {!blocker && features.length > 0 && !fresh.showResult && fresh.state === 'updating' && (
        <AnalysisStatus kind="loading" compact>Testing {features.length} {featureLabel.toLowerCase()} for {formatLocus(shownWanted)}…</AnalysisStatus>
      )}

      {rows.length > 0 && (
        <>
          <div className="text-[11px] text-ink-secondary" data-testid="plots-diff-summary">
            <b className="text-ink-primary dark:text-gray-100">{tested}</b> of {rows.length} {featureLabel.toLowerCase()} tested ·{' '}
            <span style={{ color: CALL_COLOURS.up }}>●</span> {up} higher in A ({labels.A}) · <span style={{ color: CALL_COLOURS.down }}>■</span> {down} higher in B ({labels.B}) ·
            q ≤ {d.qMax}, |Δ| ≥ {d.deltaMin} · {entry?.test === 'cmh' ? `CMH over ${[d.densityMatch ? `${d.densityBins} m6A density bins` : '', d.replicateAware ? 'replicates' : ''].filter(Boolean).join(' × ')}` : entry?.test === 'chi2' ? 'χ² test' : 'Fisher\'s exact test'}, BH
            {entry?.density?.reads_without_density ? ` · ${entry.density.reads_without_density.toLocaleString()} reads without a density left out` : ''}
          </div>
          <div className={`flex flex-wrap gap-[10px] ${fresh.stale ? 'pointer-events-none opacity-40 grayscale' : ''}`} aria-busy={fresh.stale || undefined}>
            {(['volcano', 'ma'] as const).map(k => (
              <Chart key={k} kind={k} rows={rows} width={chartW} height={chartH} settings={d} selected={selected} hover={hover} dark={dark}
                onHover={setHover} onPick={onPick} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="plots-diff-actions">
            <span className="text-ink-secondary">{selected.size} selected</span>
            <button type="button" className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 dark:border-gray-700" data-testid="plots-diff-select-called"
              onClick={() => setSelected(new Set(rows.filter(r => { const c = callOf(r, d.qMax, d.deltaMin); return c === 'up' || c === 'down'; }).map(r => r.key)))}>Select called</button>
            <button type="button" className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 dark:border-gray-700" data-testid="plots-diff-clear" onClick={() => setSelected(new Set())}>Clear</button>
            <span className="ml-2 text-ink-secondary">Selected →</span>
            {([...(hubAllowed ? [['hub', 'Hub', 'Select these in the Feature hub and open it'] as const] : []), ['filter', 'Filter', 'Keep the reads open / members at any of these (read Filter)'],
              ['cluster', 'Cluster', 'Cluster the reads on these features']] as const).map(([k, label, title]) => (
              <button key={k} type="button" disabled={!selected.size} data-testid={`plots-diff-to-${k}`} title={title} onClick={() => { void act(k); }}
                className="rounded bg-amber-600 px-2 py-0.5 font-semibold text-white hover:bg-amber-700 disabled:opacity-40">{label}</button>
            ))}
            {note && <span className="text-ink-secondary" data-testid="plots-diff-note" role="status">{note}</span>}
          </div>
          <div className="max-h-[420px] overflow-auto rounded border border-line/70 dark:border-white/10">
            <table className="w-full border-collapse text-[11px]" data-testid="plots-diff-table">
              <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="w-6 p-1" />
                  {COLUMNS.map(c => (
                    <th key={c.key} className="p-1 text-left font-semibold" title={c.title} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" data-testid={`plots-diff-sort-${c.key}`} className="hover:underline"
                        onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key && s.dir === 'asc' ? 'desc' : s.key === c.key ? 'asc' : c.key === 'q' || c.key === 'feature' || c.key === 'locus' ? 'asc' : 'desc' }))}>
                        {c.label}{sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => {
                  const call = callOf(r, d.qMax, d.deltaMin);
                  return (
                    <tr key={r.key} data-testid="plots-diff-row" data-key={r.key} data-call={call}
                      className={`border-t border-line/50 dark:border-white/5 ${hover === r.key ? 'bg-amber-50 dark:bg-amber-900/20' : ''}`}
                      onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)}>
                      <td className="p-1"><input type="checkbox" aria-label={`Select ${r.label ?? r.key}`} checked={selected.has(r.key)} onChange={() => toggle(r.key)} /></td>
                      <td className="whitespace-nowrap p-1">
                        <span className="mr-1 inline-block w-2 text-center" style={{ color: CALL_COLOURS[call] }} aria-hidden="true">{call === 'up' ? '●' : call === 'down' ? '■' : '○'}</span>
                        {r.label ?? r.key}{r.kind ? <span className="ml-1 text-gray-400">{r.kind}</span> : null}
                        {r.reason && <span className="ml-1 text-gray-400" title={r.reason}>(not tested)</span>}
                      </td>
                      <td className="whitespace-nowrap p-1">
                        {r.chrom != null && r.start != null && r.end != null
                          ? <button type="button" className="text-amber-800 hover:underline dark:text-amber-300" data-testid="plots-diff-goto" onClick={() => goTo(r.key)}>{formatLocus({ chrom: r.chrom, start: r.start, end: r.end })}</button>
                          : '—'}
                      </td>
                      <td className="p-1 tabular-nums">{pct(r.fracA)}</td>
                      <td className="p-1 tabular-nums">{pct(r.fracB)}</td>
                      <td className="whitespace-nowrap p-1 tabular-nums" title={r.deltaLo != null ? `95% CI ${signed(r.deltaLo)} to ${signed(r.deltaHi)}` : ''}>
                        {signed(r.delta)}{r.deltaLo != null ? <span className="text-gray-400"> ({signed(r.deltaLo)}, {signed(r.deltaHi)})</span> : null}
                      </td>
                      <td className="whitespace-nowrap p-1 tabular-nums" title={r.log2orLo != null ? `95% CI ${signed(r.log2orLo)} to ${signed(r.log2orHi)}` : ''}>{signed(r.log2or)}</td>
                      <td className="whitespace-nowrap p-1 tabular-nums">{qText(r.q)}</td>
                      <td className="whitespace-nowrap p-1 tabular-nums">{r.nA.toLocaleString()} / {r.nB.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {fresh.state === 'current' && entry && rows.length === 0 && (
        <AnalysisStatus kind="empty" center>No features to test here.</AnalysisStatus>
      )}
      <div className="text-[11px] text-ink-secondary" data-testid="plots-caption">
        Per read, each feature is open / a member / carrying (1) or not (0); reads that don't cover it, or weren't scored for it, don't count. Fractions are of those reads;
        Δ = A − B with Newcombe 95% intervals (CMH: the Mantel-Haenszel difference), log2 OR with Woolf (CMH: Robins-Breslow-Greenland) intervals; at least {d.minReads} reads per side.
        Click a point or a locus to go there; shift-click to select.
      </div>
    </div>
  );
}
