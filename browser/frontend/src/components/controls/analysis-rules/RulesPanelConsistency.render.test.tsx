import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import '../../../plugins/builtinPanels';
import { ClusterFeatureRulesPanel, describeRuleCounts } from '../ClusterFeatureRulesPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// M10: the Rules panel's four tabs share one shape: one "Add rule" button in the
// panel colour, one "Presets" menu, and no row of preset buttons.
describe('Rules panel tabs are consistent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 500,
      datasets: [{ id: 'ds1', available_layers: { nuc: true, tf: true, fire: true } }],
      peakRules: [], peaksByRule: {}, savedPeakPresets: [{ name: 'P1', rules: [] }],
      clusterFeatureRules: [], savedClusterFeatureRuleSets: [{ name: 'C1', rules: [] }],
      analysisSortRules: [], savedAnalysisSortRuleSets: [],
      analysisFilterRules: [], savedAnalysisFilterRuleSets: [],
      selectedPeaks: new Set(), showAnalysisDetails: false,
    } as any);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const showTab = async (tab: string) => {
    await act(async () => {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-analysis-rules-tab', { detail: { tab } }));
    });
  };

  it('every tab has one Add rule of the same shape and one Presets menu', async () => {
    await act(async () => { root.render(<ClusterFeatureRulesPanel />); });
    const shapes = new Set<string>();
    for (const tab of ['peaks', 'cluster', 'sort', 'filter']) {
      await showTab(tab);
      const adds = container.querySelectorAll<HTMLButtonElement>('[data-testid="rule-add-button"]');
      expect(adds, tab).toHaveLength(1);
      expect(adds[0].textContent).toBe('Add rule');
      shapes.add(adds[0].className);
      expect(container.querySelectorAll('[data-testid="rule-presets-button"]'), tab).toHaveLength(1);
      // The seven preset buttons are gone from the tab itself.
      const text = container.textContent ?? '';
      for (const gone of ['Load preset', 'Set default', 'Clear default', 'Export JSON', 'Import JSON', '+ Add Rule']) {
        expect(text, `${tab}: ${gone}`).not.toContain(gone);
      }
      expect(container.querySelector('select option[value=""]')?.textContent ?? '').not.toMatch(/Load preset/);
    }
    expect(shapes.size).toBe(1);
    expect([...shapes][0]).toMatch(/violet/);
  });

  it('the Presets menu holds save, load, export and import', async () => {
    await act(async () => { root.render(<ClusterFeatureRulesPanel />); });
    await showTab('cluster');
    const button = container.querySelector<HTMLButtonElement>('[data-testid="rule-presets-button"]')!;
    await act(async () => { button.click(); });
    const menu = container.querySelector('[data-testid="rule-presets-menu"]')!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain('Save');
    expect(menu.textContent).toContain('C1');
    expect(menu.textContent).toContain('Export as JSON');
    expect(menu.textContent).toContain('Import JSON');
    // Peaks keeps its BED import/export in the same menu.
    await showTab('peaks');
    const peakButton = container.querySelector<HTMLButtonElement>('[data-testid="rule-presets-button"]')!;
    await act(async () => { peakButton.click(); });
    const peakMenu = container.querySelector('[data-testid="rule-presets-menu"]')!;
    expect(peakMenu.textContent).toContain('Import peaks from BED');
    expect(peakMenu.textContent).toContain('P1');
  });

  it('describes the rule counts as a sentence', () => {
    expect(describeRuleCounts({ peak: 2, cluster: 0, sort: 0, filter: 1 }))
      .toBe('The toolbar uses 2 peak rules, no cluster rules, no sort rules and 1 filter rule.');
  });
});
