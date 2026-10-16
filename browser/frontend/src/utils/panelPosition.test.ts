import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { useSplitPanelStore } from '../stores/splitPanelStore';
import { panelReversed } from '../hooks/usePanelDisplayStore';
import { variantScanTarget } from '../features/variants/scanTarget';
import { footprintSource, orientFootprint } from './footprintSource';
import { footprintAnalysisScopes } from './footprintScopes';
import { analysisLoci } from './analysisLocus';
import { peakScanScope } from './peakScanScope';
import { readScopeGroups } from './exportReadScopes';
import { figureRegions } from './figureRegions';
import { highlightView } from './highlightActions';
import type { FootprintGroup, PanelConfig } from '../types';

const initial = useBrowserStore.getState();
const splitInitial = useSplitPanelStore.getState();
afterEach(() => { useBrowserStore.setState(initial, true); useSplitPanelStore.setState(splitInitial, true); });
const own = { chrom: 'insert_contig', start: 100, end: 500 };

describe.each(['per panel', 'split', 'expanded insert', 'reversed', 'independent copy'])('%s position features', kind => {
  function setup() {
    const p = { id: 'clicked', contentType: 'dataset', datasetId: 'd', stateKey: 'own', genome: 'own-reference',
      viewportOverride: own, reversed: kind === 'reversed', subTracks: [], collapsed: false, layoutRow: 0,
      ...(kind === 'split' ? { readSubset: { groupId: 'g', locus: own, rule: { kind: 'frozen', datasetId: 'd', groupKeys: [] } } } : {}),
      ...(kind === 'expanded insert' ? { altAllele: {} } : {}),
    } as PanelConfig;
    useBrowserStore.setState({ chrom: 'stale', start: 9000, end: 10000, navigationMode: 'perPanel', isReversed: false,
      datasets: [{ id: 'd', data_type: 'bam' }], panels: [
        { ...p, id: 'other', stateKey: 'other', genome: 'other-reference', viewportOverride: { chrom: 'different', start: 1000, end: 2000 } }, p,
      ], selectedDatasets: new Set(['clicked']), fullViewPanelId: null, collapsedRows: new Set(),
      filteredReadIds: { own: new Set(['kept']) }, activeReadIds: { own: ['kept'] }, selectedReadIds: {},
      clusterFocus: {}, clusterAssignments: {}, clusterOrder: {},
    } as never);
    if (kind === 'split') useSplitPanelStore.getState().setReads('own', { state: 'ready', ids: new Set(['kept', 'filtered-out']) } as never);
    return useBrowserStore.getState();
  }

  it('SNP and SV analysis scans the selected copy and preserves its reference and cohort', () => {
    const s = setup();
    expect(variantScanTarget(s, 'd')).toEqual({ datasetId: 'd', ...own, genome: 'own-reference', readIds: ['kept'], panelKey: 'own' });
    expect(panelReversed(s, 'clicked')).toBe(kind === 'reversed');
  });

  it('footprint sequence, motifs, size and V-plot resolve the saved source', () => {
    const s = setup();
    const fp = { datasetId: 'd', stateKey: 'own', ...own, absStart: 200, absEnd: 230, genome: 'own-reference' };
    const group = { sourceIndex: -1, sourceDatasetId: 'd', sourceViewKey: 'own', referenceChrom: own.chrom,
      referenceAbsStart: 200, referenceAbsEnd: 230, referenceGenome: 'own-reference' } as FootprintGroup;
    expect(footprintSource(s, group, ['d'])).toMatchObject({ chrom: own.chrom, genome: 'own-reference',
      reversed: kind === 'reversed', datasetIds: ['d'], readIdsByDataset: { d: ['kept'] } });
    expect(footprintAnalysisScopes([fp], s, s.panels)).toEqual([{ ...own, genome: 'own-reference', indices: [0] }]);
    expect(analysisLoci(s, ['own'])).toEqual([{ ...own, genome: 'own-reference', datasetIds: ['d'], stateKeys: ['own'], panelIds: ['clicked'] }]);
  });

  it('peak scans retain both independent loci and the selected read scope', () => {
    const s = setup();
    const request = JSON.parse(peakScanScope(s, s.peakRules[0].id));
    expect(request.windows.find((w: { panelId: string }) => w.panelId === 'clicked')).toMatchObject({ ...own, genome: 'own-reference', read_ids: ['kept'] });
    expect(request.windows.find((w: { panelId: string }) => w.panelId === 'other').chrom).toBe('different');
  });

  it('figure export and read inspection retain the source reference and region', () => {
    const s = setup();
    expect(readScopeGroups(s, 'shown')).toContainEqual({ datasetId: 'd', stateKey: 'own', ...own, genome: 'own-reference', readIds: ['kept'] });
    expect(figureRegions(s, g => g ?? 'main')).toContain('own-reference insert_contig:100-500');
  });

  it('the highlight ruler stores the clicked region on its own reference', () => {
    setup(); const addHighlights = vi.fn(() => []);
    useBrowserStore.setState({ addHighlights });
    highlightView('clicked');
    expect(addHighlights).toHaveBeenCalledWith([{ ...own, genome: 'own-reference' }]);
  });
});

it('reverse footprint display mirrors motif offsets and strand without moving the genomic interval', () => {
  const result = orientFootprint({ absStart: 200, absEnd: 206, sequence: 'AACGTT', motif_hits: [
    { start: 0, end: 2, strand: '+' },
  ] } as never, true)!;
  expect(result).toMatchObject({ absStart: 200, absEnd: 206, sequence: 'AACGTT', motif_hits: [{ start: 4, end: 6, strand: '-' }] });
});
