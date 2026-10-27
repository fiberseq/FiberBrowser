/**
 * The nucleosome panel (native/nucleosome_panel/DESIGN.md §6): per observation (dataset panel, haplotype pop-out,
 * strand split, linked locus, graph path), footprint sizes as density-matched z and coarse calls (short / mono /
 * long / multi / can't tell; named classes only with an absolute calibration), per-molecule spacing and
 * regularity, and array segments (regular, disordered, undetermined, low information) with the disruption events
 * (undersized runs, missing nucleosomes). Computed by FiberHMM's nuc module on the complete molecules, live in the
 * view (Compute) or read from an opened scan; no nucleosome maths runs here. Two modes: Segments (molecule-wide
 * outputs in view; every bar part, NRL bin and event highlights its molecules in every read track) and Window
 * (window metrics in one window, with an anchor's phasing and the dephasing readout against background anchors).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import type { AnalysisPanelProps } from '../../plugins/types';
import { AnalysisButton, AnalysisPanelHeader } from '../../components/controls/shared/AnalysisControls';
import { AnalysisPanelShell } from '../../components/controls/shared/AnalysisPanelShell';
import { JobStatus } from '../../components/controls/shared/JobStatus';
import { nucStatus, nucSummary, nucWindow, type NucCategory } from './api';
import { useHubData } from '../hub/hubData';
import type { HubSelected } from '../hub/hubState';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { isLiveJob, useNucJob } from './nucJob';
import { nucObservations, observationDatasets, observationsKey, observationViews } from './planner';
import { SegmentsView } from './SegmentsView';
import { PatchList } from './PatchList';
import { WindowControls, WindowView } from './WindowView';
import { categoryLabel, highlightCategory } from './selection';
import { resolveWindow, placeableHits } from './windowSource';
import type { NucCalibrationSummary, NucDatasetStatus, NucObservation, NucObservationSummary, NucPanelState, NucWindowObservation } from './types';

const num = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(digits));

const NO_HITS: HubSelected[] = [];

function calibrationText(c: NucCalibrationSummary | null | undefined): string {
  if (!c) return 'not calibrated yet';
  const where = c.source === 'scan' ? 'from the opened scan' : c.source === 'cache' ? 'stored' : 'computed';
  return `${c.method === 'self' ? 'self' : 'thinning'} calibration ${where}`;
}

function calibrationTitle(c: NucCalibrationSummary | null | undefined): string {
  if (!c) return 'Compute calibrates each dataset once, on a fixed sample of its own data (never the view).';
  return [
    `${calibrationText(c)} · digest ${c.digest} · settings ${c.settingsHash.slice(0, 8)} · nuc ${c.version}`,
    `pooled repeat length ${num(c.nrlPooled, 1)} bp · low-information floor λ ${num(c.lambdaFloor, 3)}`,
    c.supported && c.supported.length === 2 ? `supported λ ${num(c.supported[0], 3)}–${num(c.supported[1], 3)}` : 'no supported λ range',
    c.absolute ? 'absolute calibration: named classes available' : 'no absolute control: named classes are not shown',
    `${c.regions} calibration window${c.regions === 1 ? '' : 's'} (scope ${c.scope ?? 'data'})`,
  ].join('\n');
}

function useDatasetStatus(ids: string[], revision: number | string, parameters?: Record<string, unknown>, includeDuplicates = false) {
  const [status, setStatus] = useState<{ available?: boolean; reason?: string; datasets: NucDatasetStatus[] }>({ datasets: [] });
  const key = JSON.stringify([ids, parameters ?? null]);
  useEffect(() => {
    if (!ids.length) { setStatus({ datasets: [] }); return; }
    let live = true;
    nucStatus(ids, parameters, includeDuplicates).then(s => { if (live) setStatus(s); }).catch(e => { if (live) setStatus({ available: false, reason: String(e?.message ?? e), datasets: [] }); });
    return () => { live = false; };
  }, [key, revision]);   // eslint-disable-line react-hooks/exhaustive-deps
  return status;
}

export function NucleosomePanel({ isFullView, panelId }: AnalysisPanelProps) {
  const dark = useBrowserStore(s => s.darkMode);
  const panel = useBrowserStore(s => s.panels.find(p => p.id === panelId));
  const settings: NucPanelState = panel?.nucleosomes ?? {};
  // The observations: planned again whenever panels, the view, datasets, filters or cluster selections change.
  const deps = useBrowserStore(useShallow(s => [s.panels, s.datasets, s.chrom, s.start, s.end, s.filteredReadIds, s.clusterFocus,
    s.selectedClusters, s.clusterAssignments, s.selectedDatasets]));
  // Split panels' own reads resolve in their own store (clusterWindows reads it).
  const splitReads = useSplitPanelStore(s => s.reads);
  const observations = useMemo(() => nucObservations(useBrowserStore.getState(), dark), [...deps, splitReads, dark]);  // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = new Set(settings.hidden ?? []);
  const shown = observations.filter(o => !hidden.has(o.obsId));
  const datasetIds = observationDatasets(observations);
  const job = useNucJob(s => s.job);
  const jobPanel = useNucJob(s => s.panelId);
  const jobError = useNucJob(s => s.error);
  // Opened or closed scans change what is loaded (their rows, their calibration): summaries and status follow.
  const scansKey = useHubData(s => s.scans.map(x => `${x.scanId}:${x.manifestDigest}`).join(','));
  // The observed datasets' content (a live-lift settings change, a reload) and the duplicate policy change which
  // records the columns hold.
  const includeDuplicates = useBrowserStore(s => Boolean(s.showDuplicateReads));
  const contentKey = useBrowserStore(s => s.datasets.map(d => `${d.id}:${d.source_identity ?? ''}`).join(',') + `|${s.refreshGeneration}`);
  const revision = `${useNucJob(s => s.revision)}|${scansKey}|${contentKey}|${includeDuplicates}`;
  const status = useDatasetStatus(datasetIds, revision, settings.parameters, includeDuplicates);
  const [summaries, setSummaries] = useState<Record<string, NucObservationSummary>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const shownKey = observationsKey(shown);

  useEffect(() => {
    if (!shown.length) { setSummaries({}); return; }
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    const timerId = setTimeout(() => {
      setLoading(true);
      nucSummary(shown, ctl.signal, includeDuplicates)
        .then(res => { if (!ctl.signal.aborted) { setSummaries(Object.fromEntries(res.observations.map(o => [o.obsId, o]))); setError(''); } })
        .catch(e => { if (!ctl.signal.aborted) setError(String(e?.message ?? e)); })
        .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    }, 350);
    return () => { clearTimeout(timerId); ctl.abort(); };
  }, [shownKey, revision]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Window mode: the window (view, selected peak, hub hit, coordinates, hand-off), its anchor and background.
  const mode = settings.mode ?? 'segments';
  const view = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end })));
  const peaks = useBrowserStore(useShallow(s => mode === 'window' ? s.getAllPeaks().filter(p => !p.match && s.selectedPeaks.has(p.index)) : []));
  const hubSelected = useBrowserStore(s => s.featureHub?.selected ?? NO_HITS);
  const hubHits = placeableHits(hubSelected);
  const resolution = useMemo(() => resolveWindow(settings, { ...view, peaks, hubSelected }),
    [settings, view, peaks, hubSelected]);
  const resolutionKey = JSON.stringify(resolution);
  const [windowResults, setWindowResults] = useState<Record<string, NucWindowObservation>>({});
  const [windowLoading, setWindowLoading] = useState(false);
  const windowCtl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (mode !== 'window' || !shown.length || 'error' in resolution) { setWindowResults({}); return; }
    windowCtl.current?.abort();
    const ctl = new AbortController();
    windowCtl.current = ctl;
    const timerId = setTimeout(() => {
      setWindowLoading(true);
      nucWindow(shown, resolution.window, resolution.anchor, resolution.background, includeDuplicates, ctl.signal)
        .then(res => { if (!ctl.signal.aborted) { setWindowResults(Object.fromEntries(res.observations.map(o => [o.obsId, o]))); setError(''); } })
        .catch(e => { if (!ctl.signal.aborted) setError(String(e?.message ?? e)); })
        .finally(() => { if (!ctl.signal.aborted) setWindowLoading(false); });
    }, 500);
    return () => { clearTimeout(timerId); ctl.abort(); };
  }, [mode, shownKey, revision, resolutionKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Selection (segments mode): a bar part, NRL bin or event highlights the observation's molecules that have it.
  const [selection, setSelection] = useState<{ label: string; count: number } | null>(null);
  const select = (obs: NucObservation, category: NucCategory) => {
    highlightCategory(obs, category, includeDuplicates)
      .then(count => setSelection({ label: `${obs.label} · ${categoryLabel(category)}`, count }))
      .catch(e => setError(String(e?.message ?? e)));
  };

  const setSettings = (patch: Partial<NucPanelState>) => {
    if (!panelId) return;
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === panelId ? { ...p, nucleosomes: { ...(p.nucleosomes ?? {}), ...patch } } : p) }));
  };

  const live = isLiveJob(job);
  const compute = () => {
    if (!shown.length || !panelId) return;
    // Every column's own view: a linked locus or a panel at its own view computes there.
    void useNucJob.getState().submit({
      datasets: observationDatasets(shown), views: observationViews(shown), include_duplicates: includeDuplicates,
      ...(settings.parameters ? { parameters: settings.parameters } : {}),
    }, panelId);
  };

  const byDataset = new Map(status.datasets.map(d => [d.datasetId, d]));
  const notComputed = shown.filter(o => summaries[o.obsId] && !summaries[o.obsId].error
    && ((summaries[o.obsId].notComputed ?? 0) > 0 || !summaries[o.obsId].computed)).length;

  return <AnalysisPanelShell tabs={[]} activeTab="nuc" onTabChange={() => { }} theme="emerald" layout="standard" bodyMode="none"
    isFullView={isFullView} bodyClassName="min-w-0 break-words">
    <div data-testid="nuc-panel" className="space-y-2">
      <AnalysisPanelHeader theme="emerald"
        detail="Footprint sizes (density-matched z and coarse calls), spacing and array segments for every panel side by side, from FiberHMM's nucleosome module on the complete molecules."
        actions={<AnalysisButton theme="emerald" variant="primary" data-testid="nuc-compute" disabled={live || !shown.length || status.available === false}
          title={status.available === false ? status.reason : 'Calibrate each dataset once (a fixed sample of its own data) and compute every molecule in view'}
          onClick={compute}>Compute in view</AnalysisButton>} />
      {status.available === false && <p role="status" className="text-amber-700 dark:text-amber-300" data-testid="nuc-unavailable">{status.reason}</p>}
      {job && jobPanel === panelId && <JobStatus testId="nuc-job" title="Nucleosomes" state={job.status === 'complete' ? 'complete' : job.status === 'error' ? 'error' : job.status === 'cancelled' ? 'cancelled' : job.status === 'cancelling' ? 'cancelling' : job.status === 'queued' ? 'queued' : 'running'}
        stage={job.stage ?? null} message={live ? job.message : undefined} runKey={job.job_id} startedAt={job.created_at} finishedAt={job.finished_at ?? null}
        onCancel={live ? () => { void useNucJob.getState().cancel(); } : undefined}
        result={job.status === 'complete'
          ? Object.entries(job.results).map(([id, r]) => `${job.datasets.find(d => d.datasetId === id)?.label ?? id}: ${r.computed.toLocaleString()} computed, ${r.cached.toLocaleString()} reused`).join(' · ')
          : job.error ?? undefined} />}
      {(jobError || error) && <p role="status" className="text-red-700 dark:text-red-300" data-testid="nuc-error">{jobError || error}</p>}

      <section className="flex flex-wrap gap-1" data-testid="nuc-datasets">
        {datasetIds.map(id => {
          const d = byDataset.get(id);
          const cal = d?.active?.calibration ?? d?.storedCalibration ?? null;
          const label = useBrowserStore.getState().datasets.find(x => x.id === id)?.label ?? id;
          return <span key={id} data-testid="nuc-calibration" data-source={cal?.source ?? 'none'}
            className={`rounded-full border px-1.5 text-[10px] ${cal ? 'border-emerald-300 text-emerald-800 dark:border-emerald-700 dark:text-emerald-200' : 'border-line text-ink-muted dark:border-white/10'}`}
            title={d?.error ?? calibrationTitle(cal)}>{label}: {d?.error ? 'not readable' : calibrationText(cal)}</span>;
        })}
      </section>

      {!shown.length && <p className="text-ink-secondary">Open a dataset panel: each panel, haplotype pop-out, strand split and graph path becomes a column here.</p>}
      {shown.length > 0 && <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <div role="tablist" aria-label="Nucleosome panel mode" className="inline-flex overflow-hidden rounded border border-line dark:border-white/10">
          {(['segments', 'window'] as const).map(m => <button key={m} type="button" role="tab" aria-selected={mode === m} data-testid={`nuc-mode-${m}`}
            className={`px-2 py-0.5 ${mode === m ? 'bg-emerald-600 text-white' : 'text-ink-secondary hover:bg-gray-100 dark:hover:bg-white/10'}`}
            title={m === 'segments' ? 'Molecule-wide outputs in view: sizes, spacing, array segments' : 'Metrics within one window, phasing at an anchor, dephasing against background anchors'}
            onClick={() => setSettings({ mode: m })}>{m === 'segments' ? 'Segments' : 'Window'}</button>)}
        </div>
        {mode === 'segments' && selection && <span className="text-ink-secondary" data-testid="nuc-selection">
          Highlighting {selection.count.toLocaleString()} molecule{selection.count === 1 ? '' : 's'}: {selection.label}
          <button type="button" className="ml-1 underline" onClick={() => { useReadActionsStore.getState().clearHighlight(); setSelection(null); }}>clear</button></span>}
      </div>}
      {shown.length > 0 && mode === 'window' && <WindowControls settings={settings} setSettings={setSettings} resolution={resolution} hubCount={hubHits.length} />}
      {shown.length > 0 && mode === 'segments' && <SegmentsView observations={shown} summaries={summaries} loading={loading}
        onHide={obsId => setSettings({ hidden: [...hidden, obsId] })} onSelect={select} />}
      {shown.length > 0 && mode === 'segments' && <PatchList observations={shown} settings={settings} setSettings={setSettings} onSelect={select} />}
      {shown.length > 0 && mode === 'window' && <WindowView observations={shown} results={windowResults} loading={windowLoading} />}
      {notComputed > 0 && !live && mode === 'segments' && <p className="text-ink-secondary" data-testid="nuc-not-computed">
        {notComputed === shown.length ? 'Nothing computed in view yet: ' : 'Some molecules in view have no outputs yet: '}
        Compute in view, or open a nucleosome scan in the Hub.</p>}
      {hidden.size > 0 && <button type="button" className="text-[11px] text-ink-muted underline" onClick={() => setSettings({ hidden: [] })} data-testid="nuc-show-hidden">
        Show {hidden.size} hidden column{hidden.size === 1 ? '' : 's'}</button>}
      <p className="text-[11px] text-ink-muted">Named classes (hexasome, octasome, chromatosome) need an absolute calibration (601 arrays or spike-ins); without one sizes are density-matched z and coarse calls.</p>
    </div>
  </AnalysisPanelShell>;
}

export default NucleosomePanel;
