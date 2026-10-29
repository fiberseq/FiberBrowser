import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useAnalysisRegionStore } from '../../stores/analysisRegionStore';
import { HighlightBands } from '../../components/tracks/HighlightBands';
import { hubOutlinesFor } from './hubOutlines';
import { EMPTY_HUB, hubProviders } from './hubState';
import { useProviderSets, extraScanGroups, withGraphGroups, useHubData } from './hubData';
import { rememberDifferences, clearDifferenceCache } from '../liveLift/differenceCache';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import { useGraphStatusStore } from '../graphPanel/statusStore';
import { columnPathStatus } from './frames';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); clearDifferenceCache(); useHubData.setState({ providers: [] }); useAnalysisRegionStore.getState().set('hub', []); });
const difference = { dataset_id: 'lift', lift_key: 'map', chrom: 'chrT', start: 0, end: 1000, mode: 'items', items: [
  { id: 'change', hap: 'hm', hap_label: 'MAT', kind: 'insertion', source: 'assembly', t_start: 100, t_end: 100,
    ref_bp: 0, alt_bp: 50, src: { contig: 'source', start: 10, end: 60 } }], bins: [] };
function seed() {
  useBrowserStore.setState({ chrom: 'chrT', start: 0, end: 1000, currentGenome: 'ref', fastaPath: null,
    isReversed: false, highlights: [], featureHub: EMPTY_HUB, peakRules: [], peaksByRule: {}, panels: [],
    datasets: [{ id: 'lift', label: 'Assembly', path: '/data/assembly.bam', data_type: 'bam_livelift',
      live_lift: { key: 'map', haplotypes: ['hm', 'hp'], haplotype_labels: { hm: 'MAT', hp: 'PAT' } } },
      { id: 'native', label: 'Reference', path: '/data/native.bam', data_type: 'bam' }] } as never);
  useTrackFeedStore.setState({ byStateKey: {} });
}

it('an unselected hit is selectable in a linear pop-out, with additive selection and no read click', () => {
  seed();
  const hit = { setId: 'scan', hitId: 'hit', typeId: 'fp.class', label: 'Hit', chrom: 'chrT', start: 100, end: 200, anchor: 150 };
  useHubData.setState({ providers: [{ setId: 'scan', datasets: ['native'], type: { provides: [] },
    source: { kind: 'inline', hits: [hit] } }] as never });
  const outlines = hubOutlinesFor(useBrowserStore.getState(), [], [hit]);
  expect(outlines).toHaveLength(1);
  useAnalysisRegionStore.getState().set('hub', outlines);
  const host = document.createElement('div'), root = createRoot(host), readClick = vi.fn();
  act(() => root.render(<div onClick={readClick}><HighlightBands panel={{ id: 'p', datasetId: 'native', contentType: 'dataset' } as never} width={500} gutter={0} /></div>));
  const box = host.querySelector<HTMLElement>('[data-testid="hub-region-outline"]')!;
  expect(box.className).toContain('pointer-events-auto');
  act(() => box.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(useBrowserStore.getState().featureHub.selected).toMatchObject([hit]);
  expect(readClick).not.toHaveBeenCalled();
  act(() => useBrowserStore.getState().setFeatureHub({ selected: [{ ...hit, hitId: 'other', label: 'Other' }] }));
  const current = host.querySelector<HTMLElement>('[aria-label="Select Hit in Feature hub"]')!;
  act(() => current.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
  expect(useBrowserStore.getState().featureHub.selected.map(h => h.hitId)).toEqual(['other', 'hit']);
  act(() => root.unmount());
});

it('Differences and assembly scans share dataset-scoped haplotype columns', () => {
  seed(); rememberDifferences(difference as never);
  const sets = hubProviders().find(p => p.id === 'differences')!.sets(useBrowserStore.getState(), { chrom: 'chrT', start: 0, end: 1000 });
  const groups = extraScanGroups({ groups: [{ id: 'sample', scanDataset: 'sample', datasetId: 'lift', label: 'Assembly' }] } as never,
    'scan', [{ columns: { 'sample:MAT': {} } }] as never);
  expect(sets[0].groups[0]).toMatchObject({ id: groups[0].id, datasetId: 'lift', hap: 'MAT' });
  expect((sets[0].source as any).hits[0].values[groups[0].id]).toBeDefined();
});

it('the hub loads SVs and Differences without any mounted read panels and enriches provider columns', async () => {
  seed();
  useGraphStatusStore.setState({ status: { registrations: [{ id: 'package', revisions: { package: 'rev' } }] } as never });
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url); requests.push(u);
    let body: unknown = {};
    if (u.includes('/api/lift/differences')) body = difference;
    if (u.includes('/api/reads/compact')) body = { sv_summary: { clusters: [{ t: 'I', ref: 300, len: 70, support: 3, informative: 5 }] } };
    if (u.includes('/api/hub/columns')) body = { hits: JSON.parse(String(init?.body)).hits.map((h: any) => ({ ...h,
      graph: { paths: { pat: { datasets: ['lift'], hap: 'PAT', status: 'absent' } } } })) };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  let sets: ReturnType<typeof useProviderSets> = [];
  function Probe() { sets = useProviderSets({ chrom: 'chrT', start: 0, end: 1000 }); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  expect(sets.some(s => s.typeId === 'var.sv')).toBe(true);
  const diff = sets.find(s => s.typeId === 'var.diff')!;
  expect(diff.source.kind === 'inline' && columnPathStatus(diff.source.hits[0].graph, { datasetId: 'lift', hap: 'PAT' })).toBe('absent');
  expect(withGraphGroups(diff, useBrowserStore.getState().datasets).groups).toContainEqual(
    { id: 'ds:lift:PAT', datasetId: 'lift', kind: 'haplotype', hap: 'PAT', label: 'Assembly PAT' });
  expect(requests.some(u => u.includes('/api/reads/compact'))).toBe(true);
  expect(requests.some(u => u.includes('/api/lift/differences'))).toBe(true);
  act(() => root.unmount());
});
