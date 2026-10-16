import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { useConsensusViewStore } from '../stores/consensusViewStore';
import { useReadStatusStore } from '../stores/readStatusStore';
import { ExportDataDialog } from './ExportDataDialog';
import {
  DATA_EXPORT_GROUPS, entryAvailability, getDataExport, listDataExports, registerDataExport,
} from '../utils/dataExportRegistry';
import { registerBuiltinDataExports } from '../utils/builtinDataExports';
import { readScopeGroups, readScopeOptions } from '../utils/exportReadScopes';
import { buildReadTable, formatHighlightsBed, formatReadNames } from '../utils/dataExportActions';
import { useRegionCatalogStore } from '../stores/regionCatalogStore';
import { addCategory, addEntries, emptyCatalog } from '../utils/regionCatalog';
import { ensureBuiltinPanelsRegistered } from '../stores/__tests__/helpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
registerBuiltinDataExports();

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });

const panel = (id: string, extra: Record<string, unknown> = {}) => ({ id, contentType: 'dataset', datasetId: id, stateKey: id, layoutRow: 0, ...extra });

function setStore(extra: Record<string, unknown> = {}) {
  useBrowserStore.setState({
    chrom: 'chr19', start: 1000, end: 2000,
    datasets: [{ id: 'ds1', label: 'napa_ddda', data_type: 'bam', paths: ['/d/a.bam'] }, { id: 'bb', label: 'fiber', data_type: 'bigbed', paths: ['/d/b.bb'] }],
    panels: [panel('ds1'), panel('bb')],
    collapsedRows: new Set(), fullViewPanelId: null,
    selectedReadIds: {}, activeReadIds: { ds1: ['r1', 'r2', 'r3'], bb: ['b1'] },
    clusterAssignments: {}, clusterOrder: {}, readSortOrder: {}, jupyterReadOrder: {}, filteredReadIds: {},
    clusterPeakRegions: [], selectedPeaks: new Set(), peaksByRule: {}, peakRules: [], peakModes: {},
    captureRegions: [], compositeTracks: [], annotationFiles: [], footprintGroups: [], savedClusters: [], selectedGenes: [],
    publicMode: false, sessionName: '',
    ...extra,
  } as never);
}

beforeEach(() => {
  ensureBuiltinPanelsRegistered();
  setStore();
  useConsensusViewStore.setState({ jobId: null, catalog: null } as never);
  useReadStatusStore.setState({ byStateKey: {} });
});
afterEach(() => vi.unstubAllGlobals());

const ctx = (readScope = 'shown' as any) => ({ state: useBrowserStore.getState(), readScope });

describe('Export data registry', () => {
  it('waits for the complete cohort before enabling read exports', () => {
    setStore({ readTrackStatus: { ds1: { loading: true, stale: false, displayed: 256 } } });
    expect(entryAvailability(getDataExport('read-names')!, ctx())).toEqual({
      ok: false, reason: 'Wait for the complete read set before exporting.',
    });
    setStore({ readTrackStatus: {} });
    expect(entryAvailability(getDataExport('read-names')!, ctx()).ok).toBe(true);
  });

  it('groups every built-in export under the six topics, in order', () => {
    expect(DATA_EXPORT_GROUPS.map(g => g.title)).toEqual(['Reads', 'Peaks & regions', 'Classes & footprints', 'Clusters', 'Analysis tables', 'Session & working set']);
    const ids = (group: string) => listDataExports(group as never).map(e => e.id);
    expect(ids('reads')).toEqual(['read-names', 'read-names-copy', 'read-table', 'read-bam', 'working-set']);
    expect(ids('peaks')).toEqual(expect.arrayContaining(['peaks-bed', 'selected-peaks-bed', 'cluster-regions-bed', 'viewport-bed', 'capture-regions']));
    expect(ids('classes')).toEqual(expect.arrayContaining(['footprint-classes', 'class-result', 'tagged-bams', 'saved-footprints', 'co-occupancy']));
    expect(ids('clusters')).toEqual(['cluster-assignments', 'cluster-projection', 'saved-clusterings']);
    expect(ids('analysis')).toEqual(expect.arrayContaining(['read-stats', 'co-accessibility', 'transcription', 'primer-order']));
    expect(ids('session')).toEqual(['session-json', 'reproducibility-summary']);
    // Every entry says what is in it and its format.
    for (const e of listDataExports()) {
      expect(e.description.length, e.id).toBeGreaterThan(10);
      expect(e.format.length, e.id).toBeGreaterThan(0);
    }
  });

  it('highlights and saved regions are in the list (integ-r4: fb-r4-regions × fb-r4-export)', () => {
    useBrowserStore.setState({ currentGenome: 'hg38', highlights: [] } as never);
    expect(getDataExport('highlights-bed')!.available(ctx())).toMatchObject({ ok: false });
    expect(getDataExport('saved-regions')!.available(ctx())).toMatchObject({ ok: false });
    const highlights = [
      { id: 'a', genome: 'hg38', chrom: 'chr2', start: 50, end: 90, color: '#fde047', label: 'my enhancer' },
      { id: 'b', genome: 'hg38', chrom: 'chr1', start: 10, end: 20, color: '#93c5fd' },
      { id: 'c', genome: 'dm6', chrom: 'chr2L', start: 1, end: 5, color: 'red' },
    ];
    useBrowserStore.setState({ highlights } as never);
    expect(getDataExport('highlights-bed')!.available(ctx())).toMatchObject({ ok: true, detail: '3 highlights' });
    // One BED per reference (a BED is one assembly's coordinates).
    expect(formatHighlightsBed(highlights)).toEqual([
      { genome: 'hg38', bed: 'chr1\t10\t20\tchr1:10-20\t0\t.\t10\t20\t147,197,253\nchr2\t50\t90\tmy_enhancer\t0\t.\t50\t90\t253,224,71\n' },
      { genome: 'dm6', bed: 'chr2L\t1\t5\tchr2L:1-5\t0\t.\t1\t5\t0,0,0\n' },
    ]);
    let c = emptyCatalog('hg38');
    const cat = addCategory(c, { name: 'Enhancers' }); c = cat.catalog;
    c = addEntries(c, cat.id, [{ chrom: 'chr1', start: 1, end: 2, label: 'x', category: cat.id, source: 'saved' } as never]).catalog;
    useRegionCatalogStore.setState(st => ({ catalogs: { ...st.catalogs, hg38: c } }));
    try {
      expect(getDataExport('saved-regions')!.available(ctx())).toMatchObject({ ok: true, detail: '1 region' });
      expect(getDataExport('saved-regions')!.action).toBe('open');
    } finally {
      useRegionCatalogStore.setState(st => { const { hg38: _gone, ...rest } = st.catalogs; return { catalogs: rest }; });
    }
  });

  it('projection coordinates (fb-r3-tsne): the placeholder opens Clusters > Projection; a shown map takes the id over and gives it back', async () => {
    const { CLUSTER_PROJECTION_PLACEHOLDER } = await import('../utils/builtinDataExports');
    expect(getDataExport('cluster-projection')).toMatchObject({ action: 'open', group: 'clusters' });
    const run = vi.fn();
    registerDataExport({ ...CLUSTER_PROJECTION_PLACEHOLDER, action: 'download', available: () => ({ ok: true }), run });
    expect(getDataExport('cluster-projection')!.action).toBe('download');
    registerDataExport(CLUSTER_PROJECTION_PLACEHOLDER);
    expect(getDataExport('cluster-projection')).toBe(CLUSTER_PROJECTION_PLACEHOLDER);
  });

  it('another feature adds an export, or takes over a placeholder by its id', () => {
    const run = vi.fn();
    const remove = registerDataExport({
      id: 'cluster-projection', group: 'clusters', order: 20, title: 'Projection coordinates', format: 'TSV',
      description: 'x/y of each read on the t-SNE map', available: () => ({ ok: true }), run,
    });
    expect(listDataExports('clusters').filter(e => e.id === 'cluster-projection')).toHaveLength(1);
    expect(getDataExport('cluster-projection')!.run).toBe(run);
    const removeNames = registerDataExport({ id: 'extra', group: 'reads', title: 'X', format: 'text', description: 'An extra export', available: () => ({ ok: true }), run });
    expect(listDataExports('reads').map(e => e.id)).toContain('extra');
    removeNames();
    remove();
    expect(listDataExports('reads').map(e => e.id)).not.toContain('extra');
  });

  it('says why an export does not apply', () => {
    const reason = (id: string, scope?: string) => {
      const a = entryAvailability(getDataExport(id)!, ctx(scope));
      return a.ok ? null : a.reason;
    };
    expect(reason('peaks-bed')).toMatch(/No peaks.*Scan/);
    expect(reason('selected-peaks-bed')).toMatch(/No peaks selected/);
    expect(reason('cluster-assignments')).toMatch(/Cluster reads first/);
    expect(reason('cluster-regions-bed')).toMatch(/Cluster reads first/);
    expect(reason('footprint-classes')).toMatch(/No class run/);
    expect(reason('co-occupancy')).toMatch(/Save footprints/);
    expect(reason('transcription')).toMatch(/Pick genes/);
    expect(reason('read-names', 'selection')).toMatch(/No reads selected/);
    expect(reason('read-table', 'filtered')).toMatch(/No read filter/);
    expect(reason('viewport-bed')).toBeNull();
    expect(reason('read-names', 'shown')).toBeNull();
    // A BAM subset needs a BAM; in public mode it isn't offered.
    useBrowserStore.setState({ selectedReadIds: { bb: new Set(['b1']) } } as never);
    expect(reason('read-bam', 'selection')).toMatch(/BigBed/);
    useBrowserStore.setState({ publicMode: true } as never);
    expect(reason('read-bam', 'shown')).toMatch(/public server/);
    expect(reason('session-json')).toBeNull();  // as the Export dialog always offered it
  });

  it('applies once the state has what it needs', () => {
    setStore({
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterPeakRegions: [{ start: 1100, end: 1200 }],
      footprintGroups: [{ id: 'g1' }],
      selectedGenes: [{ name: 'g' }],
    });
    useConsensusViewStore.setState({ jobId: 'job1', catalog: {} } as never);
    for (const id of ['cluster-assignments', 'cluster-regions-bed', 'co-occupancy', 'saved-footprints', 'transcription', 'footprint-classes', 'class-result']) {
      expect(entryAvailability(getDataExport(id)!, ctx()).ok, id).toBe(true);
    }
    const detail = entryAvailability(getDataExport('cluster-assignments')!, ctx());
    expect(detail.ok && detail.detail).toBe('2 reads across 1 dataset; rows keep viewer order');
  });
});

describe('Which reads', () => {
  it('offers the selection, the reads shown, the filtered reads and each cluster, with counts', () => {
    setStore({
      selectedReadIds: { ds1: new Set(['r2']) },
      filteredReadIds: { ds1: new Set(['r1', 'r3']) },
      clusterAssignments: { ds1: { r1: 0, r2: 1, r3: 1 } },
    });
    const options = readScopeOptions(useBrowserStore.getState());
    expect(options.map(o => [o.key, o.count])).toEqual([
      ['selection', 1], ['shown', 4], ['filtered', 2], ['cluster:0', 1], ['cluster:1', 2],
    ]);
    expect(readScopeGroups(useBrowserStore.getState(), 'cluster:1')).toEqual([
      { datasetId: 'ds1', stateKey: 'ds1', chrom: 'chr19', start: 1000, end: 2000, readIds: ['r2', 'r3'] },
    ]);
    expect(formatReadNames(readScopeGroups(useBrowserStore.getState(), 'shown'))).toBe('r1\nr2\nr3\nb1\n');
  });

  it('a panel at another locus has its reads at its own region; hidden panels do not count', () => {
    setStore({
      panels: [panel('ds1', { viewportOverride: { chrom: 'chr2', start: 5, end: 50 } }), panel('bb', { collapsed: true })],
    });
    const groups = readScopeGroups(useBrowserStore.getState(), 'shown');
    expect(groups).toEqual([{ datasetId: 'ds1', stateKey: 'ds1', chrom: 'chr2', start: 5, end: 50, readIds: ['r1', 'r2', 'r3'] }]);
  });

  it('the read table has per-read statistics with each read\'s cluster, in display order', async () => {
    setStore({ clusterAssignments: { ds1: { r1: 2, r2: 0 } } });
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return json({
        per_read: [
          { read_id: 'r2', dataset_id: 'ds1', aligned_span: 900, footprint_count: 4, accessibility_pct: 30, mapq: 60, strand: '+' },
          { read_id: 'r1', dataset_id: 'ds1', aligned_span: 1000, footprint_count: 5, accessibility_pct: 20, mapq: 60, strand: '-' },
        ],
        aggregate: {}, is_bam: true,
      });
    }));
    const table = await buildReadTable(useBrowserStore.getState(), readScopeGroups(useBrowserStore.getState(), 'cluster:2').concat(readScopeGroups(useBrowserStore.getState(), 'cluster:0')));
    expect(requests[0].url).toContain('/api/reads/stats');
    expect(requests[0].body.read_ids_by_dataset).toEqual({ ds1: ['r1', 'r2'] });
    const lines = table.tsv.trim().split('\n').map(l => l.split('\t'));
    // fb-n3-export: each row names its reference (hg38 and dm6 panels share no coordinates).
    expect(lines[0].slice(0, 6)).toEqual(['read_id', 'dataset_id', 'reference', 'chrom', 'cluster', 'aligned_span']);
    expect(lines.slice(1).map(l => [l[0], l[4]])).toEqual([['r1', '2'], ['r2', '0']]);
  });
});

describe('Read table across loci', () => {
  it('a read shown in two windows is two rows, each with its own locus and cluster', async () => {
    setStore({
      panels: [panel('ds1'), panel('copy', { datasetId: 'ds1', stateKey: 'ds1:copy', viewportOverride: { chrom: 'chr19', start: 1500, end: 2500 } })],
      activeReadIds: { ds1: ['r1'], 'ds1:copy': ['r1'] },
      clusterAssignments: { ds1: { r1: 3 }, 'ds1:copy': { r1: 7 } },
    });
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return json({ per_read: [{ read_id: 'r1', dataset_id: 'ds1', aligned_span: 10 }], aggregate: {}, is_bam: true });
    }));
    const table = await buildReadTable(useBrowserStore.getState(), readScopeGroups(useBrowserStore.getState(), 'shown'));
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('start=1500');
    const rows = table.tsv.trim().split('\n').slice(1).map(l => l.split('\t'));
    expect(rows.map(r => [r[0], r[4], r[r.length - 1]])).toEqual([['r1', '3', '1'], ['r1', '7', '2']]);
  });
});

describe('Export data dialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);

  it('lists every group and entry; a disabled entry shows its reason and its button is off', () => {
    act(() => root.render(<ExportDataDialog onClose={vi.fn()} />));
    for (const g of DATA_EXPORT_GROUPS) expect(q(`[data-testid="export-group-${g.id}"]`), g.id).not.toBeNull();
    const peaks = q('[data-testid="export-entry-peaks-bed"]')!;
    expect(peaks.dataset.available).toBe('false');
    expect(q('[data-testid="export-entry-peaks-bed-reason"]')!.textContent).toMatch(/No peaks/);
    expect((q('[data-testid="export-entry-peaks-bed-button"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-testid="export-entry-viewport-bed"]')!.dataset.available).toBe('true');
    expect(q('[data-testid="export-entry-viewport-bed"]')!.textContent).toContain('BED');
    // One filled button: the session file.
    const primaries = container.querySelectorAll('.fb-btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toBe('Download .json');
  });

  it('the scope picker changes which reads the Reads exports are about', () => {
    setStore({ selectedReadIds: { ds1: new Set(['r1']) } });
    act(() => root.render(<ExportDataDialog onClose={vi.fn()} />));
    const select = q('[data-testid="export-read-scope"]') as HTMLSelectElement;
    expect(select.value).toBe('selection');  // a selection is the default
    expect(q('[data-testid="export-entry-read-names-detail"]')!.textContent).toBe('1 read');
    act(() => {
      select.value = 'filtered';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(q('[data-testid="export-entry-read-names-reason"]')!.textContent).toMatch(/No read filter/);
  });

  it('downloads a BAM subset per BAM dataset and says what was saved', async () => {
    setStore({ selectedReadIds: { ds1: new Set(['r1', 'r2']) } });
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Blob(['BAM']), { status: 200, headers: {
        'content-disposition': 'attachment; filename="napa_ddda_chr19_1000-2000_2reads.bam"', 'x-fiberbrowser-missing': '0' } });
    }));
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    act(() => root.render(<ExportDataDialog onClose={vi.fn()} />));
    await act(async () => {
      q('[data-testid="export-entry-read-bam-button"]')!.click();
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    });
    expect(bodies).toEqual([{ dataset_id: 'ds1', chrom: 'chr19', start: 1000, end: 2000, read_ids: ['r1', 'r2'] }]);
    expect(q('[data-testid="export-entry-read-bam"]')!.textContent).toContain('Saved 1 BAM');
  });

  it('an export of an analysis panel opens that panel and closes the dialog', async () => {
    setStore({ footprintGroups: [{ id: 'g1' }] });
    const onClose = vi.fn();
    act(() => root.render(<ExportDataDialog onClose={onClose} />));
    await act(async () => {
      q('[data-testid="export-entry-co-occupancy-button"]')!.click();
      await new Promise(r => setTimeout(r, 0));
    });
    expect(useBrowserStore.getState().panels.some((p: any) => p.contentType === 'footprint-analysis')).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('is a modal for the keyboard: focus moves in, Tab stays inside, and goes back on close (fb-n3-export, audit M20)', () => {
    const behind = document.createElement('button');
    behind.textContent = 'Collapse analysis strip';
    document.body.appendChild(behind);
    behind.focus();
    try {
      act(() => root.render(<ExportDataDialog onClose={vi.fn()} />));
      const dialog = q('[data-testid="export-data-dialog"]')!;
      expect(dialog.contains(document.activeElement)).toBe(true);
      // The first control of the list, not the close button.
      expect(q('[data-testid="export-data-dialog-body"]')!.contains(document.activeElement)).toBe(true);
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled])')];
      const tab = (shiftKey = false) => act(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
      });
      focusable.at(-1)!.focus();
      tab();
      expect(document.activeElement).toBe(focusable[0]);
      tab(true);
      expect(document.activeElement).toBe(focusable.at(-1));
      act(() => root.render(<></>));
      expect(document.activeElement).toBe(behind);
    } finally {
      behind.remove();
    }
  });

  it('warns before a very large working-set file', () => {
    useReadStatusStore.setState({ byStateKey: { ds1: { text: '312/4,873 visible', title: '' } } });
    act(() => root.render(<ExportDataDialog onClose={vi.fn()} />));
    expect(q('[data-testid="export-working-set-size-warning"]')!.textContent).toContain('4,873 reads');
  });
});
