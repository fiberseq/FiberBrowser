import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { getCatalog, loadGenome } = vi.hoisted(() => ({ getCatalog: vi.fn(), loadGenome: vi.fn() }));
vi.mock('../../../api/catalog', () => ({
  getCatalog,
  catalogLoad: vi.fn(), catalogUnload: vi.fn(), catalogTrackLoad: vi.fn(), catalogTrackUnload: vi.fn(),
}));
vi.mock('../../../api/reference', () => ({ loadGenome }));

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

describe('CatalogSection reference', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetModules();
    getCatalog.mockReset().mockResolvedValue({ catalog: { genome: 'hg38', groups: [], tracks: [] } });
    loadGenome.mockReset().mockResolvedValue({ success: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads the catalog genome once, and never over a reference the user loaded', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const { CatalogSection } = await import('./CatalogSection');
    useBrowserStore.setState({ hasFasta: false, currentGenome: null } as never);

    act(() => root.render(<CatalogSection />));
    await flush();
    expect(loadGenome).toHaveBeenCalledTimes(1);
    expect(loadGenome).toHaveBeenCalledWith('hg38');

    // The user then picks another reference; reopening the section (a remount) keeps it.
    useBrowserStore.setState({ hasFasta: true, currentGenome: 'dm6' } as never);
    act(() => root.render(<div />));
    act(() => root.render(<CatalogSection />));
    await flush();
    expect(loadGenome).toHaveBeenCalledTimes(1);
    expect(useBrowserStore.getState().currentGenome).toBe('dm6');
  });

  it('leaves a reference loaded before the section first opens', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const { CatalogSection } = await import('./CatalogSection');
    useBrowserStore.setState({ hasFasta: true, currentGenome: null } as never);

    act(() => root.render(<CatalogSection />));
    await flush();
    expect(loadGenome).not.toHaveBeenCalled();
  });
});
