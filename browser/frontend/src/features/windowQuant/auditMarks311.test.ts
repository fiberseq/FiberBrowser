/** Window quantification, mark layers (audit 3.1.1 #3): 5mC and deamination are marks, read from their own channel. */
import { describe, expect, it, vi } from 'vitest';

const reads = [{ id: 'r0', aligned_blocks: [[1000, 1100]], intervals: [[0, 100, 100]], methyl_m6a: [10], methyl_m5c: [20, 30], deam: [[40, 0], [50, 0], [60, 1]] }];
vi.mock('../../api/sharedFetch', () => ({ fetchJson: vi.fn(async () => ({ reads, total_reads: 1 })) }));

import { layerMeasures, loadLayers, poolLayerData } from './sources';
import { setProfileReadPool } from '../../utils/profileReadPool';
import { isMarkLayer, layerChannelRead } from '../../utils/metaprofileReads';
import { unitKey, type LoadContext, type MeasureDef } from './measures';

const ctx = { view: { chrom: 'chr1', start: 1000, end: 1100, genome: null }, bounds: { from: 1000, to: 1100 }, flankFraction: 0.1, layerUnits: 'curve', readSource: 'fetch',
  readCap: 10, seed: 1, allReads: { panels: [{ key: 'p1', datasetId: 'ds', label: 'DS' }] } } as unknown as LoadContext;
const def = (key: string): MeasureDef => ({ id: `layer:${key}`, label: key, source: 'layers', kind: 'rate', unit: 'marks per kb of read', enrichment: true, windowed: true, available: true });

describe('mark layers', () => {
  it('m6A, mod, 5mC and deamination are marks (rate); interval layers are not', () => {
    for (const k of ['m6a', 'mod', 'm5c', 'deam']) expect(isMarkLayer(k)).toBe(true);
    for (const k of ['nuc', 'tf', 'fire', 'footprint']) expect(isMarkLayer(k)).toBe(false);
    const state = { datasets: [{ id: 'ds', available_layers: { m5c: true, nuc: true } }] };
    const ms = layerMeasures({ ...ctx, state } as never);
    expect(ms.find(m => m.id === 'layer:m5c')?.kind).toBe('rate');
  });

  it('a fresh sample reads each mark layer from its own channel (100 bp read: 1 m6A, 2 5mC, 3 deamination)', async () => {
    const d = await loadLayers([def('m6a'), def('m5c'), def('deam')], ctx);
    const k = unitKey('ds', 'r0');
    expect(d['layer:m6a'].units!.get(k)!.slice(0, 2)).toEqual([1, 100]);
    expect(d['layer:m5c'].units!.get(k)!.slice(0, 2)).toEqual([2, 100]);
    expect(d['layer:deam'].units!.get(k)!.slice(0, 2)).toEqual([3, 100]);
  });

  it('the panel pool reads 5mC marks as the read track does (exact marks, never interval spans)', () => {
    setProfileReadPool('p1', { reads: reads as never, chrom: 'chr1', start: 1000, end: 1100, resolution: 500 });
    expect(layerChannelRead(reads[0] as never).points['layer:m5c']).toEqual([20, 30]);
    const d = poolLayerData(['m5c', 'deam'], { ...ctx, readSource: 'panel' } as LoadContext)!;
    expect(d['layer:m5c'].binned).toBeUndefined();
    expect(d['layer:m5c'].units!.get(unitKey('ds', 'r0'))!.slice(0, 2)).toEqual([2, 100]);
    expect(d['layer:deam'].units!.get(unitKey('ds', 'r0'))!.slice(0, 2)).toEqual([3, 100]);
  });
});
