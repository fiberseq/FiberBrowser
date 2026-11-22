/**
 * The card equals the curve beside it: a window's card value (layers, curve units, read from the panel's profile pool)
 * is the drawn profile's mean over the same bins, for the dataset and for each cluster, with the read track's own
 * binning (layerChannelRead + accumulateChannels 'touch' + finishChannels). Exact bp is the documented alternative:
 * it reads lower for calls shorter than a few bins, and the two agree for calls spanning whole bins.
 */
import { describe, expect, it } from 'vitest';
import { accumulateChannels, finishChannels } from '../plots/profileEngine';
import { layerChannelRead } from '../../utils/metaprofileReads';
import { setProfileReadPool } from '../../utils/profileReadPool';
import type { CompactRead } from '../../components/tracks/read-track/types';
import { buildGroups, computeQuant } from './engine';
import { poolLayerData } from './sources';
import { binnedWindowMean } from './windowMaths';
import { DEFAULT_QUANT_SPEC, normalizeQuantSpec } from './spec';
import type { LoadContext, MeasureDef } from './measures';

const VIEW = { chrom: 'chr1', start: 10_000, end: 14_000, genome: null };
const W = VIEW.end - VIEW.start, RES = 500;

/** Synthetic reads in window coordinates: spans that end inside the window (coverage varies), nucleosome and short
 *  TF calls at uneven offsets (calls straddle bin edges), every fourth read without calls in the window. */
function reads(n: number, seed: number): CompactRead[] {
  const out: CompactRead[] = [];
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let i = 0; i < n; i++) {
    const s = Math.floor(rnd() * 1500), e = 2200 + Math.floor(rnd() * 1800);
    const nuc: Array<[number, number, number]> = [], tf: Array<[number, number, number]> = [];
    for (let p = s + 20; p + 150 < e; p += 160 + Math.floor(rnd() * 120)) if (i % 4 !== 0 || p < 1500 || p > 2600) nuc.push([p, p + 147, 147]);
    for (let p = s + 7; p + 30 < e; p += 90 + Math.floor(rnd() * 200)) tf.push([p, p + 13 + Math.floor(rnd() * 20), 20]);
    out.push({ id: `r${i}`, intervals: [[s, e, 1]], layers: { nuc: { intervals: nuc }, tf: { intervals: tf } } } as unknown as CompactRead);
  }
  return out;
}

function curve(rs: CompactRead[], ch: string): number[] {
  return finishChannels(accumulateChannels(rs.map(layerChannelRead), RES, W, 'touch'))[ch] ?? [];
}

const layer = (key: string): MeasureDef => ({ id: `layer:${key}`, label: key, source: 'layers', kind: 'fraction', unit: 'fraction of covered bp', enrichment: true, windowed: true, available: true });

function setup(windowRel: [number, number], units: 'curve' | 'exact') {
  const pool = reads(120, 7);
  setProfileReadPool('ds', { reads: pool, chrom: VIEW.chrom, start: VIEW.start, end: VIEW.end, resolution: RES });
  const assignments = { ds: Object.fromEntries(pool.map((r, i) => [r.id, i % 3])) };
  const panels = [{ key: 'ds', datasetId: 'ds', label: 'DS' }];
  const ctx = { state: {} as never, view: VIEW, bounds: { from: VIEW.start + windowRel[0], to: VIEW.start + windowRel[1] }, allReads: { ...VIEW, panels }, clusters: null, extras: {},
    readCap: 10000, seed: 1, flankFraction: 0.1, sizeBand: [0, 90], layerUnits: units, readSource: 'panel' } as unknown as LoadContext;
  const data = poolLayerData(['nuc', 'tf'], ctx)!;
  return { pool, assignments, panels, data };
}

describe('the card matches the curve (curve units, the panel\'s reads)', () => {
  for (const win of [[1203, 1611], [0, 4000], [2000, 2009], [3700, 3990]] as Array<[number, number]>) {
    it(`window ${win[0]}–${win[1]}: dataset and every cluster, Nuc and TF, equal to the drawn curve's mean over the window's bins`, () => {
      const { pool, assignments, panels, data } = setup(win, 'curve');
      const spec = normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, ci: 'none', minReads: 0 });
      for (const comparison of ['datasets', 'clusters'] as const) {
        const groups = buildGroups(comparison, { panels, clusterPanels: panels, visible: [0, 1, 2].map(c => ({ cluster: c, color: '#000' })), clusterLabel: c => `C${c}` });
        const r = computeQuant({ spec, measures: [{ def: layer('nuc'), data: data['layer:nuc'] }, { def: layer('tf'), data: data['layer:tf'] }], groups, assignments, boundsBp: win[1] - win[0], seed: 1 });
        for (const key of ['nuc', 'tf']) {
          groups.forEach(g => {
            const rs = comparison === 'datasets' ? pool : pool.filter(x => assignments.ds[x.id] === g.match[0].cluster);
            const drawn = binnedWindowMean(curve(rs, `layer:${key}`), 0, W, win[0], win[1]);
            const card = r.cells.find(c => c.measure === `layer:${key}` && c.group === g.id)!.value;
            expect(card).not.toBeNull();
            expect(card!).toBeCloseTo(drawn!, 12);
          });
        }
      }
    });
  }

  it('exact bp is the alternative: short calls read lower than the curve; whole-bin calls agree within a bin\'s worth', () => {
    const win: [number, number] = [1203, 1611];
    const c = setup(win, 'curve'), e = setup(win, 'exact');
    const spec = normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, ci: 'none', minReads: 0 });
    const groups = buildGroups('datasets', { panels: c.panels, clusterPanels: [], visible: [], clusterLabel: String });
    const val = (d: typeof c.data, key: string) => computeQuant({ spec, measures: [{ def: layer(key), data: d[`layer:${key}`] }], groups, assignments: c.assignments, boundsBp: 408, seed: 1 }).cells[0].value!;
    expect(val(e.data, 'tf')).toBeLessThan(val(c.data, 'tf') * 0.85);
    expect(Math.abs(val(e.data, 'nuc') - val(c.data, 'nuc'))).toBeLessThan(0.1 * val(c.data, 'nuc'));
  });

  it('a window no read covers has no value (never a 0 standing for no reads)', () => {
    setProfileReadPool('ds', { reads: [{ id: 'r', intervals: [[0, 100, 1]], layers: { nuc: { intervals: [[10, 90, 80]] } } } as unknown as CompactRead],
      chrom: VIEW.chrom, start: VIEW.start, end: VIEW.end, resolution: RES });
    const panels = [{ key: 'ds', datasetId: 'ds', label: 'DS' }];
    const ctx = { view: VIEW, bounds: { from: VIEW.start + 3000, to: VIEW.start + 3100 }, allReads: { ...VIEW, panels }, flankFraction: 0.1, layerUnits: 'curve', readSource: 'panel' } as unknown as LoadContext;
    const data = poolLayerData(['nuc'], ctx)!;
    const spec = normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, ci: 'none', minReads: 0 });
    const groups = buildGroups('datasets', { panels, clusterPanels: [], visible: [], clusterLabel: String });
    const r = computeQuant({ spec, measures: [{ def: layer('nuc'), data: data['layer:nuc'] }], groups, assignments: {}, boundsBp: 100, seed: 1 });
    expect(r.cells[0]).toMatchObject({ value: null, n: 0 });
  });

  it('a panel without curves for this view gives no pool data (the source then reads a fresh sample)', () => {
    setProfileReadPool('other', { reads: [], chrom: 'chr2', start: 0, end: 10, resolution: RES });
    const ctx = { view: VIEW, bounds: { from: VIEW.start, to: VIEW.end }, allReads: { ...VIEW, panels: [{ key: 'other', datasetId: 'x', label: 'x' }] }, flankFraction: 0.1, layerUnits: 'curve' } as unknown as LoadContext;
    expect(poolLayerData(['nuc'], ctx)).toBeNull();
  });
});
