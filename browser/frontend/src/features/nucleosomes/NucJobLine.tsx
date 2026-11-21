/**
 * The nucleosome Analyse's progress line (the panel's, also under Plots' Find geometries): the stage in plain words,
 * samples done of the total, Cancel while it runs, how long it took or why it stopped.
 */
import { isLiveJob, isReplacedJob, useNucJob } from './nucJob';
import type { NucJob } from './types';

export function NucJobLine({ job, testId = 'nuc-job' }: { job: NucJob; testId?: string }) {
  const live = isLiveJob(job);
  const elapsed = Math.max(0, Math.round((job.finished_at ?? Date.now() / 1000) - job.created_at));
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-secondary" role="status" data-testid={testId} data-state={job.status}>
      {live && <span className="h-1 w-8 animate-pulse rounded bg-emerald-500" />}
      <span>{live ? job.status === 'cancelling' ? 'Cancelling…' : job.status === 'queued' ? job.message ?? 'Queued' : `Analysing… ${Math.min(Object.keys(job.results ?? {}).length + 1, job.datasets.length)} of ${job.datasets.length} samples` : isReplacedJob(job) ? 'Replaced by a newer analysis' : job.status === 'complete' ? `Analysed in ${elapsed} s` : job.status === 'cancelled' ? 'Analysis cancelled' : job.error ?? 'Analysis stopped'}</span>
      {live && job.status !== 'cancelling' && <button type="button" className="underline" data-testid={`${testId}-cancel`} onClick={() => { void useNucJob.getState().cancel({ user: true }); }}>Cancel</button>}
    </div>
  );
}
