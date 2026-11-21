/**
 * The builder: Compare is a primary row next to Group by (not under More options); with one group drawn its A − B and
 * log2 pills are disabled with the reason, Off stays; the size maps' Summary is disabled while comparing, with the
 * reason next to it; profiles call it "Summary of the comparison". A supplied card follows the same rule.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Builder } from './PlotsWorkspace';
import { newPlot, normalizePlot, type PlotSpec } from './plotModel';
import { normalizeSummary } from './summary';
import { reportGroupCount, SUMMARY_OFF_WHILE_COMPARING, useGroupCount } from './compareState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (plot: PlotSpec) => act(() => root.render(<Builder plot={plot} clustersLocus={null} />));

beforeEach(() => {
  useGroupCount.setState({ key: null, n: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Compare in the builder', { timeout: 30_000 }, () => {
  it('sits right after Group by, outside More options', () => {
    render(newPlot({ type: 'metaprofile' }));
    expect(q('plots-more')).toBeNull();
    const group = q('plots-group')!, compare = q('plots-compare')!;
    expect(compare).not.toBeNull();
    const sections = [...container.querySelectorAll('[data-testid="plots-group"], [data-testid="plots-compare"], [data-testid="plots-sampling"]')].map(e => e.getAttribute('data-testid'));
    expect(sections).toEqual(['plots-group', 'plots-compare', 'plots-sampling']);
    expect(group.compareDocumentPosition(compare) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q('plots-more-options')!.textContent).not.toContain('compare');
  });

  it('one group drawn: A − B and log2 disabled with the reason; Off stays; unknown counts leave them on', () => {
    const plot = newPlot({ type: 'metaprofile', compare: 'diff' });
    render(plot);
    expect((q('plots-compare-diff') as HTMLButtonElement).disabled).toBe(false);
    act(() => reportGroupCount(plot, 1));
    const diff = q('plots-compare-diff') as HTMLButtonElement;
    expect(diff.disabled).toBe(true);
    expect(diff.title).toContain('Compare needs two groups: this view has one dataset');
    expect((q('plots-compare-log2ratio') as HTMLButtonElement).disabled).toBe(true);
    expect((q('plots-compare-off') as HTMLButtonElement).disabled).toBe(false);
    act(() => reportGroupCount(plot, 2));
    expect((q('plots-compare-diff') as HTMLButtonElement).disabled).toBe(false);
  });

  it('hidden for a type without Compare (Differential)', () => {
    render(newPlot({ type: 'differential' }));
    expect(q('plots-compare')).toBeNull();
  });
});

describe('Summary with Compare on', { timeout: 30_000 }, () => {
  it('size maps: disabled while comparing with the one-line reason (summary.on kept); back when Compare can\'t apply', () => {
    const plot = newPlot({ type: 'size-enrichment', compare: 'log2ratio', summary: normalizeSummary({ on: true }) });
    render(plot);
    const box = q('plots-summary-on') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(q('plots-summary-blocked')!.textContent).toBe(SUMMARY_OFF_WHILE_COMPARING);
    expect(q('plots-summary-chart-kind')).toBeNull();
    expect(plot.summary.on).toBe(true);
    act(() => reportGroupCount(plot, 1));
    expect((q('plots-summary-on') as HTMLInputElement).disabled).toBe(false);
    expect(q('plots-summary-blocked')).toBeNull();
  });

  it('profiles and histograms: the summary works and says it summarises the comparison', () => {
    for (const type of ['metaprofile', 'size-histogram'] as const) {
      render(newPlot({ type, compare: 'diff', summary: normalizeSummary({ on: true }) }));
      const box = q('plots-summary-on') as HTMLInputElement;
      expect(box.disabled).toBe(false);
      expect(box.checked).toBe(true);
      expect(q('plots-summary-settings')!.textContent).toContain('Summary of the comparison');
      expect(q('plots-summary-blocked')).toBeNull();
      expect(q('plots-summary-chart-kind')).not.toBeNull();
    }
    render(newPlot({ type: 'metaprofile' }));
    expect(q('plots-summary-settings')!.textContent).toContain('Summary across groups');
  });

  it('an old spec with Compare and Summary on loads into the builder under the rule', () => {
    const old = normalizePlot({ id: 'p-old', type: 'vplot', compare: 'diff', summary: { on: true } });
    render(old);
    expect((q('plots-compare-diff') as HTMLElement).getAttribute('aria-pressed')).toBe('true');
    expect((q('plots-summary-on') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('supplied cards', { timeout: 30_000 }, () => {
  it('Compare is disabled with one series (Off stays); no summary control', () => {
    const plot = normalizePlot({ id: 'p-sup', type: 'metaprofile', compare: 'diff', summary: { on: true }, supplied: { origin: 'Nucleosomes', x0: 0, dx: 10, xLabel: 'bp', yLabel: 'v' } });
    render(plot);
    expect(q('plots-compare')).not.toBeNull();
    expect(q('plots-summary-on')).toBeNull();
    act(() => reportGroupCount(plot, 1));
    expect((q('plots-compare-diff') as HTMLButtonElement).disabled).toBe(true);
    expect((q('plots-compare-off') as HTMLButtonElement).disabled).toBe(false);
  });
});
