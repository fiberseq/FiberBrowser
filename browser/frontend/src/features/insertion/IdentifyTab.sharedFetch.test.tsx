import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { IdentifyTab } from './IdentifyTab';
import { resetIdentifyStore } from './identifyStore';
import type { LensResponse } from './insertionLensModel';
import { INSERTION_LENS_PANEL } from './insertionLensTarget';

// The real fetchJson (api/sharedFetch: identical pending GETs are shared); only the network is stubbed.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

const response = {
  success: true, chrom: 'chr2L', flank: 1000,
  site: { pos: 9467038, tolerance: 30, len_min: 50, len_max: null },
  cluster: { ref: 9467038, len: 9183, len_lo: 9180, len_hi: 9190, carriers: 3267, reference: 10 },
  carriers: [], reference: [], excluded: { other_insert: 0, not_informative: 0 }, truncated: { carriers: 0, reference: 0 },
  consensus: { seq: 'ACGT'.repeat(50), length: 200, n_reads: 32, seconds: 1 },
} as unknown as LensResponse;

const library = (short: string, licence: string) => ({
  success: true, genome: null, active: null, genome_loaded: true, tools: { blastn: true, makeblastdb: true, minimap2: true },
  libraries: [{ id: short, label: short, short, source: 'x', homepage: 'https://example.org', licence, licence_url: 'https://example.org',
    citation: 'x', size_bytes: 829547, version: 'v1', installed: false }],
});
const HUMAN = library('Human TE library', 'HUMAN-LICENCE');
const FLY = library('D. melanogaster TE library', 'FLY-LICENCE');

describe('Identify: a declaration while the TE-library request is pending (real shared fetch)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const pending: Array<{ url: string; resolve: (body: unknown) => void }> = [];

  beforeEach(() => {
    pending.length = 0;
    resetIdentifyStore();
    useBrowserStore.setState({ panels: [{ id: 'p-ins', contentType: INSERTION_LENS_PANEL } as never], referenceRevision: 0 });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => new Promise<Response>(resolve => {
      const url = String(input);
      pending.push({ url, resolve: body => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) });
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('makes a second HTTP request and shows only the new library', async () => {
    const libraryRequests = () => pending.filter(p => p.url.includes('/api/insertions/te_library'));
    await act(async () => root.render(<IdentifyTab response={response} datasetId="ds1" genome="alt-ref" reversed visible dark={false} />));
    await wait(0);
    expect(libraryRequests()).toHaveLength(1);
    await act(async () => { useBrowserStore.getState().bumpReferenceRevision(); });   // declared dm6 meanwhile
    await wait(0);
    expect(libraryRequests()).toHaveLength(2);                                      // a new HTTP request, not the pending one
    expect(libraryRequests()[0].url).not.toBe(libraryRequests()[1].url);
    const line = () => container.querySelector('[data-testid="identify-library-auto"]');
    await act(async () => { libraryRequests()[0].resolve(HUMAN); });                // the pre-declaration reply
    await wait(0);
    expect(line()).toBeNull();
    await act(async () => { libraryRequests()[1].resolve(FLY); });
    await wait(0);
    expect(line()!.textContent).toContain('FLY-LICENCE');
    expect(container.textContent).not.toContain('HUMAN-LICENCE');
  });
});
