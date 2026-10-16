/**
 * Accessibility (preview): ChIP-Atlas peaks of the pinned (or typed) factors over the NFR and its variants, from the
 * experiments that match the samples (cell type class and cell type: ChIP-Atlas' tissue, developmental stage or cell
 * line names; remembered per assembly). Peak files are fetched on request (a few hundred KB per experiment, cached);
 * the experiment list (~340 MB) downloads only when asked.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { sleep, startJob, useJob } from '../nfrJobs';
import { NfrJobOwnerContext } from './useNfrView';
import {
  downloadChipAtlasMetadata, getChipAtlas, getChipAtlasExperiments, getChipAtlasMetadata, startChipAtlas,
  type ChipAtlasExperiments, type ChipAtlasSelection, type ChipAtlasTask, type NfrMotifs,
} from '../api';
import { useBrowserStore } from '../../../stores/browserStore';
import { bp, variantColor } from '../accessibilityView';
import { ALL_EXPERIMENTS, cellTypesNamedIn } from '../chipAtlasSelection';
import { analysisPreferencesReady } from '../../../utils/analysisPreferences';
import { getDatasetDisplayLabel } from '../../../utils/datasetLabels';
import { AnalysisButton, AnalysisStatus } from '../../../components/controls/shared';
import { NfrCanvasExport } from './NfrCharts';

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const inputCls = 'rounded border border-gray-200 bg-white px-1 py-px dark:border-gray-700 dark:bg-gray-900';

/** The last ChIP-Atlas request per run and NFR (its job key and factors): reopening the view follows it. */
const lastRequest = new Map<string, { key: string; factors: string; perFactor: number }>();

export function NfrChipAtlas({ data, jobId, names, width, datasetIds = [] }: {
  data: NfrMotifs; jobId: string; names: string[]; width: number;
  /** The run's datasets: their labels and file names pick the default cell types. */
  datasetIds?: string[];
}) {
  const resolved = data.pinned.requested.filter(f => !data.pinned.missing.includes(f));
  const here = `${jobId}|${data.nfr}`;
  const last = lastRequest.get(here);
  const [factors, setFactors] = useState(last?.factors ?? resolved.join(', '));
  const [perFactor, setPerFactor] = useState(last?.perFactor ?? 12);
  const [meta, setMeta] = useState<{ present: boolean; loading: boolean; message: string } | null>(null);
  const [error, setError] = useState('');
  const [key, setKey] = useState<string | null>(last?.key ?? null);
  const owner = useContext(NfrJobOwnerContext);
  // The peak fetch belongs to the panel (utils/nfrJobs): it keeps going when this view closes, and its result stays.
  const job = useJob<ChipAtlasTask>(key);
  const task = (job?.status === 'done' ? job.data : (job?.progress as ChipAtlasTask | null)) ?? null;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const refreshMeta = useCallback(() => getChipAtlasMetadata()
    .then(m => { if (alive.current) setMeta({ present: m.present, loading: m.progress.loading, message: m.progress.message }); })
    .catch(e => setError(String((e as Error).message ?? e))), []);
  useEffect(() => { void refreshMeta(); }, [refreshMeta]);
  useEffect(() => {
    if (!meta?.loading) return;
    const t = window.setTimeout(() => void refreshMeta(), 3000);
    return () => window.clearTimeout(t);
  }, [meta, refreshMeta]);
  const list = useMemo(() => [...new Set(factors.split(/[,\s]+/).map(s => s.trim()).filter(Boolean))], [factors]);
  const datasets = useBrowserStore(s => s.datasets);
  const sampleTexts = useMemo(() => datasetIds.flatMap(id => {
    const d = datasets.find(x => x.id === id);
    return d ? [getDatasetDisplayLabel(d), d.label, d.id, (d.path ?? '').split(/[\\/]/).pop() ?? ''] : [id];
  }), [datasets, datasetIds.join('|')]);
  // The experiment selector: null until the assembly is known (the first answer); then the remembered choice, else the
  // cell types the datasets name, else every experiment.
  const [selection, setSelection] = useState<ChipAtlasSelection | null>(null);
  // the selector's counts, with the request (factors and selection) they answer
  const [facetsAt, setFacetsAt] = useState<{ key: string; data: ChipAtlasExperiments } | null>(null);
  const facets = facetsAt?.data ?? null;
  const listKey = list.join(',');
  const requestKey = `${jobId}|${listKey}|${JSON.stringify(selection)}`;
  const setFacets = (f: ChipAtlasExperiments, key: string) => setFacetsAt({ key, data: f });
  useEffect(() => {
    if (!meta?.present) return;
    let live = true;
    const key = requestKey;
    const t = window.setTimeout(() => {
      getChipAtlasExperiments(jobId, list, selection ?? ALL_EXPERIMENTS).then(async f => {
        if (!live) return;
        if (selection == null && f.present) {
          await analysisPreferencesReady();        // the choice kept on this computer, once read
          if (!live) return;
          const remembered = useBrowserStore.getState().chipAtlasSelections[f.genome] ?? null;
          const named = cellTypesNamedIn(sampleTexts, f.cell_types.map(c => c.key));
          const first = remembered ?? (named.length ? { cellTypeClasses: [], cellTypes: named } : ALL_EXPERIMENTS);
          setFacets(f, key);
          setSelection(first);   // asks again for its count
          return;
        }
        setFacets(f, key);
      }).catch(e => { if (live) setError(String((e as Error).message ?? e)); });
    }, selection == null ? 0 : 250);
    return () => { live = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.present, jobId, listKey, JSON.stringify(selection)]);
  const choose = (next: ChipAtlasSelection) => {
    setSelection(next);
    if (facets?.genome) useBrowserStore.getState().setChipAtlasSelection(facets.genome, next);
  };
  const start = () => {
    setError('');
    const sel = selection ?? ALL_EXPERIMENTS;
    const k = `chip|${jobId}|${[...list].sort().join(',')}|${perFactor}|${JSON.stringify(sel)}`;
    lastRequest.set(here, { key: k, factors, perFactor });
    setKey(k);
    startJob<ChipAtlasTask>(k, async ctx => {
      let t = await startChipAtlas(jobId, list, perFactor, sel);
      ctx.progress(t);
      while (t.status === 'running' && !ctx.signal.cancelled) {
        await sleep(1500);
        t = await getChipAtlas(t.id);
        ctx.progress(t);
      }
      if (t.status === 'error') throw new Error(t.message);
      return t;
    }, { ...(owner ?? {}), label: `ChIP-Atlas · ${owner?.label ?? data.nfr}` });
  };
  const running = job?.status === 'loading';
  // the choice is known once the first answer came (or the list has no experiments for this assembly: then all)
  const selectionReady = selection != null || (facets != null && !facets.present);
  const facetsCurrent = facetsAt?.key === requestKey;
  return (
    <div className="space-y-1.5 text-[11px]" data-testid="nfr-chipatlas">
      {meta && !meta.present && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-dashed border-amber-300 p-1.5 text-amber-800 dark:border-amber-700 dark:text-amber-200" data-testid="nfr-chipatlas-metadata">
          {meta.loading ? <span>{meta.message || 'Downloading the ChIP-Atlas experiment list…'}</span> : <>
            <span>ChIP-Atlas' experiment list is not on this computer yet (about 340 MB, downloaded once).</span>
            <AnalysisButton theme="fuchsia" variant="soft" onClick={() => { void downloadChipAtlasMetadata().then(refreshMeta); }} data-testid="nfr-chipatlas-download">Download it</AnalysisButton>
          </>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input type="text" value={factors} onChange={e => setFactors(e.target.value)} aria-label="Factors" data-testid="nfr-chipatlas-factors"
          placeholder="Factors, e.g. vfl, Trl, CTCF" title={`ChIP-Atlas peaks (q < 1e-5) of these factors (antigens) over this run's window. Up to ${perFactor} matching experiments per factor, newest first (~0.4 MB each, cached).`}
          className={`${inputCls} min-w-[14rem] flex-1 px-1.5`} />
        <label className="flex items-center gap-1" title="Experiments per factor (newest first)">max
          <input type="number" min={1} max={30} value={perFactor} onChange={e => setPerFactor(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
            className={`${inputCls} w-12`} aria-label="Experiments per factor" />
        </label>
        <AnalysisButton theme="fuchsia" variant="soft" onClick={start} data-testid="nfr-chipatlas-start"
          disabled={!meta?.present || !list.length || running || !selectionReady || (facetsCurrent && facets?.present && facets.matching === 0)}
          title={!selectionReady ? 'Reading the experiment list…' : undefined}>
          {running ? (task ? `Fetching ${task.done}/${task.total}…` : 'Starting…') : 'Check peaks'}
        </AnalysisButton>
      </div>
      {meta?.present && facets?.present && selection && <ExperimentFilter facets={facets} current={facetsCurrent} selection={selection} onChange={choose} factors={list} />}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {job?.status === 'error' && <AnalysisStatus kind="error">{job.error}</AnalysisStatus>}
      {task?.status === 'complete' && task.factors_out && <ChipResult task={task} data={data} names={names} width={width} />}
    </div>
  );
}

/** Cell type class and cell types of the experiments to use (ChIP-Atlas metadata), with how many match. */
function ExperimentFilter({ facets, current, selection, onChange, factors }: {
  facets: ChipAtlasExperiments;
  /** The counts answer this selection and these factors (else they are being asked for). */
  current: boolean;
  selection: ChipAtlasSelection; onChange: (s: ChipAtlasSelection) => void; factors: string[];
}) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState('');
  const cls = selection.cellTypeClasses[0] ?? '';
  const types = facets.cell_types.filter(c => (!cls || c.cell_type_class === cls) && (!needle || c.key.toLowerCase().includes(needle.toLowerCase())));
  const picked = new Set(selection.cellTypes);
  const toggle = (name: string, on: boolean) => onChange({ ...selection, cellTypes: on ? [...selection.cellTypes, name] : selection.cellTypes.filter(x => x !== name) });
  const perFactor = factors.map(f => `${f} ${facets.factors[f] ?? 0}`).join(', ');
  return (
    <div className="space-y-1" data-testid="nfr-chipatlas-filter">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-500" title="ChIP-Atlas experiments to use, by cell type class and cell type (tissue, stage or cell line); remembered per assembly">Experiments</span>
        <select value={cls} aria-label="Cell type class" data-testid="nfr-chipatlas-class"
          onChange={e => onChange({ cellTypeClasses: e.target.value ? [e.target.value] : [], cellTypes: [] })} className={inputCls}>
          <option value="">all classes</option>
          {facets.cell_type_classes.map(c => <option key={c.key} value={c.key}>{c.key} ({c.count})</option>)}
        </select>
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} data-testid="nfr-chipatlas-types-toggle"
          className={`${inputCls} max-w-[16rem] truncate text-left`} title={selection.cellTypes.join(', ') || 'Every cell type'}>
          {selection.cellTypes.length ? `${selection.cellTypes.length} cell type${selection.cellTypes.length === 1 ? '' : 's'}: ${selection.cellTypes.slice(0, 2).join(', ')}${selection.cellTypes.length > 2 ? '…' : ''}` : 'all cell types'} ▾
        </button>
        <span className="tabular-nums text-gray-500" data-testid="nfr-chipatlas-count" title={factors.length ? `Matching experiments per factor: ${perFactor}` : undefined}>
          {current ? `${facets.matching.toLocaleString()} of ${facets.total.toLocaleString()} match` : 'counting…'}
        </span>
        {(selection.cellTypeClasses.length > 0 || selection.cellTypes.length > 0) && (
          <button type="button" onClick={() => onChange(ALL_EXPERIMENTS)} className="text-fuchsia-700 hover:underline dark:text-fuchsia-300" data-testid="nfr-chipatlas-all">all</button>
        )}
      </div>
      {open && (
        <div className="rounded border border-gray-200 p-1.5 dark:border-gray-700" data-testid="nfr-chipatlas-types">
          <input type="search" value={needle} onChange={e => setNeedle(e.target.value)} placeholder="Filter cell types" aria-label="Filter cell types" className={`${inputCls} mb-1 w-48`} />
          <ul className="max-h-40 overflow-y-auto">
            {types.slice(0, 300).map(c => (
              <li key={`${c.cell_type_class}|${c.key}`}>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={picked.has(c.key)} onChange={e => toggle(c.key, e.target.checked)} data-testid="nfr-chipatlas-type" data-type={c.key} />
                  {c.key} <span className="text-ink-secondary">{c.cell_type_class !== cls ? `${c.cell_type_class} · ` : ''}{c.count}</span>
                </label>
              </li>
            ))}
          </ul>
          {!types.length && <p className="text-ink-secondary">No cell type matches.</p>}
        </div>
      )}
    </div>
  );
}

function ChipResult({ task, data, names, width }: { task: ChipAtlasTask; data: NfrMotifs; names: string[]; width: number }) {
  const rows = (task.factors_out ?? []).filter(f => f.experiments.length);
  const here = (task.bound ?? []).filter(b => b.nfrs.includes(data.nfr));
  const missing = (task.factors_out ?? []).filter(f => !f.available).map(f => f.factor);
  return (
    <div className="space-y-1.5">
      <p data-testid="nfr-chipatlas-bound">
        <span className="font-medium text-gray-700 dark:text-gray-200">Bound here ({data.nfr}):</span>{' '}
        {here.length ? here.map(b => `${b.factor} (${pct(task.factors_out!.find(f => f.factor === b.factor)!.overlap[data.nfr]?.NFR)} of experiments)`).join(', ') : 'none of these factors'}
        {missing.length > 0 && <span className="text-ink-secondary"> · no ChIP-Atlas experiment for {missing.join(', ')} on {task.genome}</span>}
      </p>
      <table className="text-[11px] tabular-nums" data-testid="nfr-chipatlas-table">
        <thead className="text-left text-gray-500">
          <tr><th className="pr-2 font-medium">Factor</th><th className="pr-2 font-medium">experiments</th>
            {names.map(n => <th key={n} className="pr-2 font-medium" style={{ color: variantColor(n) }}>{n}</th>)}<th className="font-medium">NFR</th></tr>
        </thead>
        <tbody>
          {rows.map(f => {
            const o = f.overlap[data.nfr] ?? {};
            return (
              <tr key={f.factor} className="border-t border-gray-100 dark:border-white/5" data-testid="nfr-chipatlas-row" data-factor={f.factor}>
                <td className="pr-2">{f.factor}</td>
                <td className="pr-2 text-gray-500" title={'Share of the factor\'s experiments with a peak over each span. Experiments:\n' + f.experiments.map(e => `${e.id} ${e.cell_type_class}: ${e.cell_type}`).join('\n')}>{f.with_peak}/{f.experiments.length} with a peak in the window{f.available > f.experiments.length ? ` (of ${f.available})` : ''}</td>
                {names.map(n => <td key={n} className="pr-2">{pct(o[n])}</td>)}
                <td>{pct(o.NFR)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <PeakTrack task={task} data={data} names={names} width={width} />
    </div>
  );
}

function PeakTrack({ task, data, names, width }: { task: ChipAtlasTask; data: NfrMotifs; names: string[]; width: number }) {
  const rows = (task.factors_out ?? []).filter(f => f.experiments.some(e => e.peaks.length));
  const lane = 6, top = 6 + names.length * (lane + 2) + 4, rowH = 14;
  const height = top + rows.length * rowH + 22;
  const [w0, w1] = data.window;
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(0, 0, w, h);
    const l = 90, r = w - 8;
    const px = (v: number) => l + ((v - w0) / Math.max(1, w1 - w0)) * (r - l);
    names.forEach((n, i) => {
      const s = data.spans[n];
      if (!s) return;
      ctx.fillStyle = variantColor(n); ctx.globalAlpha = 0.85;
      ctx.fillRect(px(s[0]), 6 + i * (lane + 2), Math.max(2, px(s[1]) - px(s[0])), lane); ctx.globalAlpha = 1;
      ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'right'; ctx.fillText(n, l - 6, 6 + i * (lane + 2) + lane);
    });
    rows.forEach((f, i) => {
      const y = top + i * rowH;
      ctx.fillStyle = '#8b93a1'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.fillText(f.factor, l - 6, y + 10);
      const k = f.experiments.length || 1;
      for (const e of f.experiments) for (const [a, b] of e.peaks) {
        if (b < w0 || a > w1) continue;
        ctx.fillStyle = '#0d9488'; ctx.globalAlpha = Math.min(0.9, 0.15 + 0.85 / k);
        ctx.fillRect(px(Math.max(a, w0)), y + 2, Math.max(1.5, px(Math.min(b, w1)) - px(Math.max(a, w0))), rowH - 4);
      }
      ctx.globalAlpha = 1;
    });
    ctx.fillStyle = '#8b93a1'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${bp(w0)}–${bp(w1)} · darker: more experiments with a peak there`, (l + r) / 2, h - 4);
  }, [rows, names.join('|'), data.spans, w0, w1, top]);
  if (!rows.length) return null;
  return <NfrCanvasExport draw={draw} width={width} height={height} filename={`nfr-chipatlas-${data.nfr}`} title="ChIP-Atlas peaks" testId="nfr-chipatlas-track"
    dataTsv={() => ['factor\texperiment\tstart\tend', ...rows.flatMap(f => f.experiments.flatMap(e => e.peaks.map(p => [f.factor, e.id, p[0], p[1]].join('\t'))))].join('\n')} />;
}
