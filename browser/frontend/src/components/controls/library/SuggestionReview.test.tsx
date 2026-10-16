import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderScanFile, FolderScanPreview, LibraryEntry, LibraryPayload } from '../../../api/library';
import { suggestedGroups } from '../../../utils/library';
import { kindCounts, leftOutText, openNeedsConfirmation, scanScopeText } from '../../../utils/libraryFolderScan';

const api = vi.hoisted(() => ({
  preview: vi.fn(), add: vi.fn(), createGroup: vi.fn(), getLibrary: vi.fn(), watch: vi.fn(), openEntries: vi.fn(),
}));
vi.mock('../../../api/library', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/library')>()),
  previewLibraryFolder: api.preview, addLibraryFolderFiles: api.add, createLibraryGroup: api.createGroup,
  getLibrary: api.getLibrary, addWatchedFolder: api.watch,
}));
vi.mock('../../../utils/libraryOpen', () => ({ openLibraryEntries: api.openEntries }));
vi.mock('../../../api/files', () => ({ pickDataset: vi.fn(), pickFolder: vi.fn(), pickAnyFile: vi.fn() }));

import { LibraryPanel } from './LibraryPanel';
import { useLibraryStore } from './libraryStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FOLDER = '/data/exp1';

const entry = (id: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id, kind: 'bam', path: `${FOLDER}/${id}.fiberhmm.bam`, folder: FOLDER, label: `${id}.fiberhmm.bam`,
  available: true, tags: [], notes: '', ...extra,
});

const payloadWith = (entries: LibraryEntry[], groups: LibraryPayload['groups'] = []): LibraryPayload => ({
  schema: 'fiberbrowser.library.v1', library_file: '/home/u/.fiberhmm/library.json', unreadable: false,
  entries, groups, watched: [], scan: { running: null, queued: [], last_error: null },
  jobs: { imported: 0, available: true }, fiberhmm_version: '3.0.0', genomes_downloaded: [],
  advisories_available: false, platform: 'darwin',
});

const file = (name: string, extra: Partial<FolderScanFile> = {}): FolderScanFile => ({
  path: `${FOLDER}/${name}`, name, kind: name.endsWith('.bb') ? 'bigbed' : name.endsWith('.gb') ? 'plasmid_map' : 'bam',
  size: 1000, cloud_only: false, entry_id: null, ...extra,
});

const previewOf = (files: FolderScanFile[], extra: Partial<FolderScanPreview> = {}): FolderScanPreview => ({
  success: true, folder: FOLDER, mode: 'folder', subdirs: ['calls', 'tracks'], max_depth: 1, files,
  kinds: {}, new: files.filter(f => !f.entry_id).length, cloud_only: files.filter(f => f.cloud_only).length,
  left_out: { aligned: 1, no_index: 0, outside: 0, other_files: 3, skipped_dirs: 1, big_dirs: 0, unreadable: 0 },
  truncated: null, watched: false, ...extra,
});

const added = (ids: string[]) => ({
  success: true, ids, added: ids.length - 2, updated: 0, relocated: 0, unchanged: 2, aligned: 0,
  not_found: [], errors: [], truncated: null,
});

describe('Suggested experiments: scan the folder before Open / Save as group', () => {
  let container: HTMLDivElement;
  let root: Root;
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const listed = [entry('a'), entry('b')];
    useLibraryStore.setState({ payload: payloadWith(listed), status: null, selectedId: null, checked: [], scanned: {} });
    api.getLibrary.mockImplementation(async () => useLibraryStore.getState().payload);
    await act(async () => root.render(<LibraryPanel onClose={() => {}} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  it('scans, shows what it found, lets the user untick, and saves the full set as a group', async () => {
    expect(q('library-suggestion-count')!.textContent).toBe('(2)');  // the listed entries, until scanned
    const files = [
      file('a.fiberhmm.bam', { entry_id: 'a' }), file('b.fiberhmm.bam', { entry_id: 'b' }),
      file('c.fiberhmm.bam'), file('d.fiberhmm.bam', { cloud_only: true, size: 0 }), file('tracks/a.bb'), file('pX.gb'),
    ];
    api.preview.mockResolvedValue(previewOf(files));
    await click(q('library-save-suggestion'));
    expect(api.preview).toHaveBeenCalledWith(FOLDER, 'folder');
    expect(api.add).not.toHaveBeenCalled();
    expect(q('library-suggestion-scope')!.textContent).toContain('tracks/ sub-folders');
    expect(q('library-suggestion-summary')!.textContent).toBe(
      'Found 6 files: 4 BAMs · 1 BigBed · 1 plasmid map — 4 new to the Library, 1 online-only.');
    expect(q('library-suggestion-left-out')!.textContent).toContain('1 aligned-only BAM');
    const rows = [...container.querySelectorAll('[data-testid="library-suggestion-file"]')];
    expect(rows.map(r => r.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('online-only'), expect.stringContaining('listed'), expect.stringContaining('new'),
    ]));
    expect(rows).toHaveLength(6);

    // Untick c, then save: every kept file is added and the group is the full set.
    await click(rows[2].querySelector('input'));
    expect(q('library-suggestion-run')!.textContent).toBe('Save group of 5');
    api.add.mockResolvedValue(added(['a', 'b', 'd', 'bb', 'map']));
    api.createGroup.mockResolvedValue({ success: true, group: { id: 'g1', name: 'data/exp1', entry_ids: [] } });
    const full = [entry('a'), entry('b'), entry('d', { cloud_only: true }), entry('bb', { kind: 'bigbed', folder: `${FOLDER}/tracks` }),
      entry('map', { kind: 'plasmid_map' })];
    api.getLibrary.mockResolvedValue(payloadWith(full));
    await click(q('library-suggestion-run'));
    expect(api.add).toHaveBeenCalledWith(FOLDER, [
      `${FOLDER}/a.fiberhmm.bam`, `${FOLDER}/b.fiberhmm.bam`, `${FOLDER}/d.fiberhmm.bam`, `${FOLDER}/tracks/a.bb`, `${FOLDER}/pX.gb`,
    ], 'folder');
    expect(api.createGroup).toHaveBeenCalledWith('data/exp1', ['a', 'b', 'd', 'bb', 'map'], FOLDER);
    expect(q('library-suggestion-review')).toBeNull();
    expect(q('library-status')!.textContent).toContain('Saved group data/exp1 with 5 files (3 new to the Library)');
  });

  it('updates the suggestion after a scan (the full set; saved groups hide it)', () => {
    const entries = [entry('a'), entry('b'), entry('bb', { kind: 'bigbed', folder: `${FOLDER}/tracks` })];
    const [before] = suggestedGroups(entries);
    expect(before).toMatchObject({ entryIds: ['a', 'b'], folder: FOLDER, scanned: false });
    const [after] = suggestedGroups(entries, [], { [FOLDER]: ['a', 'b', 'bb', 'gone'] });
    expect(after).toMatchObject({ entryIds: ['a', 'b', 'bb'], scanned: true });
    expect(suggestedGroups(entries, [{ id: 'g', name: 'x', entry_ids: ['bb', 'a', 'b'] }], { [FOLDER]: ['a', 'b', 'bb'] })
      .filter(s => s.source === 'folder')).toEqual([]);
  });

  it('asks before opening many files, then opens the full set', async () => {
    const files = Array.from({ length: 14 }, (_, i) => file(`s${i}.fiberhmm.bam`, i < 2 ? { entry_id: i ? 'b' : 'a' } : {}));
    api.preview.mockResolvedValue(previewOf(files));
    await click(q('library-open-suggestion'));
    await click(q('library-suggestion-run'));
    expect(q('library-suggestion-confirm')!.textContent).toContain('Open all 14 files (14 BAMs) at once?');
    expect(api.add).not.toHaveBeenCalled();
    expect(api.openEntries).not.toHaveBeenCalled();

    const ids = files.map((_, i) => `s${i}`);
    api.add.mockResolvedValue(added(ids));
    const full = ids.map(id => entry(id));
    api.getLibrary.mockResolvedValue(payloadWith(full));
    api.openEntries.mockResolvedValue({ success: true, message: 'Opened 14 files.' });
    await click(q('library-suggestion-confirm-open'));
    expect(api.add).toHaveBeenCalledWith(FOLDER, files.map(f => f.path), 'folder');
    expect(api.openEntries).toHaveBeenCalledTimes(1);
    const [opened, all] = api.openEntries.mock.calls[0];
    expect(opened.map((e: LibraryEntry) => e.id)).toEqual(ids);
    expect(all).toHaveLength(14);  // the refreshed Library: new entries' linked maps are known
    expect(q('library-suggestion-review')).toBeNull();
    expect(useLibraryStore.getState().scanned).toEqual({ [FOLDER]: ids });  // survives the window closing
  });

  it('opens a small set without asking', async () => {
    api.preview.mockResolvedValue(previewOf([file('a.fiberhmm.bam', { entry_id: 'a' }), file('c.fiberhmm.bam')]));
    await click(q('library-open-suggestion'));
    api.add.mockResolvedValue({ ...added(['a', 'c']), added: 1, unchanged: 1 });
    api.getLibrary.mockResolvedValue(payloadWith([entry('a'), entry('b'), entry('c')]));
    api.openEntries.mockResolvedValue({ success: true });
    await click(q('library-suggestion-run'));
    expect(q('library-suggestion-confirm')).toBeNull();
    expect(api.openEntries.mock.calls[0][0].map((e: LibraryEntry) => e.id)).toEqual(['a', 'c']);
  });

  it('shows a vanished folder inline, and can widen the scan or watch the folder', async () => {
    api.preview.mockResolvedValueOnce({ success: false, error: 'This folder no longer exists: /data/exp1', folder: FOLDER });
    await click(q('library-save-suggestion'));
    expect(q('library-suggestion-error')!.textContent).toBe('This folder no longer exists: /data/exp1');
    expect(q('library-suggestion-run')).toBeNull();

    api.preview.mockResolvedValueOnce(previewOf([file('a.fiberhmm.bam')], { mode: 'deep', subdirs: null, max_depth: 6 }));
    await click(q('library-suggestion-mode'));
    expect(api.preview).toHaveBeenLastCalledWith(FOLDER, 'deep');
    expect(q('library-suggestion-scope')!.textContent).toContain('6 levels down');
    api.watch.mockResolvedValue({ success: true, watched: { id: 'w1', path: FOLDER, max_depth: 6 } });
    await click(q('library-suggestion-watch'));
    expect(api.watch).toHaveBeenCalledWith(FOLDER);
    expect(q('library-suggestion-watch-note')!.textContent).toContain('Watching this folder');
  });

  it('a cancelled review ignores its late add answer (nothing opened or saved)', async () => {
    api.preview.mockResolvedValue(previewOf([file('a.fiberhmm.bam', { entry_id: 'a' }), file('c.fiberhmm.bam')]));
    await click(q('library-open-suggestion'));
    let answer!: (value: unknown) => void;
    api.add.mockImplementationOnce(() => new Promise(r => { answer = r; }));
    await click(q('library-suggestion-run'));
    await click(container.querySelector('[data-testid="library-suggestion-review"] [aria-label="Cancel"]'));
    expect(q('library-suggestion-review')).toBeNull();
    await act(async () => answer(added(['a', 'c'])));
    expect(api.openEntries).not.toHaveBeenCalled();
    expect(api.createGroup).not.toHaveBeenCalled();
    expect(q('library-suggestion-count')!.textContent).toBe('(2)');  // not marked scanned
  });

  it('shows a folder that vanished before Add inline', async () => {
    api.preview.mockResolvedValue(previewOf([file('c.fiberhmm.bam')]));
    await click(q('library-save-suggestion'));
    api.add.mockResolvedValue({ success: false, error: 'This folder no longer exists: /data/exp1', folder: FOLDER });
    await click(q('library-suggestion-run'));
    expect(q('library-suggestion-error')!.textContent).toBe('This folder no longer exists: /data/exp1');
    expect(api.createGroup).not.toHaveBeenCalled();
  });

  it('keeps a DAF-seq run suggestion as it was (no scan)', async () => {
    const run = (id: string) => entry(id, { folder: `/runs/${id}`, pipeline: { outdir: `/runs/${id}` } as LibraryEntry['pipeline'],
      job: { id: `j${id}`, group: 'batch1', finished_at: 1_790_000_000 } as LibraryEntry['job'] });
    act(() => useLibraryStore.setState({ payload: payloadWith([run('r1'), run('r2')]) }));
    api.createGroup.mockResolvedValue({ success: true, group: { id: 'g', name: 'run', entry_ids: ['r1', 'r2'] } });
    await click(q('library-save-suggestion'));
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.createGroup).toHaveBeenCalledWith(expect.stringMatching(/^DAF-seq run/), ['r1', 'r2'], 'r1.fiberhmm.bam, r2.fiberhmm.bam');
  });
});

describe('folder scan wording', () => {
  it('counts kinds and says what was scanned and left out', () => {
    expect(kindCounts([file('a.bam'), file('b.bam'), file('t.bb')])).toBe('2 BAMs · 1 BigBed');
    expect(scanScopeText({ mode: 'folder', subdirs: ['calls', 'tracks'], max_depth: 1 }))
      .toBe('This folder and its calls/ and tracks/ sub-folders (where FiberHMM runs write their outputs); not other sub-folders.');
    expect(leftOutText({ mode: 'folder', left_out: { aligned: 0, no_index: 0, outside: 0, other_files: 0, skipped_dirs: 0, big_dirs: 0, unreadable: 0 } })).toBe('');
    expect(leftOutText({ mode: 'folder', left_out: { aligned: 2, no_index: 1, outside: 0, other_files: 4, skipped_dirs: 1, big_dirs: 1, unreadable: 0 } }))
      .toBe('Left out: 2 aligned-only BAMs (uncalled pipeline intermediates); 1 BAM without an index (.bai/.csi); '
        + '1 folder with over 20,000 entries; 1 other sub-folder; 4 non-dataset files (indexes, QC, logs…).');
  });

  it('asks before opening more than 12 BAMs or 24 files', () => {
    const bams = (n: number) => Array.from({ length: n }, () => ({ kind: 'bam' as const }));
    expect(openNeedsConfirmation(bams(12))).toBe(false);
    expect(openNeedsConfirmation(bams(13))).toBe(true);
    expect(openNeedsConfirmation([...bams(2), ...Array.from({ length: 23 }, () => ({ kind: 'bigbed' as const }))])).toBe(true);
  });
});
