/**
 * Accessibility (preview): Find NFR variants' progress in the shared job-status layout, as Find classes shows its own
 * (JobStatus: the step strip, a plain stage title, the bar, the engine's message as the detail line).
 *
 * The stages are the ones the run reports (browser/lab/services/accessibility_workflow.py and FiberHMM's
 * inference/accessibility/workflow.py): queued → loading (per dataset; 'native' while the native caller is replayed,
 * with alignment counts) → nfr (one bar over every NFR region, with counts; the message names "N3 (3/9, …)") →
 * coaccess (per-read openness, then the pair tests, with counts) → combinations → finalizing. The pair tests are
 * the panel's NFR pairs (not the Co-accessibility panel's position matrix).
 */
import type { JobProgress, StageProgress } from '../../components/controls/shared/JobStatus';
import { stepIndex, type StageStep } from '../../components/controls/footprint-analysis/consensusStagePlan';
import type { AccessibilityJob } from './api';

export const NFR_STEPS: StageStep[] = [
  { key: 'load', label: 'Load reads', stages: ['queued', 'loading', 'native', 'saving_input'] },
  { key: 'nfr', label: 'Find NFR variants', stages: ['nfr'] },
  { key: 'coaccess', label: 'NFR pairs', stages: ['coaccess', 'combinations'] },
  { key: 'install', label: 'Save results', stages: ['finalizing', 'complete'] },
];

const STAGE_TITLE: Record<string, string> = {
  queued: 'Waiting for the worker',
  loading: 'Loading reads',
  native: 'Replaying the native caller',
  saving_input: 'Loading reads',
  nfr: 'Finding NFR variants',
  coaccess: 'Testing which openings occur together',
  combinations: 'Testing combination patterns',
  finalizing: 'Saving results',
  complete: 'NFR variants ready',
};

type JobLike = Pick<AccessibilityJob, 'stage' | 'message' | 'progress'>;

/** The stage in plain words (never the worker's id or the raw message). */
export function nfrStageTitle(job: JobLike): string {
  return STAGE_TITLE[job.stage ?? ''] ?? 'Working';
}

/** The step of the strip the stage belongs to (-1 when the plan doesn't list it: the strip keeps its step). */
export function nfrStepIndex(job: JobLike): number {
  return stepIndex(NFR_STEPS, job.stage ?? '');
}

const UNIT: Record<string, string> = { native: 'alignments', coaccess: 'pair tests' };

/**
 * The bar: the run's own counts where it gives them. The NFR phase counts internal steps over every region, which
 * mean nothing as a number: its fraction fills the bar and the words say which NFR ("NFR 3 of 9", stageProgress).
 */
export function nfrProgress(job: JobLike): JobProgress | null {
  const p = job.progress;
  if (!p) return null;
  if (job.stage === 'nfr') return { fraction: p.fraction };
  return { fraction: p.fraction, completed: p.completed, total: p.total, unit: (p as { unit?: string | null }).unit ?? UNIT[job.stage ?? ''] ?? null };
}

/** "Find NFR variants: NFR 3 of 9", from the engine's "N3 (3/9, 15040333-15041063): …". */
export function nfrStageProgress(job: JobLike): StageProgress | null {
  if (job.stage !== 'nfr') return null;
  const m = /\((\d+)\s*\/\s*(\d+)\b/.exec(job.message ?? '');
  if (!m) return null;
  const completed = Number(m[1]), total = Number(m[2]);
  return total > 0 && completed <= total ? { label: 'Find NFR variants', noun: 'NFR', completed, total } : null;
}

/** The part of a step the run is in when an earlier part of it had a count and this one has none (R5): the bar keeps
 * that part full (JobStatus `phase`) and says what is going on now. */
const PHASE: Record<string, string> = {
  combinations: 'Pair tests done · testing combination patterns',
  saving_input: 'Reads loaded · saving the evidence snapshot',
};
export function nfrPhase(job: JobLike): string | null {
  return PHASE[job.stage ?? ''] ?? null;
}
