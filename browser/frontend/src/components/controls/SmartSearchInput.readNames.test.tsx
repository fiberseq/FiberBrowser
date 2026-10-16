import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../../api/sharedFetch', async (orig) => ({ ...(await orig<object>()), fetchJson: (...a: unknown[]) => fetchJson(...a) }));
const searchGene = vi.fn();
vi.mock('../../api/reference', async (orig) => ({ ...(await orig<object>()), searchGene: (...a: unknown[]) => searchGene(...a) }));

import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { SmartSearchInput } from './SmartSearchInput';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'm84046_240619_124816_s1/240062573/ccs';
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const setViewport = vi.fn();

beforeEach(() => {
  fetchJson.mockReset();
  searchGene.mockReset();
  setViewport.mockReset();
  useReadActionsStore.setState({ highlight: null, pinnedReadIds: [] });
  useBrowserStore.setState({
    chrom: 'chr19', start: 1_000, end: 2_000, chroms: [{ name: 'chr19', size: 58_617_616 }] as never,
    datasets: [{ id: 'ds1', label: 'napa' }] as never,
    panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [] }] as never,
    setViewport,
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<SmartSearchInput />));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function type(value: string) {
  const input = host!.querySelector('[data-testid="location-search-input"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}
async function submit() {
  const form = host!.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

/** fb-r4-clicks: a read name in the locus box goes to the read and highlights it. */
describe('read names in the locus box', () => {
  it('shows a Read suggestion; Enter finds the read, goes to it and highlights it', async () => {
    type(A);
    expect(host!.querySelector('[data-testid="location-search-info"]')?.textContent).toContain('Read');
    fetchJson.mockResolvedValue({
      scope: 'region', complete: true, not_found: [],
      found: [{ name: A, read_id: A, dataset_id: 'ds1', chrom: 'chr19', start: 47_514_487, end: 47_518_985, strand: '+' }],
    });
    await submit();
    expect(fetchJson).toHaveBeenCalledWith('/api/reads/locate', expect.objectContaining({ method: 'POST' }));
    expect(searchGene).not.toHaveBeenCalled();
    expect(setViewport.mock.calls[0][0]).toBe('chr19');
    expect([...useReadActionsStore.getState().highlight!.ids]).toEqual([A]);
  });

  it('says so when the read is not there', async () => {
    type(A);
    fetchJson.mockResolvedValue({ scope: 'genome', complete: true, not_found: [A], found: [] });
    await submit();
    expect(host!.textContent).toContain(`Read not found in the open datasets: ${A}`);
    expect(setViewport).not.toHaveBeenCalled();
  });

  it('a gene name still searches genes', async () => {
    type('roX1');
    expect(host!.querySelector('[data-testid="location-search-info"]')).toBeNull();
    searchGene.mockResolvedValue({ found: true, chrom: 'chrX', start: 10, end: 20 });
    await submit();
    expect(searchGene).toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
