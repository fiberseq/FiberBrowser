import { useEffect } from 'react';
import { fetchJson } from '../../api/sharedFetch';
import { AnalysisButton, JobStatus } from '../../components/controls/shared';
import type { JobState } from '../../components/controls/shared/JobStatus';
import { usePanelField, useSyncPanelState } from './panelState';
import { useAnchorPick } from './anchors';
import { WindowBadge, formatNumber, type WindowIdentity } from './presentation';
import type { Locus, SyncResult, SyncWindow } from './model';
interface LocateJob {
  id: string;
  state: JobState;
  message: string;
  fraction?: number;
  result: { loci: Locus[]; length: number; searched: string } | null;
}
const endpoint = '/api/lab/region-sync';
/**
 * When a window has nothing comparable with the template, search the template's whole
 * reference for the window's sequence (minimap2 on a cached index) and offer to move the
 * template window to where it aligns.
 */
export function LocatePanel({ result, window: w, identities, onMove, stale = false, busy = false }: {
  result: SyncResult;
  window: SyncWindow;
  identities: Record<string, WindowIdentity>;
  onMove: (locus: Locus) => void;
  /** The panels moved or changed reference since the search: moves are off. */
  stale?: boolean;
  /** Another search (Find or Locate) is running. */
  busy?: boolean;
}) {
  const template = result.windows[0];
  const epoch = useAnchorPick(s => s.epoch);
  // One search per session, template and window (reference, locus).
  const [job, setJob] = usePanelField<LocateJob | null>(`locate:${JSON.stringify([epoch, template.panelId, template.genome, template.chrom, template.start, template.end, w.panelId, w.genome, w.chrom, w.start, w.end])}`, null);
  const running = job?.state === 'running' || job?.state === 'queued';
  // The session runs one search at a time: Find and other Locates wait while this one runs.
  const runKey = `${template.panelId}~${w.panelId}`;
  useEffect(() => {
    const mark = (on: boolean) => useSyncPanelState.setState(s => {
      const set = { ...(s.locating as Record<string, boolean> | undefined) };
      if (on) set[runKey] = true; else delete set[runKey];
      return { locating: set };
    });
    mark(running);
    return () => mark(false);
  }, [running, runKey]);
  useEffect(() => {
    if (!job?.id || !['queued', 'running'].includes(job.state))
      return;
    let live = true;
    const timer = setTimeout(() => {
      fetchJson<LocateJob>(`${endpoint}/jobs/${job.id}`).then(next => { if (live) setJob(next); })
        .catch(e => { if (live) setJob({ ...job, state: 'error', message: String(e) }); });
    }, 500);
    return () => { live = false; clearTimeout(timer); };
  }, [job]);
  const tLabel = identities[template.panelId]?.label ?? 'the template', wLabel = identities[w.panelId]?.label ?? 'this window';
  async function start() {
    setJob({ id: '', state: 'running', message: 'Starting', result: null });
    try {
      const strip = (v: SyncWindow) => ({ panelId: v.panelId, datasetId: v.datasetId, genome: v.genome, chrom: v.chrom, start: v.start, end: v.end });
      setJob(await fetchJson<LocateJob>(`${endpoint}/locate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: strip(template), query: strip(w) }) }));
    } catch (e) {
      setJob({ id: '', state: 'error', message: String(e instanceof Error ? e.message : e), result: null });
    }
  }
  const loci = job?.state === 'complete' ? job.result?.loci ?? [] : null;
  return <div data-testid={`sync-locate-${w.panelId}`} className="space-y-1 text-ink">
    <AnalysisButton theme="teal" data-testid={`sync-locate-run-${w.panelId}`} disabled={running || busy || stale} onClick={() => void start()}>
      Search {tLabel}’s reference for {wLabel}’s sequence
    </AnalysisButton>
    {job && job.state !== 'complete' && <JobStatus testId={`sync-locate-job-${w.panelId}`} title="Search the reference" state={job.state} message={job.message} runKey={job.id} progress={{ fraction: job.fraction }}
      onCancel={job.id && running ? () => { void fetchJson<LocateJob>(`${endpoint}/jobs/${job.id}`, { method: 'DELETE' }).then(setJob).catch(() => { }); } : undefined} />}
    {loci && !loci.length && <p className="text-ink-secondary">{wLabel}’s sequence does not align anywhere else in {tLabel}’s reference.</p>}
    {loci && loci.length > 0 && <ul data-testid={`sync-loci-${w.panelId}`} className="space-y-1">
      {loci.map((l, i) => <li key={i} className="flex flex-wrap items-center gap-x-2">
        <span className="font-mono">{l.chrom}:{formatNumber(l.start)}–{formatNumber(l.end)} ({l.strand})</span>
        <span className="text-ink-secondary">{formatNumber(l.aligned)} of {formatNumber(job!.result!.length)} bp of <WindowBadge identity={identities[w.panelId]} /> · {Math.round(l.identity * 100)}% identity{l.inTemplate ? ' · inside the template window' : l.chrom !== template.chrom ? ` · not on ${template.chrom}` : ''}</span>
        {!l.inTemplate && <AnalysisButton data-testid={`sync-locate-move-${w.panelId}-${i}`} disabled={stale} title={stale ? 'The panels changed since this search: find again first.' : undefined} onClick={() => onMove(l)}>Move {tLabel} here</AnalysisButton>}
      </li>)}
    </ul>}
  </div>;
}
