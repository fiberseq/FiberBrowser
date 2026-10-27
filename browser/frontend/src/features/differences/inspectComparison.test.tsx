import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { comparisonKey, useComparisonStore } from './comparison';
import { lacksExactTarget, useInspectComparison } from './AssemblyComparisonPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// agy post-merge review B HIGH 2: a reused row comparison whose exact target was refused (its window reached past
// that comparison's fetch) must not leave the inspector without a target; it runs its own wider comparison.
const target = { target_id: 'allele:del300', revision: 1, target_type: 'exact', chrom: 'chrC', ref_start: 5000, ref_end: 5300 };

function rowResponse(exactTarget: unknown) {
  return {
    dataset_id: 'ds1', chrom: 'chrC', start: 4900, end: 5100, search_complete: true, reasons: [], lineage_events: [], ledger: {}, policy: {},
    assembly: { 'MAT:del': { item_id: 'MAT:del', difference_id: 'diff:mat', hap_label: 'MAT', kind: 'deletion', exact_allele_id: 'allele:del300',
      identity_state: 'exact', sequence_status: 'available', shared_with: [], read_links: [], exact_target: exactTarget,
      t_start: 5000, t_end: 5300, ref_bp: 300, alt_bp: 0 } },
    reads: { r_del300: { read_id: 'r_del300', difference_id: 'diff:r', label: 'confirmed_by_assembly', label_text: '',
      novelty: { status: 'assembly_equivalent', reasons: [] }, sequence_status: 'available', sequence_source: 'geometry',
      links: [{ assembly_item_ids: ['MAT:del'], hap_labels: ['MAT'], relation: 'exact', rule: null, compound: false, scores: {}, reasons: [] }] } },
  };
}

const map = { id: 'ds1', data_type: 'bam_livelift', label: 'ds1' } as never;
const selection = (id: string, source: 'assembly' | 'reads') => ({ panelId: 'p1', datasetId: 'ds1', chrom: 'chrC',
  difference: { id, source, kind: 'deletion', t_start: 5000, t_end: 5300, ref_bp: 300, alt_bp: 0 } }) as never;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useComparisonStore.setState({ byKey: {} });
  fetchMock = vi.fn(async () => new Response(JSON.stringify(rowResponse(target)), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

async function inspect(sel: never) {
  function Harness() { useInspectComparison(sel, map); return null; }
  await act(async () => { root.render(React.createElement(Harness)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

it('a row entry without the exact target it knows of is not reused: the inspector compares ±2 kb itself', async () => {
  for (const [id, source] of [['MAT:del', 'assembly'], ['r_del300', 'reads']] as const) {
    useComparisonStore.setState({ byKey: {} });
    fetchMock.mockClear();
    useComparisonStore.getState().put(comparisonKey('ds1', 'chrC', 'row:p1'), rowResponse(null) as never);
    await inspect(selection(id, source));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect([body.start, body.end]).toEqual([3000, 7300]);
    expect(useComparisonStore.getState().byKey[comparisonKey('ds1', 'chrC', `inspect:${id}`)]).toBeTruthy();
    act(() => root.unmount());
    root = createRoot(host);
  }
});

it('a row entry carrying the exact target is reused, and an inspection that already ran is not repeated', async () => {
  useComparisonStore.getState().put(comparisonKey('ds1', 'chrC', 'row:p1'), rowResponse(target) as never);
  await inspect(selection('MAT:del', 'assembly'));
  expect(fetchMock).not.toHaveBeenCalled();

  act(() => root.unmount());
  root = createRoot(host);
  useComparisonStore.setState({ byKey: {} });
  useComparisonStore.getState().put(comparisonKey('ds1', 'chrC', 'inspect:MAT:del'), rowResponse(null) as never);
  await inspect(selection('MAT:del', 'assembly'));
  expect(fetchMock).not.toHaveBeenCalled();
});

it('lacksExactTarget: only an exact allele without a frozen target counts', () => {
  const response = rowResponse(null) as never as { assembly: Record<string, { exact_allele_id: string | null }> };
  const asm = (exactId: string | null, t: unknown) => ({ kind: 'assembly', value: { exact_allele_id: exactId, exact_target: t }, response }) as never;
  expect(lacksExactTarget(null)).toBe(false);
  expect(lacksExactTarget(asm('allele:del300', null))).toBe(true);
  expect(lacksExactTarget(asm('allele:del300', target))).toBe(false);
  expect(lacksExactTarget(asm(null, null))).toBe(false);
  const read = (ids: string[]) => ({ kind: 'reads', value: { links: [{ assembly_item_ids: ids }] }, response }) as never;
  expect(lacksExactTarget(read(['MAT:del']))).toBe(true);
  expect(lacksExactTarget(read([]))).toBe(false);
});
