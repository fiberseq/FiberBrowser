import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentGenome, RecentGenomesListing } from '../../../../api/recentGenomes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now() / 1000;
const entry = (over: Partial<RecentGenome>): RecentGenome => ({
  key: '/data/custom.fa', kind: 'fasta', genome_id: null, assembly: null, name: null, fasta: '/data/custom.fa',
  fasta_name: 'custom.fa', gtf: '/data/custom.gtf', gtf_name: 'custom.gtf', gtf_exists: true, exists: true, cached: null,
  last_used: now - 120, pinned: false, ...over,
});
let listing: RecentGenomesListing;
const api = vi.hoisted(() => ({
  getRecentGenomes: vi.fn(), openRecentGenome: vi.fn(), removeRecentGenome: vi.fn(), clearRecentGenomes: vi.fn(),
  pinRecentGenome: vi.fn(), reorderPinnedGenomes: vi.fn(),
}));
vi.mock('../../../../api/recentGenomes', () => api);
const prefs = vi.hoisted(() => ({ value: { recent_genomes_autoswitch: false } as Record<string, unknown>, puts: [] as unknown[] }));
const status = vi.hoisted(() => ({ value: { startup_reference: false } as Record<string, unknown> }));
vi.mock('../../../../api/sharedFetch', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/sharedFetch')>('../../../../api/sharedFetch');
  return {
    ...actual,
    fetchJson: vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/preferences/analysis')) {
        if (init?.method === 'PUT') prefs.puts.push(JSON.parse(String(init.body)));
        return prefs.value;
      }
      throw new Error(`unexpected ${url}`);
    }),
  };
});
vi.mock('../../../../api/status', () => ({ getStatus: vi.fn(async () => status.value) }));
vi.mock('../../../../api/reference', () => ({ getChromosomes: vi.fn(async () => ({ chroms: [{ name: 'chr2L', size: 23513712 }] })) }));
vi.mock('../../../../hooks/useAutoSave', () => ({ autoSaveNow: vi.fn(async () => undefined) }));
vi.mock('../../../../stores/genomeCheckStore', async () => {
  const actual = await vi.importActual<typeof import('../../../../stores/genomeCheckStore')>('../../../../stores/genomeCheckStore');
  actual.useGenomeCheckStore.setState({ refresh: vi.fn(async () => undefined) } as never);
  return actual;
});

import { RecentGenomes } from './RecentGenomes';
import { useBrowserStore } from '../../../../stores/browserStore';
import { useRecentGenomesStore } from '../../../../stores/recentGenomesStore';
import { useReferenceNoticeStore } from '../../../../stores/referenceNoticeStore';

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); });

describe('Recent genomes (Reference & Tracks)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    listing = {
      max: 8,
      pinned: [entry({ key: '/p/a.fa', fasta: '/p/a.fa', fasta_name: 'a.fa', assembly: 'dm6', pinned: true, gtf: null, gtf_name: null }),
        entry({ key: '/p/gone.fa', fasta: '/p/gone.fa', fasta_name: 'gone.fa', pinned: true, exists: false })],
      recent: [entry({}), entry({ key: 'registry:sacCer3', kind: 'registry', genome_id: 'sacCer3', name: 'S. cerevisiae (sacCer3)',
        fasta: null, fasta_name: null, gtf: null, gtf_name: null, cached: true })],
    };
    for (const fn of Object.values(api)) fn.mockReset();
    api.getRecentGenomes.mockImplementation(async () => listing);
    for (const fn of [api.removeRecentGenome, api.clearRecentGenomes, api.pinRecentGenome, api.reorderPinnedGenomes]) {
      fn.mockImplementation(async () => listing);
    }
    api.openRecentGenome.mockResolvedValue({ success: true, fasta_loaded: true, gtf_loaded: true, fasta_path: '/data/custom.fa', genome_id: null });
    prefs.puts.length = 0;
    useRecentGenomesStore.setState({ pinned: [], recent: [], loaded: false, opening: null, error: null });
    useBrowserStore.setState({ currentGenome: 'dm6', fastaPath: null, hasFasta: true } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const rows = (kind: 'pinned' | 'recent') => [...container.querySelectorAll(`[data-testid="recent-genome-${kind}"]`)] as HTMLElement[];

  it('lists Pinned above Recent, with name or assembly, files, annotation and when; missing files greyed with Remove', async () => {
    act(() => root.render(<RecentGenomes />));
    await flush();
    expect(rows('pinned').map(r => r.dataset.key)).toEqual(['/p/a.fa', '/p/gone.fa']);
    expect(rows('recent').map(r => r.dataset.key)).toEqual(['/data/custom.fa', 'registry:sacCer3']);
    expect(rows('pinned')[0].textContent).toContain('dm6');
    expect(rows('pinned')[0].textContent).toContain('a.fa');
    expect(rows('recent')[0].textContent).toContain('custom.fa + custom.gtf');
    expect(rows('recent')[0].textContent).toContain('2m ago');
    expect(rows('recent')[0].querySelector('[data-testid="recent-genome-open"]')!.getAttribute('title')).toContain('/data/custom.fa');
    const gone = rows('pinned')[1];
    expect(gone.dataset.missing).toBe('true');
    expect(gone.textContent).toContain('file not found');
    expect((gone.querySelector('[data-testid="recent-genome-open"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { (gone.querySelector('[data-testid="recent-genome-remove"]') as HTMLButtonElement).click(); });
    expect(api.removeRecentGenome).toHaveBeenCalledWith('/p/gone.fa');
  });

  it('a click loads it in one step and marks the reference as the user\'s; pin, unpin and Clear recent', async () => {
    act(() => root.render(<RecentGenomes />));
    await flush();
    await act(async () => { (rows('recent')[0].querySelector('[data-testid="recent-genome-open"]') as HTMLButtonElement).click(); });
    await flush();
    expect(api.openRecentGenome).toHaveBeenCalledWith('/data/custom.fa');
    expect(useBrowserStore.getState().fastaPath).toBe('/data/custom.fa');
    expect(useReferenceNoticeStore.getState().userChose).toBe(true);
    await act(async () => { (rows('recent')[0].querySelector('[data-testid="recent-genome-pin"]') as HTMLButtonElement).click(); });
    expect(api.pinRecentGenome).toHaveBeenCalledWith('/data/custom.fa', true);
    await act(async () => { (rows('pinned')[0].querySelector('[data-testid="recent-genome-pin"]') as HTMLButtonElement).click(); });
    expect(api.pinRecentGenome).toHaveBeenCalledWith('/p/a.fa', false);
    await act(async () => { (container.querySelector('[data-testid="recent-genomes-clear"]') as HTMLButtonElement).click(); });
    expect(api.clearRecentGenomes).toHaveBeenCalled();
  });

  it('a missing file reported on open is said, never asked for', async () => {
    api.openRecentGenome.mockResolvedValue({ success: false, missing: true, error: 'File not found: /data/custom.fa' });
    act(() => root.render(<RecentGenomes />));
    await flush();
    await act(async () => { (rows('recent')[0].querySelector('[data-testid="recent-genome-open"]') as HTMLButtonElement).click(); });
    await flush();
    expect(container.textContent).toContain('File not found');
  });

  it('offer only: no start-up switch setting, and nothing switches on its own (owner decision, 20 Nov)', async () => {
    prefs.value = { recent_genomes_autoswitch: true };   // an old saved setting: ignored
    act(() => root.render(<RecentGenomes />));
    await flush();
    expect(container.querySelector('[data-testid="recent-genomes-autoswitch"]')).toBeNull();
    expect(container.textContent).not.toContain('at start-up');
    expect(api.openRecentGenome).not.toHaveBeenCalled();
  });
});

