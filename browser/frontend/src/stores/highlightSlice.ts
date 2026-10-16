import type { BrowserState } from './browserStore';
import type { Highlight } from '../types/regions';
import { seedHistoryBaseline } from './historySlice';

/**
 * Highlighted regions (the toolbar's Highlight group): a coloured wash over
 * a region in every panel on its reference, in the genome map and in exported
 * figures. Each change is one undo step; highlights are saved in sessions
 * (SerializedState.highlights).
 */

/** Wash colours, pale enough that the reads under them stay readable in both themes. */
export const HIGHLIGHT_COLORS = [
  { id: 'yellow', color: '#fde047', name: 'Yellow' },
  { id: 'rose', color: '#fda4af', name: 'Rose' },
  { id: 'violet', color: '#c4b5fd', name: 'Violet' },
  { id: 'blue', color: '#93c5fd', name: 'Blue' },
  { id: 'peach', color: '#fdba74', name: 'Peach' },
  { id: 'slate', color: '#cbd5e1', name: 'Grey' },
] as const;

export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0].color;

export interface HighlightSlice {
  highlights: Highlight[];
  /** Dragging on a ruler highlights instead of zooming (the toolbar's Highlight button). */
  highlightDrawMode: boolean;
  /** Colour of the next highlight. */
  highlightColor: string;
  addHighlight: (highlight: Omit<Highlight, 'id' | 'color'> & { color?: string; id?: string }) => string;
  addHighlights: (highlights: Array<Omit<Highlight, 'id' | 'color'> & { color?: string }>) => string[];
  updateHighlight: (id: string, patch: Partial<Omit<Highlight, 'id'>>) => void;
  removeHighlight: (id: string) => void;
  clearHighlights: () => void;
  setHighlightDrawMode: (on: boolean) => void;
  setHighlightColor: (color: string) => void;
}

type SetState = (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void;

let counter = 0;
const newId = () => `hl_${Date.now().toString(36)}${(counter = (counter + 1) % 100000).toString(36)}`;

function fmt(h: Pick<Highlight, 'chrom' | 'start' | 'end'>): string {
  return `${h.chrom}:${h.start.toLocaleString()}-${h.end.toLocaleString()}`;
}

/** Validated highlights from a session or snapshot. */
export function normalizeHighlights(raw: unknown): Highlight[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is Highlight => !!h && typeof h === 'object'
    && typeof (h as Highlight).id === 'string' && typeof (h as Highlight).chrom === 'string'
    && Number.isFinite((h as Highlight).start) && Number.isFinite((h as Highlight).end) && (h as Highlight).end > (h as Highlight).start)
    .map(h => ({ ...h, genome: String(h.genome || 'none'), color: typeof h.color === 'string' && h.color ? h.color : DEFAULT_HIGHLIGHT_COLOR }));
}

export function createHighlightSlice(set: SetState, get: () => BrowserState): HighlightSlice {
  const undoable = (label: string, apply: () => void, coalesceKey?: string) => {
    seedHistoryBaseline(get(), `Before ${label.charAt(0).toLowerCase()}${label.slice(1)}`, 'labeling');
    apply();
    get().pushSnapshot?.(label, { kind: 'labeling', explicit: true, ...(coalesceKey ? { coalesceKey } : {}) });
  };
  return {
    highlights: [],
    highlightDrawMode: false,
    highlightColor: DEFAULT_HIGHLIGHT_COLOR,
    addHighlight: (highlight) => get().addHighlights([highlight])[0] ?? '',
    addHighlights: (list) => {
      const made: Highlight[] = list
        .map(h => {
          const start = Math.max(0, Math.floor(Math.min(h.start, h.end)));
          const end = Math.ceil(Math.max(h.start, h.end));
          return { ...h, id: (h as { id?: string }).id ?? newId(), start, end, color: h.color ?? get().highlightColor, genome: h.genome || 'none' };
        })
        .filter(h => h.chrom && h.end > h.start);
      if (!made.length) return [];
      const label = made.length === 1 ? `Highlight ${made[0].label || fmt(made[0])}` : `Highlight ${made.length} regions`;
      undoable(label, () => set(s => ({ highlights: [...s.highlights, ...made] })));
      return made.map(h => h.id);
    },
    updateHighlight: (id, patch) => {
      const current = get().highlights.find(h => h.id === id);
      if (!current) return;
      const label = 'label' in patch ? 'Rename highlight' : 'color' in patch ? 'Recolour highlight' : 'Edit highlight';
      undoable(label, () => set(s => ({ highlights: s.highlights.map(h => (h.id === id ? { ...h, ...patch } : h)) })), `highlight:${id}:${Object.keys(patch).join(',')}`);
    },
    removeHighlight: (id) => {
      const current = get().highlights.find(h => h.id === id);
      if (!current) return;
      undoable(`Remove highlight ${current.label || fmt(current)}`, () => set(s => ({ highlights: s.highlights.filter(h => h.id !== id) })));
    },
    clearHighlights: () => {
      if (!get().highlights.length) return;
      undoable('Clear highlights', () => set({ highlights: [] }));
    },
    setHighlightDrawMode: (on) => set({ highlightDrawMode: on }),
    setHighlightColor: (color) => set({ highlightColor: color }),
  };
}
