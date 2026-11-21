import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import type { AnalysisFilterRule, AnalysisSortRule } from '../../../types';
import { AnalysisFilterRulesEditor } from './AnalysisFilterRulesEditor';
import { AnalysisSortRulesEditor } from './AnalysisSortRulesEditor';
import { hubHitsSnapshot, layerFreeScope } from './RuleTermSources';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SELECTED = [
  { setId: 'scan:a', hitId: 'h1', typeId: 'nfr.element', chrom: 'chr1', start: 100, end: 200, anchor: 150, hasStates: true, label: 'one' },
  { setId: 'scan:a', hitId: 'h2', typeId: 'peak', chrom: 'chr1', start: 300, end: 400, anchor: 350, hasStates: false },
];

const nrlRule: AnalysisFilterRule = {
  id: 'f1', name: 'NRL between 185 and 195 bp', autoName: 'NRL between 185 and 195 bp', nameEdited: false, enabled: true,
  scope: { kind: 'currentWindow' }, terms: [{ id: 't1', source: 'molecule_metric', moleculeMetric: 'nuc.nrl', layer: null }],
  metric: 'value', operator: 'between', threshold: 185, thresholdMax: 195,
};

const layerRule: AnalysisFilterRule = {
  id: 'f2', name: 'TF count >= 1', autoName: 'TF count >= 1', nameEdited: false, enabled: true,
  scope: { kind: 'selectedPeaks' }, terms: [{ id: 't2', source: 'layer', layer: 'tf', sizeMin: 0, sizeMax: null }],
  metric: 'count', operator: 'gte', threshold: 1,
};

const noop = () => {};

describe('rule term sources in the editors', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ featureHub: { scans: [], ui: {} as never, anchors: [], selected: [] } } as never);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderFilter = async (rules: AnalysisFilterRule[], onUpdateRule = vi.fn()) => {
    await act(async () => {
      root.render(<AnalysisFilterRulesEditor rules={rules} savedRuleSets={[]} activeLabelRules={[]} footprintGroups={[]}
        layerOptions={[{ value: 'tf', label: 'TF' }]} onAddRule={noop} onUpdateRule={onUpdateRule} onRemoveRule={noop}
        onSetRules={noop} onSaveRuleSet={noop} onLoadRuleSet={noop} onDeleteRuleSet={noop} onSetDefaultRuleSet={noop} />);
    });
    return onUpdateRule;
  };

  const change = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  const sourceSelect = () => [...container.querySelectorAll('select')]
    .find(s => [...s.options].some(o => o.value === 'molecule_metric')) as HTMLSelectElement;

  it('a molecule metric rule shows the metric, its unit, both bounds and the AND choice', async () => {
    const onUpdate = await renderFilter([nrlRule]);
    const text = container.textContent ?? '';
    expect(text).toContain('value (bp)');
    expect(text).toContain('Within the current filter (AND)');
    expect(sourceSelect().value).toBe('molecule_metric');
    const metric = [...container.querySelectorAll('select')].find(s => s.querySelector('optgroup[label="Nucleosome"]'))!;
    expect(metric.value).toBe('nuc.nrl');
    expect(metric.querySelector('optgroup[label="NFR"]')?.textContent).toContain('Openness');
    const numbers = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')].map(i => i.value);
    expect(numbers).toEqual(['185', '195']);
    const and = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find(i => i.closest('label')?.textContent?.includes('Within the current filter'))!;
    await act(async () => { and.click(); });
    expect(onUpdate).toHaveBeenLastCalledWith('f1', expect.objectContaining({ combine: 'and' }));
  });

  it('choosing a molecule metric sets value, a view scope and clears the layer', async () => {
    const onUpdate = await renderFilter([layerRule]);
    await change(sourceSelect(), 'molecule_metric');
    const [, updates] = onUpdate.mock.calls.at(-1)!;
    expect(updates).toMatchObject({ metric: 'value', scope: { kind: 'currentWindow' }, name: 'NRL >= 1 bp' });
    expect(updates.terms[0]).toMatchObject({ source: 'molecule_metric', moleculeMetric: 'nuc.nrl', layer: null });
  });

  it('hub hits are unavailable with a note until hits with states are selected', async () => {
    await renderFilter([layerRule]);
    const option = sourceSelect().querySelector<HTMLOptionElement>('option[value="feature_hub"]')!;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain('select hits in the feature hub first');
  });

  it('hub hits snapshot the selection (hits with states only) and count', async () => {
    useBrowserStore.setState({ featureHub: { scans: [], ui: {} as never, anchors: [], selected: SELECTED } } as never);
    // An occupancy rule: a hub term counts hits, so the metric becomes count.
    const onUpdate = await renderFilter([{ ...layerRule, metric: 'occupancy' }]);
    await change(sourceSelect(), 'feature_hub');
    const [, updates] = onUpdate.mock.calls.at(-1)!;
    expect(updates.metric).toBe('count');
    expect(updates.terms[0]).toMatchObject({ source: 'feature_hub', hubState: '1', layer: null,
      hubHits: [{ setId: 'scan:a', hitId: 'h1', chrom: 'chr1', start: 100, end: 200, label: 'one' }] });
    expect(updates.name).toBe('Hub hits (1) state 1 count >= 1');
  });

  it('the sort editor offers the same sources and shows the unit for a molecule metric', async () => {
    const sort: AnalysisSortRule = { id: 's1', name: 'NRL high to low', enabled: true, scope: { kind: 'currentWindow' },
      terms: [{ id: 't', source: 'molecule_metric', moleculeMetric: 'nfr.longest_linker' }], metric: 'value', descending: true };
    await act(async () => {
      root.render(<AnalysisSortRulesEditor rules={[sort]} savedRuleSets={[]} activeLabelRules={[]} footprintGroups={[]}
        layerOptions={[{ value: 'tf', label: 'TF' }]} onAddRule={noop} onUpdateRule={noop} onRemoveRule={noop}
        onSetRules={noop} onSaveRuleSet={noop} onLoadRuleSet={noop} onDeleteRuleSet={noop} onSetDefaultRuleSet={noop} />);
    });
    expect(container.textContent).toContain('value (bp)');
    expect(sourceSelect().querySelector('option[value="feature_hub"]')).not.toBeNull();
  });
});

describe('term source helpers', () => {
  it('snapshots only hub hits with per-read states', () => {
    expect(hubHitsSnapshot(SELECTED)).toEqual([{ setId: 'scan:a', hitId: 'h1', chrom: 'chr1', start: 100, end: 200, label: 'one' }]);
  });

  it('moves a peak scope to the current window and keeps others', () => {
    expect(layerFreeScope({ kind: 'selectedPeaks', peakLevelMin: 1 }).kind).toBe('currentWindow');
    expect(layerFreeScope({ kind: 'gene', geneId: 'g1' })).toMatchObject({ kind: 'gene', geneId: 'g1' });
  });
});
