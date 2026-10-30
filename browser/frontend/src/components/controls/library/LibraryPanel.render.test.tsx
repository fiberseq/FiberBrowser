import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry, LibraryPayload } from '../../../api/library';
import { DEFAULT_FILTERS } from '../../../utils/library';
import { LibraryPanel } from './LibraryPanel';
import { useLibraryStore } from './libraryStore';

const openEntries = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/libraryOpen', () => ({ openLibraryEntries: openEntries }));
// Keep this a panel/layout test: fetching and rendering details has its own tests.
vi.mock('./LibraryDetails', () => ({
  LibraryDetails: ({ entry }: { entry: LibraryEntry }) => <div data-testid="details-entry">{entry.id}</div>,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const entries: LibraryEntry[] = ['a', 'b', 'c'].map(id => ({
  id, kind: 'bam', path: `/data/${id}.bam`, folder: '/data', label: `${id}.bam`,
  available: true, notes: '', tags: id === 'b' ? ['experiment', 'replicate', 'called'] : [],
  sample: id === 'b' ? 'A sample with a second line of row content' : null,
}));
const payload: LibraryPayload = {
  schema: 'library.v1', unreadable: false, advisories_available: false, platform: 'test',
  entries, groups: [], watched: [], scan: { running: null, queued: [], last_error: null },
  jobs: { imported: 0, available: false },
  library_file: '/data/library.json', fiberhmm_version: null, genomes_downloaded: [],
};

describe('Library pointer targets', () => {
  let container: HTMLDivElement;
  let root: Root;
  let initialState: ReturnType<typeof useLibraryStore.getState>;

  const query = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-entry-id="${id}"]`)!;

  beforeEach(() => {
    initialState = useLibraryStore.getState();
    useLibraryStore.setState({
      payload, selectedId: null, checked: [], filters: { ...DEFAULT_FILTERS },
      sort: { key: 'label', dir: 'asc' }, status: null, scanned: {},
      refresh: vi.fn(async () => payload),
    });
    openEntries.mockResolvedValue({ success: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<LibraryPanel onClose={() => {}} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useLibraryStore.setState(initialState, true);
    vi.clearAllMocks();
  });

  it('reserves the details width before the first selection so wrapped rows do not reflow under a double click', () => {
    // jsdom has no layout/hit testing. Guard the cause of reflow here rather
    // than inventing clientY-to-row geometry that the UI does not use.
    const details = query('library-details-slot');
    expect(details).not.toBeNull();
    expect(details!.classList.contains('w-[360px]')).toBe(true);
    expect(details!.classList.contains('shrink-0')).toBe(true);
    const table = query('library-table')!;
    const scroll = table.parentElement!;
    scroll.scrollTop = 120;
    const columns = Array.from(details!.parentElement!.children);
    const detailsClass = details!.className;

    act(() => row('b').querySelector<HTMLElement>('td:nth-child(2) span')!.click());
    expect(useLibraryStore.getState().selectedId).toBe('b');
    expect(query('details-entry')!.textContent).toBe('b');
    expect(query('library-details-slot')).toBe(details);
    expect(details!.className).toBe(detailsClass);
    expect(Array.from(details!.parentElement!.children)).toEqual(columns);
    expect(table.parentElement).toBe(scroll);
    expect(scroll.scrollTop).toBe(120);

    act(() => useLibraryStore.getState().select(null));
    expect(query('library-details-slot')).toBe(details);
    expect(query('details-entry')).toBeNull();
    expect(details!.className).toBe(detailsClass);
  });

  it('keeps bulk actions in place across checking and clearing so the table is not pushed down', () => {
    const bulk = query('library-bulk');
    expect(bulk).not.toBeNull();
    const table = query('library-table')!;
    const scroll = table.parentElement!;
    const siblings = Array.from(scroll.parentElement!.children);
    const bulkClass = bulk!.className;
    const open = query('library-open-selected') as HTMLButtonElement;
    const group = query('library-bulk-group') as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(group.disabled).toBe(true);
    expect([...bulk!.querySelectorAll('button')].every(button => button.disabled)).toBe(true);

    act(() => row('b').querySelector<HTMLInputElement>('input')!.click());
    expect(useLibraryStore.getState().checked).toEqual(['b']);
    expect(useLibraryStore.getState().selectedId).toBeNull();
    expect(query('library-bulk')).toBe(bulk);
    expect(bulk!.className).toBe(bulkClass);
    expect(Array.from(scroll.parentElement!.children)).toEqual(siblings);
    expect(open.disabled).toBe(false);
    expect(group.disabled).toBe(false);

    act(() => [...bulk!.querySelectorAll('button')].find(button => button.textContent === 'Clear')!.click());
    expect(useLibraryStore.getState().checked).toEqual([]);
    expect(query('library-bulk')).toBe(bulk);
    expect(Array.from(scroll.parentElement!.children)).toEqual(siblings);
    expect(open.disabled).toBe(true);
  });

  it('selects and opens the event target after sorting, including nested badges and different row content', async () => {
    act(() => useLibraryStore.getState().setSort({ key: 'label', dir: 'desc' }));
    expect([...container.querySelectorAll('[data-entry-id]')].map(el => el.getAttribute('data-entry-id'))).toEqual(['c', 'b', 'a']);
    const badge = row('b').querySelector<HTMLElement>('td:nth-child(2) span.inline-block')!;
    act(() => badge.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 210 })));
    expect(useLibraryStore.getState().selectedId).toBe('b');
    await act(async () => badge.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientY: 210 })));
    expect(openEntries).toHaveBeenCalledTimes(1);
    expect(openEntries.mock.calls[0][0]).toEqual([entries[1]]);
  });
});
