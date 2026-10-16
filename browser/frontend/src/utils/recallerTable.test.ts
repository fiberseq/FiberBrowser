import { describe, expect, it } from 'vitest';
import type { ConsensusCatalog, RecallerStrand } from '../api/consensusWorkflow';
import { channelTargets, classFilterKey, formatRecallerTableTsv, parseTiers, tierSpec, tierSum, discrepancyFlags, discrepancyScore, pooledPrevalence, recallerChannels, recallerClassRows } from './recallerTable';

const r = (prevalence: number, molecules: number, extra: Partial<RecallerStrand> = {}): RecallerStrand => ({
  prevalence, molecules, prevalence_lower_bound: 0, broader: 0, other_shape: 0, accessible: 1 - prevalence, support_gain_nats: 20,
  supported: true, resolution_nats: 12, resolved: true, spots: '', L0: 0, L1: 1, R0: 2, R1: 3, unknown_accessible_fraction: .5, efficiency: null, ...extra,
});
const fam = (family: string, start: number, recaller: Record<string, RecallerStrand>) => ({ family, consensus_start: start, consensus_end: start + 20, recaller });
const catalog = {
  cr_mode: 'lattice_recaller',
  datasets: {
    daf: { catalog: [fam('class_002', 200, { GA: r(.40, 1000), CT: r(.36, 1200) }), fam('class_001', 100, { CT: r(.30, 1200), GA: r(0, 1000, { supported: false }) })] },
    hia5: { catalog: [fam('class_001', 100, { pooled: r(.05, 100) }), fam('class_002', 200, { pooled: r(.70, 100, { resolved: false }) })] },
  },
} as unknown as ConsensusCatalog;
const labels = { daf: 'NAPA SsDddA', hia5: 'NAPA Hia5' };

describe('recaller class table', () => {
  it('lists channels per dataset (CT, GA, pooled) and one row per class in genomic order', () => {
    const ch = recallerChannels(catalog, labels);
    expect(ch.map(c => c.label)).toEqual(['NAPA SsDddA CT', 'NAPA SsDddA GA', 'NAPA Hia5']);
    const rows = recallerClassRows(catalog);
    expect(rows.map(x => x.family)).toEqual(['class_001', 'class_002']);
    expect(Object.keys(rows[1].channels).sort()).toEqual(['daf::CT', 'daf::GA', 'hia5::pooled']);
  });
  it('pools by molecules (same as pooling the molecules) or equally', () => {
    const row = recallerClassRows(catalog)[1];
    const m = pooledPrevalence(row, ['daf::CT', 'daf::GA'], 'molecules');
    expect(m.value).toBeCloseTo((.36 * 1200 + .40 * 1000) / 2200, 6);
    expect(m.molecules).toBe(2200);
    expect(m.lower).toBeLessThan(m.value!);
    expect(pooledPrevalence(row, ['daf::CT', 'daf::GA', 'hia5::pooled'], 'equal').value).toBeCloseTo((.36 + .40 + .70) / 3, 6);
  });
  it('flags one-strand classes and assay gaps, with unresolved sides marked weak', () => {
    const [one, two] = recallerClassRows(catalog), ch = recallerChannels(catalog, labels);
    const f1 = discrepancyFlags(one, ch);
    expect(f1.find(f => f.kind === 'one_strand')?.strong).toBe(true);
    const f2 = discrepancyFlags(two, ch);
    const gap = f2.find(f => f.kind === 'assay_gap');
    expect(gap?.strong).toBe(false);            // Hia5 side unresolved
    expect(f2.some(f => f.kind === 'unresolved')).toBe(true);
    expect(f2.some(f => f.kind === 'strand_gap')).toBe(false);
    expect(discrepancyScore(two, ch)).toBeGreaterThan(.3);
  });
  it('restricts a DAF dataset to one strand only when one of its strands is picked', () => {
    const ch = recallerChannels(catalog, labels);
    expect(channelTargets(['daf::GA', 'hia5::pooled'], ch)).toEqual([{ datasetId: 'daf', strand: 'GA' }, { datasetId: 'hia5', strand: null }]);
    expect(channelTargets(['daf::CT', 'daf::GA'], ch)).toEqual([{ datasetId: 'daf', strand: null }]);
    expect(classFilterKey('class_002', [{ datasetId: 'daf', strand: 'GA' }])).toBe('class:class_002:daf/GA');
  });
  it('exports every class and channel with the three prevalence tiers', () => {
    const rows = recallerClassRows(catalog), ch = recallerChannels(catalog, labels);
    rows[1].channels['hia5::pooled'] = { ...rows[1].channels['hia5::pooled'], prevalence_edge: .8, prevalence_loose: .85 };
    const lines = formatRecallerTableTsv(rows, ch, r => r.family).trim().split('\n');
    expect(lines[0].split('\t').slice(7, 10)).toEqual(['prevalence_core', 'prevalence_edge', 'prevalence_loose']);
    expect(lines).toHaveLength(1 + 6);
    const row = (family: string, channel: string) => lines.map(l => l.split('\t')).find(f => f[1] === family && f[5] === channel)!;
    const hia5 = row('class_002', 'NAPA Hia5');
    expect(hia5.slice(7, 10)).toEqual(['0.7', '0.8', '0.85']);
    const ct = row('class_001', 'NAPA SsDddA CT');
    expect(ct[8]).toBe(ct[7]);                      // no tiers reported: edge = core
    expect(pooledPrevalence(rows[1], ['hia5::pooled'], 'molecules').loose).toBeCloseTo(.85, 6);
  });
  it('counts any combination of strict, edge and overlap', () => {
    expect(parseTiers(undefined)).toEqual(['core']);
    expect(parseTiers('loose+core')).toEqual(['core', 'loose']);
    expect(tierSpec(['edge', 'core'])).toBe('core+edge');
    expect(tierSum(.5, .6, .7, ['core'])).toBeCloseTo(.5, 9);
    expect(tierSum(.5, .6, .7, ['core', 'edge'])).toBeCloseTo(.6, 9);
    expect(tierSum(.5, .6, .7, ['core', 'loose'])).toBeCloseTo(.6, 9);
    expect(tierSum(.5, .6, .7, ['core', 'edge', 'loose'])).toBeCloseTo(.7, 9);
    expect(classFilterKey('c', [{ datasetId: 'd' }], 'core+edge')).toBe('class:c:d/*:core+edge');
  });
});
