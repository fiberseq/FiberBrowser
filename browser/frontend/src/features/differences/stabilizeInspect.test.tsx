// Adapted from agy's post-merge review B round 2 (HIGH 4, probes F1-F3); each case failed before its fix.
// The inspector reuses a row comparison only when it holds every exact target the difference links to and its
// fetch covered the read's window; its own comparison then wins over later row comparisons, and runs once.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { comparisonFor, comparisonKey, exactTargetsFor, useComparisonStore } from './comparison';
import { lacksExactTarget, useInspectComparison } from './AssemblyComparisonPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const targetMat = {
  target_id: 'allele:mat100', revision: 1, target_type: 'exact', chrom: 'chrC', ref_start: 5050, ref_end: 5050, alt_bp: 100,
  diagnostic_start: 5025, diagnostic_end: 5075, source: 'assembly', source_item_id: 'MAT:ins',
  candidate_labels: { 'allele:mat100': 'MAT' }, candidates: { 'allele:mat100': 'C'.repeat(150), reference: 'C'.repeat(50) },
  competition_complete: true,
};
const targetPat = {
  target_id: 'allele:pat100', revision: 1, target_type: 'exact', chrom: 'chrC', ref_start: 5090, ref_end: 5090, alt_bp: 100,
  diagnostic_start: 5055, diagnostic_end: 5305, source: 'assembly', source_item_id: 'PAT:ins',
  candidate_labels: { 'allele:pat100': 'PAT' }, candidates: { 'allele:pat100': 'A'.repeat(350), reference: 'A'.repeat(250) },
  competition_complete: true,
};

const asmItem = (hap: 'MAT' | 'PAT', exactTarget: unknown) => ({
  item_id: `${hap}:ins`, difference_id: `diff:${hap}`, hap_label: hap, kind: 'insertion', exact_allele_id: `allele:${hap.toLowerCase()}100`,
  identity_state: 'exact', sequence_status: 'available', shared_with: [], read_links: [], exact_target: exactTarget,
  t_start: hap === 'MAT' ? 5050 : 5090, t_end: hap === 'MAT' ? 5050 : 5090, ref_bp: 0, alt_bp: 100,
});
const link = (hap: 'MAT' | 'PAT', relation = 'candidate') => ({ assembly_item_ids: [`${hap}:ins`], hap_labels: [hap], relation,
  rule: 'narrow', compound: false, scores: {}, reasons: [] });
const readValue = (id: string, label: string, reasons: string[], links: unknown[], sequenceSource = 'geometry') => ({
  read_id: id, difference_id: `diff:${id}`, label, label_text: label, novelty: { status: label, reasons },
  sequence_status: 'available', sequence_source: sequenceSource, links,
});
const response = (start: number, end: number, assembly: Record<string, unknown>, reads: Record<string, unknown>) => ({
  dataset_id: 'ds1', chrom: 'chrC', start, end, search_complete: true, reasons: [], lineage_events: [], ledger: {}, policy: {}, assembly, reads,
});

const map = { id: 'ds1', data_type: 'bam_livelift', label: 'ds1' } as never;
const readInsertion = { panelId: 'p1', datasetId: 'ds1', chrom: 'chrC',
  difference: { id: 'r_ins', source: 'reads', kind: 'insertion', t_start: 5060, t_end: 5060, ref_bp: 0, alt_bp: 100 } } as never;
const readDeletion55k = { panelId: 'p1', datasetId: 'ds1', chrom: 'chrC',
  difference: { id: 'r_del55k', source: 'reads', kind: 'deletion', t_start: 5000, t_end: 60000, ref_bp: 55000, alt_bp: 0 } } as never;
const patInsertion = { panelId: 'p1', datasetId: 'ds1', chrom: 'chrC',
  difference: { id: 'PAT:ins', source: 'assembly', kind: 'insertion', t_start: 5090, t_end: 5090, ref_bp: 0, alt_bp: 100 } } as never;

const rowKey = comparisonKey('ds1', 'chrC', 'row:p1');
const put = (key: string, r: unknown) => useComparisonStore.getState().put(key, r as never);

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof vi.fn>;
let captured: ReturnType<typeof useInspectComparison> | null;
const answer = (r: unknown) => fetchMock.mockImplementation(async () =>
  new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const bodyOf = (call: number) => JSON.parse((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].body as string);

async function settle() { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function inspect(sel: never) {
  function Harness() { captured = useInspectComparison(sel, map); return null; }
  await act(async () => { root.render(React.createElement(Harness)); });
  await settle();
}
function remount() { act(() => root.unmount()); root = createRoot(host); }

beforeEach(() => {
  useComparisonStore.setState({ byKey: {} });
  captured = null;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it('F1: a row entry holding one linked exact target while another was refused at its fetch edge is not reused', async () => {
  put(rowKey, response(4900, 5100, { 'MAT:ins': asmItem('MAT', targetMat), 'PAT:ins': asmItem('PAT', null) },
    { r_ins: readValue('r_ins', 'assembly_candidate', ['candidate_equivalence_unresolved'], [link('MAT'), link('PAT')]) }));
  expect(lacksExactTarget(comparisonFor(useComparisonStore.getState().byKey, 'ds1|chrC|', (readInsertion as { difference: never }).difference))).toBe(true);
  answer(response(3060, 7060, { 'MAT:ins': asmItem('MAT', targetMat), 'PAT:ins': asmItem('PAT', targetPat) },
    { r_ins: readValue('r_ins', 'assembly_candidate', ['candidate_equivalence_unresolved'], [link('MAT'), link('PAT')]) }));

  await inspect(readInsertion);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect([bodyOf(0).start, bodyOf(0).end]).toEqual([3060, 7060]);
  expect(exactTargetsFor(captured!.entry).map(t => t.target_id).sort()).toEqual(['allele:mat100', 'allele:pat100']);
});

it('F2: a row entry whose fetch stopped short of the read (fetch_horizon, no links) is not reused', async () => {
  put(rowKey, response(4900, 5100, {}, { r_del55k: readValue('r_del55k', 'unassessed', ['fetch_horizon', 'search_unassessed'], []) }));
  answer(response(3000, 62000, {}, { r_del55k: readValue('r_del55k', 'novel_relative_to_assembly', [], []) }));

  await inspect(readDeletion55k);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect([bodyOf(0).start, bodyOf(0).end]).toEqual([3000, 62000]);
  expect(captured!.entry?.kind === 'reads' && captured!.entry.value.label).toBe('novel_relative_to_assembly');
});

it('F3: a later row comparison does not replace the inspector\'s own (its exact target, or its consensus confirmation)', async () => {
  put(comparisonKey('ds1', 'chrC', 'inspect:PAT:ins'), response(3090, 7090, { 'PAT:ins': asmItem('PAT', targetPat) }, {}));
  await inspect(patInsertion);
  expect(exactTargetsFor(captured!.entry).map(t => t.target_id)).toEqual(['allele:pat100']);

  // A debounced or panned row comparison arrives later with the target refused at its narrower fetch edge.
  await act(async () => { put(rowKey, response(4910, 5110, { 'PAT:ins': asmItem('PAT', null) }, {})); });
  expect(exactTargetsFor(captured!.entry).map(t => t.target_id)).toEqual(['allele:pat100']);
  expect(fetchMock).not.toHaveBeenCalled();

  // The same for a read difference whose consensus the inspector confirmed.
  useComparisonStore.setState({ byKey: {} });
  put(comparisonKey('ds1', 'chrC', 'inspect:r_ins'), response(3060, 7060, { 'MAT:ins': asmItem('MAT', targetMat) },
    { r_ins: readValue('r_ins', 'confirmed_by_assembly', [], [link('MAT', 'exact')], 'consensus') }));
  put(rowKey, response(4910, 5110, { 'MAT:ins': asmItem('MAT', targetMat) },
    { r_ins: readValue('r_ins', 'assembly_candidate', ['candidate_equivalence_unresolved'], [link('MAT')]) }));
  const entry = comparisonFor(useComparisonStore.getState().byKey, 'ds1|chrC|', (readInsertion as { difference: never }).difference);
  expect(entry?.kind === 'reads' && entry.value.label).toBe('confirmed_by_assembly');
});

it('an inspection whose answer still lacks a target or still stops short is not requested again', async () => {
  // The read: its own ±2 kb comparison still stops short (past the bounded widening) and PAT's target stays refused.
  put(rowKey, response(4900, 5100, { 'MAT:ins': asmItem('MAT', targetMat), 'PAT:ins': asmItem('PAT', null) },
    { r_del55k: readValue('r_del55k', 'unassessed', ['fetch_horizon'], [link('MAT'), link('PAT')]) }));
  answer(response(3000, 62000, { 'MAT:ins': asmItem('MAT', targetMat), 'PAT:ins': asmItem('PAT', null) },
    { r_del55k: readValue('r_del55k', 'unassessed', ['fetch_horizon'], [link('MAT'), link('PAT')]) }));
  await inspect(readDeletion55k);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(lacksExactTarget(captured!.entry)).toBe(true);

  // Later row comparisons, re-renders and a reopened inspector do not ask again.
  await act(async () => { put(rowKey, response(4910, 5110, {}, { r_del55k: readValue('r_del55k', 'unassessed', ['fetch_horizon'], []) })); });
  await inspect(readDeletion55k);
  remount();
  await inspect(readDeletion55k);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // An assembly difference whose exact target the inspector's comparison also refuses.
  remount();
  fetchMock.mockClear();
  put(rowKey, response(4900, 5100, { 'PAT:ins': asmItem('PAT', null) }, {}));
  answer(response(3090, 7090, { 'PAT:ins': asmItem('PAT', null) }, {}));
  await inspect(patInsertion);
  await act(async () => { put(rowKey, response(4910, 5110, { 'PAT:ins': asmItem('PAT', null) }, {})); });
  remount();
  await inspect(patInsertion);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
