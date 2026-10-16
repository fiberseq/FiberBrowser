import '../testSetup';
import { beforeEach, describe, expect, it } from 'vitest';
import '../../plugins/builtinPanels';
import { useBrowserStore } from '../../stores/browserStore';
import { resetPreviewsForTests } from '../../utils/previewFeatures';
import { scan, snp } from './variantsTestData';
import {
  latestKey, nextSnpSelection, normalizeVariantsState, saveGrouping, scanFor, selectSnp, shownSnps, snpChange, trimScan,
  updateVariantsState, variantsPanelState,
} from './variantsState';

beforeEach(() => {
  resetPreviewsForTests(false);  // the Variants panel is supported: it opens with previews off
  useBrowserStore.setState({ panels: [] } as any);
});

describe('Variants panel state', () => {
  it('fills defaults and drops what a session file got wrong', () => {
    const s = normalizeVariantsState({ tab: 'nope', params: { min_maf: 3, min_depth: 'x', mode: 'daf' }, selected: ['a', 1], combo: { source: 'hp', minFraction: -1 } });
    expect(s.tab).toBe('snps');
    expect(s.params).toEqual({ min_maf: 0.5, min_depth: 20, both_strands: true, min_bq: 20, min_mapq: 20, mode: 'daf' });
    expect(s.selected).toEqual(['a']);
    expect(s.combo).toEqual({ source: 'hp', partial: false, minFraction: 0, autoPhase: true });
    expect(s.autoScan).toBe(true);
    expect(s.splitSoftLimit).toBe(8);
    expect(normalizeVariantsState(undefined).tab).toBe('snps');
  });

  it('selects like the other channels: click one, shift-click toggles', () => {
    expect(nextSnpSelection([], 'a', false)).toEqual(['a']);
    expect(nextSnpSelection(['a'], 'a', false)).toEqual([]);
    expect(nextSnpSelection(['a'], 'b', false)).toEqual(['b']);
    expect(nextSnpSelection(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(nextSnpSelection(['a', 'b'], 'a', true)).toEqual(['b']);
  });

  it('a channel click opens the Variants panel and keeps the selection on it', () => {
    selectSnp('8000:snv:T/G', false);
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'variants')).toBe(true);
    selectSnp('9000:snv:A/G', true);
    expect(variantsPanelState()?.selected).toEqual(['8000:snv:T/G', '9000:snv:A/G']);
    updateVariantsState({ tab: 'combos' });
    expect(variantsPanelState()?.tab).toBe('combos');
  });

  it('keeps at most 500 calls in the panel (passing first) and no read names', () => {
    const many = Array.from({ length: 700 }, (_, i) => snp(i, { passes: i % 2 === 0 }));
    const kept = trimScan(scan(many)).snps;
    expect(kept).toHaveLength(500);
    expect(kept.filter(s => s.passes)).toHaveLength(350);
    expect(kept.map(s => s.pos)).toEqual([...kept.map(s => s.pos)].sort((a, b) => a - b));
    const saved = saveGrouping({ groups: [], assignments: { r1: 0 }, n_reads: 1, covering: 1, threshold: 3, distinct: 1, snps: [],
      phase: null, tags: null, scan_key: 'k', dataset_id: 'ds1', region: { chrom: 'c', start: 0, end: 1 }, mode: 'basecall' },
    { source: 'selected', partial: false, minFraction: 0.02, autoPhase: true, snps: [] });
    expect('assignments' in saved).toBe(false);
  });

  it('draws this session\'s scan, else the one the panel kept; failing calls only when asked', () => {
    const kept = scan([snp(8000), snp(9000, { passes: false })]);
    expect(scanFor('ds1', { scans: {}, latest: {} }, { scan: kept })).toBe(kept);
    expect(scanFor('ds2', { scans: {}, latest: {} }, { scan: kept })).toBeNull();
    const fresh = scan([snp(1)], { scan_key: 'k2' });
    expect(scanFor('ds1', { scans: { k2: fresh }, latest: { ds1: 'k2' } }, { scan: kept })).toBe(fresh);
    // A panel's scan of some of the reads (a split panel's) is that panel's: the others keep the dataset's.
    const sub = scan([], { scan_key: 'k3', target: { datasetId: 'ds1', chrom: 'chrSNP', start: 0, end: 1, readIds: ['r'], panelKey: 'ds1:s:0' } });
    const store = { scans: { k2: fresh, k3: sub }, latest: { ds1: 'k2', 'ds1|ds1:s:0': 'k3' } };
    expect(scanFor('ds1', store, undefined, 'ds1:s:0')).toBe(sub);
    expect(scanFor('ds1', store, undefined, 'ds1')).toBe(fresh);
    expect(scanFor('ds1', store, undefined)).toBe(fresh);
    // The panel kept a split panel's scan (a reopened session): not drawn in the other panels.
    expect(scanFor('ds1', { scans: {}, latest: {} }, { scan: sub }, 'ds1')).toBeNull();
    expect(scanFor('ds1', { scans: {}, latest: {} }, { scan: sub }, 'ds1:s:0')).toBe(sub);
    expect(scanFor('ds1', { scans: {}, latest: {} }, { scan: sub })).toBe(sub);
    expect(latestKey('ds1')).toBe('ds1');
    expect(shownSnps(kept, true)).toHaveLength(1);
    expect(shownSnps(kept, false)).toHaveLength(2);
    expect(snpChange(snp(1))).toBe('A>G');
    expect(snpChange(snp(1, { ref: 'C' }))).toBe('C>A/G');
    expect(snpChange(snp(1, { kind: 'del', length: 3 }))).toBe('del 3 bp');
  });
});

describe('the SNP table: Shift selects a range, Cmd/Ctrl adds one (audit VAR-5)', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('range from the last clicked row, added to the selection', async () => {
    const { tableSnpSelection } = await import('./variantsState');
    expect(tableSnpSelection(['a'], 'd', 'range', order, 'a')).toEqual(['a', 'b', 'c', 'd']);
    expect(tableSnpSelection(['e'], 'b', 'range', order, 'd')).toEqual(['e', 'b', 'c', 'd']);
    expect(tableSnpSelection(['a'], 'c', 'add', order, 'a')).toEqual(['a', 'c']);
    expect(tableSnpSelection(['a', 'c'], 'c', 'add', order, 'a')).toEqual(['a']);
    expect(tableSnpSelection(['a', 'c'], 'b', 'single', order, 'a')).toEqual(['b']);
    // No anchor (or one no longer listed): Shift adds the row.
    expect(tableSnpSelection(['a'], 'c', 'range', order, null)).toEqual(['a', 'c']);
  });
});
