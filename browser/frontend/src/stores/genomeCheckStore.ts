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
}

const DISMISSED_KEY = 'fiberhmm_genome_mismatch_dismissed';

function readDismissed(): string[] {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

let inflight: Promise<void> | null = null;
let again = false;

export const useGenomeCheckStore = create<GenomeCheckState>((set, get) => ({
  check: null,
  loadingGenome: null,
  dismissed: readDismissed(),
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
          try {
            set({ check: await getGenomeCheck() });
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
}));

/** A problem is dismissed for this dataset, reference and status only. */
export function problemKey(problem: DatasetGenomeCheck): string {
  return `${problem.dataset_id}|${problem.reference?.label ?? ''}|${problem.status}`;
}

/** The problems the banner shows (warnings and errors not dismissed). */
export function visibleProblems(check: GenomeCheckResponse | null, dismissed: string[]): DatasetGenomeCheck[] {
  if (!check) return [];
  const hidden = new Set(dismissed);
  return check.problems.filter(p => (p.severity === 'error' || p.severity === 'warning') && !hidden.has(problemKey(p)));
}

/** This dataset can't be shown on the loaded reference (severity error), or null. */
export function blockingProblemFor(check: GenomeCheckResponse | null, datasetId: string): DatasetGenomeCheck | null {
  return check?.problems.find(p => p.dataset_id === datasetId && p.severity === 'error') ?? null;
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
