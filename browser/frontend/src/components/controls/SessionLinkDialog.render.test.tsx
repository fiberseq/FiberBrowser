import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';

vi.mock('../../api/sessionLinks', () => ({
  stageLink: vi.fn(async () => ({ success: true, id: 'staged-id-123456' })),
  previewLink: vi.fn(),
  openLink: vi.fn(),
  discardLink: vi.fn(async () => ({ success: true })),
  linkStatus: vi.fn(async () => ({ links: [], expired: [], expiring_soon: [] })),
}));
vi.mock('../../utils/referenceNavigation', () => ({ showLoadedReference: vi.fn(async () => undefined) }));

import { discardLink, openLink, previewLink, stageLink } from '../../api/sessionLinks';
import { SessionLinkHost } from './SessionLinkDialog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIEW = {
  success: true,
  id: 'abcdefgh12345678',
  source: { kind: 'session', host: 'data.example.org', url: 'https://data.example.org/s.json' },
  title: 'Donor A',
  genome: { kind: 'catalog', id: 'hg38', label: 'hg38' },
  locus: { text: 'chr7:100-200', chrom: 'chr7', start: 100, end: 200 },
  tracks: [
    { index: 0, name: 'Sample 1', type: 'bam', as: 'reads', host: 'data.example.org', url: 'https://data.example.org/s1.bam',
      size: 2_500_000_000, sample: 'S1', group: 'Donor A', color: '#ff0000', visible: true, signed: true, problem: null },
    { index: 1, name: 'Coverage', type: 'bigwig', as: 'signal', host: 'data.example.org', url: 'https://data.example.org/c.bw',
      size: null, sample: null, group: null, color: null, visible: true, signed: false, problem: null },
    { index: 2, name: 'Hidden', type: 'bigbed', as: 'annotation', host: 'data.example.org', url: 'https://data.example.org/h.bb',
      size: null, sample: null, group: null, color: null, visible: false, signed: false, problem: null },
  ],
  hosts: ['data.example.org'],
  warnings: ['Some files use pre-signed links.'],
  max_tracks: 100,
};

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('SessionLinkHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(previewLink).mockReset();
    vi.mocked(openLink).mockReset();
    vi.mocked(stageLink).mockClear();
    vi.mocked(discardLink).mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, '', '/?open_link=abcdefgh12345678&x=1');
    useBrowserStore.setState({ datasets: [], catalog: [], compositeTracks: [] } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('asks before loading anything and opens only the ticked tracks', async () => {
    vi.mocked(previewLink).mockResolvedValue(PREVIEW as any);
    vi.mocked(openLink).mockResolvedValue({
      success: true, opened: 1, datasets: [], tracks: [{ track_index: 0, label: 'Coverage', url: 'https://data.example.org/c.bw',
        kind: 'bigwig', render_mode: 'signal', color: null, group: null, sample: null }],
      errors: [], warnings: [], locus: PREVIEW.locus,
    } as any);
    await act(async () => {
      root.render(<SessionLinkHost request={{ kind: 'pending', id: 'abcdefgh12345678' }} />);
      await flush();
    });
    // The link left the address bar.
    expect(window.location.search).toBe('?x=1');
    const dialog = document.querySelector('[data-testid="session-link-dialog"]')!;
    expect(dialog.textContent).toContain('Open 2 tracks from data.example.org?');
    expect(dialog.textContent).toContain('hg38');
    expect(dialog.textContent).toContain('2.3 GB');
    expect(dialog.textContent).toContain('signed link');
    expect(openLink).not.toHaveBeenCalled();

    // Untick the BAM: one track left.
    const boxes = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...boxes].map(b => b.checked)).toEqual([true, true, false]);
    await act(async () => { boxes[0].click(); await flush(); });
    expect(dialog.textContent).toContain('Open 1 track from data.example.org?');

    await act(async () => {
      (document.querySelector('[data-testid="session-link-open"]') as HTMLButtonElement).click();
      await flush();
    });
    expect(openLink).toHaveBeenCalledWith('abcdefgh12345678', [1]);
    const store = useBrowserStore.getState();
    expect(store.catalog.map(c => c.url)).toEqual(['https://data.example.org/c.bw']);
    expect(store.chrom).toBe('chr7');
    expect(document.querySelector('[data-testid="session-link-dialog"]')).toBeNull();
  });

  it('cancel discards the pending link and loads nothing', async () => {
    vi.mocked(previewLink).mockResolvedValue(PREVIEW as any);
    await act(async () => {
      root.render(<SessionLinkHost request={{ kind: 'pending', id: 'abcdefgh12345678' }} />);
      await flush();
    });
    await act(async () => {
      (document.querySelector('[data-testid="session-link-cancel"]') as HTMLButtonElement).click();
      await flush();
    });
    expect(discardLink).toHaveBeenCalledWith('abcdefgh12345678');
    expect(openLink).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="session-link-dialog"]')).toBeNull();
  });

  it('asks before fetching a link on the local network', async () => {
    vi.mocked(previewLink)
      .mockResolvedValueOnce({ success: true, id: 'abcdefgh12345678', needs_fetch_confirmation: true,
        reason: 'lab.local points at a private or local-network address.',
        source: { kind: 'session', host: 'lab.local', url: 'http://lab.local/s.json' } } as any)
      .mockResolvedValueOnce(PREVIEW as any);
    await act(async () => {
      root.render(<SessionLinkHost request={{ kind: 'session', value: 'http://lab.local/s.json', genome: null }} />);
      await flush();
    });
    expect(stageLink).toHaveBeenCalledWith({ session: 'http://lab.local/s.json', genome: null });
    expect(document.body.textContent).toContain('has not contacted it yet');
    await act(async () => {
      (document.querySelector('[data-testid="session-link-fetch"]') as HTMLButtonElement).click();
      await flush();
    });
    expect(previewLink).toHaveBeenLastCalledWith('staged-id-123456', true);
    expect(document.body.textContent).toContain('Open 2 tracks');
  });

  it('shows why a link cannot be opened', async () => {
    vi.mocked(previewLink).mockResolvedValue({ success: false, id: 'x', source: { kind: 'session', host: null, url: null },
      error: 'This link has expired or was already opened. Open it again from its source.' } as any);
    await act(async () => {
      root.render(<SessionLinkHost request={{ kind: 'pending', id: 'abcdefgh12345678' }} />);
      await flush();
    });
    expect(document.querySelector('[data-testid="session-link-error"]')!.textContent).toContain('already opened');
  });
});

describe('SessionLinkHost with cluster files', () => {
  it('offers Connect to cluster and reviews again once connected; never connects itself', async () => {
    const { useConnectClusterStore } = await import('../../utils/connectCluster');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const clusterTrack = { index: 0, name: 'On the cluster', type: 'bam', as: 'reads', host: 'cluster.example.org',
      url: 'ssh://me@cluster.example.org/data/s1.bam', size: null, sample: null, group: null, color: null,
      visible: false, signed: false, cluster: 'me@cluster.example.org',
      problem: 'On the cluster me@cluster.example.org: FiberBrowser never connects from a link.' };
    vi.mocked(previewLink).mockReset();
    vi.mocked(previewLink)
      .mockResolvedValueOnce({ ...PREVIEW, tracks: [clusterTrack] } as any)
      .mockResolvedValueOnce({ ...PREVIEW, tracks: [{ ...clusterTrack, problem: null, visible: true }] } as any);
    await act(async () => {
      root.render(<SessionLinkHost request={{ kind: 'pending', id: 'abcdefgh12345678' }} />);
      await flush();
    });
    expect(useConnectClusterStore.getState().open).toBe(false);
    await act(async () => {
      (document.querySelector('[data-testid="session-link-connect"]') as HTMLButtonElement).click();
      await flush();
    });
    const store = useConnectClusterStore.getState();
    expect(store.open).toBe(true);
    expect(store.prefill).toMatchObject({ host: 'cluster.example.org', user: 'me' });
    expect(previewLink).toHaveBeenCalledTimes(1);
    await act(async () => { useConnectClusterStore.getState().close(true); await flush(); });
    expect(previewLink).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Open 1 track from cluster.example.org?');
    act(() => root.unmount());
    container.remove();
  });
});
