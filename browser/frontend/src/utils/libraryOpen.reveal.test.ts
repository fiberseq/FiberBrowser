import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./connectCluster', () => ({ ensureClusterRefsConnected: vi.fn().mockResolvedValue(true) }));
const api = vi.hoisted(() => ({ addDataset: vi.fn(), getDatasets: vi.fn() }));
vi.mock('../api/datasets', () => api);
const status = vi.hoisted(() => ({ getStatus: vi.fn() }));
vi.mock('../api/status', () => status);
const reference = vi.hoisted(() => ({ loadGenome: vi.fn(), loadFasta: vi.fn() }));
vi.mock('../api/reference', () => reference);
vi.mock('./referenceNavigation', () => ({ showLoadedReference: vi.fn().mockResolvedValue(undefined) }));

import { openLibraryEntries, resetLibraryOpening } from './libraryOpen';
import { useBrowserStore } from '../stores/browserStore';
import { useOpeningStore } from '../stores/openingStore';
import type { LibraryEntry } from '../api/library';
import type { Dataset, PanelConfig } from '../types';

const PATH = '/data/numb.bam';
const entry = { id: 'e1', kind: 'bam', path: PATH, folder: '/data', label: 'numb.bam', available: true } as LibraryEntry;
const dataset = { id: 'numb', label: 'numb', path: PATH, paths: [PATH], color: '#3b82f6', data_type: 'bam' } as unknown as Dataset;

const panel = (over: Partial<PanelConfig>): PanelConfig => ({
  id: 'p1', contentType: 'dataset', datasetId: 'numb', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over,
});

describe('Library Open never silently does nothing', () => {
  beforeEach(() => {
    useBrowserStore.setState({ datasets: [], panels: [], fullViewPanelId: null, collapsedRows: new Set(), currentGenome: null });
    useOpeningStore.setState({ opening: [], retry: {} });
    resetLibraryOpening();
    api.addDataset.mockReset();
    api.getDatasets.mockReset().mockResolvedValue({ datasets: [] });
    status.getStatus.mockReset().mockResolvedValue({});
    reference.loadGenome.mockReset();
  });

  it('shows a placeholder panel with the name within 200 ms, before the server answers', async () => {
    api.addDataset.mockReturnValue(new Promise(() => {}));  // the server never answers
    const started = vi.fn();
    const t0 = performance.now();
    void openLibraryEntries([entry], [entry], [], { onStarted: started });
    const shown = useOpeningStore.getState().opening;
    expect(performance.now() - t0).toBeLessThan(200);
    expect(shown.map(o => o.label)).toEqual(['numb.bam']);
    expect(started).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(useOpeningStore.getState().opening[0].stage).toMatch(/reading its index/));
  });

  it('replaces the placeholder with the real panel once the server has opened it', async () => {
    api.addDataset.mockResolvedValue({ success: true, dataset });
    const res = await openLibraryEntries([entry], [entry], []);
    expect(res.success).toBe(true);
    expect(useOpeningStore.getState().opening).toEqual([]);
    expect(useBrowserStore.getState().panels.some(p => p.datasetId === 'numb' && !p.collapsed)).toBe(true);
  });

  // Usability round 2, N9: from the Library as with -b, the file stem names it (the server's default); the sample second.
  it('opens a BAM under its file stem, its sample name kept for tooltips; a name the user gave wins', async () => {
    api.addDataset.mockResolvedValue({ success: true, dataset });
    await openLibraryEntries([{ ...entry, sample: 'sample_1_rep' }], [entry], []);
    expect(api.addDataset).toHaveBeenCalledWith(PATH, undefined);
    expect(useBrowserStore.getState().datasets[0]).toMatchObject({ label: 'numb', sample: 'sample_1_rep' });
    useBrowserStore.setState({ datasets: [], panels: [] });
    resetLibraryOpening();
    await openLibraryEntries([{ ...entry, label_override: 'My numb' }], [entry], []);
    expect(api.addDataset).toHaveBeenLastCalledWith(PATH, 'My numb');
  });

  it('keeps a failed open on screen with the reason', async () => {
    api.addDataset.mockResolvedValue({ success: false, error: 'No index (.bai) beside the BAM' });
    const res = await openLibraryEntries([entry], [entry], []);
    expect(res.success).toBe(false);
    expect(res.error).toContain('No index');
    const [o] = useOpeningStore.getState().opening;
    expect(o.error).toContain('No index');
    expect(useOpeningStore.getState().retry[PATH]).toBeTypeOf('function');
  });

  it('shows an open dataset whose panel a split folded away (the split panels were closed one by one)', async () => {
    useBrowserStore.setState({ datasets: [dataset], panels: [panel({ collapsed: true, collapsedBySplitGroup: 'split-x' })] });
    api.getDatasets.mockResolvedValue({ datasets: [dataset] });
    const res = await openLibraryEntries([entry], [entry], []);
    expect(api.addDataset).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/already open: shown/);
    const p = useBrowserStore.getState().panels.find(x => x.id === 'p1')!;
    expect(p.collapsed).toBe(false);
    expect(p.collapsedBySplitGroup).toBeUndefined();
  });

  it('leaves another panel\'s full view and opens a collapsed row to show it', async () => {
    useBrowserStore.setState({
      datasets: [dataset], fullViewPanelId: 'other', collapsedRows: new Set([1]),
      panels: [panel({ layoutRow: 1 }), panel({ id: 'other', datasetId: 'x' })],
    });
    api.getDatasets.mockResolvedValue({ datasets: [dataset] });
    await openLibraryEntries([entry], [entry], []);
    const s = useBrowserStore.getState();
    expect(s.fullViewPanelId).toBeNull();
    expect(s.collapsedRows.has(1)).toBe(false);
  });

  it('gives an open dataset with no panel left a new one', async () => {
    useBrowserStore.setState({ datasets: [dataset], panels: [] });
    api.getDatasets.mockResolvedValue({ datasets: [dataset] });
    await openLibraryEntries([entry], [entry], []);
    const s = useBrowserStore.getState();
    expect(s.panels.filter(p => p.datasetId === 'numb')).toHaveLength(1);
    expect(s.datasets.filter(d => d.id === 'numb')).toHaveLength(1);
  });

  it('opens afresh a dataset the page lists but the server no longer has', async () => {
    useBrowserStore.setState({ datasets: [dataset], panels: [panel({ collapsed: true, collapsedBySplitGroup: 'split-x' })] });
    api.getDatasets.mockResolvedValue({ datasets: [] });
    api.addDataset.mockResolvedValue({ success: true, dataset });
    const res = await openLibraryEntries([entry], [entry], []);
    expect(api.addDataset).toHaveBeenCalledWith(PATH, undefined);
    expect(res.success).toBe(true);
    const s = useBrowserStore.getState();
    expect(s.datasets.filter(d => d.id === 'numb')).toHaveLength(1);
    expect(s.panels.some(p => p.datasetId === 'numb' && !p.collapsed)).toBe(true);
  });

  it('does not load the genome again when the server already has it (soon after start-up)', async () => {
    const withGenome = { ...entry, reference: { genome: 'dm6' } } as unknown as LibraryEntry;
    status.getStatus.mockResolvedValue({ current_genome: 'dm6' });
    api.addDataset.mockResolvedValue({ success: true, dataset });
    await openLibraryEntries([withGenome], [withGenome], ['dm6']);
    expect(reference.loadGenome).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().currentGenome).toBe('dm6');
  });

  it('says what it is waiting for when the reference must load first', async () => {
    const withGenome = { ...entry, reference: { genome: 'dm6' } } as unknown as LibraryEntry;
    status.getStatus.mockResolvedValue({ current_genome: null });
    reference.loadGenome.mockReturnValue(new Promise(() => {}));
    void openLibraryEntries([withGenome], [withGenome], ['dm6']);
    await vi.waitFor(() => expect(useOpeningStore.getState().opening[0].stage).toBe('Loading the reference dm6…'));
  });

  it('reveals the server\'s dataset, not a stale page entry of the same file with another id', async () => {
    useBrowserStore.setState({ datasets: [{ ...dataset, id: 'numb_2' }], panels: [panel({ datasetId: 'numb_2' })] });
    api.getDatasets.mockResolvedValue({ datasets: [dataset] });
    await openLibraryEntries([entry], [entry], []);
    const s = useBrowserStore.getState();
    expect(s.datasets.map(d => d.id)).toEqual(['numb']);
    expect(s.panels.some(p => p.datasetId === 'numb' && !p.collapsed)).toBe(true);
    expect(s.panels.some(p => p.datasetId === 'numb_2')).toBe(false);
  });

  it('a second Open of a file being opened waits for the first (never two datasets)', async () => {
    let finish!: (v: unknown) => void;
    api.addDataset.mockReturnValue(new Promise(r => { finish = r; }));
    const first = openLibraryEntries([entry], [entry], []);
    await vi.waitFor(() => expect(api.addDataset).toHaveBeenCalledTimes(1));
    const second = await openLibraryEntries([entry], [entry], []);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/being opened already/);
    finish({ success: true, dataset });
    expect((await first).success).toBe(true);
    expect(api.addDataset).toHaveBeenCalledTimes(1);
  });

  it('a reference that fails to load with an error leaves no placeholder spinning', async () => {
    const withGenome = { ...entry, reference: { genome: 'dm6' } } as unknown as LibraryEntry;
    status.getStatus.mockResolvedValue({ current_genome: null });
    reference.loadGenome.mockRejectedValue(new Error('Failed to fetch'));
    const res = await openLibraryEntries([withGenome], [withGenome], ['dm6']);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to fetch');
    expect(useOpeningStore.getState().opening[0].error).toContain('Failed to fetch');
  });
});
