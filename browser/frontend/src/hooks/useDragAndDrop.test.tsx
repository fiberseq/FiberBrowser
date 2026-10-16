import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';

vi.mock('../api/files', () => ({
  uploadFile: vi.fn(async (file: File) => (file.name.startsWith('broken')
    ? { success: false, error: 'disk full' }
    : { success: true, path: `/uploads/${file.name}` })),
}));
vi.mock('../api/datasets', () => ({
  addDataset: vi.fn(async (path: string) => (path.endsWith('.bam') && !path.includes('bad')
    ? { success: true, dataset: { id: path.split('/').pop()!.replace('.bam', ''), label: 'x', path, paths: [path] } }
    : { success: false, error: `${path.split('/').pop()}: not readable` })),
  addDatasetsGrouped: vi.fn(async (paths: string[]) => ({
    success: true, datasets: [{ id: 'sample', label: 'sample', path: paths[0], paths }],
  })),
}));
vi.mock('../api/reference', () => ({
  loadGtf: vi.fn(async (path: string) => (path.includes('bad') ? { success: false, message: 'bad GTF' } : { success: true })),
}));

import { useDragAndDrop } from './useDragAndDrop';
import { addDataset, addDatasetsGrouped } from '../api/datasets';
import { uploadFile } from '../api/files';
import { receiveNativeDrop, resetNativeDrop } from '../utils/nativeDrop';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function drop(...fileNames: string[]) {
  let hook: ReturnType<typeof useDragAndDrop> | null = null;
  function Host() { hook = useDragAndDrop(); return null; }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Host />));
  const event = {
    preventDefault: () => {},
    stopPropagation: () => {},
    dataTransfer: { files: fileNames.map(name => new File(['x'], name)) },
  } as unknown as React.DragEvent;
  await act(async () => { await hook!.handleDrop(event); });
  act(() => root.unmount());
}

describe('useDragAndDrop', () => {
  it('refreshes the view after a dropped GTF loads, so its genes show', async () => {
    const before = useBrowserStore.getState().refreshGeneration;
    await drop('genes.gtf');
    expect(useBrowserStore.getState().refreshGeneration).toBe(before + 1);
    expect(useBrowserStore.getState().error).toBeNull();
  });

  it('reports a GTF that fails to load, naming it', async () => {
    const before = useBrowserStore.getState().refreshGeneration;
    await drop('bad.gtf');
    expect(useBrowserStore.getState().refreshGeneration).toBe(before);
    expect(useBrowserStore.getState().error).toBe('bad.gtf: bad GTF');
  });

  it('dropped BigBed layer companions load together as one dataset', async () => {
    await drop('sample_footprint.bb', 'sample_tf.bb');
    expect(addDatasetsGrouped).toHaveBeenCalledTimes(1);
    expect((addDatasetsGrouped as any).mock.calls[0][0].sort()).toEqual(['/uploads/sample_footprint.bb', '/uploads/sample_tf.bb']);
    expect(addDataset).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().datasets.filter(d => d.id === 'sample')).toHaveLength(1);
  });

  it('a BAM dropped with its index opens; the index is neither uploaded nor an error', async () => {
    vi.mocked(uploadFile).mockClear();
    vi.mocked(addDataset).mockClear();
    useBrowserStore.setState({ error: null, datasets: [] });
    await drop('sampleA.bam.bai', 'sampleA.bam', 'sampleB.bai', 'sampleB.bam');
    expect(vi.mocked(uploadFile).mock.calls.map(c => (c[0] as File).name).sort()).toEqual(['sampleA.bam', 'sampleB.bam']);
    expect(vi.mocked(addDataset).mock.calls.map(c => c[0]).sort()).toEqual(['/uploads/sampleA.bam', '/uploads/sampleB.bam']);
    expect(useBrowserStore.getState().datasets.map(d => d.id).sort()).toEqual(['sampleA', 'sampleB']);
    expect(useBrowserStore.getState().error).toBeNull();
  });

  it('every file that cannot open is named with its reason; the rest still open', async () => {
    vi.mocked(uploadFile).mockClear();
    useBrowserStore.setState({ error: null, datasets: [] });
    await drop('lonely.bam.bai', 'reads.cram', 'bad.bam', 'broken.bam', 'good.bam');
    const error = useBrowserStore.getState().error ?? '';
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['good']);
    expect(error).toContain('lonely.bam.bai: this is a BAM index file');
    expect(error).toContain('Open lonely.bam instead');
    expect(error).toContain('reads.cram: CRAM files can');
    expect(error).toContain('bad.bam: not readable');
    expect(error).toContain('broken.bam: the upload failed (disk full)');
    // Neither the index nor the CRAM is uploaded.
    expect(vi.mocked(uploadFile).mock.calls.map(c => (c[0] as File).name).sort()).toEqual(['bad.bam', 'broken.bam', 'good.bam']);
  });

  it('in the desktop app, dropped files open from their real paths (no upload)', async () => {
    vi.mocked(uploadFile).mockClear();
    vi.mocked(addDataset).mockClear();
    useBrowserStore.setState({ error: null, datasets: [] });
    window.__fiberbrowserNativeDrop = true;
    try {
      // The app reports the drop (fiberbrowser/desktop.py -> native-drop) as the page handles it.
      setTimeout(() => receiveNativeDrop({ files: [
        { name: 'big.bam', path: '/data/run1/big.bam' }, { name: 'big.bam.bai', path: '/data/run1/big.bam.bai' },
      ] }), 20);
      await drop('big.bam', 'big.bam.bai');
      expect(uploadFile).not.toHaveBeenCalled();
      expect(vi.mocked(addDataset).mock.calls.map(c => c[0])).toEqual(['/data/run1/big.bam']);
      expect(useBrowserStore.getState().error).toBeNull();
    } finally {
      delete window.__fiberbrowserNativeDrop;
      resetNativeDrop();
    }
  });
});
