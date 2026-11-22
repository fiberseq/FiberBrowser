/**
 * The Source chips: multi-select for Metaprofile (the click adds or removes; the last stays), single-select for the
 * others; families offered for Metaprofile over the view, greyed with the step button (Find classes, Open
 * Accessibility) when there are none, and greyed with the reason for BED region sets.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Builder } from './PlotsWorkspace';
import { newPlot, plotSources, type PlotSpec } from './plotModel';
import { useBrowserStore } from '../../stores/browserStore';
import { registerPlotsState } from './plotsState';
import { useGroupCount } from './compareState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (plot: PlotSpec) => act(() => root.render(<Builder plot={plot} clustersLocus={null} />));
const current = () => useBrowserStore.getState().plotsWorkspace.current;
const DATASETS = [{ id: 'd1', label: 'Early', available_layers: { nuc: true, tf: true, msp: true, tf2: true } }] as never;

beforeEach(() => {
  registerPlotsState();
  useGroupCount.setState({ key: null, n: null });
  useBrowserStore.setState({ datasets: DATASETS, chrom: 'chr1', start: 1000, end: 5000 } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Source chips', { timeout: 30_000 }, () => {
  it('Metaprofile: several sources, custom MA-tag layers among them; the last one stays', () => {
    const plot = newPlot({ type: 'metaprofile', source: 'nuc' });
    useBrowserStore.getState().setPlotsWorkspace(ws => ({ ...ws, current: plot }));
    render(current());
    expect(q('plots-source-tf2')).not.toBeNull();
    act(() => q('plots-source-tf')!.click());
    render(current());
    act(() => q('plots-source-tf2')!.click());
    render(current());
    expect(plotSources(current())).toEqual(['nuc', 'tf', 'tf2']);
    expect(q('plots-source-nuc')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('plots-source-tf')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('plots-source')!.textContent).toContain('3 selected');
    act(() => q('plots-source-nuc')!.click());
    act(() => q('plots-source-tf')!.click());
    render(current());
    expect(plotSources(current())).toEqual(['tf2']);
    act(() => q('plots-source-tf2')!.click());
    expect(plotSources(current())).toEqual(['tf2']);
  });

  it('single-select types: a chip replaces the source', () => {
    const plot = newPlot({ type: 'size-histogram', source: 'nuc' });
    useBrowserStore.getState().setPlotsWorkspace(ws => ({ ...ws, current: plot }));
    render(current());
    act(() => q('plots-source-tf')!.click());
    expect(plotSources(current())).toEqual(['tf']);
    expect(current().source).toBe('tf');
    expect(q('plots-source-family-fp-families')).toBeNull();
  });

  it('families: greyed with the step button when there are none here; greyed with the reason for BED sets', () => {
    render(newPlot({ type: 'metaprofile' }));
    const empty = q('plots-source-family-empty-fp-families') as HTMLButtonElement;
    expect(empty.disabled).toBe(true);
    expect(empty.title).toMatch(/Find classes has not run/);
    expect(q('plots-prereq-run-classes')!.textContent).toBe('Find classes');
    expect(q('plots-prereq-run-nfr')!.textContent).toBe('Open Accessibility');
    render(newPlot({ type: 'metaprofile', where: 'bed' }));
    const blocked = q('plots-source-family-blocked-fp-families') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toMatch(/one locus/);
  });

  it('several sources: the layout settings appear (panels per group by default, shared y)', () => {
    const plot = { ...newPlot({ type: 'metaprofile' }), source: 'nuc', sources: ['nuc', 'tf'] };
    render(plot);
    act(() => q('plots-more-options')!.click());
    expect(q('plots-profile-multi-layout')).not.toBeNull();
    expect((q('plots-profile-multi-layout')!.querySelector('select') as HTMLSelectElement).value).toBe('auto');
    expect((q('plots-profile-multi-y')!.querySelector('select') as HTMLSelectElement).value).toBe('shared');
  });
});
