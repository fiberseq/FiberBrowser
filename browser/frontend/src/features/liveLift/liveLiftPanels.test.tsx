/** Follow correspondence through the real panel/feed/canvas path. A hook-only
 * test cannot detect a detached coverage track or an early canvas return. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReadTrack } from '../../components/tracks/read-track/ReadTrack';
import { CoverageTrack } from '../../components/tracks/CoverageTrack';
import { ReadTrackActions } from '../../components/tracks/read-track/ReadTrackActions';
import { ReadTooltip } from '../../components/tracks/read-track/ReadTrackTooltip';
import { drawReadTrack } from '../../components/tracks/read-track/ReadTrackCanvas';
import { makeDataViewportKey } from '../../components/tracks/read-track/useReadTrackData';
import { useBrowserStore } from '../../stores/browserStore';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import { ensureBuiltinPanelsRegistered } from '../../stores/__tests__/helpers';
import type { CompactRead } from '../../components/tracks/read-track/types';
import type { Dataset, PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ coverage: vi.fn(), data: vi.fn(), locate: vi.fn(), copy: vi.fn() }));
vi.mock('../../api/coverage', async original => ({ ...await original<object>(), getCoverage: mocks.coverage }));
vi.mock('../../components/tracks/read-track/useReadTrackData', async original => ({
  ...await original<object>(), useReadTrackData: mocks.data,
}));
vi.mock('../../utils/readLocate', async original => ({ ...await original<object>(), locateReads: mocks.locate }));
vi.mock('../../utils/clipboard', () => ({ copyText: mocks.copy }));

const dataset: Dataset = { id: 'lift', label: 'Lift', path: 'x.bam', color: '#000', data_type: 'bam_livelift',
  live_lift: { manifest: 'map', map_label: 'map', haplotypes: ['H#1', 'H#2'], haplotype_labels: { 'H#1': 'MAT', 'H#2': 'PAT' },
    settings: { coverage_hatching: true }, key: 'v1' } };
const read: CompactRead = { id: 'r', intervals: [[200, 300, 100]], live_lift: {
  v: 1, hap_label: 'MAT', segments: [[100, 800, 0, '+', true]], connectors: [], badges: [],
} };
const rows = [read];
const corr = { haplotypes: { MAT: { depth: null, correspondence: [0] }, PAT: { depth: null, correspondence: [1] } },
  pooled: { depth: null, correspondence: [0.5], mode: 'raw' as const }, hatching: true };
const panel = { id: 'p', contentType: 'dataset', datasetId: 'lift', stateKey: 'lift', liftHap: 'MAT' } as PanelConfig;
const originalState = useBrowserStore.getState();
let root: Root;
let host: HTMLDivElement;
type Trace = { strokes: string[]; outlines: number[][] };
let traces: WeakMap<HTMLCanvasElement, Trace>;
function context(trace: Trace) {
  const state: Record<string, unknown> = { strokeStyle: '', fillStyle: '' };
  return new Proxy(state, { get: (target, key: string) => {
    if (key === 'stroke') return () => trace.strokes.push(String(target.strokeStyle));
    if (key === 'strokeRect') return (...args: number[]) => trace.outlines.push(args);
    if (key === 'measureText') return () => ({ width: 1 });
    if (key === 'getLineDash') return () => [];
    if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
    return key in target ? target[key] : () => undefined;
  }, set: (target, key: string, value) => { target[key] = value; return true; } }) as unknown as CanvasRenderingContext2D;
}
beforeEach(() => {
  ensureBuiltinPanelsRegistered();
  useBrowserStore.setState({ ...originalState, datasets: [dataset], panels: [panel], chrom: 'chrT', start: 0, end: 1000,
    showCoverageHistogram: true, maxRegionForReads: 1000, refreshGeneration: 0 }, true);
  useTrackFeedStore.setState({ byStateKey: {} });
  mocks.coverage.mockResolvedValue({ coverage: [0], max: 0, live_lift: corr });
  mocks.locate.mockResolvedValue({ found: [] });
  mocks.copy.mockResolvedValue(true);
  const ref = { current: 1 };
  mocks.data.mockImplementation(p => ({ reads: rows, displayReads: rows, profileReads: rows, loading: false,
    totalReads: 1, totalOverlappingReads: 1, totalSpanningReads: 1, workingReads: 1, hiddenByMinFootprints: 0,
    overlayMarks: {}, fetchSequenceRef: ref, currentDataSequenceRef: ref, dataSequence: 1,
    dataViewportKey: makeDataViewportKey(p.chrom, p.start, p.end, p.datasetId, undefined, undefined, undefined, p.liftHap),
    coverageData: [0], coverageMax: 0, coverageReads: null, coverageLiveLift: corr, fulfilledReadFetchCount: 1 }));
  traces = new WeakMap();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const trace = traces.get(this) ?? { strokes: [], outlines: [] };
    traces.set(this, trace);
    return context(trace);
  } as any);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useTrackFeedStore.setState({ byStateKey: {} });
  useBrowserStore.setState(originalState, true);
});
const hatch = 'rgba(71, 85, 105, 0.55)';

it('publishes correspondence from a normal lifted ReadTrack and hatches the separate CoverageTrack', async () => {
  await act(async () => root.render(<><ReadTrack datasetId="lift" stateKey="lift" width={1000} height={100} liftHap="MAT" publishFeed />
    <CoverageTrack width={1000} height={30} panel={panel} /></>));
  expect(mocks.coverage.mock.calls[0][7]).toMatchObject({ correspondenceOnly: true, liftHap: 'MAT' });
  expect(useTrackFeedStore.getState().byStateKey.lift.liftCorrespondence).toEqual([0]);
  const canvas = host.querySelector('[data-copilot-track="coverage"] canvas') as HTMLCanvasElement;
  expect(traces.get(canvas)?.strokes).toContain(hatch);
  // A correspondence-only update must republish, even when reads are identical.
  await act(async () => root.render(<><ReadTrack datasetId="lift" stateKey="lift" width={1000} height={100} liftHap="PAT" publishFeed />
    <CoverageTrack width={1000} height={30} panel={panel} /></>));
  expect(useTrackFeedStore.getState().byStateKey.lift.liftCorrespondence).toEqual([1]);
});

it.each([false, true])('hatches zoomed-out lifted ReadTrack coverage at zero depth, reversed=%s', async reversed => {
  useBrowserStore.setState({ end: 2000, isReversed: reversed, showCoverageHistogram: false });
  await act(async () => root.render(<ReadTrack datasetId="lift" stateKey="lift" width={1000} height={100} liftHap="MAT" publishFeed />));
  const canvas = host.querySelector('canvas')!;
  expect(traces.get(canvas)?.strokes).toContain(hatch);
});

it('hatches an inline histogram when ReadTrack does not publish a feed', async () => {
  await act(async () => root.render(<ReadTrack datasetId="lift" stateKey="lift" width={1000} height={100} liftHap="MAT" />));
  expect(traces.get(host.querySelector('canvas')!)?.strokes).toContain(hatch);
  expect(useTrackFeedStore.getState().byStateKey.lift).toBeUndefined();
});

it('uses the lifted body for tooltip span and copy-read-locus fallback', async () => {
  await act(async () => root.render(<ReadTooltip hoveredRead={{ read, x: 10, y: 10 }} width={1000} height={100}
    chrom="chrT" start={1000} myClusterAssignments={{}} myReadStateDetails={null} />));
  expect(host.textContent).toContain('Span: 700 bp (chrT:1,100-1,800)');
  const props = { stateKey: 'lift', datasetId: 'lift', chrom: 'chrT', start: 1000, end: 2000,
    reads: rows, layout: { rowHeight: 10, rowGap: 0, trackHeight: 100, scrollAdjust: 0, needsScroll: false, maxScrollOffset: 0 },
    rowsTop: 0, width: 1000, sidebarWidth: 0, regionWidth: 1000, isReversed: false,
    contextTarget: { read, x: 1, y: 1, clientX: 1, clientY: 1, genomePos: 1200, footprint: null },
    closeContextMenu() {}, selectFootprintAt: () => false, selectReadById() {} };
  await act(async () => root.render(<ReadTrackActions {...props} />));
  const copy = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Copy locus of read'));
  expect(copy).toBeDefined();
  await act(async () => copy!.click());
  expect(mocks.copy).toHaveBeenCalledWith('chrT:1,100-1,800');
});

it.each([false, true])('outlines the lifted body on selection and highlight, reversed=%s', reversed => {
  const canvas = document.createElement('canvas');
  const base = { canvas, displayReads: rows, width: 1000, height: 100, regionWidth: 1000, chrom: 'chrT', start: 0, end: 1000,
    datasetId: 'lift', sidebarWidth: 0, hasCluster: false, myClusterAssignments: {}, myClusterOrder: [], hasClusterFocus: false,
    enabledModTypes: {}, enabledCigarTypes: {}, isBAM: true, fillReadHeight: true, storeReadRowHeight: 10, readScrollOffset: 0,
    readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1, showCoverageHistogram: false, isReversed: reversed,
    activeColormap: originalState.activeColormap, genes: [], allPeaks: [], orthogonalTracks: [], modificationOverlays: [],
    overlayMarks: {}, jupyterReadHighlights: new Map(), jupyterFootprintColorMap: new Map(), allJupyterMarkers: [],
    selectedReadIds: new Set(['r']), readHighlightIds: new Set(['r']), selectedFootprints: [], footprintGroups: [],
    clusterStateConsensus: new Map(), hasFilter: false, maxRegionForReads: 1000 };
  drawReadTrack(base as Parameters<typeof drawReadTrack>[0]);
  const x = reversed ? 200 : 100;
  expect(traces.get(canvas)?.outlines.some(([left, , width]) => left === x - 1 && width === 702)).toBe(true);
  expect(traces.get(canvas)?.outlines.some(([left, , width]) => left === x - 1.5 && width === 703)).toBe(true);
});
