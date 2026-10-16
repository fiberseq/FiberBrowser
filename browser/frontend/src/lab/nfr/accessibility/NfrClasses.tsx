import { scrollIntoViewWithin } from '../../../utils/scrollWithin';
/**
 * Accessibility (preview): the footprint classes (Find classes) inside a saved NFR, viewed with its variants: per
 * class, how often each variant's molecules are open at it and footprinted there when open. Without classes, Run Find
 * classes for this window starts the run here (with its stage, elapsed time and Cancel while it runs); its classes
 * join the NFR run (and the motif map's marker layer). Linked, not copied: each class opens in the Footprints panel,
 * and a class saved there is marked. Classes carry the one label every panel uses ("Class 025").
 */
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAccessibilityStore } from '../accessibilityStore';
import { getNfrClasses, getNfrCooccupancy, startNfrClassRun, type NfrClass } from '../api';
import { cancelConsensus, getConsensusJob, type ConsensusJob } from '../../../api/consensusWorkflow';
import { useBrowserStore } from '../../../stores/browserStore';
import { bp, variantColor } from '../accessibilityView';
import { cssValue, showFootprintClass } from '../../../utils/panelLinks';
import { classLabel, runTitle } from '../../../utils/classIdentity';
import { useRunName } from '../../../utils/runNames';
import type { SavedNfr } from '../savedNfrVariants';
import { AnalysisButton, AnalysisStatus } from '../../../components/controls/shared';
import { JobStatus, type JobState } from '../../../components/controls/shared/JobStatus';
import { stageLabel } from '../../../components/controls/footprint-analysis/ConsensusProgress';
import { consensusPhase, engineMessage, stagePlan, stepIndex, tileProgress } from '../../../components/controls/footprint-analysis/consensusStagePlan';
import { LayerBar } from './NfrCharts';
import { HelpTip } from './HelpTip';
import { useView } from './useNfrView';
import { cardKey } from '../savedNfrVariants';

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
/** How often a started Find classes run is looked for again until its classes join. */
export const CLASS_POLL_MS = 8000;
/** How often the started run's stage and elapsed time are read while it runs. */
export const CLASS_STATUS_POLL_MS = 2000;
/** Before launch: a rough size, never an invented ETA. */
export const CLASS_RUN_HINT = 'Usually several minutes for a view this size.';
/** What the two numbers of a class cell are. */
export const CLASS_CELL_HELP = 'Each cell: open % · footprinted-when-open %. Open: the share of the variant\'s reads whose own opening covers '
  + 'the class centre. Footprinted when open: of those open reads that the class run labelled, the share carrying the class. '
  + 'Bar: grey closed, light open, full colour open and footprinted; the line under it is the 95% interval of open.';

/** Run Find classes on the NFR run's window (its datasets and loader settings); reports the started (or existing)
 * consensus job. Before launch it says roughly how long a run takes. */
export function RunClassesButton({ jobId, waiting, onStarted }: { jobId: string; waiting: boolean; onStarted: (classJob: string | null) => void }) {
  const [state, setState] = useState<{ status: string; message?: string } | null>(null);
  const run = async () => {
    setState({ status: 'starting' });
    try {
      const out = await startNfrClassRun(jobId);
      setState({ status: out.status, message: out.message ?? undefined });
      onStarted(out.job_id);
    } catch (e) {
      setState({ status: 'error', message: String((e as Error).message ?? e) });
    }
  };
  const busy = waiting || state?.status === 'starting';
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <AnalysisButton theme="fuchsia" variant="soft" onClick={run} disabled={busy} data-testid="nfr-run-classes"
        title="Find classes (the lattice caller) on this run's window, datasets and settings, as the Footprints panel runs it; the classes join this NFR run without finding variants again">
        {busy ? 'Find classes running…' : 'Run Find classes for this window'}
      </AnalysisButton>
      {state?.status === 'error' && <span className="text-red-600 dark:text-red-400">{state.message}</span>}
    </span>
  );
}

export function NfrClasses({ entry, names }: { entry: SavedNfr; names: string[] }) {
  const classRevision = useAccessibilityStore(s => s.classRevision);
  const { data: fresh, error, loading } = useView(() => getNfrClasses(entry.jobId, entry.nfrId), `${entry.jobId}|${entry.nfrId}|classes|c${classRevision}`, 'Footprint classes');
  // while asking again (a new class revision), the last answer stays on screen
  const last = useRef(fresh);
  if (fresh) last.current = fresh;
  const data = fresh ?? last.current;
  // no classes in a cached answer: ask once more on opening (a Find classes run may have finished since)
  const askedAgain = useRef(false);
  useEffect(() => {
    if (!data || askedAgain.current || data.classes.length) return;
    askedAgain.current = true;
    useAccessibilityStore.getState().bumpClassRevision();
  }, [data]);
  // A run started here: follow its consensus job (stage, elapsed time, Cancel) and look again until a class run has
  // joined this NFR run (its classes may all lie elsewhere in the window: then this NFR has none); a failed or
  // cancelled run ends the wait with its message.
  const [waiting, setWaiting] = useState<{ job: string | null } | null>(null);
  const [classJob, setClassJob] = useState<ConsensusJob | null>(null);
  const [runError, setRunError] = useState('');
  useEffect(() => {
    if (!waiting) return;
    if (data?.class_job) { setWaiting(null); setClassJob(null); return; }
    let live = true;
    const t = window.setTimeout(() => { if (live) useAccessibilityStore.getState().bumpClassRevision(); }, CLASS_POLL_MS);
    return () => { live = false; window.clearTimeout(t); };
  }, [waiting, data, classRevision]);
  useEffect(() => {
    const id = waiting?.job;
    if (!id) return;
    let live = true;
    let t = 0;
    const poll = async () => {
      try {
        const j = await getConsensusJob(id);
        if (!live) return;
        setClassJob(j);
        if (j.status === 'error' || j.status === 'cancelled') {
          setWaiting(null); setClassJob(null);
          setRunError(`Find classes ${j.status === 'error' ? 'failed' : 'was cancelled'}${j.message ? `: ${j.message}` : ''}`);
          return;
        }
        // done: its classes join now; ask the class view at once rather than at the next look
        if (j.status === 'complete') { useAccessibilityStore.getState().bumpClassRevision(); return; }
      } catch { /* the class view's answer still decides */ }
      if (live) t = window.setTimeout(poll, CLASS_STATUS_POLL_MS);
    };
    t = window.setTimeout(poll, 0);
    return () => { live = false; window.clearTimeout(t); };
  }, [waiting?.job]);
  const cancel = () => { if (waiting?.job) void cancelConsensus(waiting.job).then(setClassJob).catch(e => setRunError(String((e as Error).message ?? e))); };
  const groups = useBrowserStore(useShallow(s => s.footprintGroups));
  const savedIn = (c: NfrClass) => data?.class_job ? groups.find(g => g.savedClass && g.consensusJobId === data.class_job && g.consensusStateId === c.class_id)?.savedClass?.id : undefined;
  // A link from the Footprints panel points at one class: bring its row into view, marked.
  const key = cardKey(entry.jobId, entry.nfrId);
  const linked = useAccessibilityStore(s => (s.highlightClass?.card === key ? s.highlightClass : null));
  // the same class only when this card's classes come from the linked class's run (class ids repeat across runs)
  const otherRun = !!linked?.classJob && !!data?.class_job && linked.classJob !== data.class_job;
  const highlight = linked && !otherRun ? linked.classId : null;
  const tableRef = useRef<HTMLTableElement>(null);
  const hasRows = !!data?.classes.length;
  // One short run name everywhere ("Footprint run 2 · 6 Oct 14:02"); the id in the tooltip.
  const classRun = useRunName('footprint', data?.class_job ?? null);
  const linkedRun = useRunName('footprint', linked?.classJob ?? null);
  useEffect(() => {
    if (!highlight || !hasRows) return;
    scrollIntoViewWithin(tableRef.current?.querySelector<HTMLElement>(`[data-testid="nfr-class-row"][data-class="${cssValue(highlight)}"]`), { block: 'center', behavior: 'smooth' });
  }, [highlight, hasRows]);
  return (
    <div className="space-y-1.5 text-[11px]" data-testid="nfr-classes-view">
      {loading && !data && <AnalysisStatus kind="loading">Footprint classes in this NFR…</AnalysisStatus>}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {data && !data.classes.length && (
        <div className="space-y-1.5 rounded-md border border-dashed border-gray-300 p-1.5 text-gray-600 dark:border-gray-700 dark:text-gray-300" data-testid="nfr-class-status">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="nfr-class-reason" title={data.reason ?? undefined}>{data.class_job ? 'No footprint class in this NFR.' : 'No footprint classes yet.'}</span>
            {!data.class_job && <RunClassesButton jobId={entry.jobId} waiting={!!waiting}
              onStarted={job => { setRunError(''); setClassJob(null); setWaiting({ job }); useAccessibilityStore.getState().bumpClassRevision(); }} />}
            {runError && <span className="text-red-600 dark:text-red-400" data-testid="nfr-class-run-error">{runError}</span>}
          </div>
          {!data.class_job && (
            <JobStatus title="Find classes" testId="nfr-find-classes-status"
              state={waiting ? ((classJob?.status as JobState | undefined) ?? 'queued') : 'idle'}
              stage={classJob ? stageLabel(classJob) : null}
              steps={classJob ? stagePlan(classJob) : undefined} stepIndex={classJob ? stepIndex(stagePlan(classJob), classJob.stage) : -1}
              runKey={waiting?.job ?? undefined} startedAt={classJob ? classJob.started_at ?? classJob.created_at : null} finishedAt={classJob?.finished_at ?? null}
              progress={classJob?.progress ? { fraction: classJob.progress.fraction, completed: classJob.progress.completed, total: classJob.progress.total,
                unit: classJob.progress.unit === 'families' ? 'classes' : classJob.progress.unit } : null}
              stageProgress={tileProgress(classJob)} phase={consensusPhase(classJob)}
              message={engineMessage(classJob?.message)} onCancel={waiting?.job ? cancel : undefined} hint={CLASS_RUN_HINT} doneText="Classes found; joining this NFR run" />
          )}
        </div>
      )}
      {data && data.classes.length > 0 && (
        <>
          <p className="text-gray-600 dark:text-gray-300" data-testid="nfr-class-status"
            title={`${runTitle('footprint', data.class_job)}${data.joined === 'posthoc' ? ' (joined after this NFR run)' : ''}`}>
            <span data-testid="nfr-class-count">{data.classes.length} class{data.classes.length === 1 ? '' : 'es'} in {entry.nfrId}</span> · <span data-testid="nfr-class-run">{classRun.name}</span>
            {data.joined === 'posthoc' ? ' (joined after this NFR run)' : ''}
          </p>
          {otherRun && (
            <p className="text-amber-700 dark:text-amber-400" data-testid="nfr-class-other-run">
              The linked {classLabel(linked!.classId)} is from {linkedRun.name}; this NFR's classes are from {classRun.name}.
            </p>
          )}
          <p className="flex items-center gap-1 text-gray-600 dark:text-gray-300" data-testid="nfr-class-legend">
            Each variant: <span className="font-medium">open % · footprinted-when-open %</span>
            <HelpTip term="open % · footprinted-when-open %" text={CLASS_CELL_HELP} testId="nfr-class-help" />
          </p>
          {/* Two short lines per class (R4): the class, its link and saved mark, then its span; each variant cell a bar
              and "37% · 26%" (open · footprinted when open, as the column heads say). Narrow card (420 px): the link stays
              in the first column, so it never goes past the card's edge (N18). */}
          <table ref={tableRef} className="w-full tabular-nums" data-testid="nfr-classes-table">
            <thead className="text-left text-gray-600 dark:text-gray-300">
              <tr><th className="font-medium">Class</th>
                {names.map(n => <th key={n} className="font-medium" title={`${n}: open % · footprinted-when-open %`}>
                  <span style={{ color: variantColor(n) }}>{n}</span> <span className="font-normal text-ink-muted">open · fp</span></th>)}</tr>
            </thead>
            <tbody>
              {data.classes.map(c => {
                const saved = savedIn(c);
                const marked = highlight === c.class_id;
                const span = `${bp(c.start)}–${bp(c.end)}${c.inside.length > 0 ? ` · in ${c.inside.join(', ')}` : ''}`;
                return (
                  <tr key={c.id} className={`border-t border-gray-100 align-middle dark:border-white/5 ${marked ? 'bg-emerald-50 ring-2 ring-inset ring-emerald-400 dark:bg-emerald-900/20' : ''}`}
                    data-testid="nfr-class-row" data-class={c.class_id} data-highlighted={marked || undefined}>
                    <td className="py-px pr-2 leading-[14px]" data-testid="nfr-class-name-cell">
                      <span className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="whitespace-nowrap font-medium" title={`${c.class_id} of ${runTitle('footprint', data.class_job)}`}>{classLabel({ class_id: c.class_id, label: c.label })}</span>
                        <button type="button" className="whitespace-nowrap text-[10px] text-emerald-700 hover:underline dark:text-emerald-300" data-testid="nfr-class-show"
                          onClick={() => data.class_job && showFootprintClass(data.class_job, c.class_id, entry.datasetIds)}
                          title="Open the Footprints panel on this class (highlighted on the reads)">Footprints ↗</button>
                        {saved && <span className="rounded bg-emerald-100 px-1 text-[10px] leading-3 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" title="Saved in the Footprints panel">saved {saved}</span>}
                      </span>
                      <span className="block text-[10px] leading-3 text-ink-muted" title={span}>{span}</span>
                    </td>
                    {names.map(n => (
                      <td key={n} className="min-w-[3.5rem] py-px pr-2">
                        <LayerBar layer={c.layers[n]} name={n} fluid />
                        <div className="whitespace-nowrap text-[10px] leading-3 text-gray-600 dark:text-gray-300" data-testid="nfr-class-cell" data-variant={n}
                          aria-label={`${n}: open ${pct(c.layers[n]?.p_open)}, footprinted when open ${pct(c.layers[n]?.p_fp_given_open)}`}
                          title={`${n}: open ${pct(c.layers[n]?.p_open)} · footprinted when open ${pct(c.layers[n]?.p_fp_given_open)}`}>
                          {pct(c.layers[n]?.p_open)} · {pct(c.layers[n]?.p_fp_given_open)}</div>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <details className="rounded border border-gray-100 px-1.5 py-1 dark:border-white/5" data-testid="nfr-coocc-disclosure">
            <summary className="cursor-pointer text-gray-600 dark:text-gray-300" title="Pairs of classes footprinted together on the same molecule, within each variant">Footprinted together</summary>
            <div className="mt-1"><CoOccupancy entry={entry} names={names} /></div>
          </details>
        </>
      )}
    </div>
  );
}

function CoOccupancy({ entry, names }: { entry: SavedNfr; names: string[] }) {
  const classRevision = useAccessibilityStore(s => s.classRevision);
  const { data, error, loading } = useView(() => getNfrCooccupancy(entry.jobId, entry.nfrId), `${entry.jobId}|${entry.nfrId}|coocc|c${classRevision}`, 'Co-occupancy');
  const pairs = (data?.pairs ?? []).filter(p => names.includes(p.variant)).slice(0, 20);
  return (
    <div className="space-y-1" data-testid="nfr-coocc">
      {loading && <AnalysisStatus kind="loading">Co-occupancy of class pairs…</AnalysisStatus>}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {data && !pairs.length && <p className="text-gray-500">No pair of non-overlapping classes has enough reads open at both.</p>}
      {pairs.length > 0 && (
        <table className="w-full tabular-nums" data-testid="nfr-coocc-table">
          <thead className="text-left text-gray-500">
            <tr><th className="font-medium">Variant</th><th className="font-medium">Pair</th><th className="font-medium">apart</th>
              <th className="font-medium" title="Reads open at both and labelled by both">reads</th><th className="font-medium" title="Footprinted at both: observed (expected if independent)">both</th>
              <th className="font-medium">odds ratio</th><th className="font-medium">q</th></tr>
          </thead>
          <tbody>
            {pairs.map(p => (
              <tr key={`${p.variant}-${p.a_id}-${p.b_id}`} className="border-t border-gray-100 dark:border-white/5" data-testid="nfr-coocc-row">
                <td className="pr-2 font-semibold" style={{ color: variantColor(p.variant) }}>{p.variant}</td>
                <td className="pr-2">{classLabel({ class_id: p.a_id, label: p.a })} + {classLabel({ class_id: p.b_id, label: p.b })}</td>
                <td className="pr-2 text-gray-500">{bp(p.distance)} bp</td>
                <td className="pr-2">{p.reads}</td>
                <td className="pr-2">{p.both} <span className="text-ink-secondary">({p.expected_both?.toFixed(1)})</span></td>
                <td className={`pr-2 ${p.q != null && p.q <= 0.1 ? 'font-semibold text-fuchsia-700 dark:text-fuchsia-300' : ''}`}>{p.odds_ratio?.toFixed(2) ?? '–'}</td>
                <td className="text-gray-500">{p.q == null ? '–' : p.q < 0.001 ? p.q.toExponential(0) : p.q.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <p className="text-[10px] text-ink-secondary">{data.definition}.</p>}
    </div>
  );
}
