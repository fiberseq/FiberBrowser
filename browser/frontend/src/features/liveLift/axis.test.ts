import { beforeEach, describe, expect, it } from 'vitest';
import { makeAxis, type LiveLiftExpansion } from './axis';
import { useBrowserStore } from '../../stores/browserStore';
import { normalizeExpansions } from './persistence';
import { serializeState, deserializeSavedState } from '../../stores/historySlice';
import { storeExtensions } from '../../stores/storeExtensions';
import type { PanelConfig } from '../../types';

const ins = (pos = 40, length = 20, ins_id = 'MAT:src:0-20:insertion'): LiveLiftExpansion => ({
  chrom: 'chr1', pos, length, ins_id, label: 'HG002 MAT +20 bp', hap_label: 'MAT',
});
describe('piecewise live-lift axis', () => {
  it('collapse is the plain axis; insertion bp have the same scale as target bp', () => {
    expect(makeAxis(0, 100, 1000).toX(40)).toBe(400);
    const a = makeAxis(0, 100, 1200, false, [ins()]);
    expect(a.blocks.map(b => [b.x0, b.x1])).toEqual([[400, 600]]);
    expect(a.toX(40)).toBe(600); expect(a.toX(50)).toBe(700);
    expect(a.toX(40, { ins_id: ins().ins_id, offset: 10 })).toBe(500);
    expect(makeAxis(0, 100, 1000, false, []).blocks).toEqual([]);
  });
  it('multiple blocks have deterministic order, including insertions at the same boundary', () => {
    const a = makeAxis(0, 100, 150, false, [ins(60, 10, 'z'), ins(40, 20, 'b'), ins(40, 20, 'a')]);
    expect(a.blocks.map(b => [b.x0, b.x1, b.ins.ins_id])).toEqual([[40, 60, 'a'], [60, 80, 'b'], [100, 110, 'z']]);
    expect(a.toX(100)).toBe(150);
  });
  it.each([false, true])('fromX inverts genomic and insertion-local positions (reversed=%s)', reversed => {
    const a = makeAxis(10, 100, 800, reversed, [ins(40, 20, 'a'), ins(70, 30, 'b')]);
    for (const pos of [10, 39, 40, 55, 70, 90, 100]) expect(a.fromX(a.toX(pos)).pos).toBeCloseTo(pos);
    for (const id of ['a', 'b']) {
      const local = a.fromX(a.toX(40, { ins_id: id, offset: 12 }));
      expect(local.ins_id).toBe(id); expect(local.within).toBeCloseTo(12);
    }
  });
  it('maps reversed columns and split target spans without covering a block', () => {
    const a = makeAxis(0, 100, 120, true, [ins()]);
    expect(a.blocks[0]).toMatchObject({ x0: 60, x1: 80 });
    expect(a.spans(20, 70)).toEqual([{ x: 80, w: 20 }, { x: 30, w: 30 }]);
  });
  it('the same genome position aligns at the same fraction in panels of different widths', () => {
    const a = makeAxis(0, 100, 800, false, [ins()]), b = makeAxis(0, 100, 1300, false, [ins()]);
    for (const pos of [0, 25, 40, 80, 100]) expect(a.toX(pos) / 800).toBeCloseTo(b.toX(pos) / 1300);
  });
  it('ignores blocks outside the view while retaining their state for panning back', () => {
    expect(makeAxis(50, 100, 500, false, [ins()]).blocks).toEqual([]);
    expect(makeAxis(0, 40, 400, false, [ins()]).blocks).toEqual([]);
  });
});
describe('expansion sessions and panel minimum size', () => {
  beforeEach(() => useBrowserStore.setState({ chrom: 'chr1', panels: [], liveLiftExpansions: {} }));
  it('adds, deduplicates, collapses, and refuses blocks over 50 kb', () => {
    const s = useBrowserStore.getState();
    s.expandLiveLift('main', ins()); s.expandLiveLift('main', ins());
    s.expandLiveLift('main', ins(50, 50_001, 'too-big'));
    expect(useBrowserStore.getState().liveLiftExpansions.main).toHaveLength(1);
    s.collapseLiveLift('main', ins().ins_id);
    expect(useBrowserStore.getState().liveLiftExpansions.main).toEqual([]);
  });
  it('round trips expansions and each panel’s minimum-size filter through session JSON', () => {
    useBrowserStore.setState({ panels: [{ id: 'p', contentType: 'dataset', datasetId: 'd', linkGroup: null, subTracks: [], collapsed: false, layoutRow: 0, liveLiftMinBp: 50 } as PanelConfig] });
    useBrowserStore.getState().expandLiveLift('main', ins());
    const saved = JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())));
    const restored = deserializeSavedState(saved);
    expect(restored.liveLiftExpansions?.main).toEqual([ins()]);
    expect(restored.panels?.[0].liveLiftMinBp).toBe(50);
    const extension = storeExtensions().find(e => e.id === 'liveLift')!;
    expect(extension.importSession?.(saved, useBrowserStore.getState()).liveLiftExpansions).toEqual({ main: [ins()] });
    expect(extension.importSession?.(undefined, useBrowserStore.getState()).liveLiftExpansions).toEqual({});
  });
  it('clears on chromosome departure, including independently pinned views', () => {
    useBrowserStore.setState({ panels: [{ id: 'own', linkGroup: null, viewportOverride: { chrom: 'chr1', start: 0, end: 100 } } as PanelConfig] });
    useBrowserStore.getState().expandLiveLift('main', ins());
    useBrowserStore.getState().expandLiveLift('panel:own', ins());
    useBrowserStore.setState({ chrom: 'chr2' });
    expect(useBrowserStore.getState().liveLiftExpansions.main).toEqual([]);
    expect(useBrowserStore.getState().liveLiftExpansions['panel:own']).toHaveLength(1);
    useBrowserStore.setState({ panels: [{ id: 'own', linkGroup: null, viewportOverride: { chrom: 'chr2', start: 0, end: 100 } } as PanelConfig] });
    expect(useBrowserStore.getState().liveLiftExpansions['panel:own']).toEqual([]);
  });
  it('validates untrusted session expansions', () => {
    expect(normalizeExpansions({ main: [ins(), ins(), ins(40, -1), ins(30, 50001), null] })).toEqual({ main: [ins()] });
  });
});
