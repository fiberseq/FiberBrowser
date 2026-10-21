import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { useReadStatusStore } from '../stores/readStatusStore';
import { registerBuiltinDataExports } from './builtinDataExports';
import { entryAvailability, getDataExport } from './dataExportRegistry';
import {
  buildReadTable, downloadClusterAssignments, downloadClusterRegionsBed, downloadPeaksBed, downloadReadBams, downloadReadNames,
  downloadViewportBed, downloadWorkingSetTsv, formatClusterAssignmentsForState, formatClusterRegionsBed, referenceAt, viewBedIntervals,
} from './dataExportActions';
import { readScopeGroups } from './exportReadScopes';

/**
 * fb-n3-export: Export data with an hg38 panel and a dm6 panel on its own
 * genome, in "Each panel navigates" (the main locus is stale). Every export
 * about "the view" takes the panels' loci and references (utils/panelScope),
 * and a BED holds one reference's coordinates.
 */

registerBuiltinDataExports();

const STALE_MAIN = { chrom: 'chr19', start: 47_514_037, end: 47_519_435 };
const HUMAN_AT = { chrom: 'chr19', start: 47_514_262, end: 47_519_210 };
const FLY_AT = { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const panel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: id, stateKey: id, layoutRow: 0, subTracks: [], collapsed: false, ...extra,
});

let saved: Array<{ name: string; text: Promise<string> }>;

// jsdom's Blob has no text(); a fetch Response's blob is Node's (no FileReader).
const blobText = (blob: Blob) => (typeof blob.text === 'function' ? blob.text() : new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
}));

beforeEach(() => {
  localStorage.clear();
  useBrowserStore.setState({
    ...STALE_MAIN,
    currentGenome: 'hg38', fastaPath: null, navigationMode: 'perPanel', lastMovedPanels: {},
    datasets: [{ id: 'napa', label: 'napa_ddda', data_type: 'bam', paths: ['/d/napa.bam'] },
      { id: 'flyamp', label: 'FlyAmp', data_type: 'bam', paths: ['/d/flyamp.bam'] }],
    panels: [panel('napa', { viewportOverride: { ...HUMAN_AT }, navOwn: true }), panel('flyamp', { genome: 'dm6', viewportOverride: { ...FLY_AT } })],
    collapsedRows: new Set(), fullViewPanelId: null, selectedDatasets: new Set(),
    selectedReadIds: {}, activeReadIds: { napa: ['h1', 'h2'], flyamp: ['f1'] },
    clusterAssignments: {}, clusterOrder: {}, readSortOrder: {}, jupyterReadOrder: {}, filteredReadIds: {},
    clusterPeakRegions: [], selectedPeaks: new Set(), peaksByRule: {}, peakModes: {},
    peakRules: [{ id: 'acc', name: 'Accessibility', enabled: true, source: 'accessibility', color: '#000' }],
    publicMode: false, sessionName: '', readProjection: null,
  } as never);
  useReadStatusStore.setState({ byStateKey: {} });
  saved = [];
  // Every download: its file name and contents.
  let pending: Blob | null = null;
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => { pending = blob; return 'blob:x'; }),
    revokeObjectURL: vi.fn(),
  }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, text: pending ? blobText(pending) : Promise.resolve('') });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const s = () => useBrowserStore.getState();
const files = async () => Promise.all(saved.map(async f => ({ name: f.name, text: await f.text })));

describe('Export data with an hg38 and a dm6 panel (Each panel navigates)', () => {
  it('Working set: one request per panel locus and reference; nothing from the stale main locus (audit M3)', async () => {
    const urls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x');
      urls.push(u);
      const id = u.searchParams.get('dataset_ids')!;
      return json({ datasets: { [id]: { reads: [{ id: id === 'napa' ? 'h1' : 'f1', intervals: [[0, 10, 10]] }] } } });
    }));
    const message = await downloadWorkingSetTsv(s());
    expect(urls.map(u => [u.searchParams.get('dataset_ids'), u.searchParams.get('chrom'), u.searchParams.get('start'), u.searchParams.get('panel_genome')]))
      .toEqual([['napa', 'chr19', String(HUMAN_AT.start), null], ['flyamp', 'chr2L', String(FLY_AT.start), 'dm6']]);
    const [file] = await files();
    expect(file.name).toMatch(/^working_set_chr19_47514262-47519210_plus1_\d{8}_\d{6}\.tsv$/);
    const rows = file.text.trim().split('\n').slice(1).map(l => l.split('\t'));
    expect(rows.map(r => [r[1], r[7], ...r.slice(-2)])).toEqual([
      ['napa', String(HUMAN_AT.start), 'hg38', 'chr19'],
      ['flyamp', String(FLY_AT.start), 'dm6', 'chr2L'],
    ]);
    expect(message).toBe('Saved 2 reads from 2 regions');
  });

  it('Working set: the size warning counts only the panels on screen', () => {
    useReadStatusStore.setState({ byStateKey: { napa: { text: '10/1,200 visible', title: '' }, gone: { text: '50,000 reads', title: '' } } });
    const ctx = { state: s(), readScope: 'shown' as const };
    expect(getDataExport('working-set')!.sizeWarning!(ctx)).toContain('About 1,200 reads in view');
  });

  it('Peaks: one BED per reference, each naming it; no dm6 peak in the hg38 file (audit M5)', async () => {
    useBrowserStore.setState({
      peaksByRule: { acc: [
        { index: 1, start: HUMAN_AT.start + 100, end: HUMAN_AT.start + 300, chrom: 'chr19', ruleId: 'acc' },
        { index: 2, start: FLY_AT.start + 50, end: FLY_AT.start + 250, chrom: 'chr2L', genome: 'dm6', ruleId: 'acc' },
      ] },
      selectedPeaks: new Set([2]),
    } as never);
    expect(downloadPeaksBed(s())).toBe('Saved 2 BED files, one per reference (2 peaks)');
    const [hg38, dm6] = await files();
    expect(hg38.name).toBe('peaks_hg38_chr19_47514262-47519210.bed');
    expect(dm6.name).toBe('peaks_dm6_chr2L_6356793-6357648.bed');
    const body = (bed: string) => bed.split('\n').filter(l => l && !l.startsWith('#'));
    expect(hg38.text).toContain('# reference=hg38');
    expect(body(hg38.text).map(l => l.split('\t')[0])).toEqual(['chr19']);
    expect(dm6.text).toContain('# reference=dm6');
    expect(body(dm6.text).map(l => l.split('\t')[0])).toEqual(['chr2L']);
    // Selected peaks: only the reference that has some.
    saved = [];
    expect(downloadPeaksBed(s(), true)).toBe('Saved 1 selected peak');
    expect((await files()).map(f => f.name)).toEqual(['selected_peaks_chr2L_6356793-6357648.bed']);
  });

  it('Cluster regions: each region on its own chromosome and reference (audit M4)', async () => {
    useBrowserStore.setState({
      peaksByRule: { acc: [{ index: 2, start: 6_356_930, end: 6_357_166, chrom: 'chr2L', genome: 'dm6', ruleId: 'acc' }] },
      clusterPeakRegions: [
        { start: 6_356_930, end: 6_357_166, mode: 'accessibility', chrom: 'chr2L' },
        { start: 6_357_191, end: 6_357_572, mode: 'tf', chrom: 'chr2L' },
      ],
    } as never);
    const rows = formatClusterRegionsBed(s()).trim().split('\n');
    expect(rows[0].split('\t').slice(-2)).toEqual(['mode', 'reference']);
    expect(rows.slice(1).map(l => l.split('\t')).map(r => [r[0], r[1], r.at(-1)])).toEqual([
      ['chr2L', '6356930', 'dm6'], ['chr2L', '6357191', 'dm6'],
    ]);
    downloadClusterRegionsBed(s());
    expect((await files())[0].name).toBe('cluster_regions_chr2L_6356930-6357572.bed');
  });

  it('Cluster regions: the clustered panels\' reference, though another reference has a peak at the same coordinates (Codex review)', () => {
    useBrowserStore.setState({
      peaksByRule: { acc: [
        { index: 1, start: 100, end: 200, chrom: 'chr2L', ruleId: 'acc' },
        { index: 2, start: 100, end: 200, chrom: 'chr2L', genome: 'dm6', ruleId: 'acc' },
      ] },
      clusterAssignments: { flyamp: { f1: 0 } },
      clusterPeakRegions: [{ start: 100, end: 200, mode: 'accessibility', chrom: 'chr2L' }],
    } as never);
    expect(formatClusterRegionsBed(s()).trim().split('\n')[1].split('\t').at(-1)).toBe('dm6');
  });

  it('Cluster assignments: the header and file name give the clustered panel\'s locus and reference', async () => {
    useBrowserStore.setState({ clusterAssignments: { flyamp: { f1: 0 } } } as never);
    const header = formatClusterAssignmentsForState(s()).split('\n').filter(l => l.startsWith('#'));
    expect(header).toEqual(expect.arrayContaining(['# chrom: chr2L', `# start: ${FLY_AT.start}`, `# end: ${FLY_AT.end}`, '# reference: dm6']));
    downloadClusterAssignments(s());
    expect((await files())[0].name).toBe('clusters_chr2L_6356793-6357648.tsv');
  });

  it('Current region: each panel\'s locus, one BED per reference, not the stale main locus (audit M1)', async () => {
    const available = entryAvailability(getDataExport('viewport-bed')!, { state: s(), readScope: 'shown' });
    expect(available).toEqual({ ok: true, detail: 'hg38 chr19:47,514,262-47,519,210, dm6 chr2L:6,356,793-6,357,648' });
    expect(downloadViewportBed(s())).toBe('Saved 2 BED files, one per reference (2 regions)');
    expect(await files()).toEqual([
      { name: 'region_hg38_chr19_47514262-47519210.bed', text: `chr19\t${HUMAN_AT.start}\t${HUMAN_AT.end}\tviewport\t0\t.\n` },
      { name: 'region_dm6_chr2L_6356793-6357648.bed', text: `chr2L\t${FLY_AT.start}\t${FLY_AT.end}\tviewport\t0\t.\n` },
    ]);
    // A selected panel: its view only.
    saved = [];
    useBrowserStore.setState({ selectedDatasets: new Set(['flyamp']) } as never);
    downloadViewportBed(s());
    expect((await files()).map(f => f.name)).toEqual(['region_chr2L_6356793-6357648.bed']);
    // No dataset panel on screen (an analysis panel maximized): said, not the stale main locus.
    useBrowserStore.setState({ selectedDatasets: new Set(), panels: [...s().panels, { id: 'an', contentType: 'cluster-detail' }], fullViewPanelId: 'an' } as never);
    expect(entryAvailability(getDataExport('viewport-bed')!, { state: s(), readScope: 'shown' })).toMatchObject({ ok: false, reason: 'No dataset panel on screen' });
  });

  it('Current region on a circular contig across its origin: a BED piece on each side of the seam (Codex review)', () => {
    const plasmid = { size: 1000, circular: true };
    expect(viewBedIntervals({ start: -100, end: 100 }, plasmid)).toEqual([[900, 1000], [0, 100]]);
    expect(viewBedIntervals({ start: 900, end: 1100 }, plasmid)).toEqual([[900, 1000], [0, 100]]);
    expect(viewBedIntervals({ start: 100, end: 300 }, plasmid)).toEqual([[100, 300]]);
    expect(viewBedIntervals({ start: -100, end: 100 }, { size: 1000, circular: false })).toEqual([[0, 100]]);
    useBrowserStore.setState({
      chroms: [{ name: 'pUC19', size: 1000, circular: true }],
      panels: [panel('napa', { viewportOverride: { chrom: 'pUC19', start: -100, end: 100 }, navOwn: true })],
    } as never);
    downloadViewportBed(s());
    return files().then(([f]) => expect(f.text).toBe('pUC19\t900\t1000\tviewport\t0\t.\npUC19\t0\t100\tviewport\t0\t.\n'));
  });

  it('A projection\'s reference is its datasets\' panels\' (Codex review)', () => {
    expect(referenceAt(s(), FLY_AT, ['flyamp', 'flyamp'])).toBe('dm6');
    expect(referenceAt(s(), HUMAN_AT, ['napa'])).toBe('hg38');
    // Not the reference of another panel that happens to be at that locus.
    useBrowserStore.setState({ panels: [...s().panels, panel('copy', { datasetId: 'napa', stateKey: 'napa:copy', viewportOverride: { ...FLY_AT } })] } as never);
    expect(referenceAt(s(), FLY_AT, ['flyamp'])).toBe('dm6');
    expect(referenceAt(s(), FLY_AT, ['napa'])).toBe('hg38');
    expect(referenceAt(s(), { chrom: 'chrX', start: 0, end: 1 }, ['napa', 'flyamp'])).toBe('hg38,dm6');
  });

  it('Read names: the file is named after the reads\' loci', async () => {
    downloadReadNames(readScopeGroups(s(), 'shown'), 'shown', s());
    expect((await files())[0]).toEqual({ name: 'read_names_shown_chr19_47514262-47519210_plus1.txt', text: 'h1\nh2\nf1\n' });
  });

  it('Read table: each region asks its reference; alignment bounds, reference and a plain strand (audit M6, Codex audit #11)', async () => {
    const urls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x');
      urls.push(u);
      const fly = u.searchParams.get('chrom') === 'chr2L';
      return json({ per_read: fly
        ? [{ read_id: 'f1', dataset_id: 'flyamp', ref_start: 6_356_893, ref_end: 6_357_548, strand: '-', mapq: 60 }]
        : [{ read_id: 'h1', dataset_id: 'napa', ref_start: 47_514_300, ref_end: 47_518_000, strand: '+', mapq: 60 },
          { read_id: 'h2', dataset_id: 'napa', ref_start: 47_514_400, ref_end: 47_519_000, strand: '-', mapq: 60 }],
      aggregate: {}, is_bam: true });
    }));
    const table = await buildReadTable(s(), readScopeGroups(s(), 'shown'));
    expect(urls.map(u => u.searchParams.get('panel_genome'))).toEqual([null, 'dm6']);
    const [header, ...rows] = table.tsv.trim().split('\n').map(l => l.split('\t'));
    const col = (name: string) => header.indexOf(name);
    expect(rows.map(r => [r[0], r[col('reference')], r[col('chrom')], r[col('ref_start')], r[col('ref_end')], r[col('strand')]])).toEqual([
      ['h1', 'hg38', 'chr19', '47514300', '47518000', '+'],
      ['h2', 'hg38', 'chr19', '47514400', '47519000', '-'],
      ['f1', 'dm6', 'chr2L', '6356893', '6357548', '-'],
    ]);
  });

  it('BAM subset: a dm6 panel\'s reads are cut on its reference', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(new Blob(['BAM']), { status: 200, headers: { 'x-fiberbrowser-missing': '0' } });
    }));
    await downloadReadBams(readScopeGroups(s(), 'shown'));
    expect(urls.map(u => u.replace(/^.*\/api/, '/api'))).toEqual(['/api/reads/export_bam', '/api/reads/export_bam?panel_genome=dm6']);
  });
});

describe('graph primary G8: lifted reads in exports', () => {
  const s = () => useBrowserStore.getState();
  beforeEach(() => {
    useBrowserStore.setState({
      datasets: [{ id: 'napa', label: 'napa_ddda', data_type: 'bam', paths: ['/d/napa.bam'] },
        { id: 'lift', label: 'Lifted', data_type: 'bam_livelift', paths: ['/d/src.bam'] }],
      panels: [panel('napa', { viewportOverride: { ...HUMAN_AT }, navOwn: true }), panel('lift', { viewportOverride: { ...HUMAN_AT }, navOwn: true })],
      activeReadIds: { napa: ['h1'], lift: ['lift-cohort:v1 ["g|q1","q1","r",0,"primary"]'] },
    } as never);
  });

  it('BAM subset: a lifted dataset\'s reads come from its source windows; the export says so', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(new Blob(['BAM']), { status: 200, headers: { 'x-fiberbrowser-missing': '0',
        ...(String(url).includes('/api/lift/') ? { 'x-fiberbrowser-source-contigs': 'chr19_MATERNAL+chr19_PATERNAL' } : {}) } });
    }));
    const entry = getDataExport('read-bam')!;
    const avail = entryAvailability(entry, { state: s(), readScope: 'shown' } as never);
    expect(avail.ok).toBe(true);
    const msg = await entry.run({ state: s(), readScope: 'shown' } as never);
    expect(urls.map(u => u.replace(/^.*\/api/, '/api')).sort()).toEqual(['/api/lift/export_bam', '/api/reads/export_bam']);
    expect(String(msg)).toContain('on its source assembly (chr19_MATERNAL, chr19_PATERNAL)');
  });

  it('graph features: the read table is offered for lifted reads alone and says their bounds are on the source assembly', () => {
    const entry = getDataExport('read-table')!;
    expect(entryAvailability(entry, { state: s(), readScope: 'shown' } as never)).toMatchObject({ ok: true });
    useBrowserStore.setState({ activeReadIds: { lift: ['lift-cohort:v1 ["g|q1","q1","r",0,"primary"]'] } } as never);
    const avail = entryAvailability(entry, { state: s(), readScope: 'shown' } as never);
    expect(avail.ok).toBe(true);
    expect(String((avail as { detail?: string }).detail)).toContain('source assembly');
  });

  it('graph features: the read table asks Read Stats for lifted datasets too, with their labels by cohort identity', async () => {
    const aid = 'lift-cohort:v1 ["g|q1","q1","r",0,"primary"]';
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(body);
      return json({ per_read: (body.read_ids_by_dataset.lift ?? []).map((id: string) => ({ read_id: id, dataset_id: 'lift',
        ref_start: 10, ref_end: 20, ref_contig: 'chrS_MATERNAL' })), aggregate: {}, is_bam: true });
    }));
    useBrowserStore.setState({ activeReadIds: { lift: [aid] },
      clusterAssignments: { lift: { 'lift-record:v1 ["g|q1","q1","r"]': 2 } } } as never);
    const table = await buildReadTable(s(), readScopeGroups(s(), 'shown'));
    expect(bodies.length).toBe(1);
    expect(Object.keys(bodies[0].read_ids_by_dataset).sort()).toEqual(['lift', 'napa'].filter(k => k in bodies[0].read_ids_by_dataset).sort());
    expect(bodies[0].read_ids_by_dataset.lift).toEqual([aid]);
    const line = table.tsv.split('\n').find(l => l.includes('chrS_MATERNAL'))!;
    const cols = table.tsv.split('\n')[0].split('\t');
    const vals = line.split('\t');
    expect(vals[cols.indexOf('ref_contig')]).toBe('chrS_MATERNAL');
    expect(vals[cols.indexOf('cluster')]).toBe('2');
  });
});
