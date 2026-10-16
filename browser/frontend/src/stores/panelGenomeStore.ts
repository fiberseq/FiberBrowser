import { useMemo } from 'react';
import { create } from 'zustand';
import {
  attachPanelGenome,
  detachPanelGenome,
  getPanelGenomes,
  type AttachGenomeRequest,
  type AttachGenomeResponse,
  type PanelGenomeInfo,
} from '../api/panelGenomes';
import type { ChromInfo } from '../types';
import type { ClosedDatasetReference } from './historySlice';
import { useBrowserStore } from './browserStore';
import { useGenomeCheckStore } from './genomeCheckStore';
import type { Locus } from '../utils/panelNavigation';
import { startLociForPanels } from '../utils/panelGenomeStart';

/**
 * The references loaded besides the main genome and which datasets use them
 * (GET /api/panel_genomes). Panels carry their reference's key
 * (PanelConfig.genome); this store has what the panel header shows: the
 * reference's name and chromosomes.
 */
interface PanelGenomeState {
  genomes: Record<string, PanelGenomeInfo>;
  /** dataset id -> key */
  assignments: Record<string, string>;
  /** Dataset ids being given a reference (the buttons say "Loading…"). */
  attaching: string[];
  /** The assignments are the server's current ones (false while a refresh is on its way). */
  ready: boolean;
  refresh: () => Promise<void>;
  /** Panels follow the assignments known now (no request). */
  applyAssignments: () => void;
  /**
   * Give datasets a reference of their own. `perPanel`: one dataset opened in
   * its own panel from a mismatch ("Open with dm6 in its own panel"): the
   * navigation switches to "Each panel navigates" (fb-r3-nav) when other
   * panels are open, so each can move on its own; Linked then moves the panels
   * on each reference together again. Several datasets opened together stay
   * as they are: in "Linked navigation" they form their reference's link group.
   */
  attach: (request: AttachGenomeRequest, options?: { perPanel?: boolean }) => Promise<AttachGenomeResponse & { switchedToPerPanel?: boolean }>;
  detach: (datasetIds: string[]) => Promise<void>;
}

function chromsOf(info: PanelGenomeInfo | undefined): ChromInfo[] {
  return (info?.chroms ?? []).map(c => ({ name: c.name, size: c.size, circular: Boolean(c.circular) } as ChromInfo));
}

/** A first locus on a reference (its first chromosome's start) for a panel with none. */
function fallbackLocus(info: PanelGenomeInfo | undefined): Locus | null {
  const first = info?.chroms?.[0];
  return first ? { chrom: first.name, start: 0, end: Math.min(first.size, 10_000) } : null;
}

// Each dataset's best-covered window on its own reference, as the server last said (audit L12).
let serverLoci: Record<string, Locus> = {};

function applyToPanels(genomes: Record<string, PanelGenomeInfo>, assignments: Record<string, string>,
  options: { loci?: Record<string, Locus>; undoLabel?: string } = {}) {
  const hasChrom = (key: string, chrom: string) => {
    const info = genomes[key];
    // Unknown yet (or not listed): keep what the panel shows.
    if (!info || !info.chroms?.length) return true;
    return info.chroms.some(c => c.name === chrom);
  };
  // A panel not yet on its reference (a window opened later) starts at its dataset's reads.
  const loci = options.loci
    ?? startLociForPanels(useBrowserStore.getState().panels, assignments, serverLoci, hasChrom);
  useBrowserStore.getState().applyPanelGenomes(assignments, {
    ...options,
    loci,
    fallback: key => fallbackLocus(genomes[key]),
    hasChrom,
  });
}

let inflight: Promise<void> | null = null;
let again = false;
// Bumped by each attach: a refresh answer asked for before it is stale (it would undo the attach).
let attachGeneration = 0;

export const usePanelGenomeStore = create<PanelGenomeState>((set, get) => ({
  genomes: {},
  assignments: {},
  attaching: [],
  ready: false,
  refresh: async () => {
    // Asked again meanwhile (a session restored, datasets changed): once more after this one.
    if (inflight) {
      again = true;
      return inflight;
    }
    set({ ready: false });
    inflight = (async () => {
      try {
        do {
          again = false;
          try {
            const asked = attachGeneration;
            const res = await getPanelGenomes();
            // A reference given meanwhile: ask again rather than apply the older answer.
            if (asked !== attachGeneration) {
              again = true;
              continue;
            }
            const genomes = Object.fromEntries((res.genomes ?? []).map(g => [g.key, g]));
            serverLoci = res.loci ?? {};
            set({ genomes, assignments: res.datasets ?? {} });
          } catch {
            /* keep the last answer (a server restarting) */
          }
        } while (again);
        applyToPanels(get().genomes, get().assignments);
      } finally {
        inflight = null;
        set({ ready: true });
      }
    })();
    return inflight;
  },
  applyAssignments: () => applyToPanels(get().genomes, get().assignments),
  attach: async (request, options = {}) => {
    set({ attaching: [...new Set([...get().attaching, ...request.dataset_ids])] });
    try {
      const st = useBrowserStore.getState();
      // Open at the dataset's best-covered window, as wide as the view now.
      const span = Math.max(1_000, Math.min(200_000, st.end - st.start || 10_000));
      const res = await attachPanelGenome({ span, ...request });
      if (!res.success) return res;
      attachGeneration += 1;
      const listed = await getPanelGenomes();
      const genomes = Object.fromEntries((listed.genomes ?? []).map(g => [g.key, g]));
      serverLoci = listed.loci ?? {};
      set({ genomes, assignments: listed.datasets ?? {} });
      // No undo point: the reference is loaded on the server (Undo can't unload it).
      applyToPanels(genomes, listed.datasets ?? {}, { loci: res.loci });
      void useGenomeCheckStore.getState().refresh();
      // Its own panel among others: each panel navigates (one undo step, which keeps the reference).
      const after = useBrowserStore.getState();
      const targets = new Set(request.dataset_ids);
      const others = after.panels.some(p => p.contentType === 'dataset' && !!p.datasetId && !targets.has(p.datasetId));
      if (options.perPanel && after.navigationMode === 'linked' && others) {
        const name = genomes[(listed.datasets ?? {})[request.dataset_ids[0]] ?? '']?.label ?? request.genome_id ?? 'its reference';
        const label = after.datasets.find(d => d.id === request.dataset_ids[0])?.label ?? request.dataset_ids[0];
        after.switchToPerPanelForOwnReference(request.dataset_ids, res.loci ?? {}, `Open ${label} with ${name}: each panel navigates`);
        return { ...res, switchedToPerPanel: true };
      }
      return res;
    } finally {
      set({ attaching: get().attaching.filter(id => !request.dataset_ids.includes(id)) });
    }
  },
  detach: async (datasetIds) => {
    await detachPanelGenome(datasetIds);
    await get().refresh();
    void useGenomeCheckStore.getState().refresh();
  },
}));

/** The chromosomes of a panel's reference (the main genome's for none). */
export function panelGenomeChroms(key: string | null | undefined, mainChroms: ChromInfo[]): ChromInfo[] {
  if (!key) return mainChroms;
  return chromsOf(usePanelGenomeStore.getState().genomes[key]);
}

/** The chromosomes (sizes, topology) of a panel's reference, as a hook: the main genome's for none. */
export function usePanelChroms(key: string | null | undefined): ChromInfo[] {
  const mainChroms = useBrowserStore(s => s.chroms);
  const info = usePanelGenomeStore(s => (key ? s.genomes[key] : undefined));
  return useMemo(() => (key ? chromsOf(info) : mainChroms), [key, info, mainChroms]);
}

/**
 * The reference a dataset has of its own, as Undo of closing it gives it back
 * (the server closes it with its last dataset). null: the main genome.
 */
export function closedDatasetReference(datasetId: string): ClosedDatasetReference | null {
  const { assignments, genomes } = usePanelGenomeStore.getState();
  const key = assignments[datasetId];
  const info = key ? genomes[key] : undefined;
  if (!key || !info) return null;
  if (info.kind === 'registry' && (info.genome_id ?? key)) return { key, source: { genome_id: info.genome_id ?? key } };
  if (info.kind === 'fasta' && info.fasta_path) {
    return { key, source: { fasta_path: info.fasta_path, ...(info.gtf_path ? { gtf_path: info.gtf_path } : {}) } };
  }
  if (info.kind === 'contigs' || info.kind === 'header_fasta') return { key, source: { contigs: true } };
  return null;
}

/** The name a panel header shows for its reference. */
export function panelGenomeLabel(info: PanelGenomeInfo | undefined, key: string): string {
  return info?.label ?? key.replace(/^(fasta|contigs):/, '');
}

/**
 * The reference a locus on `chrom` is on, for a request about it (primers,
 * sequence): a selected panel on its own reference showing that chromosome,
 * else the main genome when it has it, else the one panel reference that has
 * it. null: the main genome.
 */
export function referenceForChrom(chrom: string | null | undefined): string | null {
  if (!chrom) return null;
  const st = useBrowserStore.getState();
  const own = st.panels.filter(p => p.genome && p.viewportOverride?.chrom === chrom);
  const selected = own.find(p => st.selectedDatasets.has(p.id));
  if (selected?.genome) return selected.genome;
  if (st.chroms.some(c => c.name === chrom)) return null;
  if (own[0]?.genome) return own[0].genome;
  const holders = Object.values(usePanelGenomeStore.getState().genomes).filter(g => g.chroms.some(c => c.name === chrom));
  return holders.length === 1 ? holders[0].key : null;
}
