import { expect, it } from 'vitest';
import { comparisonFor, exactTargetsFor, mergeLedger, useComparisonStore } from './comparison';

const read = { id: 'r1', source: 'reads' } as never;
const response = (label: string) => ({ reads: { r1: { read_id: 'r1', label, label_text: label, links: [], novelty: { status: '', reasons: [] } } }, assembly: {} }) as never;

it('the inspector\'s own comparison of a difference wins (a consensus re-compare over the row); else the newest', () => {
  const put = useComparisonStore.getState().put;
  put('ds|chr3|row:p1', response('assembly_candidate'));
  put('ds|chr3|row:p2', response('assembly_supported_approximate'));
  expect(comparisonFor(useComparisonStore.getState().byKey, 'ds|chr3|', read)!.value).toMatchObject({ label: 'assembly_supported_approximate' });
  put('ds|chr3|inspect:r1', response('confirmed_by_assembly'));
  expect(comparisonFor(useComparisonStore.getState().byKey, 'ds|chr3|', read)!.value).toMatchObject({ label: 'confirmed_by_assembly' });
  put('ds|chr3|row:p1', response('unassessed'));   // a later, narrower row refresh does not replace it
  expect(comparisonFor(useComparisonStore.getState().byKey, 'ds|chr3|', read)!.value).toMatchObject({ label: 'confirmed_by_assembly' });
  expect(comparisonFor(useComparisonStore.getState().byKey, 'other|chr3|', read)).toBeNull();
});

it('exact targets of a read difference come from its linked assembly items, once each', () => {
  const t = { target_id: 'allele:x' };
  const entry = { kind: 'reads', value: { links: [{ assembly_item_ids: ['a', 'b'] }, { assembly_item_ids: ['a'] }] },
    response: { assembly: { a: { exact_target: t }, b: { exact_target: null } } } } as never;
  expect(exactTargetsFor(entry)).toEqual([t]);
});

it('ledgers merge: retired records and higher revisions win; lineage is unioned', () => {
  const a = { records: { x: { identity_state: 'provisional', revision: 1 } }, seeds: {}, lineage: {}, snapshots: {} };
  const b = { records: { x: { identity_state: 'retired', revision: 1 }, y: { identity_state: 'provisional', revision: 1 } }, seeds: {}, lineage: { x: { descendants: ['y'] } }, snapshots: {} };
  const m = mergeLedger(a, b);
  expect(m.records.x.identity_state).toBe('retired');
  expect(Object.keys(m.records)).toEqual(['x', 'y']);
  expect(m.lineage.x.descendants).toEqual(['y']);
});
