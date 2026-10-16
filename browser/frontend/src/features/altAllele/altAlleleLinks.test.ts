import '../testSetup';
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore, ensureBuiltinPanelsRegistered } from '../../stores/__tests__/helpers';
import type { PanelConfig } from '../../types';
import type { AltAlleleLayout } from './types';

/**
 * fb-n11-altallele: a linked alt-allele panel moves with the main view through the
 * breakpoint, and moves the main view mapped back (inside the insert: the breakpoint).
 */
const L: AltAlleleLayout = {
  chrom: 'chr2L', ref: 9_467_038, insert_len: 9_184, flank_left: 20_000, flank_right: 20_000,
  name: 'chr2L_9467038_INS9184', length: 49_184, insert_start: 20_000, insert_end: 29_184,
};

let store: ReturnType<typeof createTestStore>;
const panel = (id: string) => store.getState().panels.find(p => p.id === id)!;
const main = () => { const s = store.getState(); return { chrom: s.chrom, start: s.start, end: s.end }; };

function altPanel(linked = true): string {
  const id = store.getState().addPanel('alt');
  store.setState(s => ({
    panels: s.panels.map(p => (p.id === id ? {
      ...p, genome: 'fasta:alt_x', ownLocus: true, stateKey: `${id}~alt`,
      viewportOverride: { chrom: L.name, start: 19_000, end: 30_184 },
      altAllele: {
        cluster: { datasetId: 'src', chrom: 'chr2L', ref: L.ref, len: L.insert_len }, layout: L,
        altDatasetId: 'alt', genomeKey: 'fasta:alt_x', linked, restore: null,
      },
    } as PanelConfig : p)),
  }));
  return id;
}

beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  store = createTestStore();
  store.getState().addPanel('src');
  store.getState().setViewport('chr2L', 9_466_038, 9_468_038);
});

describe('alt-allele panels and the main view', () => {
  it('follow a main-view move mapped through the breakpoint', () => {
    const id = altPanel();
    store.getState().setViewport('chr2L', 9_468_000, 9_469_000);
    expect(panel(id).viewportOverride).toEqual({ chrom: L.name, start: 30_146, end: 31_146 });
    // Back across the breakpoint: the insert shows in full.
    store.getState().setViewport('chr2L', 9_466_038, 9_468_038);
    expect(panel(id).viewportOverride).toEqual({ chrom: L.name, start: 19_000, end: 30_184 });
  });

  it('move the main view mapped back; inside the insert it stays at the breakpoint', () => {
    const id = altPanel();
    store.getState().setPanelViewport(id, 30_146, 31_146);
    expect(main()).toEqual({ chrom: 'chr2L', start: 9_468_000, end: 9_469_000 });
    expect(panel(id).viewportOverride).toEqual({ chrom: L.name, start: 30_146, end: 31_146 });
    store.getState().setPanelViewport(id, 22_000, 24_000);
    expect(main()).toEqual({ chrom: 'chr2L', start: 9_466_038, end: 9_468_038 });
    // The panel keeps its own view (the main view's move doesn't move it back).
    expect(panel(id).viewportOverride).toEqual({ chrom: L.name, start: 22_000, end: 24_000 });
  });

  it('a pan inside the insert (the main view stays at the breakpoint) is still an undo step', () => {
    const id = altPanel();
    store.getState().setPanelViewport(id, 22_000, 24_000);
    store.getState().setPanelViewport(id, 22_500, 24_500);
    expect(main()).toEqual({ chrom: 'chr2L', start: 9_466_038, end: 9_468_038 });
    expect(store.getState()._historyStack.at(-1)?.label).toMatch(/^Navigate panel to chr2L_9467038_INS9184:22,500/);
  });

  it('a source on a reference of its own never links to the main view', () => {
    const id = altPanel();
    store.setState(s => ({ panels: s.panels.map(p => (p.id === id ? { ...p, altAllele: { ...p.altAllele!, sourceGenome: 'hg19' } } : p)) }));
    store.getState().setViewport('chr2L', 9_468_000, 9_469_000);
    expect(panel(id).viewportOverride).toEqual({ chrom: L.name, start: 19_000, end: 30_184 });
    store.getState().setPanelViewport(id, 22_000, 24_000);
    expect(main()).toEqual({ chrom: 'chr2L', start: 9_468_000, end: 9_469_000 });
  });

  it('an unlinked one, or the main view on another chromosome, moves nothing', () => {
    const id = altPanel(false);
    store.getState().setViewport('chr2L', 9_468_000, 9_469_000);
    expect(panel(id).viewportOverride).toEqual({ chrom: L.name, start: 19_000, end: 30_184 });
    store.getState().setPanelViewport(id, 22_000, 24_000);
    expect(main()).toEqual({ chrom: 'chr2L', start: 9_468_000, end: 9_469_000 });
    const linked = altPanel(true);
    store.getState().setViewport('chr3R', 1_000, 2_000);
    expect(panel(linked).viewportOverride).toEqual({ chrom: L.name, start: 19_000, end: 30_184 });
  });
});
