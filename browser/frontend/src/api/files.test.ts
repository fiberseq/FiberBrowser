import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ local: true, chosen: ['/srv/data/a.bam'] as string[] | null }));
vi.mock('../utils/serverFileBrowser', () => ({
  isLocalPage: () => bridge.local,
  chooseServerPaths: vi.fn(async () => bridge.chosen),
}));

import { pickAnyFile, pickFilesToOpen } from './files';
import { chooseServerPaths } from '../utils/serverFileBrowser';

function mockPicker(response: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as Response));
}

describe('file picking', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(chooseServerPaths).mockClear();
  });

  it('uses the native dialog on a local page', async () => {
    bridge.local = true;
    mockPicker({ success: true, path: '/x.bam', paths: ['/x.bam'] });
    expect((await pickAnyFile()).paths).toEqual(['/x.bam']);
    expect(chooseServerPaths).not.toHaveBeenCalled();
  });

  it('respects a cancelled native dialog', async () => {
    bridge.local = true;
    mockPicker({ success: false, cancelled: true, path: null, message: 'No file selected' });
    expect((await pickAnyFile()).success).toBe(false);
    expect(chooseServerPaths).not.toHaveBeenCalled();
  });

  it('does not mistake a dialog that could not open for a cancel', async () => {
    bridge.local = true;
    mockPicker({ success: false, cancelled: false, path: null, message: 'File dialog could not open: cannot open display' });
    expect((await pickAnyFile()).paths).toEqual(['/srv/data/a.bam']);
  });

  it('asks the server to scan a BLAST folder chosen in the page', async () => {
    bridge.local = false;
    bridge.chosen = ['/srv/blast'];
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, path: '/srv/blast/hg38' }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { pickFilePrimer } = await import('./primers');
    expect((await pickFilePrimer('blast')).path).toBe('/srv/blast/hg38');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('dir=%2Fsrv%2Fblast');
    bridge.chosen = ['/srv/data/a.bam'];
  });

  it('falls back to the in-page browser when the native dialog fails', async () => {
    bridge.local = true;
    mockPicker({ success: false, path: null, message: 'no display name and no $DISPLAY' });
    expect((await pickAnyFile()).paths).toEqual(['/srv/data/a.bam']);
  });

  it('always uses the in-page browser from another machine', async () => {
    bridge.local = false;
    mockPicker({ success: true, path: '/wrong-screen.bam' });
    expect((await pickAnyFile()).paths).toEqual(['/srv/data/a.bam']);
  });

  it('Load File in the desktop app opens the app\'s own dialog with the shared filters', async () => {
    bridge.local = true;
    const pick = vi.fn(async () => ({ success: true, path: '/d/a.bam', paths: ['/d/a.bam', '/d/a.bam.bai'] }));
    (window as any).pywebview = { api: { pick_files: pick } };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect((await pickFilesToOpen()).paths).toEqual(['/d/a.bam', '/d/a.bam.bai']);
      expect(pick).toHaveBeenCalledWith('open', true);
      expect(fetchMock).not.toHaveBeenCalled();
      // A cancel in the app's dialog is a cancel (no other dialog follows).
      pick.mockResolvedValueOnce({ success: false, cancelled: true, path: null, paths: [] } as any);
      expect((await pickFilesToOpen()).success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      // The app's dialog failing: the server's dialog instead.
      pick.mockRejectedValueOnce(new Error('no window'));
      mockPicker({ success: true, path: '/x.bam', paths: ['/x.bam'] });
      expect((await pickFilesToOpen()).paths).toEqual(['/x.bam']);
      // Pickers for any file (run inputs: FASTQ, zips...) stay unfiltered, on the server's dialog.
      pick.mockClear();
      mockPicker({ success: true, path: '/r.fastq.gz', paths: ['/r.fastq.gz'] });
      expect((await pickAnyFile()).paths).toEqual(['/r.fastq.gz']);
      expect(pick).not.toHaveBeenCalled();
    } finally {
      delete (window as any).pywebview;
    }
  });

  it('the in-page browser gets the file-type filters for Load File, none for any file', async () => {
    bridge.local = false;
    await pickAnyFile();
    expect(vi.mocked(chooseServerPaths).mock.calls[0][0].filters).toBeUndefined();
    vi.mocked(chooseServerPaths).mockClear();
    await pickFilesToOpen();
    const options = vi.mocked(chooseServerPaths).mock.calls[0][0];
    expect(options.filters?.[0].label).toBe('Supported files');
    expect(options.filters?.at(-1)).toEqual({ label: 'All files', suffixes: [] });
  });
});
