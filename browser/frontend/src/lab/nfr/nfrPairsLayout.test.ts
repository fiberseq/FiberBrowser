import '../testSetup';
import { beforeEach, describe, expect, it } from 'vitest';
import { assignLanes, foldableNfrs, pairForPicks, shownArcs, shownElements } from './nfrPairsLayout';
import { pickElement } from './nfrSelection';
import { filteredArcs, DEFAULT_PAIR_FILTER } from './accessibilityView';
import { useAccessibilityStore } from './accessibilityStore';
import { NFR_RESULT } from './accessibility/fixture';
import { migratePanelTracks } from '../../stores/utils';

const el = (id: string, start: number, end: number, kind: 'nfr' | 'tf' = 'nfr') => ({ id, kind, start, end });

describe('NFR pairs layout: lanes', () => {
  it('overlapping elements get distinct lanes; elements apart share one', () => {
    const { lanes, count } = assignLanes([el('N1:V1', 100, 200), el('N1:V2', 150, 400), el('N1:V3', 380, 500)]);
    expect(lanes.get('N1:V1')).toBe(0);
    expect(lanes.get('N1:V2')).toBe(1);
    expect(lanes.get('N1:V3')).toBe(0);           // apart from V1: its lane
    expect(count).toBe(2);
    expect(assignLanes([el('a', 0, 10), el('b', 10, 20), el('c', 30, 40)]).count).toBe(1);   // touching is not overlapping
  });
  it('footprint classes take lanes under the NFR elements, packed the same way', () => {
    const { lanes, count } = assignLanes([el('N1', 100, 500), el('c1', 150, 170, 'tf'), el('c2', 160, 180, 'tf'), el('c3', 300, 320, 'tf')]);
    expect(lanes.get('N1')).toBe(0);
    expect([lanes.get('c1'), lanes.get('c2'), lanes.get('c3')]).toEqual([1, 2, 1]);
    expect(count).toBe(3);
  });
  it('the same lanes whatever the view (genomic overlap, not pixels)', () => {
    const a = assignLanes([el('x', 0, 100), el('y', 100.5, 200)]);
    expect(a.lanes.get('y')).toBe(0);
  });
});

describe('NFR pairs layout: folded NFRs', () => {
  it('an NFR with several variants is one element until unfolded; classes as they are', () => {
    expect(foldableNfrs(NFR_RESULT)).toEqual(['N1']);
    const folded = shownElements(NFR_RESULT, []);
    expect(folded.map(e => e.id)).toEqual(['N1', 'class_008']);
    expect(folded[0]).toMatchObject({ members: ['N1:V1', 'N1:V2', 'N1:V3'], start: 47518152.1, end: 47518513.7, group: { nfr: 'N1', size: 3, expanded: false } });
    expect(folded[0].prevalence).toBeCloseTo(1 - 0.2694);
    expect(shownElements(NFR_RESULT, ['N1']).map(e => e.id)).toEqual(['N1:V1', 'N1:V2', 'class_008', 'N1:V3']);
    expect(shownElements(NFR_RESULT, [], false).map(e => e.id)).toEqual(['N1']);
  });
  it('arcs go to the folded NFR; a pair inside it waits for it to unfold', () => {
    const arcs = filteredArcs(NFR_RESULT, { ...DEFAULT_PAIR_FILTER, focus: null, includeClasses: true });
    const folded = shownArcs(arcs, shownElements(NFR_RESULT, []));
    expect(folded.arcs.map(a => [a.from, a.to])).toEqual([['N1', 'class_008'], ['N1', 'class_008']]);
    expect(folded.inner.get('N1')).toBe(1);
    expect(folded.arcs[0].pair.a).toBe('N1:V2');     // the run's pair: inspecting it is unchanged
    const open = shownArcs(arcs, shownElements(NFR_RESULT, ['N1']));
    expect(open.arcs).toHaveLength(3);
    expect(open.inner.size).toBe(0);
  });
  it('picks: two elements as they are, a folded NFR its strongest pair, plain words otherwise', () => {
    expect(pairForPicks(NFR_RESULT, 'N1:V1', 'N1:V3')).toEqual({ a: 'N1:V1', b: 'N1:V3' });
    expect(pairForPicks(NFR_RESULT, 'N1', 'class_008')).toEqual({ a: 'N1:V1', b: 'class_008' });      // |−2.44| > 1.92
    expect(pairForPicks(NFR_RESULT, 'N1:V1', 'N1:V2')).toEqual({ error: expect.stringContaining('overlap') });
    expect(pairForPicks(NFR_RESULT, 'N1', 'N1:V2')).toEqual({ error: expect.stringContaining('same NFR') });
    // an NFR picked as such with a single element is that element (Codex review)
    const single = { ...NFR_RESULT, elements: [...NFR_RESULT.elements, { id: 'N2:V1', kind: 'nfr' as const, subtype: 'variant' as const, nfr: 'N2', start: 47518700, end: 47518800, label: 'N2 V1', prevalence: 0.2, n: 100 }] };
    expect(pairForPicks(single, 'N2', 'class_008')).toEqual({ a: 'N2:V1', b: 'class_008' });
  });
});

describe('NFR pairs: one selection', () => {
  beforeEach(() => useAccessibilityStore.setState({ jobId: 'job', result: NFR_RESULT, focus: null, pairRequest: null }));
  it('a click selects, a click on another asks for the pair, a click on the selected one deselects', () => {
    expect(pickElement('N1:V1')).toBe('selected');
    expect(useAccessibilityStore.getState().focus).toBe('N1:V1');
    expect(pickElement('class_008')).toBe('pair');
    expect(useAccessibilityStore.getState().pairRequest).toMatchObject({ jobId: 'job', a: 'N1:V1', b: 'class_008' });
    expect(useAccessibilityStore.getState().focus).toBe('N1:V1');           // still selected: its arcs stay
    expect(pickElement('N1:V1')).toBe('cleared');
    expect(useAccessibilityStore.getState().focus).toBeNull();
  });
  it('a variant of the selected NFR replaces the selection (no pair of an NFR with itself)', () => {
    pickElement('N1');
    expect(pickElement('N1:V2')).toBe('selected');
    expect(useAccessibilityStore.getState().focus).toBe('N1:V2');
    expect(useAccessibilityStore.getState().pairRequest).toBeNull();
  });
  it('the fold state is per run', () => {
    const s = useAccessibilityStore.getState();
    s.setExpanded('job', 'N1', true);
    s.setExpanded('other', 'N2', true);
    expect(useAccessibilityStore.getState().expanded).toMatchObject({ job: ['N1'], other: ['N2'] });
    s.setExpanded('job', 'N1', false);
    expect(useAccessibilityStore.getState().expanded.job).toEqual([]);
  });
});

describe('sessions from before the arcs moved onto the NFR track', () => {
  it('drop the old NFR pairs row and keep the NFR track', () => {
    const [panel] = migratePanelTracks([{ contentType: 'dataset', subTracks: [
      { type: 'axis', visible: true }, { type: 'nfr', visible: true, heightOverride: 200 }, { type: 'nfr-variants', visible: true }, { type: 'reads', visible: true },
    ] as never }]);
    const types = panel.subTracks!.map(t => t.type);
    expect(types).not.toContain('nfr');
    expect(types).toContain('nfr-variants');
  });
});
