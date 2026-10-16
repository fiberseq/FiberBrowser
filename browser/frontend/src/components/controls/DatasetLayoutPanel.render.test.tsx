import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { DatasetLayoutPanel } from './DatasetLayoutPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ds = (id: string, label: string, paths = [`/data/${label}.bam`]) => ({ id, label, color: '#3b82f6', path: paths[0], paths });
const panel = (id: string, datasetId: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
});
const layoutPanel = { id: 'panel-dataset-layout', contentType: 'dataset-layout', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 };

describe('Layout panel shows only the actions that can apply (M20)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const render = () => act(() => root.render(<DatasetLayoutPanel />));
  const buttons = () => Array.from(container.querySelectorAll('button')).map(b => (b.textContent ?? '').trim()).filter(Boolean);
  const disabled = () => Array.from(container.querySelectorAll('button')).filter(b => b.disabled).map(b => (b.textContent ?? '').trim());

  it('with one dataset: no disabled link/merge buttons, one line saying why', () => {
    useBrowserStore.setState({ datasets: [ds('ds1', 'napa_ddda')], panels: [panel('p1', 'ds1'), layoutPanel] } as never);
    render();
    const labels = buttons();
    for (const gone of ['Merge', 'Link', 'Unlink', 'Unmerge', 'Clear ticks', 'Tick all', 'Pair link', 'Link all', 'Unlink all']) {
      expect(labels).not.toContain(gone);
    }
    expect(disabled()).toEqual([]);
    expect(container.querySelector('[data-testid="layout-link-needs-two"]')?.textContent).toMatch(/two or more dataset panels/);
    // No unexplained "Single" / "row 1" chips.
    expect(container.textContent).not.toMatch(/\bSingle\b|row 1/);
    // The tour's Layout step still finds Equal widths.
    expect(container.querySelector('[data-testid="layout-equal-widths"]')).not.toBeNull();
  });

  it('with two datasets: Link and Merge are offered and say what to tick first', () => {
    useBrowserStore.setState({
      datasets: [ds('ds1', 'a'), ds('ds2', 'b')],
      panels: [panel('p1', 'ds1'), panel('p2', 'ds2', { layoutRow: 1 }), layoutPanel],
    } as never);
    render();
    const link = container.querySelector<HTMLButtonElement>('[data-copilot-anchor="dataset-link-button"]')!;
    expect(link.disabled).toBe(true);
    expect(link.title).toBe('Tick two or more panels below first');
    expect(container.querySelector('[data-copilot-anchor="dataset-merge-button"]')).not.toBeNull();
    // Nothing linked or merged yet: no Unlink / Unmerge / Unlink all.
    expect(buttons()).not.toContain('Unlink');
    expect(buttons()).not.toContain('Unmerge');
    expect(buttons()).not.toContain('Unlink all');
    expect(container.querySelector('[data-testid="layout-link-needs-two"]')).toBeNull();
    // Two rows: the row chip says which of how many.
    expect(container.textContent).toContain('row 2 of 2');
  });
});

describe('Layout panel wording (M20)', () => {
  it('a link group reads as linked panels, not buckets', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    useBrowserStore.setState({
      datasets: [ds('ds1', 'a'), ds('ds2', 'b')],
      panels: [panel('p1', 'ds1', { linkGroup: 'link-1' }), panel('p2', 'ds2', { linkGroup: 'link-1' }), layoutPanel],
    } as never);
    act(() => root.render(<DatasetLayoutPanel />));
    expect(container.textContent).toContain('Linked panels');
    expect(container.textContent).not.toMatch(/bucket|link-1/);
    // Now there is something linked, Unlink (for ticked panels) and Unlink all appear.
    const labels = Array.from(container.querySelectorAll('button')).map(b => (b.textContent ?? '').trim());
    expect(labels).toContain('Unlink');
    expect(labels).toContain('Unlink all');
    expect(labels).not.toContain('Link all');
    act(() => root.unmount());
    container.remove();
  });
});

describe('Layout panel review follow-ups', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('a single merged panel still says why Link and Merge are absent', () => {
    useBrowserStore.setState({
      datasets: [ds('ds1', 'a', ['/data/a.bam', '/data/b.bam'])],
      panels: [panel('p1', 'ds1'), layoutPanel],
    } as never);
    act(() => root.render(<DatasetLayoutPanel />));
    expect(container.querySelector('[data-testid="layout-link-needs-two"]')).not.toBeNull();
  });

  it('counts rows among the dataset panels only ("row 2 of 2", never "row 3 of 2")', () => {
    useBrowserStore.setState({
      datasets: [ds('ds1', 'a'), ds('ds2', 'b')],
      panels: [panel('p1', 'ds1', { layoutRow: 0 }), { ...layoutPanel, layoutRow: 1 }, panel('p2', 'ds2', { layoutRow: 2 })],
    } as never);
    act(() => root.render(<DatasetLayoutPanel />));
    expect(container.textContent).toContain('row 2 of 2');
    expect(container.textContent).not.toContain('row 3 of 2');
  });
});
