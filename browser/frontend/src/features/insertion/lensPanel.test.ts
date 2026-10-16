import '../testSetup';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalPanelType, getAnalysisPanel, migratePanelAliases } from '../../plugins/registry';
import { useBrowserStore } from '../../stores/browserStore';
import { applyImportedState } from '../../api/session';
import { openInsertionLens, INSERTION_LENS_PANEL } from './insertionLensTarget';
import { resetPreviewsForTests } from '../../utils/previewFeatures';

beforeEach(() => {
  localStorage.clear();
  useBrowserStore.setState({ panels: [], _historyStack: [], _historyPointer: -1 } as any);
});

describe('the insertion lens is its own panel (supported); Variants is supported too', () => {
  it('registry: two panels, no alias between them', () => {
    expect(INSERTION_LENS_PANEL).toBe('insertion-lens');
    expect(getAnalysisPanel('insertion-lens')?.label).toBe('Insertion lens');
    expect(getAnalysisPanel('insertion-lens')?.preview).toBeUndefined();
    expect(getAnalysisPanel('variants')?.preview).toBeUndefined();
    expect(canonicalPanelType('insertion-lens')).toBe('insertion-lens');
  });

  it('opening the lens from the reads\' menu opens the lens panel', () => {
    openInsertionLens({ datasetId: 'ds1', chrom: 'chrT', pos: 100, seek: true });
    const panel = useBrowserStore.getState().panels.find(p => p.contentType === 'insertion-lens');
    expect(panel?.insertionLens).toEqual({ datasetId: 'ds1', chrom: 'chrT', pos: 100, seek: true, genome: null, reversed: false });
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'variants')).toBe(false);
  });

  it('captures the clicked copy reference and direction for the lens and Identify', () => {
    useBrowserStore.setState({ navigationMode: 'perPanel', isReversed: false, panels: [
      { id: 'copy', contentType: 'dataset', datasetId: 'ds1', genome: 'own', reversed: true,
        viewportOverride: { chrom: 'insert', start: 0, end: 1000 } },
    ] } as never);
    openInsertionLens({ datasetId: 'ds1', chrom: 'insert', pos: 100, seek: true }, 'copy');
    const lens = useBrowserStore.getState().panels.find(p => p.contentType === INSERTION_LENS_PANEL)?.insertionLens;
    expect(lens).toMatchObject({ genome: 'own', reversed: true, chrom: 'insert' });
  });

  it('a Variants panel of 3.0 development builds: its lens and Identify results go to a lens panel, its SNP state stays', () => {
    const out = migratePanelAliases([
      { id: 'panel-variants', contentType: 'variants', variants: { tab: 'lens' }, insertionLens: { x: 1 }, insertionIdentify: { k: 1 } } as any,
      { id: 'panel-x', contentType: 'dataset' } as any,
    ]);
    // Saved on the lens tab, nothing else: it is the lens panel (its id kept).
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'panel-variants', contentType: 'insertion-lens', insertionLens: { x: 1 }, insertionIdentify: { k: 1 } });
    expect(out[0]).not.toHaveProperty('variants');
    expect(out[1]).toEqual({ id: 'panel-x', contentType: 'dataset' });

    // On the lens tab with SNP state too: both kept, the Variants part minimized beside it.
    const both = migratePanelAliases([{ id: 'panel-variants', contentType: 'variants', variants: { tab: 'lens', selected: ['8000:snv:T/G'] }, insertionLens: { x: 2 } } as any]);
    expect(both.map(p => [p.id, p.contentType, (p as any).collapsed ?? false])).toEqual([
      ['panel-variants', 'insertion-lens', false], ['panel-variants-variants', 'variants', true]]);
    expect((both[1] as any).variants).toEqual({ selected: ['8000:snv:T/G'] });

    // On the SNPs tab with Identify results: Variants keeps its id, the results go to a minimized lens panel.
    const snps = migratePanelAliases([{ id: 'panel-variants', contentType: 'variants', variants: { tab: 'snps', selected: ['a'] }, insertionIdentify: { k: 3 } } as any]);
    expect(snps.map(p => [p.id, p.contentType])).toEqual([['panel-variants', 'variants'], ['panel-variants-lens', 'insertion-lens']]);
    expect((snps[1] as any).insertionIdentify).toEqual({ k: 3 });
    expect(snps[0]).not.toHaveProperty('insertionIdentify');

    // A Variants panel without lens state is left alone.
    expect(migratePanelAliases([{ id: 'v', contentType: 'variants', variants: { tab: 'svs' } } as any])).toEqual([{ id: 'v', contentType: 'variants', variants: { tab: 'svs' } }]);
  });

  it('a panel opened later never takes a migrated panel\'s id', () => {
    resetPreviewsForTests(true);
    useBrowserStore.setState({ panels: migratePanelAliases([{ id: 'panel-variants', contentType: 'variants', variants: { tab: 'lens' }, insertionLens: { x: 1 } } as any]) } as any);
    useBrowserStore.getState().openAnalysisPanel('variants');
    const ids = useBrowserStore.getState().panels.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const variants = useBrowserStore.getState().panels.find(p => p.contentType === 'variants')!;
    expect(variants.id).toBe('panel-variants-2');
    useBrowserStore.getState().closeAnalysisPanel(variants.id);
    expect(useBrowserStore.getState().panels.find(p => p.contentType === 'insertion-lens')?.insertionLens).toEqual({ x: 1 });
    resetPreviewsForTests(false);
  });

  it('with previews off a Variants panel opens (it is supported); one a session brought is shown', () => {
    resetPreviewsForTests(false);
    useBrowserStore.getState().openAnalysisPanel('variants');
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'variants')).toBe(true);
    useBrowserStore.setState({ panels: [{ id: 'panel-variants', contentType: 'variants', collapsed: true, subTracks: [], datasetId: null, linkGroup: null, layoutRow: 0 }] } as any);
    useBrowserStore.getState().openAnalysisPanel('variants');
    expect(useBrowserStore.getState().panels.find(p => p.contentType === 'variants')?.collapsed).toBe(false);
  });

  it('a session saved with the Insertions panel (before Variants) restores the lens panel on its lens', () => {
    const lens = { datasetId: 'ds1', chrom: 'chrT', pos: 5, ref: 5, len: 2000, tolerance: 50, lenMin: 1600, lenMax: 2400, flank: 1000 };
    applyImportedState({
      datasets: [], overlays: [], has_fasta: false,
      frontend: {
        panels: [
          { id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: 'default', layoutRow: 0 },
          { id: 'panel-insertion-lens', contentType: 'insertion-lens', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, insertionLens: lens },
        ],
      },
      viewport: { chrom: 'chrT', start: 1, end: 100 },
    });
    const panel = useBrowserStore.getState().panels.find(p => p.contentType === 'insertion-lens');
    expect(panel?.insertionLens).toMatchObject({ ref: 5, len: 2000 });
    expect(panel?.id).toBe('panel-insertion-lens');
  });

  it('a session keeps the Variants panel\'s tab, settings, selection and results', async () => {
    const { collectFrontendState } = await import('../../api/session');
    applyImportedState({
      datasets: [], overlays: [], has_fasta: false,
      frontend: { panels: [{ id: 'panel-variants', contentType: 'variants', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
        variants: { tab: 'combos', selected: ['8000:snv:T/G'], params: { min_maf: 0.2, min_depth: 10, both_strands: false, min_bq: 0, min_mapq: 0, mode: 'basecall' } } }] },
      viewport: { chrom: 'chrSNP', start: 7000, end: 11000 },
    });
    const saved = collectFrontendState() as any;
    useBrowserStore.setState({ panels: [] } as any);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: saved, viewport: { chrom: 'chrSNP', start: 7000, end: 11000 } });
    const panel = useBrowserStore.getState().panels.find(p => p.contentType === 'variants');
    expect(panel?.variants).toMatchObject({ tab: 'combos', selected: ['8000:snv:T/G'], params: { min_maf: 0.2, mode: 'basecall' } });
  });
});
