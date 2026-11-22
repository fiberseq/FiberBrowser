import { create } from 'zustand';
import { getGenomeCheck, type DatasetGenomeCheck, type GenomeCheckResponse } from '../api/genomeCheck';

/**
 * Whether the loaded datasets fit the loaded genome (GET /api/genome/check),
 * shared by the mismatch banner, the genome picker's suggestion and the read
 * tracks (whose "go to this dataset's reads" prompt gives way to it).
 */
interface GenomeCheckState {
  check: GenomeCheckResponse | null;
  /** Registry genome being loaded from a suggestion (its id). */
  loadingGenome: string | null;
  /** Dismissed problems (see problemKey); a new reference or status shows them again. */
  dismissed: string[];
  refresh: () => Promise<void>;
  setLoadingGenome: (genomeId: string | null) => void;
  dismiss: (keys: string[]) => void;
  /** Datasets kept as a custom genome with no reference (see customGenomeKey): never flagged again. */
  customGenomes: string[];
  useAsCustomGenome: (keys: string[]) => void;
}

const DISMISSED_KEY = 'fiberhmm_genome_mismatch_dismissed';
const CUSTOM_KEY = 'fiberhmm_custom_genome_datasets';

function readCustom(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function readDismissed(): string[] {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Bumped when the reference changes: answers to checks asked before it are dropped. */
let checkGeneration = 0;

/** The reference changed: drop the last answer and any answer still in flight for the old reference. */
export function invalidateGenomeCheck(): void {
  checkGeneration += 1;
  useGenomeCheckStore.setState({ check: null });
}

let inflight: Promise<void> | null = null;
let again = false;

export const useGenomeCheckStore = create<GenomeCheckState>((set, get) => ({
  check: null,
  loadingGenome: null,
  dismissed: readDismissed(),
  customGenomes: readCustom(),
  refresh: async () => {
    // One request at a time; a refresh asked for meanwhile runs once after it.
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          const asked = checkGeneration;
          try {
            const check = await getGenomeCheck();
            // An answer asked for before the reference changed (invalidateGenomeCheck) is not this reference's.
            if (asked === checkGeneration) set({ check });
            else again = true;
          } catch {
            /* keep the last answer (e.g. a server restarting) */
          }
        } while (again);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  setLoadingGenome: genomeId => set({ loadingGenome: genomeId }),
  dismiss: keys => {
    const dismissed = [...new Set([...get().dismissed, ...keys])];
    try { sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed.slice(-200))); } catch { /* private mode */ }
    set({ dismissed });
  },
  useAsCustomGenome: keys => {
    // Remembered in this browser (not just the session): a custom or synthetic genome is a choice, not a mistake.
    const customGenomes = [...new Set([...get().customGenomes, ...keys])].slice(-500);
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(customGenomes)); } catch { /* private mode: this session only */ }
    set({ customGenomes });
  },
}));

/**
 * Every contig of the dataset is unknown to every known assembly (a custom or synthetic genome): no registry
 * genome fits, none is suggested, and nothing is merely renamed or a different length.
 */
export function unknownToEveryAssembly(problem: DatasetGenomeCheck): boolean {
  const d = problem.details;
  return problem.severity === 'error' && problem.assembly?.kind === 'unknown' && !problem.assembly?.in_registry
    && !problem.suggestion && !problem.known_not_in_registry && (d?.missing?.length ?? 0) > 0
    && !(d?.renamed?.length) && !(d?.length_differs?.length) && !(d?.sequence_differs?.length);
}

/** The custom-genome choice is kept for the dataset's own contigs (names and lengths), whatever reference is loaded. */
export function customGenomeKey(problem: DatasetGenomeCheck): string {
  const contigs = [...(problem.details?.missing ?? [])].map(c => `${c.contig}:${c.length}`).sort().join(',');
  return `${problem.dataset_id}|${contigs}`;
}

function keptAsCustom(problem: DatasetGenomeCheck, custom: string[]): boolean {
  return custom.length > 0 && custom.includes(customGenomeKey(problem));
}

/** A problem is dismissed for this dataset, reference and status only. */
export function problemKey(problem: DatasetGenomeCheck): string {
  return `${problem.dataset_id}|${problem.reference?.label ?? ''}|${problem.status}`;
}

/** The problems the banner shows (warnings and errors not dismissed). */
export function visibleProblems(check: GenomeCheckResponse | null, dismissed: string[],
  custom: string[] = useGenomeCheckStore.getState().customGenomes): DatasetGenomeCheck[] {
  if (!check) return [];
  const hidden = new Set(dismissed);
  return check.problems.filter(p => (p.severity === 'error' || p.severity === 'warning') && !hidden.has(problemKey(p))
    && !keptAsCustom(p, custom));
}

/** This dataset can't be shown on the loaded reference (severity error), or null. */
export function blockingProblemFor(check: GenomeCheckResponse | null, datasetId: string): DatasetGenomeCheck | null {
  const custom = useGenomeCheckStore.getState().customGenomes;
  return check?.problems.find(p => p.dataset_id === datasetId && p.severity === 'error' && !keptAsCustom(p, custom)) ?? null;
}

/**
 * The read track's "go to this dataset's reads" prompt (a jump to its
 * best-covered locus): only when nothing in view, the panel follows the main
 * view, and the dataset fits the loaded reference. On the wrong reference the
 * mismatch notice takes its place.
 */
export function findReadsPromptAllowed(
  overlappingReads: number,
  overrideChrom: string | null | undefined,
  genomeProblem: DatasetGenomeCheck | null,
): boolean {
  return overlappingReads === 0 && overrideChrom == null && !genomeProblem;
}
