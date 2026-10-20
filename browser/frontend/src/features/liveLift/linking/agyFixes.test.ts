/** Regressions for the second (agy) review of P3. */
import { beforeEach, describe, expect, it } from 'vitest';
import { linearX, ribbonGeometry, type GapRow } from './ribbon';
import { useLiftHover } from './hover';
import { liftPanelFor } from './liftLink';
import type { PanelConfig } from '../../../types';
import { decodeTile, mapSpan, prefetchView, resetNavigation, setNavigationFetcher, type LiftSummary } from './navigation';

const S = 'chrS_MATERNAL';
const x = linearX(0, 1000, 1000, false);

describe('ribbon gaps', () => {
  it('draws a gap whose chain has no piece in view (a view inside a deletion), with no uncovered band over it', () => {
    const gaps: GapRow[] = [[0, 0, 1000, 500, 500, 'target_insertion', S, '+']];
    const g = ribbonGeometry({ pieces: [], gaps, topX: x, bottomX: x, contig: S, height: 40, target: { start: 0, end: 1000 }, source: { start: 0, end: 1000 } });
    expect(g.shapes.map(s => s.kind)).toContain('target_insertion');
    expect(g.shapes.some(s => s.kind === 'uncovered_target')).toBe(false);
  });
});

describe('hover', () => {
  beforeEach(() => useLiftHover.setState({ hover: null }));
  it('another row of the same molecule moves the hover (supplementary, other orientation)', () => {
    const base = { key: 'k', datasetId: 'd', panelId: 'p' };
    useLiftHover.getState().set({ ...base, target: { chrom: 'c', start: 0, end: 10 } });
    useLiftHover.getState().set({ ...base, target: { chrom: 'c', start: 500, end: 600 } });
    expect(useLiftHover.getState().hover?.target?.start).toBe(500);
  });
});

describe('retargeting after pooling or splitting', () => {
  const link = { id: 'L', datasetId: 'lift', liftPanelId: 'gone', hap: 'h2', hapLabel: 'PAT', contig: 'c', flip: false };
  const p = (id: string, liftHap?: string) => ({ id, contentType: 'dataset', datasetId: 'lift', liftHap }) as PanelConfig;
  it('pairs with its haplotype\'s split panel, else the pooled panel', () => {
    expect(liftPanelFor(link, [p('mat', 'MAT'), p('pat', 'PAT')])?.id).toBe('pat');
    expect(liftPanelFor(link, [p('pooled')])?.id).toBe('pooled');
    expect(liftPanelFor({ ...link, liftPanelId: 'mat' }, [p('mat', 'MAT'), p('pat', 'PAT')])?.id).toBe('pat');
    expect(liftPanelFor(link, [])).toBeNull();
  });
});

describe('a view inside a gap with the exact tile loaded', () => {
  const SUMMARY: LiftSummary = { key: 'k', tile_bp: 1_000_000, outline_max_drift: 1000, haplotypes: ['H#1'], labels: { 'H#1': 'MAT' },
    sources: { [S]: 'H#1' }, targets: { chrT: 20_000 }, selected: [true], chains: [['chrT', 1000, 7000, S, 0, 5000, '+', 'H#1', 6000, 5000]] };
  // Exact pieces: t[1000,3000)->q[0,2000), t[4000,7000)->q[2000,5000) (a 1 kb target-only gap); the outline merged them
  // with 1 kb drift.
  const tileBytes = (side: number) => {
    const out = [0x47, 0x4c, 0x54, 0x31, side, 0, 2];
    const uv = (n: number) => { while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); };
    const zz = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
    uv(zz(1000)); uv(2000); uv(zz(0)); uv(0);
    uv(zz(1000)); uv(3000); uv(zz(2000)); uv(0);
    return new Uint8Array(out);
  };
  beforeEach(() => {
    resetNavigation();
    setNavigationFetcher({ json: async u => (u.includes('summary') ? SUMMARY : { rows: [[1000, 7000, 0, 5000, '+', 0, 1000]] }), bytes: async () => tileBytes(0) });
  });
  it('maps exactly (no endless pending correction)', async () => {
    expect(decodeTile(tileBytes(0)).start).toEqual([1000, 4000]);
    await prefetchView('lift', 'k', 0, 'chrT', 3200, 3800);
    const out = mapSpan('lift', 'k', 'toSource', { chrom: 'chrT', start: 3200, end: 3800 }, { hap: 'H#1' });
    expect(out.status).toBe('mapped');
    if (out.status === 'mapped') expect(out.mapping.exact).toBe(true);
  });
});
