import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { showLoadedReference } from './referenceNavigation';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('showLoadedReference', () => {
  it('lists the new contigs and moves off a chromosome the reference lacks', async () => {
    useBrowserStore.setState({ chrom: 'chr2L', start: 100, end: 200, chroms: [{ name: 'chr2L', size: 1000 }] } as never);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ chroms: [{ name: 'contigA', size: 50000 }, { name: 'contigB', size: 10 }] })));
    const before = useBrowserStore.getState().refreshGeneration;
    await showLoadedReference();
    const st = useBrowserStore.getState();
    expect(st.refreshGeneration).toBeGreaterThan(before);
    expect(st.chroms.map(c => c.name)).toEqual(['contigA', 'contigB']);
    expect([st.chrom, st.start, st.end]).toEqual(['contigA', 0, 20000]);
  });

  it('stays put when the current chromosome is still there', async () => {
    useBrowserStore.setState({ chrom: 'contigB', start: 1, end: 9 } as never);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ chroms: [{ name: 'contigA', size: 50000 }, { name: 'contigB', size: 10 }] })));
    await showLoadedReference();
    expect(useBrowserStore.getState().chrom).toBe('contigB');
  });
});
