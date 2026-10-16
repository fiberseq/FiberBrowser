// Accessibility (preview): the shown NFR-variant run, shared by the panel and the read panels' arc track.
// Starred NFRs live in the browser store (sessions, undo, localStorage): utils/savedNfrVariants.ts.
import { create } from 'zustand';
import type { AccessibilityJob, AccessibilityGroups, AccessibilityResult, AccessibilitySplit } from './api';
import type { AppliedGrouping } from '../../utils/readGroups';
import { DEFAULT_PAIR_FILTER } from './accessibilityView';

export type ArcSelection = 'significant' | 'all';

/** Read groups the panel put into the read panels: NFR configurations, a pair split or combination patterns. */
export interface AppliedNfrGroups {
  kind: 'configurations' | 'pair' | 'combination';
  jobId: string;
  grouping: AppliedGrouping;
  /** The configurations of one NFR ("Group reads by variant"). */
  configurations?: AccessibilityGroups;
  /** A pair split or combination patterns (the drill-down card). */
  split?: AccessibilitySplit;
  /** Cleared or closed by the user (shown again only if undo brings its groups back). */
  dismissed?: boolean;
}

interface AccessibilityStore {
  job: AccessibilityJob | null;
  setJob: (value: AccessibilityJob | null | ((previous: AccessibilityJob | null) => AccessibilityJob | null)) => void;
  batchRunning: boolean;
  batchCancelled: boolean;
  batchTotal: number;
  regionJobs: AccessibilityJob[];
  batchError: string;

  /** The run the panel shows (a completed job). */
  jobId: string | null;
  result: AccessibilityResult | null;
  /** Draw the pair arcs on the NFR track over the reads of the run's datasets (on by default). */
  showArcs: boolean;
  /** Arcs drawn: pairs with q <= 0.1 (default) or every tested pair. */
  arcSelection: ArcSelection;
  /** Include footprint-class elements (variant x class arcs). */
  showClassArcs: boolean;
  /** The panel's shared filters (one strip for every tab): q for every list and test, the pairs' strength and top N,
   * the focused element or NFR. */
  qMax: number;
  minEffect: number;
  topN: number | null;
  focus: string | null;
  setFilter: (patch: Partial<Pick<AccessibilityStore, 'qMax' | 'minEffect' | 'topN' | 'focus'>>) => void;
  /** The species of the motif catalogue (from the last motif answer): which pinned list the pin box edits. */
  /** The element (variant 'N5:V2', NFR 'N5' or class id) hovered in the panel or, through the feature bridge, in the
   * NFR channel above the reads (INTERFACE.md of fb-n11-features): the arcs emphasise its connections. */
  hoveredElement: string | null;
  /** Bumped when a view finds no footprint layer, so motif and class views ask again (a Find classes run may have
   * finished since: their cached results must not keep the class columns empty). */
  classRevision: number;
  bumpClassRevision: () => void;
  setHoveredElement: (id: string | null) => void;
  motifSpecies: string | null;
  /** The species' default pinned list (from the last motif answer), used when the user has no list of their own. */
  defaultPins: string[] | null;
  setMotifSpecies: (value: string | null, defaults?: string[] | null) => void;
  /** The read groups applied from this panel, newest last (Clear returns to the one before). */
  applied: AppliedNfrGroups[];
  setRun: (jobId: string | null, result: AccessibilityResult | null) => void;
  setShowArcs: (value: boolean) => void;
  setArcSelection: (value: ArcSelection) => void;
  setShowClassArcs: (value: boolean) => void;
  pushApplied: (value: AppliedNfrGroups) => void;
  dismissApplied: (value: AppliedNfrGroups) => void;
  clearApplied: () => void;
  /** The panel's view, kept here so a remount (closing split panels re-mounts the panel) loses nothing: the tab, the
   * list filter, the open card ('<job>|<NFR>') with its highlighted variant, the Earlier group, the variants
   * unticked on cards not starred, and the scroll position of the panel's frame. */
  panelTab: 'nfrs' | 'coaccess';
  /** NFR pairs: the arcs or the matrix. */
  pairsView: 'arcs' | 'matrix';
  /** NFR pairs: the run's NFR elements, or the view's position x position matrix (Co-accessibility's). */
  pairsMode: 'elements' | 'positions';
  listFilter: 'all' | 'starred';
  openCard: string | null;
  focusedVariant: { card: string; variantId: string } | null;
  showEarlier: boolean;
  untickedLive: Record<string, string[]>;
  listScroll: number | null;
  setPanelView: (patch: Partial<Pick<AccessibilityStore, 'panelTab' | 'pairsView' | 'pairsMode' | 'listFilter' | 'openCard' | 'focusedVariant' | 'showEarlier' | 'listScroll' | 'highlightClass'>>) => void;
  setLiveTicked: (card: string, variantId: string, ticked: boolean) => void;
  /** Per card ('<job>|<NFR>'): the view its analysis shows (Motifs, Footprints, ...), so a link can open it on one. */
  cardView: Record<string, string>;
  setCardView: (card: string, view: string) => void;
  /** A footprint class to point at in a card's Footprints view (a link from the Footprints panel carries it). */
  highlightClass: { card: string; classId: string; classJob?: string } | null;
  /** The pair (or combination) the drill-down card shows without regrouping the reads: an arc, matrix cell or pair
   * row inspects; "Group reads by this pair" then applies it (pushApplied). */
  inspected: { jobId: string; split: AccessibilitySplit } | null;
  setInspected: (value: { jobId: string; split: AccessibilitySplit } | null) => void;
  /** NFR pairs: the NFRs unfolded into their variants, per run (an NFR with several variants is one element until
   * then). One state for the panel's arcs and matrix and the NFR track over the reads (nfrPairsLayout.ts). */
  expanded: Record<string, string[]>;
  setExpanded: (jobId: string, nfrId: string, open: boolean) => void;
  setAllExpanded: (jobId: string, nfrIds: string[]) => void;
  /** Two elements picked on the NFR track (or anywhere outside the panel): the panel inspects their pair when it shows
   * this run (pairForPicks), then clears it. */
  pairRequest: { jobId: string; a: string; b: string; seq: number } | null;
  requestPair: (jobId: string, a: string, b: string) => void;
  clearPairRequest: (seq: number) => void;
  /** Bumped when a session is imported: the shown run belongs to the previous session. */
  generation: number;
  reset: () => void;
}

const MAX_APPLIED = 24;

export const useAccessibilityStore = create<AccessibilityStore>(set => ({
  job: null,
  setJob: value => set(s => ({ job: typeof value === 'function' ? value(s.job) : value })),
  batchRunning: false, batchCancelled: false, batchTotal: 0, regionJobs: [], batchError: '',
  jobId: null,
  result: null,
  showArcs: true,
  arcSelection: 'significant',
  showClassArcs: true,
  ...DEFAULT_PAIR_FILTER,
  focus: null,
  setFilter: patch => set(patch),
  hoveredElement: null,
  classRevision: 0,
  bumpClassRevision: () => set(s => ({ classRevision: s.classRevision + 1 })),
  setHoveredElement: hoveredElement => set(s => (s.hoveredElement === hoveredElement ? s : { hoveredElement })),
  motifSpecies: null,
  defaultPins: null,
  setMotifSpecies: (motifSpecies, defaults) => set(defaults === undefined ? { motifSpecies } : { motifSpecies, defaultPins: defaults }),
  applied: [],
  setRun: (jobId, result) => set(s => ({ jobId, result, ...(s.jobId !== jobId ? { inspected: null } : {}) })),
  setShowArcs: showArcs => set({ showArcs }),
  setArcSelection: arcSelection => set({ arcSelection }),
  setShowClassArcs: showClassArcs => set({ showClassArcs }),
  // Kept (not popped) so undo / redo can bring a grouping back with its names and Clear.
  pushApplied: value => set(s => ({ applied: [...s.applied.slice(-(MAX_APPLIED - 1)), value] })),
  dismissApplied: value => set(s => ({ applied: s.applied.map(a => (a === value ? { ...a, dismissed: true } : a)) })),
  clearApplied: () => set({ applied: [] }),
  panelTab: 'nfrs',
  pairsView: 'arcs',
  pairsMode: 'elements',
  listFilter: 'all',
  openCard: null,
  focusedVariant: null,
  showEarlier: false,
  untickedLive: {},
  listScroll: null,
  setPanelView: patch => set(patch),
  setLiveTicked: (card, variantId, ticked) => set(s => {
    const off = new Set(s.untickedLive[card] ?? []);
    if (ticked) off.delete(variantId); else off.add(variantId);
    return { untickedLive: { ...s.untickedLive, [card]: [...off] } };
  }),
  cardView: {},
  setCardView: (card, view) => set(s => (s.cardView[card] === view ? s : { cardView: { ...s.cardView, [card]: view } })),
  highlightClass: null,
  inspected: null,
  setInspected: inspected => set({ inspected }),
  expanded: {},
  setExpanded: (jobId, nfrId, open) => set(s => {
    const now = s.expanded[jobId] ?? [];
    if (now.includes(nfrId) === open) return s;
    return { expanded: { ...s.expanded, [jobId]: open ? [...now, nfrId] : now.filter(id => id !== nfrId) } };
  }),
  setAllExpanded: (jobId, nfrIds) => set(s => ({ expanded: { ...s.expanded, [jobId]: [...nfrIds] } })),
  pairRequest: null,
  requestPair: (jobId, a, b) => set(s => ({ pairRequest: { jobId, a, b, seq: (s.pairRequest?.seq ?? 0) + 1 } })),
  clearPairRequest: seq => set(s => (s.pairRequest?.seq === seq ? { pairRequest: null } : s)),
  generation: 0,
  reset: () => set(s => ({ job: null, batchRunning: false, batchCancelled: false, batchTotal: 0, regionJobs: [], batchError: '', jobId: null, result: null, showArcs: true, expanded: {}, pairRequest: null, applied: [], focus: null, generation: s.generation + 1,
    openCard: null, focusedVariant: null, untickedLive: {}, listScroll: null, cardView: {}, highlightClass: null, inspected: null })),
}));
