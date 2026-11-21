/**
 * The step a Plots plot is waiting for, as a button that runs it (no "run X first" without a way to run X): each
 * runs the panel's own command for the current view with its current settings, behind Plots, and the plot picks up
 * the new features by itself (the hub providers it reads change). A step that needs choices without a sensible
 * default opens its panel with the action ready, and says so.
 *
 * - peaks: Scan peaks (the toolbar's scan, current rules).
 * - select-peaks: Scan peaks if there are none, then select the peaks in view (Where = selected features).
 * - classes: Find classes in this view (Footprints › Classes, its current settings).
 * - geometries: the Nucleosomes panel on this view (it analyses, then calls patches and shared geometries).
 * - cluster: Cluster the reads (the toolbar's Cluster, current settings).
 * - groups: read groups need a choice (which split, which classes): opens Footprints › Classes.
 */
import { useEffect, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { runAppCommand } from '../../utils/appCommands';
import { findFootprintClassesInView, openPanelOnTab } from '../../utils/analysisCommands';
import { keepWorkspaceWhile, setWorkspace } from './workspace';
import { useLiveJobs } from '../../stores/liveJobsStore';
import { ConsensusProgress } from '../../components/controls/footprint-analysis/ConsensusProgress';
import { cancelConsensus } from '../../api/consensusWorkflow';
import { IndeterminateStripes } from '../../components/controls/shared/JobStatus';
import { AnalysisProgressStatus } from '../../components/controls/AnalysisProgressLine';
import { NucJobLine } from '../nucleosomes/NucJobLine';
import { isLiveJob, useNucJob } from '../nucleosomes/nucJob';

export type PrereqKind = 'peaks' | 'select-peaks' | 'classes' | 'geometries' | 'cluster' | 'groups';

export interface PrereqAction {
  label: string;
  /** While it runs, in place. */
  running: string;
  /** What the button does (its tooltip). */
  title: string;
  /** Opens a panel for a choice (the workspace goes to the browser). */
  opensPanel?: boolean;
  /** Run it: true when started; a string says why it could not. */
  run: () => boolean | string | Promise<boolean | string>;
}

const peaksInView = () => {
  const s = useBrowserStore.getState();
  return s.getAllPeaks().filter(p => (p.chrom == null || p.chrom === s.chrom) && p.end > s.start && p.start < s.end);
};

export const PREREQ_ACTIONS: Record<PrereqKind, PrereqAction> = {
  peaks: {
    label: 'Scan peaks', running: 'Waiting for Scan peaks…', title: 'Scan peaks in the view with the current peak rules',
    run: () => (runAppCommand('scan-peaks') === true ? true : 'Scan is not available right now (peaks locked, or a scan is running).'),
  },
  'select-peaks': {
    label: 'Scan and select peaks', running: 'Waiting for Scan peaks…', title: 'Scan peaks in the view (if there are none) and select them all',
    run: async () => {
      if (!peaksInView().length && runAppCommand('scan-peaks') !== true) return 'Scan is not available right now (peaks locked, or a scan is running).';
      const t0 = Date.now();
      while (!peaksInView().length && Date.now() - t0 < 60_000) await new Promise(r => setTimeout(r, 250));
      const peaks = peaksInView();
      if (!peaks.length) return 'No peaks in this view with the current rules.';
      useBrowserStore.getState().replacePeakSelection(peaks.map(p => p.index));
      return true;
    },
  },
  classes: {
    label: 'Find classes', running: 'Waiting for Find classes…', title: 'Run Find classes on this view with the Footprints panel\'s current settings (it works behind Plots)',
    run: async () => {
      const started = await keepWorkspaceWhile(() => findFootprintClassesInView());
      return started ? true : 'Find classes did not start: a run is shown already (Find again in Footprints › Classes), or the panel is busy.';
    },
  },
  geometries: {
    label: 'Find geometries', running: 'Waiting for Find geometries (nucleosome analysis, then shared geometries)…', title: 'Run the Nucleosomes panel on this view: its analysis, then patches and shared geometries (it works behind Plots)',
    run: () => {
      keepWorkspaceWhile(() => useBrowserStore.getState().openAnalysisPanel('nucleosomes' as never));
      return true;
    },
  },
  cluster: {
    label: 'Cluster reads', running: 'Waiting for Cluster reads…', title: 'Cluster the reads in the view with the current clustering settings',
    run: () => (keepWorkspaceWhile(() => runAppCommand('cluster-reads')) === true ? true : 'Clustering is not available right now.'),
  },
  groups: {
    label: 'Choose groups in Footprints', running: 'Opening Footprints…', opensPanel: true,
    title: 'Read groups need a choice (which split, which classes): opens Footprints › Classes to pick them',
    run: () => { setWorkspace('browser'); openPanelOnTab('footprint-analysis', 'states'); return true; },
  },
};

/** The button: runs the step, says it is running until the plot has what it needed (`done`) or the step fails. */
export function PrereqButton({ kind, done = false, testId }: { kind: PrereqKind; done?: boolean; testId?: string }) {
  const a = PREREQ_ACTIONS[kind];
  const [state, setState] = useState<'idle' | 'running' | { error: string }>('idle');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { if (done && state === 'running') setState('idle'); }, [done, state]);
  // A step that never produces anything (nothing found) stops saying it is running after a while.
  useEffect(() => {
    if (state !== 'running') return;
    const t = window.setTimeout(() => { if (alive.current) setState({ error: `${a.label}: nothing new yet. Check its panel.` }); }, 180_000);
    return () => window.clearTimeout(t);
  }, [state, a.label]);
  const go = async () => {
    setState('running');
    try {
      const r = await a.run();
      if (!alive.current) return;
      if (r !== true) setState({ error: typeof r === 'string' ? r : `${a.label} did not start.` });
      else if (a.opensPanel) setState('idle');
    } catch (e) {
      if (alive.current) setState({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={testId ?? `plots-prereq-${kind}`} data-state={typeof state === 'string' ? state : 'error'}>
      <button type="button" onClick={() => { void go(); }} disabled={state === 'running'} title={a.title} data-testid={`plots-prereq-run-${kind}`}
        className="rounded bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-700 disabled:opacity-60">{a.label}</button>
      {state === 'running' && <span className="text-[11px]" role="status" data-testid={`plots-prereq-waiting-${kind}`}>{a.running}</span>}
      {state === 'running' && <PrereqProgress kind={kind} />}
      {typeof state === 'object' && <span className="text-[11px]" role="status">{state.error}</span>}
      {a.opensPanel && state === 'idle' && <span className="text-[10px] opacity-80">(opens the panel: it needs a choice)</span>}
    </span>
  );
}

/** The step's own progress, as its panel shows it (the same component and job state): the consensus run's stages and
 *  bar with Cancel, the nucleosome Analyse's line with Cancel, the clustering line, the peak scan. */
export function PrereqProgress({ kind }: { kind: PrereqKind }) {
  const consensus = useLiveJobs(s => s.consensus);
  const scanning = useLiveJobs(s => s.scanning);
  const nuc = useNucJob(s => s.job);
  if (kind === 'classes' && consensus && ['queued', 'running', 'cancelling'].includes(consensus.status)) {
    return <div className="basis-full" data-testid="plots-prereq-progress-classes">
      <ConsensusProgress job={consensus} onCancel={() => { void cancelConsensus(consensus.job_id).then(j => useLiveJobs.setState({ consensus: j })); }} />
    </div>;
  }
  if (kind === 'geometries' && nuc && isLiveJob(nuc)) return <div className="basis-full"><NucJobLine job={nuc} testId="plots-prereq-progress-geometries" /></div>;
  if (kind === 'cluster') return <AnalysisProgressStatus className="basis-full flex items-center gap-2 text-[11px] text-ink-secondary" testId="plots-prereq-progress-cluster" dismiss={false} />;
  if ((kind === 'peaks' || kind === 'select-peaks') && scanning) {
    return <div className="basis-full flex items-center gap-2 text-[11px] text-ink-secondary" data-testid="plots-prereq-progress-peaks" role="status">
      <span className="relative block h-1.5 w-24 overflow-hidden rounded bg-amber-100"><IndeterminateStripes /></span> Scanning peaks…
    </div>;
  }
  return null;
}
