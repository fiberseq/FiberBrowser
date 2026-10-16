/** Codex review of fb-n13: the fixes, each pinned. */
import '../testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { emptyCatalog } from '../../utils/regionCatalog';
import { toggleSvFeature } from './svFeatures';
import { svClusterMenu, buildReadMenu, SPLIT_IN_SPLIT, type ReadMenuItem } from '../../components/tracks/read-track/readMenuModel';
import { variantSplitGrouping } from './variantSplit';
import { openSplitPanels } from '../../utils/splitPanels';
import { scanDatasetRegions } from '../../utils/regionScan';
import type { AlleleGrouping } from './api';
import type { PanelConfig, Dataset } from '../../types';

const panel: PanelConfig = { id: 'p1', contentType: 'dataset', datasetId: 'numb', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 };

describe('Codex fb-n13', () => {
  beforeEach(() => {
    useBrowserStore.setState({ selectedFeatures: [], panels: [panel], chrom: 'chr2L', start: 0, end: 100_000 } as never);
  });

  it('#4 an SV on another chromosome at the same place is another SV', () => {
    toggleSvFeature({ t: 'D', ref: 5_000, len: 1_500 }, 'numb', 'chr1');
    toggleSvFeature({ t: 'D', ref: 5_010, len: 1_500 }, 'numb', 'chr2');
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.chrom)).toEqual(['chr1', 'chr2']);
    toggleSvFeature({ t: 'D', ref: 5_000, len: 1_500 }, 'numb', 'chr1');
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.chrom)).toEqual(['chr2']);
  });

  it('#5 Split into panels is offered disabled, with why, inside a split panel', () => {
    const own = svClusterMenu({ cluster: 'INS 9.2 kb', insertion: true, splitActive: true, splitAllowed: true, splitPanelsBlocked: SPLIT_IN_SPLIT }, false)
      .filter((e): e is ReadMenuItem => e.kind === 'item');
    for (const action of ['sv-split-this-panels', 'sv-split-panels']) {
      const it = own.find(e => e.action === action)!;
      expect(it.disabled).toBe(true);
      expect(it.title).toBe(SPLIT_IN_SPLIT);
    }
    expect(own.find(e => e.action === 'sv-split-this')!.disabled).toBeFalsy();
    const read = buildReadMenu({ readId: 'r', footprint: null, readSelected: false, selectedCount: 0, hasReadFilter: false, excludedCount: 0,
      readHighlighted: false, anyHighlight: false, isMac: true, sv: { thisEvent: 'INS 9.2 kb', splitPanelsBlocked: SPLIT_IN_SPLIT } })
      .filter((e): e is ReadMenuItem => e.kind === 'item');
    expect(read.find(e => e.action === 'sv-split-this-panels')!.disabled).toBe(true);
  });

  it('#6 a variant split\'s panels record the view its reads were classified in', () => {
    useBrowserStore.setState({ panels: [{ ...panel, collapsed: true }, { ...panel, id: 'copy', viewportOverride: { chrom: 'chr2L', start: 50_000, end: 60_000 } }] } as never);
    const grouping = {
      groups: [{ id: 0, key: '+', label: 'roo+', alleles: ['+'], count: 1, kind: 'combo' }], assignments: { a: 0 }, n_reads: 1, covering: 1,
      threshold: 1, distinct: 1, snps: [], phase: null, tags: null, scan_key: 'k', dataset_id: 'numb', mode: 'sv',
      region: { chrom: 'chr2L', start: 50_000, end: 60_000 }, svs: ['I:55000:9000'], columns: [{ id: 'I:55000:9000', name: 'roo', kind: 'sv' }],
    } as AlleleGrouping;
    const split = variantSplitGrouping(grouping, 'numb', 'roo');
    openSplitPanels(split, [{ key: '0', label: 'roo+ (1)', colour: '#f00', kind: 'group', groupKeys: ['0'], count: 1, checked: true }], [useBrowserStore.getState().panels[0]]);
    const made = useBrowserStore.getState().panels.find(p => p.readSubset)!;
    expect(made.readSubset!.locus).toEqual({ chrom: 'chr2L', start: 50_000, end: 60_000, label: 'roo' });
  });

  describe('region scans', () => {
    const ds = { id: 'numb', label: 'numb', path: '/x.bam', data_type: 'bam' } as unknown as Dataset;
    beforeEach(() => {
      useRegionCatalogStore.setState({ catalogs: { dm6: emptyCatalog('dm6') }, sync: { dm6: 'local' }, fingerprints: {}, scans: {} } as never);
    });

    it('#9 an older answer arriving after a newer one is dropped', async () => {
      const replies: Array<(v: unknown) => void> = [];
      vi.stubGlobal('fetch', vi.fn(() => new Promise(r => replies.push(r))));
      const older = scanDatasetRegions(ds, { scope: 'dataset' });
      const newer = scanDatasetRegions(ds, { scope: 'view', view: { chrom: 'chr2L', start: 0, end: 1000 } });
      const body = (scope: string, start: number) => ({ ok: true, json: async () => ({ success: true, kind: 'top', genome: 'dm6', fingerprint: 'fp', scope,
        regions: [{ chrom: 'chr2L', start, end: start + 100, reads: 5, label: 'x', gene: null }] }) });
      await vi.waitFor(() => expect(replies.length).toBe(2));
      replies[1](body('view', 10));
      await newer;
      replies[0](body('dataset', 9_000));
      expect(await older).toBeNull();
      expect(useRegionCatalogStore.getState().scans.numb.scope).toBe('view');
      expect(useRegionCatalogStore.getState().catalogs.dm6.entries.map(e => e.start)).toEqual([10]);
      vi.unstubAllGlobals();
    });

    it('#10 a scan that finds nothing clears the dataset\'s earlier regions', async () => {
      useRegionCatalogStore.getState().applyDetection({ success: true, kind: 'top', genome: 'dm6', fingerprint: 'fp',
        regions: [{ chrom: 'chr2L', start: 1, end: 2, reads: 5, label: 'x', gene: null }] }, 'numb', 'top', 'chr2L:0-1000');
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, kind: 'top', genome: 'dm6', fingerprint: 'fp', regions: [] }) })));
      await scanDatasetRegions(ds, { scope: 'view', view: { chrom: 'chr2L', start: 5_000, end: 6_000 } });
      expect(useRegionCatalogStore.getState().catalogs.dm6.categories).toEqual([]);
      expect(useRegionCatalogStore.getState().scans.numb.state).toBe('done');
      vi.unstubAllGlobals();
    });
  });
});
