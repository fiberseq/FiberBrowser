import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useAnalysisRegionStore } from '../../stores/analysisRegionStore';
import { HighlightBands } from '../../components/tracks/HighlightBands';
import { hubOutlinesFor, hubHitTargetsFor } from './hubOutlines';
import { EMPTY_HUB, hubProviders } from './hubState';
import { useProviderSets, extraScanGroups, withGraphGroups, useHubData } from './hubData';
import { rememberDifferences, clearDifferenceCache } from '../liveLift/differenceCache';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import { useGraphStatusStore } from '../graphPanel/statusStore';
import { columnPathStatus } from './frames';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); clearDifferenceCache(); useHubData.setState({ providers: [] }); useAnalysisRegionStore.getState().set('hub', []); useAnalysisRegionStore.getState().setHitTargets('hub', []); });
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

const linearPanel = { id: 'p', datasetId: 'native', contentType: 'dataset' } as const;
const hit = { setId: 'scan', hitId: 'hit', typeId: 'fp.class', label: 'Hit', chrom: 'chrT', start: 100, end: 200, anchor: 150 };
function setRegions(selected: typeof hit[], available: typeof hit[]) {
  const state = useBrowserStore.getState();
  useAnalysisRegionStore.getState().set('hub', hubOutlinesFor(state, selected));
  useAnalysisRegionStore.getState().setHitTargets('hub', hubHitTargetsFor(state, selected, available).filter(o => !o.selected));
}
function mockBounds(host: HTMLElement) {
  const layer = host.querySelector<HTMLElement>('[data-testid="highlight-bands"]')!;
  vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100, x: 0, y: 0, toJSON: () => ({}) });
}

it('N available hits with zero selected draw no outline boxes; hover previews only one hit', () => {
  seed();
  // More than the old 64-outline limit: every available hit must still be hit-testable.
  const available = Array.from({ length: 100 }, (_, i) => ({ ...hit, hitId: `hit-${i}`, start: i * 10, end: i * 10 + 10 }));
  setRegions([], available);
  expect(useAnalysisRegionStore.getState().outlines.hub).toEqual([]);
  expect(useAnalysisRegionStore.getState().hitTargets.hub).toHaveLength(100);
  const host = document.createElement('div'), root = createRoot(host);
  act(() => root.render(<div><HighlightBands panel={linearPanel} width={500} gutter={0} /></div>));
  mockBounds(host);
  expect(host.querySelectorAll('[data-testid="hub-region-outline"], [data-testid="hub-region-hover"]')).toHaveLength(0);
  const track = host.firstElementChild!;
  act(() => track.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 401, clientY: 50 })));
  expect(host.querySelectorAll('[data-testid="hub-region-hover"]')).toHaveLength(1);
  expect(host.querySelector<HTMLElement>('[data-testid="hub-region-hover"]')!.style.opacity).toBe('0.3');
  expect(host.querySelectorAll('[data-testid="hub-region-outline"]')).toHaveLength(0);
  act(() => track.dispatchEvent(new MouseEvent('pointerleave')));
  expect(host.querySelector('[data-testid="hub-region-hover"]')).toBeNull();
  act(() => track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 401, clientY: 50 })));
  expect(useBrowserStore.getState().featureHub.selected[0].hitId).toBe('hit-80');
  act(() => root.unmount());
});

it('an unselected hit is selectable in a linear pop-out, with additive selection and no read click', () => {
  seed();
  useHubData.setState({ providers: [{ setId: 'scan', datasets: ['native'], type: { provides: [] },
    source: { kind: 'inline', hits: [hit] } }] } as never);
  setRegions([], [hit]);
  const host = document.createElement('div'), root = createRoot(host), readClick = vi.fn();
  act(() => root.render(<div><div data-testid="reads" onClick={readClick} /><HighlightBands panel={linearPanel} width={500} gutter={0} /></div>));
  mockBounds(host);
  const reads = host.querySelector('[data-testid="reads"]')!;
  // No preceding hover or visible box is needed, including on touch devices.
  act(() => reads.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 75, clientY: 50 })));
  expect(useBrowserStore.getState().featureHub.selected).toMatchObject([hit]);
  expect(readClick).not.toHaveBeenCalled();
  act(() => useBrowserStore.getState().setFeatureHub({ selected: [{ ...hit, hitId: 'other', label: 'Other' }] }));
  act(() => reads.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true, clientX: 75, clientY: 50 })));
  expect(useBrowserStore.getState().featureHub.selected.map(h => h.hitId)).toEqual(['other', 'hit']);
  act(() => setRegions([hit], [hit]));
  const selectedBox = host.querySelector<HTMLElement>('[aria-label="Select Hit in Feature hub"]')!;
  expect(selectedBox.style.opacity).toBe('1');
  act(() => selectedBox.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
  expect(useBrowserStore.getState().featureHub.selected.map(h => h.hitId)).toEqual(['other']);
  act(() => reads.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 50 })));
  expect(readClick).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it('linear hit-testing respects reversed coordinates, overlap, track controls and pan drags', () => {
  seed();
  useBrowserStore.setState({ isReversed: true });
  const narrow = { ...hit, hitId: 'narrow', start: 140, end: 160 };
  setRegions([], [hit, narrow]);
  const host = document.createElement('div'), root = createRoot(host), readClick = vi.fn();
  act(() => root.render(<div><div data-testid="reads" onClick={readClick} /><button>Track control</button>
    <HighlightBands panel={linearPanel} width={600} gutter={100} /></div>));
  const layer = host.querySelector<HTMLElement>('[data-testid="highlight-bands"]')!;
  vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 0, right: 600, bottom: 100, width: 500, height: 100, x: 100, y: 0, toJSON: () => ({}) });
  const reads = host.querySelector('[data-testid="reads"]')!;
  // Position 150 is x=425 within the reversed axis, plus the gutter. It lies in both hits.
  act(() => reads.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 510, clientY: 50 })));
  act(() => reads.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 525, clientY: 50 })));
  expect(useBrowserStore.getState().featureHub.selected).toEqual([]);
  act(() => host.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 525, clientY: 50 })));
  expect(useBrowserStore.getState().featureHub.selected).toEqual([]);
  act(() => reads.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 525, clientY: 50 })));
  expect(useBrowserStore.getState().featureHub.selected).toMatchObject([narrow]);
  expect(readClick).toHaveBeenCalledTimes(1); // Only the drag's click was passed to the read track.
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
