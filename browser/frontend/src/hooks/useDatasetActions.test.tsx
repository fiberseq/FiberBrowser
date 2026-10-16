import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import type { Dataset } from '../types';

const { dataset, loadDerivedLayers, removeDataset } = vi.hoisted(() => {
  const dataset = { id: 'ds1', name: 'sample', path: '/data/sample.bb' } as unknown as Dataset;
  return {
    dataset,
    loadDerivedLayers: vi.fn(async (_path: string, _ids?: string[]) => ({ success: true, datasets: [dataset] })),
    removeDataset: vi.fn(),
  };
});

vi.mock('../api/files', () => ({
  pickFile: vi.fn(),
  pickDataset: vi.fn(),
  pickAnyFile: vi.fn(),
  pickFilesToOpen: vi.fn(async () => ({ success: true, paths: ['/data/sample.bb', '/data/sample.fiberlayers.bb'] })),
}));
vi.mock('../api/datasets', () => ({
  addDataset: vi.fn(),
  removeDataset,
  addDatasetsGrouped: vi.fn(async () => ({ success: true, datasets: [dataset] })),
}));
vi.mock('../api/footprints', () => ({ loadDerivedLayers, loadFootprintRules: vi.fn() }));
vi.mock('../api/status', () => ({ getStatus: vi.fn(async () => ({ has_gtf: false, gene_count: 0, track_count: 0 })) }));
vi.mock('../api/tracks', () => ({ getTracks: vi.fn(async () => ({ tracks: [] })), removeTrack: vi.fn() }));
vi.mock('../api/overlays', () => ({
  getOverlays: vi.fn(async () => ({ overlays: [] })),
  addOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  pickOverlayFile: vi.fn(),
}));
vi.mock('../api/s3', () => ({
  getS3Status: vi.fn(async () => null),
  configureS3: vi.fn(),
  testS3Access: vi.fn(),
}));

import { useDatasetActions } from './useDatasetActions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useDatasetActions.handleLoadFile', () => {
  it('loads a derived-layer bundle onto a source dataset loaded in the same batch', async () => {
    useBrowserStore.setState({ datasets: [], error: null } as any);
    let hook: ReturnType<typeof useDatasetActions> | null = null;
    function Host() { hook = useDatasetActions(); return null; }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host />));

    await act(async () => { await hook!.handleLoadFile(); });

    expect(loadDerivedLayers).toHaveBeenCalledWith('/data/sample.fiberlayers.bb', ['ds1']);
    expect(useBrowserStore.getState().error).toBeNull();
    act(() => root.unmount());
  });
});

// Owner report 2026-10-01: "if I load BAIs with BAMs by mistake nothing opens and there is no error".
describe('useDatasetActions.handleLoadFile with indexes and failures', () => {
  async function loadFile(paths: string[]) {
    const { pickFilesToOpen } = await import('../api/files');
    vi.mocked(pickFilesToOpen).mockResolvedValueOnce({ success: true, path: paths[0], paths });
    const { addDataset } = await import('../api/datasets');
    vi.mocked(addDataset).mockReset().mockImplementation(async (path: string | string[]) => {
      const p = String(path);
      if (p.endsWith('.bam') && !p.includes('broken')) {
        const id = p.split('/').pop()!.replace('.bam', '');
        return { success: true, dataset: { id, label: id, path: p, paths: [p] } as unknown as Dataset };
      }
      return { success: false, error: `Invalid path: ${p}` };
    });
    useBrowserStore.setState({ datasets: [], error: null } as any);
    let hook: ReturnType<typeof useDatasetActions> | null = null;
    function Host() { hook = useDatasetActions(); return null; }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Host />));
    await act(async () => { await hook!.handleLoadFile(); });
    act(() => root.unmount());
    return vi.mocked(addDataset).mock.calls.map(c => c[0]);
  }

  it('BAMs chosen with their .bai/.csi open, and the indexes are used, not reported', async () => {
    const opened = await loadFile(['/d/a.bam', '/d/a.bam.bai', '/d/b.bam', '/d/b.csi']);
    expect(opened).toEqual(['/d/a.bam', '/d/b.bam']);
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['a', 'b']);
    expect(useBrowserStore.getState().error).toBeNull();
  });

  it('names every file that could not open, not just the last, and still opens the rest', async () => {
    await loadFile(['/d/a.bam', '/d/broken.bam', '/d/orphan.bam.bai', '/d/reads.cram']);
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['a']);
    const error = useBrowserStore.getState().error ?? '';
    expect(error).toMatch(/^3 of 4 files could not be opened:/);
    expect(error).toContain('Invalid path: /d/broken.bam');
    expect(error).toContain('orphan.bam.bai: this is a BAM index file, not a file to open on its own. Open orphan.bam instead');
    expect(error).toContain('reads.cram: CRAM files can');
  });
});

// Codex UI audit 2026-10-01: "Dataset-close failures silently do nothing".
describe('useDatasetActions.handleRemove', () => {
  async function closeWith(result: () => Promise<unknown>) {
    removeDataset.mockReset().mockImplementation(result);
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'demo', paths: ['/tmp/demo.bam'] }], error: null } as any);
    let hook: ReturnType<typeof useDatasetActions> | null = null;
    function Host() { hook = useDatasetActions(); return null; }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Host />));
    await act(async () => { await hook!.handleRemove('ds1'); });
    act(() => root.unmount());
  }

  it('a failed request keeps the dataset and says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await closeWith(async () => { throw new Error('500 Backend unavailable'); });
    expect(useBrowserStore.getState().datasets).toHaveLength(1);
    expect(useBrowserStore.getState().error).toMatch(/Could not close demo: 500 Backend unavailable/);
  });

  it('a refusal (success: false) keeps the dataset and shows the reason', async () => {
    await closeWith(async () => ({ success: false, error: 'Dataset is busy' }));
    expect(useBrowserStore.getState().datasets).toHaveLength(1);
    expect(useBrowserStore.getState().error).toMatch(/Could not close demo: Dataset is busy/);
  });
});

// fb-n1-s3: an S3-compatible endpoint (R2, B2, MinIO) could only be set from
// the Connect dialog or a profile; Load Remote URL had no field for it.
describe('useDatasetActions.handleLoadS3', () => {
  it('sends the endpoint (and profile) before testing and loading an s3:// URL', async () => {
    const s3 = await import('../api/s3');
    const datasets = await import('../api/datasets');
    vi.mocked(s3.configureS3).mockResolvedValue({ success: true, endpoint_url: 'http://127.0.0.1:9000' });
    vi.mocked(s3.testS3Access).mockResolvedValue({ accessible: true });
    vi.mocked(datasets.addDataset).mockResolvedValue({ success: true, dataset } as any);
    useBrowserStore.setState({ datasets: [], error: null } as any);
    let hook: ReturnType<typeof useDatasetActions> | null = null;
    function Host() { hook = useDatasetActions(); return null; }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host />));
    act(() => {
      hook!.setS3Url('s3://lab/run1.bam');
      hook!.setS3Endpoint(' http://127.0.0.1:9000 ');
    });

    await act(async () => { await hook!.handleLoadS3(); });

    expect(s3.configureS3).toHaveBeenCalledWith(undefined, undefined, 'http://127.0.0.1:9000');
    expect(s3.testS3Access).toHaveBeenCalledWith('s3://lab/run1.bam');
    expect(datasets.addDataset).toHaveBeenCalledWith('s3://lab/run1.bam');
    expect(useBrowserStore.getState().error).toBeNull();
    act(() => root.unmount());
  });

  it('shows the server reason when the object cannot be read', async () => {
    const s3 = await import('../api/s3');
    const datasets = await import('../api/datasets');
    vi.mocked(s3.configureS3).mockClear();
    vi.mocked(datasets.addDataset).mockClear();
    vi.mocked(s3.testS3Access).mockResolvedValue({
      accessible: false, error: "http://127.0.0.1:9000 rejected profile 'lab' (SignatureDoesNotMatch)" });
    useBrowserStore.setState({ datasets: [], error: null } as any);
    let hook: ReturnType<typeof useDatasetActions> | null = null;
    function Host() { hook = useDatasetActions(); return null; }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host />));
    act(() => { hook!.setS3Url('s3://lab/run1.bam'); });

    await act(async () => { await hook!.handleLoadS3(); });

    expect(s3.configureS3).not.toHaveBeenCalled();  // nothing typed: settings kept
    expect(datasets.addDataset).not.toHaveBeenCalled();
    expect(String(useBrowserStore.getState().error)).toContain('SignatureDoesNotMatch');
    act(() => root.unmount());
  });
});

describe('useDatasetActions.handleLoadS3 settings', () => {
  it('tests the BAM of a <bam>##idx##<index> reference, and clearing the fields resets the settings', async () => {
    const s3 = await import('../api/s3');
    const datasets = await import('../api/datasets');
    vi.mocked(s3.getS3Status).mockResolvedValue({ available: true, configured: true, profile: 'lab', endpoint_url: 'http://127.0.0.1:9000' });
    vi.mocked(s3.configureS3).mockClear();
    vi.mocked(s3.configureS3).mockResolvedValue({ success: true });
    vi.mocked(s3.testS3Access).mockClear();
    vi.mocked(s3.testS3Access).mockResolvedValue({ accessible: true });
    vi.mocked(datasets.addDataset).mockResolvedValue({ success: true, dataset } as any);
    useBrowserStore.setState({ datasets: [], error: null } as any);
    let hook: ReturnType<typeof useDatasetActions> | null = null;
    function Host() { hook = useDatasetActions(); return null; }
    const root = createRoot(document.createElement('div'));
    await act(async () => { root.render(<Host />); });
    await act(async () => { hook!.setShowS3Input(true); });
    // The form starts from the current settings: loading as is changes nothing.
    expect(hook!.s3Profile).toBe('lab');
    expect(hook!.s3Endpoint).toBe('http://127.0.0.1:9000');
    act(() => { hook!.setS3Url('s3://lab/x.bam##idx##s3://lab/idx/x.bai'); });
    await act(async () => { await hook!.handleLoadS3(); });
    expect(s3.configureS3).not.toHaveBeenCalled();
    expect(s3.testS3Access).toHaveBeenCalledWith('s3://lab/x.bam');
    expect(datasets.addDataset).toHaveBeenCalledWith('s3://lab/x.bam##idx##s3://lab/idx/x.bai');

    // Both fields cleared: back to AWS with the default credentials.
    act(() => { hook!.setS3Url('s3://public/y.bam'); hook!.setS3Profile(''); hook!.setS3Endpoint(''); });
    await act(async () => { await hook!.handleLoadS3(); });
    expect(s3.configureS3).toHaveBeenCalledWith(undefined, undefined, undefined);
    act(() => root.unmount());
  });
});
