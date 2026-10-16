import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { LibraryEntry } from '../../../api/library';
import { useLibraryStore } from './libraryStore';
import { LibrarySidebarSection } from './LibraryHost';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Library sidebar (UI audit M26)', () => {
  it('says why a file needs a re-run, and what the Library lists', () => {
    const entry = {
      id: 'flyamp', kind: 'bam', path: '/d/flyamp.called.bam', folder: '/d', label: 'flyamp.called.bam',
      available: true, tags: [], notes: '', rerun: 'rerun-recommended',
      advisories: { key: 'k', fiberhmm_version: '3.0.0', items: [{ id: 'daf-dedup-orientation', severity: 'rerun-recommended', title: 'DAF duplicates grouped by alignment orientation' }] },
    } as LibraryEntry;
    useLibraryStore.setState({
      payload: { entries: [entry], groups: [], watched: [], scan: { running: false, queued: [] }, jobs: [] } as any,
      refresh: vi.fn(async () => {}) as any,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<LibrarySidebarSection />));
    const note = container.querySelector('[data-testid="library-sidebar-rerun-note"]');
    expect(note?.textContent).toContain('DAF duplicates grouped by alignment orientation');
    expect(container.textContent).toContain('1 needs re-run');
    act(() => root.unmount());
  });

  it('the scope text names what is not listed (the bundled demo)', async () => {
    const { LIBRARY_SCOPE_TEXT } = await import('../../../utils/library');
    expect(LIBRARY_SCOPE_TEXT).toContain('not the bundled demo');
  });
});
