/** The nucleosome panel: single-fibre regularity per dataset and cluster (pool → find → compare). One header (title,
 * Settings, help, Analyse this view), one status line, then three tabs: the shared geometries (with each series'
 * score and patch shares), the charts and detail tables, and the association with a site. Older sessions' Sites,
 * Spacing and At a site keys (`mode`, `window`, `anchor`…) are ignored: they open on the geometries. */
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useFrozenWhileInactive } from '../../hooks/usePanelDisplayStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import type { AnalysisPanelProps } from '../../plugins/types';
import { AnalysisButton, AnalysisPanelHeader } from '../../components/controls/shared/AnalysisControls';
import { AnalysisPanelShell } from '../../components/controls/shared/AnalysisPanelShell';
import { Info } from './PanelPrimitives';
import { nucStatus } from './api';
import { useHubData } from '../hub/hubData';
import { clearAutoAnalyseVeto, isLiveJob, isNucBusy, isReplacedJob, useNucBusy, useNucJob } from './nucJob';
import { NucJobLine } from './NucJobLine';
import { keepsGeometriesOutOfView, releaseGeoRun } from './geoRuns';
import { nucObservations, observationDatasets, observationViews } from './planner';
import { RegularityView } from './RegularityView';
import { Row } from './PatchGeometryView';
import { DEFAULT_REG_PARAMS } from './regParams';
import type { NucCalibrationSummary, NucDatasetStatus, NucPanelState, NucRegTab } from './types';

const num = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(digits));

const NO_SETTINGS: NucPanelState = {};

/** The panel's tabs (every older `mode` opens on the first). */
const NUC_TABS: Array<{ key: NucRegTab; label: string }> = [
  { key: 'geometries', label: 'Geometries' },
  { key: 'charts', label: 'Charts' },
  { key: 'site', label: 'Near a site' },
];

function calibrationText(c: NucCalibrationSummary | null | undefined): string {
  if (!c) return 'not calibrated yet';
  const where = c.source === 'scan' ? 'from the opened scan' : c.source === 'cache' ? 'stored' : 'computed';
  return `${c.method === 'self' ? 'self' : 'thinning'} calibration ${where}`;
}

function calibrationTitle(c: NucCalibrationSummary | null | undefined): string {
  if (!c) return 'Analyse calibrates each dataset once, on a fixed sample of its own data (never the view).';
  return [
    `${calibrationText(c)} · digest ${c.digest} · settings ${c.settingsHash.slice(0, 8)} · nuc ${c.version}`,
    `pooled repeat length ${num(c.nrlPooled, 1)} bp · low-information floor λ ${num(c.lambdaFloor, 3)}`,
    c.supported && c.supported.length === 2 ? `supported λ ${num(c.supported[0], 3)}–${num(c.supported[1], 3)}` : 'no supported λ range',
    `${c.regions} calibration window${c.regions === 1 ? '' : 's'} (scope ${c.scope ?? 'data'})`,
  ].join('\n');
}

/** How many settings differ from the defaults (shown on the Settings button). */
export function changedSettings(settings: NucPanelState): number {
  const reg = settings.regularity ?? {};
  const params = (reg.params ?? {}) as Record<string, unknown>;
  const defaults = DEFAULT_REG_PARAMS as unknown as Record<string, unknown>;
  let n = Object.keys(params).filter(k => params[k] != null && JSON.stringify(params[k]) !== JSON.stringify(defaults[k])
    && !((k === 'mask_open_bp' || k === 'thin_per_kb') && params[k] === null)).length;
  if ((reg.cohort ?? (reg.spanning ? 'spanning' : 'overlapping')) !== 'overlapping') n++;
  if (reg.autoAnalyse && reg.autoAnalyse !== 'first') n++;
  const ps = reg.patches ?? {};
  if (ps.open === false) n++;
  const { low, ...rest } = ps.params ?? {};
  n += Object.values(rest).filter(v => v !== undefined).length;
  if (low === null) n++; else if (low) n += Object.values(low).filter(v => v !== undefined).length;
  n += Object.values(ps.reference ?? {}).filter(v => v != null && v !== '').length;
  if (ps.origin != null) n++;
  return n;
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
  // Hidden by full view: the panel's inputs stay as they were when it was hidden, so nothing is asked or started
  // meanwhile; shown again, it catches up once with whatever changed (usePanelDisplayStore.PanelActiveContext).
  const settings: NucPanelState = useFrozenWhileInactive(panel?.nucleosomes ?? NO_SETTINGS);
  // The observations: planned again whenever panels, the view, datasets, filters or cluster selections change.
  const deps = useBrowserStore(useShallow(s => [s.panels, s.datasets, s.chrom, s.start, s.end, s.filteredReadIds, s.clusterFocus,
    s.selectedClusters, s.clusterAssignments, s.selectedDatasets]));
  // Split panels' own reads resolve in their own store (clusterWindows reads it).
  const splitReads = useSplitPanelStore(s => s.reads);
  const observations = useFrozenWhileInactive(useMemo(() => nucObservations(useBrowserStore.getState(), dark), [...deps, splitReads, dark]));  // eslint-disable-line react-hooks/exhaustive-deps
  // Columns hidden under Settings (Columns), with a one-line way back.
  const hidden = new Set(settings.hidden ?? []);
  const shown = observations.filter(o => !hidden.has(o.obsId));
  const datasetIds = observationDatasets(observations);
  const job = useNucJob(s => s.job);
  const jobPanel = useNucJob(s => s.panelId);
  const jobError = useNucJob(s => s.error);
  useEffect(() => { if (panelId) void useNucJob.getState().followLatest(panelId); }, [panelId]);
  // The panel's geometries (hub set, track above the reads) go with it: when it is closed, not when it is only laid
  // out of an export of another panel (geoRuns.releaseGeoRun).
  useEffect(() => () => { if (panelId) releaseGeoRun(panelId, keepsGeometriesOutOfView, useBrowserStore.getState().panels); }, [panelId]);
  // Opened or closed scans change what is loaded (their rows, their calibration): status follows.
  const scansKey = useHubData(s => s.scans.map(x => `${x.scanId}:${x.manifestDigest}`).join(','));
  // The observed datasets' content (a live-lift settings change, a reload) and the duplicate policy change which
  // records the columns hold.
  const includeDuplicates = useFrozenWhileInactive(useBrowserStore(s => Boolean(s.showDuplicateReads)));
  // The toolbar's QC-fail toggle (incl. FiberHMM chimeras) changes them too; api.ts sends it with the duplicate policy.
  const includeQcFail = useFrozenWhileInactive(useBrowserStore(s => Boolean(s.showQcFailReads)));
  const contentKey = useBrowserStore(s => s.datasets.map(d => `${d.id}:${d.source_identity ?? ''}`).join(',') + `|${s.refreshGeneration}`);
  const revision = useFrozenWhileInactive(`${useNucJob(s => s.revision)}|${scansKey}|${contentKey}|${includeDuplicates}|qc${includeQcFail}`);
  const status = useDatasetStatus(datasetIds, revision, settings.parameters, includeDuplicates);
  const view = useFrozenWhileInactive(useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end }))));
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The view's datasets without nucleosome calls yet (the Regularity view's answer): Analyse does those first. */
  const [todo, setTodo] = useState<string[]>([]);

  const setSettings = (patch: Partial<NucPanelState>) => {
    if (!panelId) return;
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === panelId ? { ...p, nucleosomes: { ...(p.nucleosomes ?? {}), ...patch } } : p) }));
  };

  const live = isLiveJob(job);
  /** An Analyse runs or is being submitted (by any panel or a cluster view). */
  const busy = useNucBusy();
  /** Analyse the columns' views (all, or these datasets'). Never while an Analyse runs: the server runs one at a time
   * and a new request would replace the running one (this panel's or another's), so the button is disabled meanwhile. */
  const analyse = (datasets: string[] | null, user = false): Promise<void> => {
    const cols = datasets ? shown.filter(o => datasets.includes(o.datasetId)) : shown;
    if (!cols.length || !panelId || isNucBusy()) return Promise.resolve();
    // The user's own Analyse lifts a Cancel's hold on these views (automatic starts may analyse them again).
    if (user) clearAutoAnalyseVeto(observationViews(cols));
    // Every column's own view: a linked locus or a panel at its own view computes there.
    return useNucJob.getState().submit({
      datasets: observationDatasets(cols), views: observationViews(cols), include_duplicates: includeDuplicates,
      ...(settings.parameters ? { parameters: settings.parameters } : {}),
    }, panelId);
  };
  // The one Analyse button: the view's unanalysed datasets when there are some, else every column (current outputs
  // are reused).
  const compute = () => { void analyse(todo.length ? todo : null, true); };

  const byDataset = new Map(status.datasets.map(d => [d.datasetId, d]));
  const reg = settings.regularity ?? {};
  const tab: NucRegTab = reg.view ?? 'geometries';
  const changed = changedSettings(settings);
  const ownJob = job && jobPanel === panelId ? job : null;
  const elapsed = ownJob ? Math.max(0, Math.round((ownJob.finished_at ?? Date.now() / 1000) - ownJob.created_at)) : 0;
  // A finished Analyse is one short chip beside the locus; progress, Cancel, a cancel or an error get their own line.
  const done = !!ownJob && !live && ownJob.status === 'complete' && !isReplacedJob(ownJob);
  const locus = `${view.chrom}:${(view.start + 1).toLocaleString()}–${view.end.toLocaleString()}`;

  // Columns (settings drawer): every panel, pop-out, strand and path is a column; any can be hidden.
  const columnsRow = observations.length > 1 ? <Row label="Columns" testId="nuc-columns-row">
    {observations.map(o => <label key={o.obsId} className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
      <input type="checkbox" checked={!hidden.has(o.obsId)} data-testid="nuc-column-toggle" data-obs={o.obsId}
        disabled={!hidden.has(o.obsId) && shown.length <= 1}
        onChange={e => setSettings({ hidden: e.target.checked ? [...hidden].filter(x => x !== o.obsId) : [...hidden, o.obsId] })} />
      <span className="h-2 w-2 rounded-sm" style={{ background: o.color }} />{o.label}</label>)}
  </Row> : null;
  const header = <div data-testid="nuc-header">
      <AnalysisPanelHeader theme="emerald" title={locus}
        meta={done ? <span role="status" data-testid="nuc-job" data-state="complete" title={ownJob!.timings ? `Calibration ${ownJob!.timings.calibration.toFixed(1)} s · molecules ${ownJob!.timings.molecules.toFixed(1)} s` : undefined}>
          analysed in {elapsed} s{ownJob!.timings && <span className="sr-only" data-testid="nuc-timings"> (calibration {ownJob!.timings.calibration.toFixed(1)} s · molecules {ownJob!.timings.molecules.toFixed(1)} s)</span>}</span> : undefined}
        actions={<>
          <AnalysisButton theme="emerald" variant={settingsOpen ? 'soft' : 'quiet'} data-testid="nuc-settings-toggle" aria-expanded={settingsOpen}
            title="Every parameter: the regularity score, molecules, patches, geometries, the reference and positions" onClick={() => setSettingsOpen(v => !v)}>
            Settings{changed ? <span className="ml-1 rounded-full bg-emerald-100 px-1 text-[10px] text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200" data-testid="nuc-settings-changed">{changed}</span> : null}</AnalysisButton>
          <Info label="the nucleosome panel">
            <p>Each molecule is scored in sliding windows: the strongest spectral peak at nucleosome repeat lengths, against the spectrum’s median, as a log2 ratio. The local repeat length is that peak’s period. Random packing places each window’s own footprints at random and simulates marks at the window’s own rates; its median is each dataset’s reference.</p>
            <p>The score is turned into discrete patches on each molecule: a <strong>high-regularity</strong> patch starts at a window above the start threshold and extends while windows stay above the extend threshold; a <strong>low-regularity</strong> patch is the mirror below the reference (chromatin less regular than random packing of the same nucleosomes). A single window without a score is bridged; two or more end the patch. Patches shared by many molecules form <strong>geometries</strong>. Marking density raises scores, so comparisons are made within m6A/kb quintiles.</p>
            <p>In the read lane, a hatched stretch had too few calls for a score; an empty one is beyond the reach of any window. Changing the settings recomputes the layers for Cluster, Sort and the read lanes; nucleosome calls and calibration stay as they are.</p>
            <p>Analyse runs FiberHMM’s nucleosome module on complete molecules. Calibration comes from a fixed sample of each dataset, not this view, and is stored. Opened scans and BAM tags are reused first; annotations with changed calls are ignored. Live-lift results are computed on source records and projected with the calls.</p>
            {ownJob && <p>Last analysis: {ownJob.stage ?? ownJob.status}. {ownJob.message ?? ownJob.error ?? ''} · {elapsed} s elapsed.</p>}
            <div className="mt-2 space-y-2" data-testid="nuc-datasets">{datasetIds.map(id => {
              const d = byDataset.get(id), cal = d?.active?.calibration ?? d?.storedCalibration ?? null;
              const label = useBrowserStore.getState().datasets.find(x => x.id === id)?.label ?? id;
              const r = job?.results?.[id];
              return <div key={id} data-testid="nuc-calibration" data-source={cal?.source ?? 'none'}><strong>{label}</strong><p>{d?.error ?? calibrationText(cal)}</p>
                <p className="whitespace-pre-line text-ink-secondary">{calibrationTitle(cal)}</p>{r && <p>{r.computed} computed · {r.cached} reused</p>}</div>;
            })}</div></Info>
          <AnalysisButton theme="emerald" variant="primary" data-testid="nuc-compute" disabled={!shown.length || status.available === false || busy}
            title={status.available === false ? status.reason : busy ? 'An Analyse is running: one runs at a time'
              : todo.length ? 'Compute nucleosome calls and regularity for this view’s unanalysed datasets' : 'Analyse complete molecules in each read panel’s view; current outputs are reused'}
            onClick={compute}>Analyse this view</AnalysisButton></>} />
  </div>;
  // One status line under the header: availability, the Analyse's progress (with Cancel) or how long it took, errors.
  const summary = <>
      {status.available === false && <p role="status" className="text-amber-700 dark:text-amber-300" data-testid="nuc-unavailable">{status.reason}</p>}
      {ownJob && !done && <NucJobLine job={ownJob} />}
      {jobError && <p role="status" className="text-red-700 dark:text-red-300" data-testid="nuc-error">{jobError}</p>}
  </>;
  return <AnalysisPanelShell tabs={shown.length ? NUC_TABS : []} activeTab={tab} onTabChange={k => setSettings({ regularity: { ...reg, view: k === 'geometries' ? undefined : k } })}
    theme="emerald" layout="standard" bodyMode="fill" header={header} summary={summary}
    isFullView={isFullView} className="flex h-full min-h-0 w-full flex-col" bodyClassName="min-h-0 min-w-0 break-words">
    <div data-testid="nuc-panel" className="flex min-h-full flex-col gap-2.5">
      {!shown.length && <p className="text-ink-secondary">Open a dataset panel: each panel, haplotype pop-out, strand split and graph path becomes a column here.</p>}
      {shown.length > 0 && <RegularityView observations={shown} settings={settings} setSettings={setSettings}
        revision={revision} includeDuplicates={includeDuplicates} panelId={panelId} analysing={live && jobPanel === panelId}
        onAnalyse={(datasets, user) => analyse(datasets, user)} settingsOpen={settingsOpen} onTodo={setTodo} extraSettings={columnsRow} />}
      {hidden.size > 0 && <button type="button" className="self-start text-[11px] text-ink-muted underline" onClick={() => setSettings({ hidden: [] })} data-testid="nuc-show-hidden">
        Show {hidden.size} hidden column{hidden.size === 1 ? '' : 's'}</button>}
    </div>
  </AnalysisPanelShell>;
}

export default NucleosomePanel;
