import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

describe('peak selection follows its peaks when rule indices change', () => {
  const twoRules = () => {
    const base = store.getState().peakRules[0];
    store.getState().setPeakRules([{ ...base, id: 'ruleA' }, { ...base, id: 'ruleB' }]);
    const [a, b] = store.getState().peakRules;
    store.getState().setPeaksByRule(a.id, [{ start: 100, end: 120, index: 0 }] as never);
    store.getState().setPeaksByRule(b.id, [{ start: 500, end: 520, index: 0 }] as never);
    const peakA = store.getState().peaksByRule[a.id][0];
    store.setState({ selectedPeaks: new Set([peakA.index]), peakModes: { [peakA.index]: 'tf' } });
    return { a, b };
  };

  it('reordering rules keeps the same peak selected, with its mode', () => {
    const { a } = twoRules();
    const rules = store.getState().peakRules;
    const from = rules.findIndex(r => r.id === a.id);
    store.getState().reorderPeakRules(from, rules.length - 1);
    const peakA = store.getState().peaksByRule[a.id][0];
    expect([...store.getState().selectedPeaks]).toEqual([peakA.index]);
    expect(store.getState().peakModes[peakA.index]).toBe('tf');
    const selected = store.getState().getAllPeaks().find(p => store.getState().selectedPeaks.has(p.index))!;
    expect([selected.start, selected.end]).toEqual([100, 120]);
  });

  it('removing a rule re-indexes the later rules, so a rescan cannot collide with the selection', () => {
    const base = store.getState().peakRules[0];
    store.getState().setPeakRules(['A', 'B', 'C'].map(id => ({ ...base, id })));
    store.getState().setPeaksByRule('A', [{ start: 100, end: 120 }] as never);
    store.getState().setPeaksByRule('B', [{ start: 500, end: 520 }] as never);
    store.getState().setPeaksByRule('C', [{ start: 900, end: 920 }] as never);
    store.setState({ selectedPeaks: new Set([10000]), peakModes: { 10000: 'tf' } });  // B's peak

    store.getState().removePeakRule('A');
    store.getState().setPeaksByRule('C', [{ start: 950, end: 970 }] as never);  // rescan C

    const selected = store.getState().getAllPeaks().filter(p => store.getState().selectedPeaks.has(p.index));
    expect(selected.map(p => [p.ruleId, p.start])).toEqual([['B', 500]]);
    expect(store.getState().peakModes[selected[0].index]).toBe('tf');
  });

  it('removing a rule drops its peaks from the selection', () => {
    const { a } = twoRules();
    store.getState().removePeakRule(a.id);
    expect(store.getState().selectedPeaks.size).toBe(0);
    expect(store.getState().peakModes).toEqual({});
  });
});

describe('closing and removing panels', () => {
  it('closing a selected copy drops it from the selection and drops its own state', () => {
    const a = store.getState().addPanel('ds1');
    const copy = store.getState().openPanelAtSite(a);
    store.setState({ selectedDatasets: new Set([copy]), filteredReadIds: { [copy]: new Set(['r1']) } });
    store.getState().removePanel(copy);
    expect(store.getState().selectedDatasets.size).toBe(0);
    expect(store.getState().filteredReadIds[copy]).toBeUndefined();
  });

  it("duplicating a panel keeps the source panel's clusters and filters", () => {
    const a = store.getState().addPanel('ds1');
    store.setState({ clusterAssignments: { ds1: { r1: 0 } }, filteredReadIds: { ds1: new Set(['r1']) } });
    store.getState().duplicatePanel(a);
    const source = store.getState().panels.find(p => p.id === a)!;
    expect(source.stateKey).toBe(a);
    expect(store.getState().clusterAssignments[a]).toEqual({ r1: 0 });
    expect(store.getState().filteredReadIds[a]).toEqual(new Set(['r1']));
  });

  it("replacing the datasets drops the gone ones' selections and state", () => {
    store.getState().setDatasets([{ id: 'ds1', label: 'A' }, { id: 'ds2', label: 'B' }] as never);
    const p2 = store.getState().panels.find(p => p.datasetId === 'ds2')!;
    store.setState({ selectedDatasets: new Set([p2.id]), clusterAssignments: { ds2: { r: 1 }, ds1: { q: 0 } } });
    store.getState().setDatasets([{ id: 'ds1', label: 'A' }] as never);
    expect(store.getState().selectedDatasets.size).toBe(0);
    expect(store.getState().clusterAssignments).toEqual({ ds1: { q: 0 } });
  });
});

describe('undo then a real edit', () => {
  it('records the edit and drops redo, even right after the undo', () => {
    store.setState({ clusterK: 3 });
    store.getState().pushSnapshot('K=3', { kind: 'clustering' });
    store.setState({ clusterK: 5 });
    store.getState().pushSnapshot('K=5', { kind: 'clustering' });
    store.getState().undo();
    expect(store.getState().clusterK).toBe(3);
    store.setState({ clusterK: 8 });
    store.getState().pushSnapshot('K=8', { kind: 'clustering' });
    expect(store.getState()._historyStack.map(s => s.label).slice(-2)).toEqual(['K=3', 'K=8']);
    expect(store.getState().canRedo()).toBe(false);
  });

  it('a push that only repeats the restored state is still skipped', () => {
    store.setState({ clusterK: 3 });
    store.getState().pushSnapshot('K=3', { kind: 'clustering' });
    store.setState({ clusterK: 5 });
    store.getState().pushSnapshot('K=5', { kind: 'clustering' });
    store.getState().undo();
    store.getState().pushSnapshot('Echo', { kind: 'clustering' });
    expect(store.getState().canRedo()).toBe(true);
  });
});
