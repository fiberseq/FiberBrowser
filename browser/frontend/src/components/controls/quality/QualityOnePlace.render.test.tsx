import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { QualityQuickControls } from './QualityQuickControls';
import { QualityTab } from '../labeling/QualityTab';
import { FootprintReadFilters } from '../sidebar/view/FootprintReadFilters';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FIRE = { layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true };

// M9: quality filters are edited in one place (Labeling > Quality); the toolbar
// group and the sidebar only summarise and link to it.
describe('quality filters have one editor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ filters: [], available: {} }), { status: 200 })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 500, maxRegionForReads: 1_000_000,
      datasets: [{ id: 'ds1', available_layers: { nuc: true, tf: true, fire: true } }],
      activeColormap: { ...useBrowserStore.getState().activeColormap, qualityFilters: [FIRE] },
    } as any);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the toolbar group summarises the filters and links to the editor, with no filter controls', async () => {
    await act(async () => { root.render(<QualityQuickControls />); });
    const group = container.querySelector('[data-testid="quality-controls-toolbar"]')!;
    expect(group).not.toBeNull();
    // No checkbox, number or slider that changes a filter here.
    expect(group.querySelectorAll('input')).toHaveLength(0);
    const link = container.querySelector<HTMLButtonElement>('[data-testid="quality-edit-link"]')!;
    expect(link.textContent).toBe('Edit filters…');
    const opened: string[] = [];
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail.tab);
    window.addEventListener('fiberbrowser:open-colormap-tab', onOpen);
    await act(async () => { link.click(); });
    window.removeEventListener('fiberbrowser:open-colormap-tab', onOpen);
    expect(opened).toEqual(['quality']);
  });

  it('the sidebar only links to Labeling > Quality', async () => {
    await act(async () => { root.render(<FootprintReadFilters />); });
    expect(container.textContent).toContain('Labeling > Quality');
    expect(container.textContent).not.toContain('Labeling & Quality');
  });

  it('Labeling > Quality: Add filter does not wrap and remove is an icon button', async () => {
    const noop = () => {};
    await act(async () => {
      root.render(
        <QualityTab
          qualityShading={useBrowserStore.getState().activeColormap.qualityShading}
          tfOverlay={useBrowserStore.getState().activeColormap.tfOverlay}
          layerOpacities={{}}
          displaySmoothing={{ enabled: false, sigmaX: 0, sigmaY: 0 }}
          qualityFilters={[FIRE as any]}
          enabledQualityFilterCount={1}
          availableQualityPresets={[]}
          qualityFilterMatchesPreset={() => false}
          addQualityPreset={noop}
          addQualityFilter={noop}
          updateQualityFilter={noop}
          removeQualityFilter={noop}
          setQualityShading={noop}
          setTfOverlay={noop}
          setDisplaySmoothing={noop}
          setLayerOpacity={noop}
          hasTfLayer={false}
          hasFireLayer
          allLayerNames={['fire']}
          qualityFilterLayerNames={['fire']}
          layerLabelByKey={{}}
        />,
      );
    });
    const add = container.querySelector<HTMLButtonElement>('[data-testid="quality-add-filter"]')!;
    expect(add.textContent).toBe('Add filter');
    expect(add.className).toContain('whitespace-nowrap');
    expect(add.querySelector('svg')).not.toBeNull();
    const remove = container.querySelector<HTMLButtonElement>('[data-testid="quality-remove-filter"]')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove filter');
    expect(remove.textContent).toBe('');
    expect(remove.querySelector('svg')).not.toBeNull();
    expect(container.textContent).not.toContain('×');
  });
});
