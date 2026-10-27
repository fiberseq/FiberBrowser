/**
 * The nucleosome panel (native/nucleosome_panel/DESIGN.md §6): per observation (dataset panel, haplotype pop-out,
 * strand split, linked locus, graph path), footprint sizes as density-matched z and coarse calls (short / mono /
 * long / multi / can't tell; named classes only with an absolute calibration), per-molecule spacing and
 * regularity, and array segments (regular, disordered, undetermined, low information) with the disruption events
 * (undersized runs, missing nucleosomes). Computed by FiberHMM's nuc module on the complete molecules, live in the
 * view (Compute) or read from an opened scan; no nucleosome maths runs here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import type { AnalysisPanelProps } from '../../plugins/types';
import { AnalysisButton, AnalysisPanelHeader } from '../../components/controls/shared/AnalysisControls';
import { AnalysisPanelShell } from '../../components/controls/shared/AnalysisPanelShell';
import { JobStatus } from '../../components/controls/shared/JobStatus';
import { nucStatus, nucSummary } from './api';
import { isLiveJob, useNucJob } from './nucJob';
import { nucObservations, observationDatasets, observationsKey, observationViews } from './planner';
import type { NucCalibrationSummary, NucDatasetStatus, NucObservation, NucObservationSummary, NucPanelState } from './types';

const pct = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? '' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(digits));

/** Coarse classes in the mix bar: colour and label (can't tell / edge-truncated hatched, never dropped). */
export const COARSE_BAR: Array<{ key: keyof NonNullable<NucObservationSummary['sizes']>['coarse']; label: string; color: string; hatched?: boolean }> = [
  { key: 'short', label: 'short (z < −2)', color: '#f59e0b' },
  { key: 'mono', label: 'mono', color: '#16a34a' },
  { key: 'long', label: 'long (z > 2)', color: '#0d9488' },
  { key: 'multi2', label: 'multi (2)', color: '#2563eb' },
  { key: 'multi3', label: 'multi (3+)', color: '#7c3aed' },
  { key: 'cant_tell', label: "can't tell", color: '#9ca3af', hatched: true },
  { key: 'edge_truncated', label: 'edge-truncated', color: '#d1d5db', hatched: true },
];

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

export function CoarseMixBar({ sizes }: { sizes: NucObservationSummary['sizes'] }) {
  if (!sizes || !sizes.footprints) return <span className="text-ink-muted">—</span>;
  const total = sizes.footprints;
  return <div className="flex h-3 w-28 overflow-hidden rounded-sm border border-line dark:border-white/10" data-testid="nuc-coarse-bar"
    title={COARSE_BAR.map(c => `${c.label}: ${sizes.coarse[c.key]} (${pct(sizes.coarse[c.key] / total)})`).join('\n') + `\nTF calls among them: ${sizes.tf}`}>
    {COARSE_BAR.map(c => {
      const w = sizes.coarse[c.key] / total;
      if (!w) return null;
      return <span key={c.key} style={{ width: `${w * 100}%`, background: c.hatched
        ? `repeating-linear-gradient(135deg, ${c.color} 0 2px, transparent 2px 4px)` : c.color }} />;
    })}
  </div>;
}

function useDatasetStatus(ids: string[], revision: number, parameters?: Record<string, unknown>) {
  const [status, setStatus] = useState<{ available?: boolean; reason?: string; datasets: NucDatasetStatus[] }>({ datasets: [] });
  const key = JSON.stringify([ids, parameters ?? null]);
  useEffect(() => {
    if (!ids.length) { setStatus({ datasets: [] }); return; }
    let live = true;
    nucStatus(ids, parameters).then(s => { if (live) setStatus(s); }).catch(e => { if (live) setStatus({ available: false, reason: String(e?.message ?? e), datasets: [] }); });
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
  const revision = useNucJob(s => s.revision);
  const status = useDatasetStatus(datasetIds, revision, settings.parameters);
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
      nucSummary(shown, ctl.signal)
        .then(res => { if (!ctl.signal.aborted) { setSummaries(Object.fromEntries(res.observations.map(o => [o.obsId, o]))); setError(''); } })
        .catch(e => { if (!ctl.signal.aborted) setError(String(e?.message ?? e)); })
        .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    }, 350);
    return () => { clearTimeout(timerId); ctl.abort(); };
  }, [shownKey, revision]);   // eslint-disable-line react-hooks/exhaustive-deps

  const setSettings = (patch: Partial<NucPanelState>) => {
    if (!panelId) return;
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === panelId ? { ...p, nucleosomes: { ...(p.nucleosomes ?? {}), ...patch } } : p) }));
  };

  const live = isLiveJob(job);
  const compute = () => {
    if (!shown.length || !panelId) return;
    // Every column's own view: a linked locus or a panel at its own view computes there.
    void useNucJob.getState().submit({
      datasets: observationDatasets(shown), views: observationViews(shown),
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
      {shown.length > 0 && <div className="overflow-x-auto">
        <table className="w-full text-[11px]" data-testid="nuc-table">
          <thead className="text-ink-muted">
            <tr>
              <th className="px-1 text-left">Observation</th>
              <th className="px-1 text-right" title="Molecules with outputs / records in view">Molecules</th>
              <th className="px-1 text-left" title="Coarse size calls of footprints centred in view (nucleosome and TF calls)">Size classes</th>
              <th className="px-1 text-right" title="Footprints whose size can't be told, or that touch a read end">Can't tell</th>
              <th className="px-1 text-right" title="Per-molecule repeat length (median of dyad gaps): median [IQR]">NRL</th>
              <th className="px-1 text-right" title="Per-molecule regularity S: median">S</th>
              <th className="px-1 text-right" title="Molecules too short for a repeat length">Too short</th>
              <th className="whitespace-nowrap px-1 text-right" title="Share of segmented bases in view: regular / disordered / undetermined / low information">Reg · Dis · Und · Low</th>
              <th className="px-1 text-right" title="Undersized footprint runs and missing nucleosomes in view">Events</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(o => <ObservationRow key={o.obsId} obs={o} summary={summaries[o.obsId]} loading={loading} onHide={() => setSettings({ hidden: [...hidden, o.obsId] })} />)}
          </tbody>
        </table>
      </div>}
      {notComputed > 0 && !live && <p className="text-ink-secondary" data-testid="nuc-not-computed">
        {notComputed === shown.length ? 'Nothing computed in view yet: ' : 'Some molecules in view have no outputs yet: '}
        Compute in view, or open a nucleosome scan in the Hub.</p>}
      {hidden.size > 0 && <button type="button" className="text-[11px] text-ink-muted underline" onClick={() => setSettings({ hidden: [] })} data-testid="nuc-show-hidden">
        Show {hidden.size} hidden column{hidden.size === 1 ? '' : 's'}</button>}
      <p className="text-[11px] text-ink-muted">Named classes (hexasome, octasome, chromatosome) need an absolute calibration (601 arrays or spike-ins); without one sizes are density-matched z and coarse calls.</p>
    </div>
  </AnalysisPanelShell>;
}

function ObservationRow({ obs, summary, loading, onHide }: { obs: NucObservation; summary?: NucObservationSummary; loading: boolean; onHide: () => void }) {
  const s = summary;
  const nrl = s?.spacing?.nrl.quantiles;
  const seg = s?.segments;
  return <tr className="border-t border-gray-100 dark:border-gray-800" data-testid="nuc-row" data-obs={obs.obsId} data-kind={obs.kind}>
    <td className="px-1 text-left">
      <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: obs.color }} />
      <span className="align-middle" title={`${obs.label}${obs.kind === 'graph' ? ' (graph path: every molecule over the path, insertions included)' : ''}${obs.readIds ? ` · ${obs.readIds.length} reads` : ''}`}>{obs.label}</span>
      <button type="button" aria-label={`Hide ${obs.label}`} className="ml-1 text-ink-muted hover:text-ink" onClick={onHide}>×</button>
      {s?.sources?.some(x => x !== 'live') && <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300"
        data-testid="nuc-source" title={`Outputs read from ${s.sources.filter(x => x !== 'live').map(x => x === 'annotated' ? "the BAM's own nucleosome groups" : 'an opened scan').join(' and ')}${s.sources.includes('live') ? ', the rest computed here' : ''}`}>
        {s.sources.includes('annotated') ? 'BAM tags' : 'scan'}</span>}
    </td>
    {s?.error ? <td colSpan={8} className="px-1 text-left text-amber-700 dark:text-amber-300">{s.error}</td> : <>
      <td className="whitespace-nowrap px-1 text-right" data-testid="nuc-molecules"
        title={s ? [`${s.computed ?? 0} molecules with outputs of ${s.records ?? 0} records in view`,
          s.undecodable ? `${s.undecodable} records without calls FiberHMM can read` : '',
          s.notComputed ? `${s.notComputed} not computed yet` : '',
          s.lowInformation ? `${s.lowInformation} below the low-information floor (counted, left out of segments)` : ''].filter(Boolean).join('\n') : undefined}>
        {s ? `${(s.computed ?? 0).toLocaleString()} / ${(s.records ?? 0).toLocaleString()}` : loading ? '…' : ''}
        {s?.lowInformation ? <span className="text-ink-muted"> · {s.lowInformation} low</span> : null}</td>
      <td className="px-1 text-left"><CoarseMixBar sizes={s?.sizes} /></td>
      <td className="px-1 text-right">{pct(s?.sizes?.cantTellFraction)}</td>
      <td className="whitespace-nowrap px-1 text-right" data-testid="nuc-nrl">{nrl ? `${num(nrl[2])} [${num(nrl[1])}–${num(nrl[3])}]` : ''}</td>
      <td className="px-1 text-right">{num(s?.spacing?.regularity?.[2], 2)}</td>
      <td className="px-1 text-right">{pct(s?.spacing?.tooShortFraction)}</td>
      <td className="whitespace-nowrap px-1 text-right" data-testid="nuc-segments">{seg?.bp ? `${pct(seg.regular)} · ${pct(seg.disordered)} · ${pct(seg.undetermined)} · ${pct(seg.low_information)}` : ''}</td>
      <td className="px-1 text-right">{seg ? `${seg.undersizedRuns} · ${seg.missingNucleosomes}` : ''}</td>
    </>}
  </tr>;
}

export default NucleosomePanel;
