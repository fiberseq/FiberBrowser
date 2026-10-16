import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { CircularGenomePanel } from './CircularGenomePanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Regions panel haplotype tab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr1_mat', start: 1000, end: 2000,
      chroms: [{ name: 'chr1_mat', size: 50000 }, { name: 'chr1_pat', size: 50000 }],
      datasets: [], panels: [], navigatorRegions: [],
    } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('opens the haplotype comparison form from its own tab', async () => {
    await act(async () => root.render(<CircularGenomePanel />));
    const tab = [...container.querySelectorAll('button')].find(b => b.textContent === 'Compare haplotypes');
    expect(tab).toBeTruthy();
    await act(async () => { tab!.click(); });
    expect(container.querySelector('[data-tour="haplotype-compare-form"]')).not.toBeNull();
    expect([...container.querySelectorAll('button')].some(b => b.textContent?.includes('Compare Haplotypes'))).toBe(true);
  });
});
