/** P2a review probes, inverted: exercise real store/session and mouse/data hooks, not substitute hit/key helpers. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { ensureBuiltinPanelsRegistered } from '../../stores/__tests__/helpers';
import { collectFrontendState, applyImportedState } from '../../api/session';
import type { CoverageResponse } from '../../api/coverage';
import type { Dataset } from '../../types';
import type { CompactRead } from '../../components/tracks/read-track/types';
import { autoSplitNewLiftedDatasets, useLiveLiftHeader } from './register';
import { useReadTrackData } from '../../components/tracks/read-track/useReadTrackData';
import { useReadTrackMouse } from '../../components/tracks/read-track/useReadTrackMouse';
import { coverageHistogramBins } from '../../components/tracks/read-track/ReadTrackCanvas';
import { useLiftCorrespondence } from './useLiftCorrespondence';
import { liveLiftHaplotypeColor } from './palette';
import { LiveLiftTooltipLines } from './LiveLiftTooltip';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const coverage = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<CoverageResponse>>());
vi.mock('../../api/coverage', async importOriginal => ({ ...await importOriginal<object>(), getCoverage: coverage }));

const dataset: Dataset = {
  id: 'lift', path: 'x.bam', label: 'lift', color: '#000', data_type: 'bam_livelift', source_identity: 'v1',
  live_lift: { manifest: '/map.json', map_label: 'map', haplotypes: ['H#1', 'H#2'],
    haplotype_labels: { 'H#1': 'MAT', 'H#2': 'PAT' }, settings: { haplotype_mode: 'split' }, key: 'v1' },
};
const correspondence: NonNullable<CoverageResponse['live_lift']> = {
  haplotypes: { MAT: { depth: null, correspondence: [0.25] }, PAT: { depth: null, correspondence: [0.5] } },
  pooled: { depth: null, correspondence: [0.75], mode: 'raw' }, hatching: true,
};
const originalState = useBrowserStore.getState();
const roots: Root[] = [];
function mount() {
  const host = document.createElement('div');
  const root = createRoot(host);
  roots.push(root);
  return { root, host };
}
beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  useBrowserStore.setState({ ...originalState, datasets: [dataset], panels: [], refreshGeneration: 0,
    maxRegionForReads: 100_000, darkMode: false }, true);
  coverage.mockReset().mockResolvedValue({ coverage: [1], max: 1, live_lift: correspondence });
});
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useBrowserStore.setState(originalState, true);
});

/** Session export serializes panel fields; restoration must respect them even with a fresh split subscriber. */
function roundTripSession() {
  const frontend = JSON.parse(JSON.stringify(collectFrontendState()));
  const datasets = JSON.parse(JSON.stringify(useBrowserStore.getState().datasets));
  useBrowserStore.setState({ panels: [], datasets: [] });
  applyImportedState({ datasets, overlays: [], has_fasta: false, frontend });
  autoSplitNewLiftedDatasets(new Set());
}

it('keeps a saved pooled panel pooled with a fresh subscriber, and can split it again (probe 1)', () => {
  const id = useBrowserStore.getState().addPanel('lift');
  autoSplitNewLiftedDatasets(new Set());
  expect(useBrowserStore.getState().panels.map(p => p.liftHap)).toEqual(['MAT', 'PAT']);
  useBrowserStore.getState().poolLiftHapPanels('lift');
  expect(useBrowserStore.getState().panels[0].liftHaplotypeMode).toBe('pooled');
  roundTripSession();
  expect(useBrowserStore.getState().panels.map(p => [p.id, p.liftHap, p.liftHaplotypeMode]))
    .toEqual([[id, undefined, 'pooled']]);
  useBrowserStore.getState().splitPanelByLiftHap(id, ['MAT', 'PAT']);
  expect(useBrowserStore.getState().panels.map(p => p.liftHap)).toEqual(['MAT', 'PAT']);
});

it('keeps split haplotype panels split through session save/restore', () => {
  const id = useBrowserStore.getState().addPanel('lift');
  useBrowserStore.getState().splitPanelByLiftHap(id, ['MAT', 'PAT']);
  const ids = useBrowserStore.getState().panels.map(p => p.id);
  roundTripSession();
  expect(useBrowserStore.getState().panels.map(p => p.id)).toEqual(ids);
  expect(useBrowserStore.getState().panels.map(p => [p.liftHap, p.liftHaplotypeMode]))
    .toEqual([['MAT', 'split'], ['PAT', 'split']]);
});

it('distinguishes a restored legacy panel from one newly added under the split default', () => {
  const id = useBrowserStore.getState().addPanel('lift');
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => ({ ...p, liftHaplotypeMode: undefined })) }));
  autoSplitNewLiftedDatasets(new Set());
  expect(useBrowserStore.getState().panels.map(p => p.id)).toEqual([id]);
});

it.each(['addDataset', 'setDatasets'] as const)('applies the default only to fresh panels from %s', async method => {
  for (const mode of ['split', 'pooled'] as const) {
    await act(async () => {
      useBrowserStore.setState({ datasets: [], panels: [] });
      const ds = { ...dataset, live_lift: { ...dataset.live_lift!, settings: { haplotype_mode: mode } } };
      if (method === 'addDataset') useBrowserStore.getState().addDataset(ds);
      else useBrowserStore.getState().setDatasets([ds]);
      autoSplitNewLiftedDatasets(new Set());
    });
    expect(useBrowserStore.getState().panels.map(p => p.liftHap)).toEqual(mode === 'split' ? ['MAT', 'PAT'] : [undefined]);
    expect(useBrowserStore.getState().panels.every(p => p.liftHaplotypeMode === mode)).toBe(true);
  }
});

const dataParams = {
  chrom: 'chrT', start: 0, end: 2_000_000, datasetId: 'lift', width: 800, height: 300, isBAM: true,
  spanningOnly: false, needsLayers: false, requestedLayers: [], needsLayerQualities: false,
  needsMethylation: false, useServerMetaprofile: false, serverMetaprofileLayers: [],
  hasPushedReads: false, myClusterAssignments: {}, myClusterOrder: [], myReadSortOrder: [], myJupyterOrder: [],
  readDisplayMode: 'fit', allReadsDisplayCap: 5000, backgroundReadCap: null, readRowHeight: 3,
  readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
  exportMatchedReadCount: null, exportMatchedReadFetchCount: null, showDuplicateReads: false,
} as Parameters<typeof useReadTrackData>[0];

it('fetches zoomed-out coverage per haplotype, lift identity and refresh, retaining correspondence (probe 2)', async () => {
  let result!: ReturnType<typeof useReadTrackData>;
  function Probe({ hap }: { hap: string }) { result = useReadTrackData({ ...dataParams, liftHap: hap }); return null; }
  const { root } = mount();
  await act(async () => root.render(<Probe hap="MAT" />));
  expect(coverage).toHaveBeenCalledTimes(1);
  expect(coverage.mock.calls[0][7]).toEqual({ liftHap: 'MAT', liftKey: 'v1', refreshGeneration: 0 });
  expect(result.coverageLiveLift).toEqual(correspondence);
  await act(async () => root.render(<Probe hap="PAT" />));
  expect(coverage).toHaveBeenCalledTimes(2);
  expect(coverage.mock.calls[1][7]).toMatchObject({ liftHap: 'PAT' });
  await act(async () => useBrowserStore.setState({ datasets: [{ ...dataset, live_lift: { ...dataset.live_lift!, key: 'v2' } }] }));
  expect(coverage).toHaveBeenCalledTimes(3);
  expect(coverage.mock.calls[2][7]).toMatchObject({ liftKey: 'v2' });
  await act(async () => useBrowserStore.setState({ refreshGeneration: 1 }));
  expect(coverage).toHaveBeenCalledTimes(4);
  expect(coverage.mock.calls[3][7]).toMatchObject({ refreshGeneration: 1 });
});

it('discards an old haplotype response that completes after the new coverage', async () => {
  let finishOld!: (result: CoverageResponse) => void;
  coverage.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  let result!: ReturnType<typeof useReadTrackData>;
  function Probe({ hap }: { hap: string }) { result = useReadTrackData({ ...dataParams, liftHap: hap }); return null; }
  const { root } = mount();
  await act(async () => root.render(<Probe hap="MAT" />));
  expect(result.coverageData).toBeNull();
  await act(async () => root.render(<Probe hap="PAT" />));
  expect(result.coverageData).toEqual([1]);
  await act(async () => finishOld({ coverage: [99], max: 99 }));
  expect(result.coverageData).toEqual([1]);
  expect(result.coverageLiveLift).toEqual(correspondence);
});

it('hatches from map-only correspondence, with the same haplotype/identity/refresh invalidation', async () => {
  let result: number[] | null = null;
  function Probe({ hap }: { hap?: string }) {
    const ds = useBrowserStore(s => s.datasets[0]);
    result = useLiftCorrespondence(ds, 'chrT', 0, 1000, hap, true);
    return null;
  }
  const { root } = mount();
  await act(async () => root.render(<Probe hap="MAT" />));
  expect(result).toEqual([0.25]);
  expect(coverage.mock.calls[0][7]).toEqual({ liftHap: 'MAT', liftKey: 'v1', refreshGeneration: 0, correspondenceOnly: true });
  await act(async () => root.render(<Probe hap="PAT" />));
  expect(result).toEqual([0.5]);
  await act(async () => useBrowserStore.setState({ datasets: [{ ...dataset, live_lift: { ...dataset.live_lift!, key: 'v2' } }] }));
  expect(coverage.mock.calls[2][7]).toMatchObject({ liftKey: 'v2', correspondenceOnly: true });
  await act(async () => useBrowserStore.setState({ refreshGeneration: 1 }));
  expect(coverage.mock.calls[3][7]).toMatchObject({ refreshGeneration: 1, correspondenceOnly: true });
  await act(async () => root.render(<Probe />));
  expect(result).toEqual([0.75]);
  expect(coverage).toHaveBeenCalledTimes(5);
});

it('puts haplotype, lift identity, refresh and map-only mode in the actual coverage URL/cache key', async () => {
  const fetch = vi.fn(async () => ({ ok: true, headers: new Headers(), json: async () => ({ coverage: [], max: 0 }) }));
  vi.stubGlobal('fetch', fetch);
  const { getCoverage } = await vi.importActual<typeof import('../../api/coverage')>('../../api/coverage');
  for (const lift of [
    { liftHap: 'MAT', liftKey: 'v1', refreshGeneration: 0 },
    { liftHap: 'PAT', liftKey: 'v1', refreshGeneration: 0 },
    { liftHap: 'PAT', liftKey: 'v2', refreshGeneration: 0 },
    { liftHap: 'PAT', liftKey: 'v2', refreshGeneration: 1 },
  ]) await getCoverage('chrT', 0, 1000, 200, 'lift', undefined, false, { ...lift, correspondenceOnly: true });
  const urls = fetch.mock.calls.map(call => String((call as unknown[])[0]));
  expect(new Set(urls).size).toBe(4);
  const params = new URL(urls[3], 'http://localhost').searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ lift_hap: 'PAT', lift_key: 'v2', refresh_generation: '1', lift_correspondence_only: 'true' });
});

const read: CompactRead = {
  id: 'r', intervals: [[100, 200, 100], [800, 900, 100]],
  live_lift: { v: 1, hap_label: 'MAT', molecule: 'm', segments: [[100, 900, 0, '+', true]],
    connectors: [[200, 800]], badges: [[450, 'source_insertion', 80, 80, 'I']] },
};

it('counts body bins once per lifted molecule, excludes alternatives, and preserves native rows (probe 3 histogram)', () => {
  const overlap = { ...read, id: 'supp', live_lift: { ...read.live_lift!, segments: [[150, 300, 0, '+', true]], connectors: [] } } as CompactRead;
  const alt = { ...read, live_lift: { ...read.live_lift!, alt: true } };
  expect(Array.from(coverageHistogramBins([alt], 10, 1000))).toEqual(Array(10).fill(0));
  expect(Array.from(coverageHistogramBins([read, overlap], 10, 1000))).toEqual([0, 1, 1, 0, 0, 0, 0, 0, 1, 0]);
  expect(Array.from(coverageHistogramBins([read, { ...read, live_lift: { ...read.live_lift!, molecule: 'other' } }], 10, 1000)))
    .toEqual([0, 2, 0, 0, 0, 0, 0, 0, 2, 0]);
  const native = { ...read, live_lift: undefined };
  expect(Array.from(coverageHistogramBins([native, native], 10, 1000))).toEqual([0, 2, 0, 0, 0, 0, 0, 0, 2, 0]);
});

it.each([false, true])('hits only lifted bodies and badge boxes through the mouse hook, reversed=%s (probe 3 mouse)', async isReversed => {
  let mouse!: ReturnType<typeof useReadTrackMouse>;
  const offset = 50; // Linked rows are relative to their session's bounds, not to the panel's start.
  function Probe() {
    mouse = useReadTrackMouse({ displayReads: [read], width: 1100, height: 200, sidebarWidth: 100,
      regionWidth: 1000, start: 1000, end: 2000, linkedBoundsStart: 1000 + offset, chrom: 'chrT', datasetId: 'lift', stateKey: 'lift', hasCluster: false,
      myClusterAssignments: {}, myClusterOrder: [], myClusterFocus: null, mySelectedClusters: null, hasClusterFocus: false,
      isPanning: false, isReversed, fillReadHeight: false, storeReadRowHeight: 20, readScrollOffset: 0,
      readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1, showReadTooltip: true, showCoverageHistogram: false });
    return null;
  }
  const { root } = mount();
  await act(async () => root.render(<Probe />));
  // Half-sized CSS bounds check the client-to-canvas conversion as well as sidebar/linked/reversed geometry.
  const canvas = { clientWidth: 1100, clientHeight: 200, getBoundingClientRect: () => ({ left: 20, top: 30, width: 550, height: 100 }) };
  const toX = (rel: number) => 100 + (isReversed ? 1000 - rel - offset : rel + offset);
  const eventAt = (x: number, y = 10) => ({ currentTarget: canvas, clientX: 20 + x / 2, clientY: 30 + y / 2,
    shiftKey: true, ctrlKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} }) as unknown as React.MouseEvent<HTMLCanvasElement>;
  const move = (x: number, y = 10) => act(() => mouse.handleMouseMove(eventAt(x, y)));
  move(toX(150));
  expect(mouse.hoveredRead?.read.id).toBe('r');
  expect(mouse.hoveredRead?.liveLiftBadge).toBeUndefined();
  for (const x of [toX(600), toX(50)]) {
    move(x);
    expect(mouse.hoveredRead).toBeNull();
    act(() => mouse.handleClick(eventAt(x)));
    expect(useBrowserStore.getState().selectedReadIds.lift?.size ?? 0).toBe(0);
    act(() => mouse.handleContextMenu(eventAt(x)));
    expect(mouse.contextTarget?.read).toBeNull();
  }
  for (const x of [toX(450) - 2, toX(450) + 35]) {
    move(x);
    expect(mouse.hoveredRead?.read.id).toBe('r');
    expect(mouse.hoveredRead?.liveLiftBadge).toBe(read.live_lift!.badges![0]);
  }
  move(toX(450) + 35, 19); // Outside the label vertically; its connector is still empty.
  expect(mouse.hoveredRead).toBeNull();
  act(() => mouse.handleClick(eventAt(toX(150))));
  expect(useBrowserStore.getState().selectedReadIds.lift?.has('r')).toBe(true);
});

it.each([false, true])('uses the shared palette on the actual header chip and tooltip, dark=%s', async dark => {
  useBrowserStore.setState({ darkMode: dark });
  const { root, host } = mount();
  function Header({ hap }: { hap?: string }) {
    const header = useLiveLiftHeader({ panel: { id: 'p', datasetId: 'lift', liftHap: hap }, dataset } as Parameters<typeof useLiveLiftHeader>[0]);
    return <>{header?.chips}<LiveLiftTooltipLines read={read} /></>;
  }
  for (const hap of ['MAT', 'PAT', undefined]) {
    await act(async () => root.render(<Header hap={hap} />));
    const chip = host.querySelector('[data-testid="live-lift-chip"]') as HTMLElement;
    const color = document.createElement('span');
    color.style.color = liveLiftHaplotypeColor(hap, dark);
    expect(chip.style.color).toBe(color.style.color);
  }
  expect(liveLiftHaplotypeColor('MAT', dark)).not.toBe(liveLiftHaplotypeColor('PAT', dark));
  const hapLine = Array.from(host.querySelectorAll('[data-testid="read-live-lift"] > div')).find(el => el.textContent === 'Haplotype MAT') as HTMLElement;
  const color = document.createElement('span');
  color.style.color = liveLiftHaplotypeColor('MAT', true); // Read tooltips always have a dark background.
  expect(hapLine.style.color).toBe(color.style.color);
});
