/**
 * One job-status pattern for every long analysis (usability audit Top 2, X-2): what the job is, the stage it is in
 * (in plain words), the time since it started, Cancel while it runs, and the last outcome kept on screen until the
 * next run. Before a run it can say how long such a run usually takes; it never invents a time remaining.
 *
 * Footprints' consensus run (footprint-analysis/ConsensusProgress.tsx) is a wrapper over it; NFR Find classes, the
 * alt-allele build and Identify use it directly. See scratch INTERFACE.md (fb-u1-global) for the contract.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export type JobState = 'idle' | 'queued' | 'running' | 'cancelling' | 'complete' | 'error' | 'cancelled';

export interface JobStep { key: string; label: string }

export interface JobProgress {
  /** Completed share of the current stage's work (0–1); null/undefined: unknown. */
  fraction?: number | null;
  completed?: number | null;
  total?: number | null;
  /** What `completed`/`total` count ("classes", "reads"). */
  unit?: string | null;
}

/** Progress within the current stage that the job states as a count in words ("tile 44 of 59"), when it has no
 * completed/total of its own: drawn as a determinate bar, and said as "<label>: <noun> 44 of 59". */
export interface StageProgress {
  /** The stage ("Find classes"); omitted, the bar text starts with the noun. */
  label?: string | null;
  /** What is counted, singular ("tile"). */
  noun: string;
  completed: number;
  total: number;
}

/** "Find classes: tile 44 of 59". */
export function stageProgressText(p: StageProgress): string {
  const count = `${p.noun} ${p.completed.toLocaleString()} of ${p.total.toLocaleString()}`;
  return p.label ? `${p.label}: ${count}` : count;
}

export interface JobStatusProps {
  /** The job's name ("Find classes", "Building insertion reference"). */
  title: string;
  state: JobState;
  /** The current stage in plain words (never a worker's stage id). */
  stage?: string | null;
  /** The whole plan, as a segmented bar; `stepIndex` is the current step (it only moves forward within a run). */
  steps?: JobStep[];
  stepIndex?: number;
  /** Identifies the run (a job id): the steps' forward-only memory starts again for a new one. */
  runKey?: string;
  /** Epoch time the run started / finished: ms, or seconds when below 1e12 (server job records). */
  startedAt?: number | null;
  finishedAt?: number | null;
  progress?: JobProgress | null;
  /** A count the job reports only in words ("tile 44/59"): used when `progress` has no fraction (N6). */
  stageProgress?: StageProgress | null;
  /** The part of the current step the job is in when it has no count of its own but an earlier part of the same step
   * had one ("Pair tests done · testing combination patterns", R5): said as the bar's text, and the bar keeps the
   * earlier part's fill (the rest striped) instead of turning back into stripes. Without it, an uncounted stage is
   * stripes, as before. */
  phase?: string | null;
  /** Live message from the job (aria-live polite). */
  message?: ReactNode;
  /** Shows Cancel while queued or running. */
  onCancel?: () => void;
  /** The last outcome, shown once the run is over, until the next run starts. */
  result?: ReactNode;
  /** Before launch only: how long such a run usually takes ("Usually several minutes for a view this size"). */
  hint?: ReactNode;
  /** Small print while the job runs (what the bar measures). */
  note?: ReactNode;
  /** Small print after an error or cancellation (what was kept). */
  stoppedNote?: ReactNode;
  /** Text under the bar when the run completed (default "Done"). */
  doneText?: string;
  /** The heading in place of the stage after an error / a cancellation (default "<title> failed" / "<title> cancelled"). */
  errorTitle?: string;
  cancelledTitle?: string;
  /** The heading once the run completed (default "<title> finished"). */
  doneTitle?: string;
  /** Accessible name of the progress bar (default "<title> progress"). */
  progressLabel?: string;
  /** One line (cards, toolbars): title · stage · elapsed · Cancel, then the result. */
  compact?: boolean;
  testId?: string;
  /** Test ids of the bar's fill and the step row (kept by wrappers with older ids). */
  fillTestId?: string;
  stepsTestId?: string;
  className?: string;
}

export const LIVE_STATES: readonly JobState[] = ['queued', 'running', 'cancelling'];
export const isLive = (state: JobState) => LIVE_STATES.includes(state);

/** "12s", "4m 05s", "1h 02m". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const toSeconds = (t: number) => (t < 1e12 ? t : t / 1000);

/** Seconds since `startedAt` (to `finishedAt` once over), ticking every second while `live`. */
export function useElapsed(live: boolean, startedAt?: number | null, finishedAt?: number | null): number | null {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [live, startedAt]);
  if (startedAt == null || !Number.isFinite(startedAt)) return null;
  const end = finishedAt != null && Number.isFinite(finishedAt) ? toSeconds(finishedAt) : now;
  return Math.max(0, end - toSeconds(startedAt));
}

function StepRow({ steps, stepIndex, runKey, state, fraction, held = null, testId, label }: {
  steps: JobStep[]; stepIndex: number; runKey?: string; state: JobState; fraction: number | null;
  /** The fill kept from an earlier, counted part of the current step (the rest striped): see JobStatus `phase`. */
  held?: number | null; testId: string; label: string;
}) {
  // Only moves forward: stages can repeat (per dataset), and a stage the plan doesn't list keeps the current step.
  const reached = useRef<{ key: string | undefined; index: number }>({ key: runKey, index: 0 });
  if (reached.current.key !== runKey) reached.current = { key: runKey, index: 0 };
  if (stepIndex > reached.current.index) reached.current.index = stepIndex;
  const finished = state === 'complete';
  const stopped = state === 'cancelled' || state === 'error';
  const current = finished ? steps.length : reached.current.index;
  return (
    <div data-testid={testId} className="space-y-1">
      <div className="flex gap-1" role="list" aria-label={label}>
        {steps.map((step, i) => {
          const done = i < current;
          const active = i === current && !finished;
          const unknown = active && !stopped && (fraction == null || !Number.isFinite(fraction));
          const fill = done ? 100 : active && fraction != null && Number.isFinite(fraction) ? Math.max(4, Math.min(100, 100 * fraction))
            : active && stopped ? (held != null && held > 0 ? Math.max(4, Math.min(100, 100 * held)) : 35) : 0;
          const partial = unknown && held != null && held > 0;
          return (
            <div key={step.key} role="listitem" className="min-w-0 flex-1" title={step.label}
              aria-current={active ? 'step' : undefined} data-state={done ? 'done' : active ? 'active' : 'pending'}>
              <div className="h-2 overflow-hidden rounded-full bg-cyan-100 dark:bg-gray-700">
                {partial ? <HeldFill percent={100 * held!} /> : unknown ? <IndeterminateStripes /> : <div style={{ width: `${fill}%` }} className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${
                  done ? 'bg-emerald-600' : stopped ? 'bg-amber-500' : 'bg-cyan-600'}`} />}
              </div>
              <div className={`mt-0.5 truncate text-[11px] leading-tight ${active ? 'font-semibold text-cyan-900 dark:text-cyan-100' : done ? 'text-emerald-700 dark:text-emerald-400' : 'text-ink-secondary'}`}>
                {step.label}
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-[11px] tabular-nums text-ink-secondary">
        {finished ? `All ${steps.length} steps done` : `Step ${Math.min(current + 1, steps.length)} of ${steps.length}`}
      </div>
    </div>
  );
}

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Unknown progress, unmistakably: moving diagonal stripes across the whole bar (still stripes with reduced motion),
 * never a fill that could be read as a share done. SVG-animated, so it needs no stylesheet. */
export function IndeterminateStripes({ testId }: { testId?: string }) {
  const id = `fb-stripes-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg data-testid={testId} data-indeterminate="true" aria-hidden="true" className="block h-full w-full text-cyan-600 dark:text-cyan-400" preserveAspectRatio="none">
      <defs>
        <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="12" fill="currentColor" opacity="0.65" />
          {!reducedMotion() && <animateTransform attributeName="patternTransform" type="translate" from="0 0" to="12 0" dur="0.9s" repeatCount="indefinite" additive="sum" />}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} opacity="0.55" />
    </svg>
  );
}

/** The part of a step already done, kept full, and stripes over the rest: the job is in a later part of the same step
 * whose size it does not say (R5). */
function HeldFill({ percent, testId }: { percent: number; testId?: string }) {
  const p = Math.max(4, Math.min(100, percent));
  return (
    <div className="flex h-full w-full" data-testid={testId} data-held={Math.round(p)}>
      <div style={{ width: `${p}%` }} className="h-full shrink-0 rounded-l-full bg-cyan-600" />
      <div className="h-full min-w-0 flex-1"><IndeterminateStripes /></div>
    </div>
  );
}

/** The most of a held fill: a later part of the step always shows some stripes (work remains). */
const HELD_MAX = 0.9;

function CancelButton({ state, onCancel, testId }: { state: JobState; onCancel: () => void; testId: string }) {
  const cancelling = state === 'cancelling';
  return (
    <button type="button" data-testid={`${testId}-cancel`} disabled={cancelling} onClick={onCancel}
      className="inline-flex min-h-[24px] items-center rounded-fb border border-line bg-white px-2 text-[11px] font-medium text-ink hover:bg-gray-50 disabled:opacity-60 dark:border-white/15 dark:bg-white/5 dark:text-gray-100 dark:hover:bg-white/10">
      {cancelling ? 'Cancelling…' : 'Cancel'}
    </button>
  );
}

export function JobStatus(props: JobStatusProps) {
  const {
    title, state, stage, steps, stepIndex = -1, runKey, startedAt, finishedAt, progress, stageProgress, message, onCancel, result,
    hint, note, stoppedNote, doneText = 'Done', compact = false, testId = 'job-status', className = '', phase = null,
  } = props;
  const live = isLive(state);
  const elapsed = useElapsed(live, startedAt, finishedAt);
  // The most of the current step's bar filled so far (this run, this step): what a later, uncounted part keeps (R5).
  const heldRef = useRef<{ key: string; max: number }>({ key: '', max: 0 });
  if (state === 'idle') {
    if (!hint && !result) return null;
    return (
      <div data-testid={testId} data-state="idle" className={`text-[11px] text-ink-secondary ${className}`}>
        {result && <div data-testid={`${testId}-result`}>{result}</div>}
        {hint && <div data-testid={`${testId}-hint`}>{hint}</div>}
      </div>
    );
  }
  const finished = state === 'complete';
  const stopped = state === 'cancelled' || state === 'error';
  // A stated count ("tile 44 of 59") fills the bar when the job gives no fraction of its own.
  const stated = stageProgress && stageProgress.total > 0 && Number.isFinite(stageProgress.completed) ? stageProgress : null;
  const fraction = finished ? 1 : progress?.fraction ?? (stated ? Math.max(0, Math.min(1, stated.completed / stated.total)) : null);
  const known = fraction != null && Number.isFinite(fraction);
  const percent = known ? Math.max(0, Math.min(100, 100 * fraction!)) : null;
  const stepKey = `${runKey ?? ''}|${stepIndex}`;
  if (heldRef.current.key !== stepKey) heldRef.current = { key: stepKey, max: 0 };
  if (known && !finished) heldRef.current.max = Math.max(heldRef.current.max, Math.max(0, Math.min(1, fraction!)));
  // A named later part of the step with no count: the earlier part stays full, the rest striped.
  const held = live && !known && phase && heldRef.current.max > 0 ? Math.min(HELD_MAX, heldRef.current.max) : null;
  // Stopped (cancelled, failed) in an uncounted part of a step: the part done so far stays on the bar, static.
  const stoppedHeld = stopped && !known && heldRef.current.max > 0 ? Math.min(HELD_MAX, heldRef.current.max) : null;
  // Under the step strip the step is already named: the bar says only the count ("tile 44 of 59", not "Find classes: …").
  const stripShown = !compact && !!steps?.length;
  const statedShown = stated && stripShown && steps!.some(st => st.label === stated.label) ? { ...stated, label: null } : stated;
  const heading = state === 'cancelling' ? 'Cancellation requested'
    : state === 'error' ? props.errorTitle ?? `${title} failed`
      : state === 'cancelled' ? props.cancelledTitle ?? `${title} cancelled`
        : finished ? props.doneTitle ?? `${title} finished`
          : stage || (state === 'queued' ? 'Waiting to start' : 'Working');
  const elapsedText = elapsed == null ? null : `${formatElapsed(elapsed)} ${state === 'queued' ? 'waiting' : 'elapsed'}`;
  const count = progress?.total != null && progress.total > 0 && progress.completed != null
    ? `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} ${progress.unit ?? 'items'} completed` : null;
  const statedText = statedShown && !count ? stageProgressText(statedShown) : null;
  const barText = finished ? doneText : count ?? statedText ?? (live && phase ? `${phase}${held == null ? ' · total not yet known' : ''}` : null)
    ?? (stopped ? 'Stopped before completion' : state === 'queued' ? 'Queued' : 'Working · total not yet known');
  const tone = state === 'error' ? 'border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30'
    : stopped ? 'border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/20'
      : finished ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/20'
        : 'border-cyan-400 bg-cyan-50 dark:border-cyan-700 dark:bg-gray-900';

  if (compact) {
    return (
      <div data-testid={testId} data-state={state} className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-fb border px-2 py-1 text-[11px] ${tone} ${className}`}>
        {live && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-cyan-600 motion-reduce:animate-none" aria-hidden="true" />}
        <strong className="font-semibold text-ink dark:text-gray-100">{live ? title : heading}</strong>
        {live && <span role="status" aria-live="polite" data-testid={`${testId}-stage`} className="text-ink dark:text-gray-200">{state === 'cancelling' ? 'Cancellation requested' : stage || (state === 'queued' ? 'Waiting to start' : 'Working')}</span>}
        {count && live && <span className="tabular-nums text-ink-secondary">{count}</span>}
        {statedText && live && <span className="tabular-nums text-ink-secondary" data-testid={`${testId}-stage-progress`}>{statedText}</span>}
        {!count && !statedText && live && known && percent! > 0 && <span className="tabular-nums text-ink-secondary">{Math.floor(percent!)}% of this stage</span>}
        {elapsedText && <span data-testid={`${testId}-elapsed`} className="whitespace-nowrap tabular-nums text-ink-secondary">{elapsedText}</span>}
        {live && onCancel && <CancelButton state={state} onCancel={onCancel} testId={testId} />}
        {!live && result && <span data-testid={`${testId}-result`} className="basis-full text-ink dark:text-gray-200">{result}</span>}
        {!live && message && <span role={state === 'error' ? 'alert' : undefined} className="basis-full break-words text-ink dark:text-gray-200">{message}</span>}
      </div>
    );
  }

  return (
    <div data-testid={testId} data-state={state} className={`space-y-2 rounded-lg border p-3 ${tone} ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <strong className="text-cyan-900 dark:text-cyan-100">{heading}</strong>
        <span className="inline-flex items-center gap-2">
          {elapsedText && <span data-testid={`${testId}-elapsed`} className="whitespace-nowrap text-[11px] tabular-nums">{elapsedText}</span>}
          {live && onCancel && <CancelButton state={state} onCancel={onCancel} testId={testId} />}
        </span>
      </div>
      {steps && steps.length > 0 && (
        <StepRow steps={steps} stepIndex={stepIndex} runKey={runKey} state={state} fraction={known && !finished ? fraction! : null} held={held ?? stoppedHeld}
          testId={props.stepsTestId ?? `${testId}-steps`} label={`${title} steps`} />
      )}
      <div role="progressbar" aria-label={props.progressLabel ?? `${title} progress`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent == null ? undefined : Math.round(percent)} aria-valuetext={barText}
        className="h-4 overflow-hidden rounded-full border border-cyan-200 bg-cyan-100 dark:border-gray-600 dark:bg-gray-700">
        {held != null
          ? <HeldFill percent={100 * held} testId={props.fillTestId ?? `${testId}-fill`} />
          : !known && live
          ? <IndeterminateStripes testId={props.fillTestId ?? `${testId}-fill`} />
          : <div data-testid={props.fillTestId ?? `${testId}-fill`} style={{ width: `${known ? percent : stoppedHeld != null ? 100 * stoppedHeld : 0}%` }}
            className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${stopped ? 'bg-amber-500' : finished ? 'bg-emerald-600' : 'bg-cyan-600'}`} />}
      </div>
      <div className="flex justify-between gap-2 text-[11px] tabular-nums">
        <span data-testid={`${testId}-bar-text`}>{barText}</span>{known && !finished && <span>{Math.floor(percent!)}% of this stage</span>}
      </div>
      {message != null && message !== '' && <p role={state === 'error' ? 'alert' : 'status'} aria-live="polite" className="break-words" data-testid={`${testId}-message`}>{message}</p>}
      {live && note && <p className="text-[11px] text-ink-secondary">{note}</p>}
      {stopped && stoppedNote && <p className="text-[11px]">{stoppedNote}</p>}
      {!live && result && <div data-testid={`${testId}-result`}>{result}</div>}
    </div>
  );
}
