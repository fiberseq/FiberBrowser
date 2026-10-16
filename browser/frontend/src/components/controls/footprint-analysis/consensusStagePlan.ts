import type { ConsensusJob, ConsensusMode } from '../../../api/consensusWorkflow';

/** One step of a consensus run as the user sees it, and the worker stages it covers. */
export interface StageStep { key: string; label: string; stages: string[] }

const LOAD: StageStep = { key: 'load', label: 'Load reads', stages: ['queued', 'loading', 'load', 'native', 'saving_input'] };
const INSTALL: StageStep = { key: 'install', label: 'Install layers', stages: ['finalizing', 'saving', 'complete'] };

/** Step lists per engine, in the order the FiberHMM workflows report their stages. */
export const STAGE_PLANS: Record<ConsensusMode, StageStep[]> = {
  // lattice_recaller/workflow.py (Find footprint classes, default)
  lattice_recaller: [
    LOAD,
    { key: 'discover', label: 'Find classes', stages: ['recaller_discovery'] },
    { key: 'score', label: 'Count', stages: ['recaller_quantify'] },
    INSTALL,
  ],
  // harmonized_families/workflow.py (Find footprint classes)
  staged_native_families: [
    LOAD,
    { key: 'fit', label: 'Fit classes per dataset', stages: ['native_cache', 'native_fit'] },
    { key: 'score', label: 'Score across datasets', stages: ['foreign_scoring'] },
    { key: 'parents', label: 'Shared parent classes', stages: ['parent_cache', 'parent_fit', 'consolidation'] },
    { key: 'resolve', label: 'Choose classes', stages: ['resolution'] },
    INSTALL,
  ],
  // native_workflow.py
  native_family_distribution: [
    LOAD,
    { key: 'nominate', label: 'Discover classes', stages: ['cr_nomination'] },
    { key: 'models', label: 'Save models', stages: ['native_provenance', 'saving_models'] },
    { key: 'classify', label: 'Fit and test classes', stages: ['cr_classification'] },
    INSTALL,
  ],
  // workflow.py
  call_harmonization: [
    LOAD,
    { key: 'boundaries', label: 'Normalize boundaries', stages: ['sr'] },
    { key: 'classes', label: 'Fit classes', stages: ['cr', 'cr_fit', 'cr_assign', 'clustering', 'models', 'saving_models'] },
    { key: 'rescue', label: 'Rescue and compare', stages: ['rescue', 'population_rescue', 'comparability', 'splitting', 'transfer'] },
    { key: 'cross', label: 'Cross-dataset relationships', stages: ['xcr'] },
    INSTALL,
  ],
  legacy_lattice: [LOAD, INSTALL],
};

export function jobMode(job: ConsensusJob): ConsensusMode | null {
  const requested = (job.request?.parameters as { cr?: { engine?: string } } | undefined)?.cr?.engine;
  const mode = job.cr_mode ?? requested;
  return mode && mode in STAGE_PLANS ? (mode as ConsensusMode) : null;
}

/** The lattice recaller's optional read-order check (recaller.order_replicates > 0) runs after Count. */
export const ROBUST_STEP: StageStep = { key: 'robust', label: 'Check read order', stages: ['recaller_robustness'] };

export function stagePlan(job: ConsensusJob): StageStep[] {
  const mode = jobMode(job);
  const orders = Number((job.request?.parameters as { recaller?: { order_replicates?: number } } | undefined)?.recaller?.order_replicates ?? 0);
  if (mode === 'lattice_recaller' && orders > 0) {
    const plan = STAGE_PLANS.lattice_recaller;
    return [...plan.slice(0, -1), ROBUST_STEP, plan[plan.length - 1]];
  }
  if (mode) return STAGE_PLANS[mode];
  // Unknown engine: the plan that knows the current stage.
  return Object.values(STAGE_PLANS).find(plan => plan.some(step => step.stages.includes(job.stage)))
    ?? STAGE_PLANS.lattice_recaller;
}

/** Index of the step the stage belongs to, or -1 for a stage the plan doesn't list. */
export function stepIndex(plan: StageStep[], stage: string): number {
  return plan.findIndex(step => step.stages.includes(stage));
}

/** Counts the lattice recaller states only in words, per stage: its discovery's tiles ("tile 44/59 15040000-15042000:
 * 2387 molecules") and its Count step's class groups ("group 113/124 (3 classes), …"). */
const WORD_COUNTS: Record<string, { label: string; noun: string; re: RegExp }> = {
  recaller_discovery: { label: 'Find classes', noun: 'tile', re: /\btile (\d+)\s*\/\s*(\d+)\b/ },
  recaller_quantify: { label: 'Count', noun: 'group', re: /\bgroup (\d+)\s*\/\s*(\d+)\b/ },
};

/**
 * A count the run states only in words, as stage progress (N6, B2), so the bar is determinate: "tile 44 of 59" while
 * classes are found, "group 113 of 124" while they are counted. Null for any other stage or message. The label is the
 * step's own name (JobStatus leaves it out under the step strip, which already names the step). A tile total counts
 * every tile of the window (some have too few molecules to search), so the bar can stop short before the next stage.
 */
export function tileProgress(job: Pick<ConsensusJob, 'stage' | 'message'> | null | undefined): { label: string; noun: string; completed: number; total: number } | null {
  const spec = job ? WORD_COUNTS[job.stage] : undefined;
  if (!job || !spec) return null;
  const m = spec.re.exec(job.message ?? '');
  if (!m) return null;
  const completed = Number(m[1]), total = Number(m[2]);
  return total > 0 && completed <= total ? { label: spec.label, noun: spec.noun, completed, total } : null;
}

/**
 * The part of a step the run is in when an earlier part of the same step had a count and this one has none (R5):
 * named, with the earlier part kept full on the bar rather than turned back into stripes. Null otherwise.
 */
export function consensusPhase(job: Pick<ConsensusJob, 'stage'> | null | undefined): string | null {
  return job?.stage === 'saving_input' ? 'Reads loaded · saving the evidence snapshot' : null;
}

/** The engine's words, made grammatical where it counts one thing: "(1 classes)" → "(1 class)" (FiberHMM
 * lattice_recaller/workflow.py says "classes" whatever the count). */
export function engineMessage(message: string | null | undefined): string {
  return (message ?? '').replace(/\b1 classes\b/g, '1 class');
}
