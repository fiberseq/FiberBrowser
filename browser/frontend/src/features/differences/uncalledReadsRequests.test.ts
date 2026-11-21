/** Min footprints' "All reads, including uncalled" (-1) reaches the dev-only panels: every /api request then
 * carries hide_uncalled=false (utils/signalFilters), which the server's read policy turns into the browser-side
 * uncalled-read rule before FiberHMM's engines (nucleosomes, hub, scans) see the reads. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { nucStatus } from '../nucleosomes/api';
import { submitAssoc } from '../hub/assocApi';

const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ available: true, datasets: [] }), text: async () => '{}' } as unknown as Response;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); useBrowserStore.setState({ minFootprints: 5 }); });

describe('uncalled reads in the dev-only panels', () => {
  it.each([[5, null], [0, null], [-1, 'false']])('min footprints %s sends hide_uncalled=%s', async (minFootprints, expected) => {
    useBrowserStore.setState({ minFootprints });
    await nucStatus(['d']);
    await submitAssoc({ mode: 'M3', a: { kind: 'marks', typeId: 'nuc.seg.regular' }, scope: { kind: 'view' } } as never).catch(() => undefined);
    for (const url of urls) expect(new URL(url, 'http://x').searchParams.get('hide_uncalled')).toBe(expected);
    expect(urls.length).toBe(2);
  });
});
