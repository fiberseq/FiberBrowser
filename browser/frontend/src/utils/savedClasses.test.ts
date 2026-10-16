import { describe, expect, it } from 'vitest';
import type { FootprintGroup } from '../types';
import { nextSavedClassId, remapSavedClassIds, replaceSavedClass, savedClassGroups, savedRunTiers, savedTierOf, restoreRemovedGroups, savedClassName, savedDisplayName } from './savedClasses';
import { normalizeFootprintGroups } from '../stores/utils';

const g = (id: string, extra: Partial<FootprintGroup> = {}) => ({ id, name: id, color: '#000', sizeMin: 0, sizeMax: null, enabled: true, ...extra }) as FootprintGroup;
const info = (id: string) => ({ id, family: 'class_001', className: 'Class 1', runLabel: '', start: 0, end: 10, channels: [], stats: {}, picked: [] });

describe('saved classes', () => {
  it('numbers saved classes after the highest used', () => {
    expect(nextSavedClassId([])).toBe('S1');
    expect(nextSavedClassId([g('a', { savedClass: info('S2') }), g('b', { savedClass: info('S7') }), g('c')])).toBe('S8');
  });
  it('replaces a saved class in place', () => {
    const all = [g('a'), g('b', { savedClass: info('S1') }), g('c', { savedClass: info('S1') }), g('d')];
    expect(replaceSavedClass(all, 'S1', [g('x', { savedClass: info('S1') })]).map(x => x.id)).toEqual(['a', 'x', 'd']);
  });
  it('draws a run\'s class as its saved definitions count it, and only for that run', () => {
    const all = [
      g('a', { savedClass: info('S1'), consensusJobId: 'run1', consensusStateId: 'class_001', consensusTier: 'core+edge' }),
      g('b', { savedClass: info('S2'), consensusJobId: 'run1', consensusStateId: 'class_001', consensusTier: 'core+loose' }),
      g('c', { savedClass: info('S3'), consensusJobId: 'run2', consensusStateId: 'class_002' }),
    ];
    expect(savedRunTiers(all, 'run1')).toEqual({ class_001: 'core+edge+loose' });
    expect(savedRunTiers(all, 'run2')).toEqual({ class_002: 'core' });
  });
  it('stores strict explicitly, so a wider copy of the same class never widens it (audit F4)', () => {
    const daf = { ...info('S1'), channels: [{ key: 'd::CT', datasetId: 'd', strand: 'CT', label: 'D CT', daf: true }, { key: 'd::GA', datasetId: 'd', strand: 'GA', label: 'D GA', daf: true }], picked: ['d::CT', 'd::GA'] };
    const template = g('t', { consensusJobId: 'j', consensusStateId: 'class_001' });
    const strict = savedClassGroups(daf, template, 'core');
    const wider = savedClassGroups({ ...daf, id: 'S2' }, template, 'core+edge');
    expect(strict.every(x => x.consensusTier === 'core')).toBe(true);
    expect(savedRunTiers([...strict, ...wider], 'j')).toEqual({ class_001: 'core+edge' });   // the run's display union
    expect(strict.map(savedTierOf)).toEqual(['core']);                                        // what S1 filters/counts
    expect(wider.map(savedTierOf)).toEqual(['core+edge']);
  });
  it('treats a saved class restored without a tier as strict', () => {
    const [legacy] = normalizeFootprintGroups([g('a', { savedClass: info('S1'), consensusJobId: 'j', consensusStateId: 'class_001' })]);
    expect(legacy.consensusTier).toBe('core');
    const [plain] = normalizeFootprintGroups([g('b')]);
    expect(plain.consensusTier).toBeUndefined();
    expect(savedTierOf({ consensusTier: undefined })).toBe('core');
  });
  it('an undo of a removal never gives two definitions one S-number (Codex review)', () => {
    const removed = [g('a', { savedClass: info('S2'), name: 'S2 · Class 1 · D' }), g('b', { savedClass: info('S2'), name: 'S2 · Class 1 · H' })];
    const now = [g('x', { savedClass: info('S1'), name: 'S1 · Class 1 · D' }), g('y', { savedClass: info('S2'), name: 'S2 · Class 9 · D' })];  // S2 reused meanwhile
    const out = restoreRemovedGroups(removed, now);
    expect(out.map(x => [x.id, x.savedClass?.id, x.name])).toEqual([
      ['x', 'S1', 'S1 · Class 1 · D'], ['y', 'S2', 'S2 · Class 9 · D'], ['a', 'S3', 'S3 · Class 1 · D'], ['b', 'S3', 'S3 · Class 1 · H']]);
    // nothing taken meanwhile: back as they were; entries still here are not doubled
    expect(restoreRemovedGroups(removed, [now[0]]).map(x => x.savedClass?.id)).toEqual(['S1', 'S2', 'S2']);
    expect(restoreRemovedGroups(removed, [removed[0]]).map(x => x.id)).toEqual(['a', 'b']);
  });
  it('renumbers appended saved classes after the ones already here, consistently across entries', () => {
    const here = [g('a', { savedClass: info('S1'), name: 'S1 · Class 1 · D' }), g('b', { savedClass: info('S2'), name: 'S2 · Class 1 · D' })];
    const loaded = [
      g('x', { savedClass: info('S1'), name: 'S1 · Class 1 · D CT' }), g('y', { savedClass: info('S1'), name: 'S1 · Class 1 · H' }),
      g('z', { savedClass: info('S2'), name: 'S2 · Class 1 (strict + edge) · D' }), g('plain'),
    ];
    const out = remapSavedClassIds(loaded, here);
    expect(out.map(x => x.savedClass?.id ?? null)).toEqual(['S3', 'S3', 'S4', null]);
    expect(out.map(x => x.name)).toEqual(['S3 · Class 1 · D CT', 'S3 · Class 1 · H', 'S4 · Class 1 (strict + edge) · D', 'plain']);
    expect(remapSavedClassIds(loaded, [])[0].savedClass?.id).toBe('S1');
  });
});

describe('saved class names (integ40 Codex review)', () => {
  const info = (className: string) => ({ id: 'S1', family: 'class_025', className }) as any;
  it('an older rank-based name shows as the class label, in the card and in the export name', () => {
    expect(savedDisplayName(info('Class 1'))).toBe('Class 025');
    expect(savedClassName(info('Class 1'))).toBe('S1 · Class 025');
    expect(savedClassName(info(''), 'core+edge')).toMatch(/^S1 · Class 025 \(/);
  });
  it('a name the user gave is kept', () => {
    expect(savedDisplayName(info('dl site'))).toBe('dl site');
    expect(savedClassName(info('dl site'))).toBe('S1 · dl site');
  });
});

it('saves window channels against real datasets and genomic bounds while retaining distinct copy membership', () => {
  const source = { dataset_id: 'd', window: { chrom: 'chr2', start: 300, end: 400, strand: '-' as const }, coordinate_origin: 1000 };
  const saved = { ...info('S1'), start: 1010, end: 1020, channels: [
    { key: 'd@a::pooled', datasetId: 'd@a', strand: 'pooled', label: 'A', daf: false, source },
    { key: 'd@b::pooled', datasetId: 'd@b', strand: 'pooled', label: 'B', daf: false, source: { ...source, window: { ...source.window, start: 500, end: 600 } } },
  ], picked: ['d@a::pooled', 'd@b::pooled'] };
  const groups = savedClassGroups(saved, g('t', { referenceChrom: 'oriented_BED', consensusStateId: 'class_001', consensusJobId: 'j' }), 'core');
  expect(groups.map(v => [v.sourceDatasetId, v.consensusDatasetId, v.referenceChrom, v.referenceAbsStart, v.referenceAbsEnd])).toEqual([
    ['d', 'd@a', 'chr2', 380, 390], ['d', 'd@b', 'chr2', 580, 590],
  ]);
  expect(savedClassGroups(saved, groups[0], 'core+edge', groups).map(v => v.id)).toEqual(groups.map(v => v.id));
  expect(normalizeFootprintGroups(groups)[0].consensusDatasetId).toBe('d@a');
});
