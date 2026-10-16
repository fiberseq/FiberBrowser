import type { Snapshot } from '../stores/historySlice';

/**
 * The step Undo and Redo act on, in words. The history keeps the state after
 * each step, so Undo reverses the current entry and Redo re-applies the next
 * one. A "Before …" entry is a checkpoint of changes that had no step of
 * their own (peaks scanned, a selection made) just before an action.
 */
export function describeHistoryStep(snapshot: Pick<Snapshot, 'label'> | undefined | null): string | null {
  const label = snapshot?.label?.trim();
  if (!label) return null;
  const before = /^Before\s+(.+)$/i.exec(label);
  if (before) return `earlier changes (before ${before[1]})`;
  return label;
}

/** Undo reverses the current step; Redo re-applies the next. */
export function undoRedoLabels(stack: Array<Pick<Snapshot, 'label'>>, pointer: number): { undo: string | null; redo: string | null } {
  const canUndo = pointer > 0;
  const canRedo = pointer >= 0 && pointer < stack.length - 1;
  return {
    undo: canUndo ? describeHistoryStep(stack[pointer]) : null,
    redo: canRedo ? describeHistoryStep(stack[pointer + 1]) : null,
  };
}

type StepLocus = { chrom: string; start: number; end: number };
type StepPanel = {
  id: string; contentType?: string; datasetId?: string | null; genome?: string | null;
  viewportOverride?: StepLocus | null; collapsed?: boolean;
};
type StepState = { chrom?: unknown; start?: unknown; end?: unknown; panels?: unknown; collapsedRows?: unknown; fullViewPanelId?: unknown };

const fmtLocus = (l: StepLocus) => `${l.chrom}:${Math.max(0, l.start).toLocaleString('en-US')}-${l.end.toLocaleString('en-US')}`;
const lociKey = (genome: string | null | undefined, l: StepLocus) => `${genome ?? ''}|${l.chrom}:${l.start}-${l.end}`;

function mainOf(state: StepState): StepLocus | null {
  return typeof state.chrom === 'string' && typeof state.start === 'number' && typeof state.end === 'number'
    ? { chrom: state.chrom, start: state.start, end: state.end } : null;
}

/** The dataset panels a step showed (as utils/panelScope's visibleDatasetPanels, on a saved step). */
function datasetPanelsOf(state: StepState): StepPanel[] {
  if (!Array.isArray(state.panels)) return [];
  const panels = (state.panels as Array<StepPanel & { layoutRow?: number }>).filter(Boolean);
  const isDataset = (p: StepPanel) => p.contentType === 'dataset' && !!p.datasetId;
  const maximized = typeof state.fullViewPanelId === 'string' ? panels.find(p => p.id === state.fullViewPanelId) : undefined;
  if (maximized) return isDataset(maximized) ? [maximized] : [];
  const collapsedRows = new Set(Array.isArray(state.collapsedRows) ? state.collapsedRows as number[] : []);
  return panels.filter(p => isDataset(p) && !p.collapsed && !collapsedRows.has(p.layoutRow ?? 0));
}

/** Where each dataset panel of a step is (its own locus, else the main one), with its reference. */
function panelLoci(state: StepState): Array<{ id: string; genome: string | null; locus: StepLocus }> {
  const main = mainOf(state);
  const out: Array<{ id: string; genome: string | null; locus: StepLocus }> = [];
  for (const p of datasetPanelsOf(state)) {
    const locus = p.viewportOverride ?? main;
    if (locus) out.push({ id: p.id, genome: p.genome ?? null, locus });
  }
  return out;
}

function describeLoci(list: Array<{ genome: string | null; locus: StepLocus }>): string {
  const seen = new Set<string>();
  const distinct = list.filter(x => {
    const key = lociKey(x.genome, x.locus);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const first = distinct[0];
  const text = `${first.genome ? `${first.genome} ` : ''}${fmtLocus(first.locus)}`;
  return distinct.length > 1 ? `${text} +${distinct.length - 1} more` : text;
}

/**
 * The locus a History entry names (audit L1): where the step moved panels to
 * (a panel on another reference with that reference's name), else the main
 * locus when it moved, else what the panels showed. In "Each panel navigates"
 * the main locus is stale, so a panel step never names it.
 */
export function describeStepLocus(state: StepState, prev?: StepState | null): string {
  const now = panelLoci(state);
  const main = mainOf(state);
  if (prev) {
    const before = new Map(panelLoci(prev).map(x => [x.id, lociKey(x.genome, x.locus)]));
    const moved = now.filter(x => before.has(x.id) && before.get(x.id) !== lociKey(x.genome, x.locus));
    const prevMain = mainOf(prev);
    const mainMoved = !!main && !!prevMain && lociKey(null, main) !== lociKey(null, prevMain);
    // Panels that moved with the main view are named by it.
    const own = moved.filter(x => !(mainMoved && !x.genome && lociKey(null, x.locus) === lociKey(null, main!)));
    if (own.length) return describeLoci(own);
    if (mainMoved) return fmtLocus(main!);
  }
  const followsMain = datasetPanelsOf(state).some(p => !p.genome && !p.viewportOverride);
  if ((followsMain || now.length === 0) && main) return fmtLocus(main);
  return now.length ? describeLoci(now) : 'unknown';
}

/** A panel of the step shows another locus or reference than in the step before. */
export function panelLociChanged(prev: StepState | undefined | null, state: StepState): boolean {
  if (!prev) return false;
  const key = (s: StepState) => datasetPanelsOf(s).map(p => `${p.id}=${p.viewportOverride ? lociKey(p.genome, p.viewportOverride) : `${p.genome ?? ''}|main`}`).join(';');
  return key(prev) !== key(state);
}
