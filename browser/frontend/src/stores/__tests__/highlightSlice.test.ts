import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';
import { serializeState } from '../historySlice';
import { SESSION_PRE_VIEWPORT_KEYS, applyImportedState } from '../../api/session';
import { useBrowserStore } from '../browserStore';
import { normalizeHighlights } from '../highlightSlice';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({ chrom: 'chr2L', start: 1000, end: 5000, currentGenome: 'dm6' } as never);
});

describe('highlights (toolbar Highlight group)', () => {
  it('each change is one undo step, and redo brings it back', () => {
    const s = () => store.getState();
    const id = s().addHighlight({ genome: 'dm6', chrom: 'chr2L', start: 1500, end: 1200, label: 'enhancer' });
    // Start and end are put in order; the next colour is used.
    expect(s().highlights).toEqual([{ id, genome: 'dm6', chrom: 'chr2L', start: 1200, end: 1500, label: 'enhancer', color: s().highlightColor }]);
    s().setHighlightColor('#93c5fd');
    const second = s().addHighlight({ genome: 'dm6', chrom: 'chr2L', start: 3000, end: 3100 });
    expect(s().highlights.find(h => h.id === second)?.color).toBe('#93c5fd');
    s().updateHighlight(id, { label: 'MSE' });
    s().removeHighlight(second);
    expect(s().highlights.map(h => h.label)).toEqual(['MSE']);

    s().undo(); // remove
    expect(s().highlights).toHaveLength(2);
    s().undo(); // rename
    expect(s().highlights.find(h => h.id === id)?.label).toBe('enhancer');
    s().undo(); // second highlight
    s().undo(); // first highlight
    expect(s().highlights).toEqual([]);
    s().redo();
    expect(s().highlights.map(h => h.id)).toEqual([id]);
  });

  it('are saved in sessions and snapshots, and bad ones are dropped on restore', () => {
    store.getState().addHighlights([
      { genome: 'dm6', chrom: 'chr2L', start: 10, end: 20 },
      { genome: 'hg38', chrom: 'chr19', start: 100, end: 300, label: 'x', color: '#fda4af' },
    ]);
    const saved = serializeState(store.getState());
    expect(saved.highlights).toEqual(store.getState().highlights);
    // Sessions carry them (applied with the panels, before the view).
    expect(SESSION_PRE_VIEWPORT_KEYS).toContain('highlights');
    // A snapshot brings them back.
    const index = store.getState()._historyPointer;
    store.setState({ highlights: [] } as never);
    store.getState().restoreSnapshot(index);
    expect(store.getState().highlights.map(h => h.label ?? null)).toEqual([null, 'x']);
    expect(normalizeHighlights([{ id: 'a', chrom: 'c', start: 5, end: 1 }, { id: 'b', chrom: 'c', start: 1, end: 5 }, null]))
      .toEqual([{ id: 'b', chrom: 'c', start: 1, end: 5, genome: 'none', color: '#fde047' }]);
    expect(normalizeHighlights(undefined)).toEqual([]);
  });

  it('Clear removes all at once (one undo step)', () => {
    store.getState().addHighlights([{ genome: 'dm6', chrom: 'chr2L', start: 1, end: 9 }, { genome: 'dm6', chrom: 'chr2L', start: 20, end: 29 }]);
    store.getState().clearHighlights();
    expect(store.getState().highlights).toEqual([]);
    store.getState().undo();
    expect(store.getState().highlights).toHaveLength(2);
  });
});

describe('highlights in sessions', () => {
  it('a session saved before highlights existed opens with none (not the previous session’s)', () => {
    useBrowserStore.setState({ highlights: [{ id: 'h', genome: 'dm6', chrom: 'chr2L', start: 1, end: 9, color: '#fde047' }] } as never);
    applyImportedState({ datasets: [], frontend: { sessionName: 'old' } });
    expect(useBrowserStore.getState().highlights).toEqual([]);
    applyImportedState({ datasets: [], frontend: { highlights: [{ id: 'k', genome: 'hg38', chrom: 'chr1', start: 5, end: 50, color: '#93c5fd', label: 'x' }] } });
    expect(useBrowserStore.getState().highlights.map(h => h.id)).toEqual(['k']);
  });
});
