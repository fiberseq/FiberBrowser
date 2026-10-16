import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchJson } from '../../api/sharedFetch';
import { SyncPanel } from './SyncPanel';
import { useAnchorPick } from './anchors';
import { useSyncPanelState } from './panelState';
import { useSyncSettings, DEFAULT_SYNC_SETTINGS, SYNC_SETTINGS_KEY } from './settings';
import type { SyncResult } from './model';
vi.mock('../../api/reference', async (original) => ({ ...await original<typeof import('../../api/reference')>(), getSequence: vi.fn(async () => ({ sequence: 'A' })), getGenes: vi.fn(async () => ({ genes: [] })) }));
vi.mock('../../api/sharedFetch', async (original) => ({ ...await original<typeof import('../../api/sharedFetch')>(), fetchJson: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement, root: Root;
const q = (id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const click = (id: string) => act(async () => q(id).dispatchEvent(new MouseEvent('click', { bubbles: true })));
const result: SyncResult = {
  metrics: ['sequence'], windows: ['a', 'b'].map(id => ({ panelId: id, datasetId: id, genome: null, chrom: 'chr1', start: 100, end: 1100, label: id })),
  proposals: [{ id: 'p', panelId: 'b', partnerId: 'a', rank: 0, template: [100, 1100], window: [100, 1100], strand: '-', sources: ['sequence'], metrics: { sequence: { verdict: 'supports', score: 1 } }, status: 'single-metric', confidence: 1, supports: 1, assessed: 1 }],
  coverage: { a: Array.from({ length: 25 }, () => [[0, 1000]]), b: Array.from({ length: 25 }, () => [[0, 1000]]) }, notes: []
};
beforeEach(() => {
  useSyncPanelState.setState({}, true);
  useSyncSettings.setState(DEFAULT_SYNC_SETTINGS, true);
  localStorage.removeItem(SYNC_SETTINGS_KEY);
  useBrowserStore.setState({
    panels: ['a', 'b'].map(id => ({ id, datasetId: id, contentType: 'dataset', subTracks: [], collapsed: false, layoutRow: 0, linkGroup: null, viewportOverride: { chrom: 'chr1', start: 100, end: 1100 } })),
    datasets: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], comparisonFrames: [], activeComparisonFrameId: null, chrom: 'chr1', start: 100, end: 1100, filteredReadIds: {}, selectedClusters: {}, clusterFocus: {}, clusterAssignments: {}
  } as never);
  vi.mocked(fetchJson).mockReset().mockImplementation(async (_url, options) => options?.method === 'POST' ? { id: 'job', state: 'queued', message: 'Queued', result: null } as never : { id: 'job', state: 'complete', message: 'Ready', result } as never);
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); node.remove(); });
it('loads scoped coverage before accepting a known correspondence', async () => {
  useBrowserStore.setState({ filteredReadIds: { a: new Set(['read-a']), b: new Set(['read-b']) } });
  await act(async () => root.render(<SyncPanel />));
  await click('sync-use-correspondence');
  const body = JSON.parse(vi.mocked(fetchJson).mock.calls.find(([, o]) => o?.method === 'POST')![1]!.body as string);
  expect(body.coverageOnly).toBe(true);
  expect(body.windows.map((w: any) => w.readIds)).toEqual([['read-a'], ['read-b']]);
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  await click('sync-proposal-automatic-a-b');
  expect(q('sync-checklist').textContent).toContain('25 reads cover');
  expect((q('sync-accept') as HTMLButtonElement).disabled).toBe(false);
  await click('sync-accept');
  expect(useBrowserStore.getState().comparisonFrames).toHaveLength(1);
});
it('searches, selects a reversed match, accepts a frame, and clears transient state on session import', async () => {
  await act(async () => root.render(<SyncPanel />));
  await click('sync-find');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  expect(q('sync-map')).toBeTruthy();
  // After Find the windows and metrics fold into one line; Edit reopens them.
  expect(q('sync-windows')).toBeNull();
  expect(q('sync-setup-summary').textContent).toContain('2 windows · template W1 · sequence');
  expect(q('sync-refine')).toBeNull();
  await click('sync-setup-summary');
  expect(q('sync-window-a').textContent).toContain('W1');
  expect(q('sync-window-b').textContent).toContain('W2');
  await click('sync-ribbon-p');
  expect(q('sync-checklist').textContent).toContain('25 reads cover ≥80% (need 20) · 25 span all of it');
  expect(q('sync-why').textContent).toContain('Sequence supports (100% identity)');
  expect(q('sync-comparable-summary').textContent).toBe('Comparable ✓');
  expect(q('sync-proposal-p').getAttribute('aria-selected')).toBe('true');
  expect(q('sync-refine-start').closest('label')?.textContent).toBe('Template start');
  expect(q('sync-refine-end').closest('label')?.textContent).toBe('Template end');
  expect(q('sync-refine-row-b').textContent).toContain('W2 · chr1:100–1,100 (-)');
  expect(q('sync-refine-row-b').textContent).toContain('1 block · maps 1,000 of 1,000 frame bp');
  expect((q('sync-accept') as HTMLButtonElement).disabled).toBe(false);
  await click('sync-accept');
  expect(useBrowserStore.getState().comparisonFrames[0].windows[1].strand).toBe('-');
  expect(q('sync-active-frame').textContent).toContain('1,000 bp');
  await act(async () => useAnchorPick.setState(s => ({ epoch: s.epoch + 1 })));
  expect(q('sync-map')).toBeNull();
});
it('refuses accepting a result after a panel moves', async () => {
  await act(async () => root.render(<SyncPanel />));
  await click('sync-find');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  await click('sync-ribbon-p');
  await act(async () => useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === 'b' ? { ...p, viewportOverride: { chrom: 'chr2', start: 100, end: 1100 } } : p) })));
  expect((q('sync-accept') as HTMLButtonElement).disabled).toBe(true);
  expect(q('sync-results-notes').textContent).toContain('Search again');
});

it('explains zero spanning reads and keeps window identities after template reordering', async () => {
  vi.mocked(fetchJson).mockImplementation(async (_url, options) => options?.method === 'POST'
    ? { id: 'job', state: 'queued', message: 'Queued', result: null } as never
    : { id: 'job', state: 'complete', message: 'Ready', result: { ...result, windows: [...result.windows].reverse(), proposals: [{ ...result.proposals[0], panelId: 'a', partnerId: 'b' }], coverage: {} } } as never);
  await act(async () => root.render(<SyncPanel />));
  await click('sync-find');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  await click('sync-ribbon-p');
  expect(q('sync-lane-a').textContent).toContain('W2 template');
  expect(q('sync-comparable-summary').textContent).toBe('1 issue');
  expect(q('sync-checklist').textContent).toContain('W2: 0 reads cover ≥80% (need 20) · 0 span all of it');
  expect(q('sync-checklist').textContent).toContain('Too few reads cover 80% of 1,000 bp: shorten the sub-window or lower the coverage.');
  expect((q('sync-accept') as HTMLButtonElement).disabled).toBe(true);
});

it('runs the clustering check on the refined windows and shows window shares', async () => {
  await act(async () => root.render(<SyncPanel />));
  await click('sync-find');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  await click('sync-ribbon-p');
  vi.mocked(fetchJson).mockImplementation(async (url) => String(url).endsWith('/cluster')
    ? { windows: [{ key: 'a', panelId: 'a', eligible: 25, used: 25, total: 25, clusters: [20, 5] }, { key: 'b', panelId: 'b', eligible: 25, used: 25, total: 25, clusters: [10, 15] }], clusters: [{ cluster: 0, reads: 30, windows: 2, agreement: .9 }, { cluster: 1, reads: 20, windows: 2, agreement: null }], k: 2, separation: .41, agreement: .8, fitted: 50, seconds: .2 } as never
    : { id: 'job', state: 'complete', message: 'Ready', result } as never);
  await click('sync-cluster-run');
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const body = JSON.parse(String(vi.mocked(fetchJson).mock.calls.at(-1)![1]!.body));
  expect(body.windows.map((w: { strand: string }) => w.strand)).toEqual(['+', '-']);
  expect(body.minCover).toBe(0.8);
  expect(body.length).toBe(1000);
  expect(body.windows[1].blocks).toEqual([{ frame: [0, 1000], genomic: [100, 1100] }]);
  expect(q('sync-cluster-result').textContent).toContain('window profiles agree r 0.90');
  expect(q('sync-cluster-result').textContent).toContain('largely separate the windows (NMI 0.41)');
});

it('keeps the map when the panel remounts (full view, dock)', async () => {
  await act(async () => root.render(<SyncPanel />));
  await click('sync-find');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  await click('sync-ribbon-p');
  await act(async () => root.render(<div />));
  await act(async () => root.render(<SyncPanel isFullView />));
  expect(q('sync-map')).toBeTruthy();
  expect(q('sync-proposal-p').getAttribute('aria-selected')).toBe('true');
  expect(q('sync-checklist')).toBeTruthy();
});

it('pools repeated copies of a window, one frame window each, and hides a cluster check from an older selection', async () => {
  const copy = { ...result.proposals[0], id: 'copy', template: [100, 1100] as [number, number], window: [100, 1100] as [number, number], strand: '+' as const, confidence: .9 };
  vi.mocked(fetchJson).mockImplementation(async (url, options) => String(url).endsWith('/cluster')
    ? { windows: [{ key: 'a', panelId: 'a', eligible: 25, used: 25, total: 25, clusters: [20, 5] }, { key: 'b#a', panelId: 'b', eligible: 25, used: 25, total: 25, clusters: [10, 15] }, { key: 'b#b', panelId: 'b', eligible: 25, used: 25, total: 25, clusters: [5, 20] }], clusters: [{ cluster: 0, reads: 35, windows: 3, agreement: .9 }], k: 2, separation: .1, agreement: .8, fitted: 75, seconds: .2 } as never
    : options?.method === 'POST' ? { id: 'job', state: 'queued', message: 'Queued', result: null } as never
      : { id: 'job', state: 'complete', message: 'Ready', result: { ...result, proposals: [result.proposals[0], copy] } } as never);
  await act(async () => root.render(<SyncPanel />));
  await click('sync-find');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  await click('sync-ribbon-p');
  expect(q('sync-refine-row-b').textContent).toContain('(-)');
  // Tick the second copy: both are used, as W2a and W2b.
  await act(async () => q('sync-copy-copy-input').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(q('sync-refine-row-b#a')).toBeTruthy();
  expect(q('sync-refine-row-b#b')).toBeTruthy();
  expect(q('sync-checklist').textContent).toContain('W2a:');
  expect(q('sync-checklist').textContent).toContain('W2b:');
  // The last chosen copy cannot be unticked.
  await act(async () => q('sync-copy-p-input').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(q('sync-refine-row-b').textContent).toContain('(+)');
  expect((q('sync-copy-copy-input') as HTMLInputElement).disabled).toBe(true);
  await act(async () => q('sync-copy-p-input').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await click('sync-cluster-run');
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const body = JSON.parse(String(vi.mocked(fetchJson).mock.calls.at(-1)![1]!.body));
  expect(body.windows.map((w: { key: string }) => w.key)).toEqual(['a', 'b#a', 'b#b']);
  expect(q('sync-cluster-result').textContent).toContain('W2b');
  const cover = q('sync-min-cover') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(cover, '60');
    cover.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(q('sync-cluster-result')).toBeNull();
});

it('keeps Advanced thresholds per viewer, resets them and sends them with the search', async () => {
  await act(async () => root.render(<SyncPanel />));
  const knob = q('sync-knob-maxIndel') as HTMLInputElement;
  const set = (el: HTMLInputElement, v: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await set(knob, '500');
  await set(q('sync-knob-sequenceCover') as HTMLInputElement, '70');
  await set(q('sync-knob-profileAloneZ') as HTMLInputElement, '999');
  expect(JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY)!)).toMatchObject({ maxIndel: 500, sequenceCover: 70, profileAloneZ: 50 });
  await click('sync-find');
  const body = JSON.parse(String(vi.mocked(fetchJson).mock.calls.find(c => c[1]?.method === 'POST')![1]!.body));
  expect(body.thresholds).toMatchObject({ maxIndel: 500, sequenceCover: 0.7, profileAloneZ: 50, profileSupport: 0.3, profileAloneR: 0.4, shapeMinR: 0.6, shapeMinZ: 4, shapeWidth: 300, shapeLandmarks: 0 });
  expect(body.metrics).toContain('shape');
  expect(body.minimum).toBe(200);
  // The landmark switch is a checkbox in Advanced, sent as 1.
  await act(async () => q('sync-knob-shapeLandmarks-input').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(useSyncSettings.getState().shapeLandmarks).toBe(1);
  await click('sync-knob-reset-maxIndel');
  expect((q('sync-knob-maxIndel') as HTMLInputElement).value).toBe('2000');
  await click('sync-knob-defaults');
  expect(useSyncSettings.getState()).toEqual(DEFAULT_SYNC_SETTINGS);
});

it('opens compactly: windows, metrics and Find with no inner scroll box or empty results area', async () => {
  await act(async () => root.render(<SyncPanel />));
  const order = ['sync-windows', 'sync-metrics', 'sync-find'].map(id => q(id));
  expect(order.every(Boolean)).toBe(true);
  expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(node.querySelector('.max-h-\\[400px\\]')).toBeNull();
  expect(q('sync-map')).toBeNull();
  expect(q('sync-job')).toBeNull();
  expect(q('sync-active-frame')).toBeNull();
});

it('says why nothing was found and locates the window in the template reference', async () => {
  const empty: SyncResult = { ...result, windows: result.windows.map(w => w.panelId === 'b' ? { ...w, chrom: 'chr2' } : w), proposals: [], notes: [{ panelId: 'b', kind: 'nothing', text: 'nothing comparable with the template: no shared sequence of at least 100 bp between the two windows.' }] };
  vi.mocked(fetchJson).mockImplementation(async (url, options) => String(url).endsWith('/locate')
    ? { id: 'loc', state: 'queued', message: 'Queued', result: null } as never
    : String(url).endsWith('/jobs/loc') ? { id: 'loc', state: 'complete', message: 'Search finished', result: { length: 1000, searched: 'main', loci: [{ chrom: 'chr2L', start: 9464470, end: 9465192, strand: '+', aligned: 722, identity: .99, query: [100, 822], inTemplate: false }] } } as never
      : options?.method === 'POST' ? { id: 'job', state: 'queued', message: 'Queued', result: null } as never
        : { id: 'job', state: 'complete', message: 'Ready', result: empty } as never);
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === 'b' ? { ...p, viewportOverride: { chrom: 'chr2', start: 100, end: 1100 } } : p) }));
  await act(async () => root.render(<SyncPanel />));
  expect(q('sync-same-locus')).toBeNull();
  await click('sync-find');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  expect(q('sync-nothing')).not.toBeNull();
  expect(q('sync-proposal-automatic-a-b')).toBeNull();
  expect(q('sync-note-nothing').textContent).toContain('no shared sequence');
  expect(q('sync-map')).toBeNull();
  await click('sync-locate-run-b');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  expect(q('sync-loci-b').textContent).toContain('chr2L:9,464,470–9,465,192 (+)');
  expect(JSON.parse(String(vi.mocked(fetchJson).mock.calls.find(c => String(c[0]).endsWith('/locate'))![1]!.body))).toMatchObject({ template: { panelId: 'a' }, query: { panelId: 'b' } });
});

it('finds repeats with one ticked window, groups three copies on its lane and accepts W1a–c', async () => {
  const repeats: SyncResult = { ...result, windows: [result.windows[0]], proposals: [
    { ...result.proposals[0], id: 'ab', panelId: 'a', template: [100, 300], window: [450, 650], strand: '+' },
    { ...result.proposals[0], id: 'ac', panelId: 'a', template: [100, 300], window: [800, 1000], strand: '-' },
    { ...result.proposals[0], id: 'bc', panelId: 'a', template: [450, 650], window: [800, 1000], strand: '-' },
  ] };
  useBrowserStore.setState(s => ({ panels: s.panels.slice(0, 1) }));
  vi.mocked(fetchJson).mockImplementation(async (_url, options) => options?.method === 'POST'
    ? { id: 'job', state: 'queued', message: 'Queued', result: null } as never
    : { id: 'job', state: 'complete', message: 'Ready', result: repeats } as never);
  await act(async () => root.render(<SyncPanel />));
  expect(q('sync-find').textContent).toContain('Find repeats in this window');
  expect((q('sync-find') as HTMLButtonElement).disabled).toBe(false);
  await click('sync-find');
  await act(async () => { await new Promise(r => setTimeout(r, 550)); });
  expect(node.querySelectorAll('[data-testid^="sync-bar-"]')).toHaveLength(1);
  expect(node.querySelectorAll('[data-testid^="sync-ribbon-"]')).toHaveLength(3);
  expect(q('sync-ribbon-ac').getAttribute('aria-label')).toContain('reversed');
  expect(node.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(q('sync-repeat-group-ab').textContent).toContain('3 copies');
  await click('sync-proposal-ab');
  expect(q('sync-refine-row-a#a').textContent).toContain('W1a');
  expect(q('sync-refine-row-a#b').textContent).toContain('W1b');
  expect(q('sync-refine-row-a#c').textContent).toContain('W1c');
  expect(q('sync-copies-a')).toBeTruthy();
  await click('sync-accept');
  const saved = useBrowserStore.getState().comparisonFrames[0];
  expect(saved.windows.map(w => [w.panelId, w.copy, w.start, w.end, w.strand])).toEqual([
    ['a', 'a', 100, 300, '+'], ['a', 'b', 450, 650, '+'], ['a', 'c', 800, 1000, '-'],
  ]);
});

it('keeps map and member checkboxes together, accepts two three-window blocks, and undoes the batch', async () => {
  const windows = ['a', 'b', 'c'].map(id => ({ ...result.windows[0], panelId: id, datasetId: id }));
  const proposals = [200, 600].flatMap((start, i) => ['b', 'c'].map((id, j) => ({ ...result.proposals[0], id: `${i}-${id}`,
    partnerId: j ? 'b' : 'a', panelId: id, strand: '+' as const, template: [start, start + 100] as [number, number], window: [start, start + 100] as [number, number] })));
  const multi = { ...result, windows, proposals };
  useBrowserStore.setState({ peakRules: [], peaksByRule: {}, _historyStack: [], _historyPointer: -1,
    panels: windows.map(w => ({ id: w.panelId, datasetId: w.datasetId, contentType: 'dataset', subTracks: [], viewportOverride: { chrom: w.chrom, start: w.start, end: w.end } })),
    datasets: windows.map(w => ({ id: w.datasetId, label: w.label })) } as never);
  useSyncPanelState.setState({ result: multi, epoch: useAnchorPick.getState().epoch });
  await act(async () => root.render(<SyncPanel />));
  const members = () => [...node.querySelectorAll<HTMLInputElement>('[data-testid^="sync-member-"] input')];
  expect(members()).toHaveLength(6);
  expect(members().every(e => e.checked)).toBe(true);
  const mapMember = node.querySelector<HTMLButtonElement>('[data-testid^="sync-map-member-"]')!;
  await act(async () => mapMember.click());
  expect(members().filter(e => e.checked)).toHaveLength(5);
  expect(mapMember.getAttribute('aria-pressed')).toBe('false');
  await act(async () => members().find(e => !e.checked)!.click());
  expect(mapMember.getAttribute('aria-pressed')).toBe('true');
  await click('sync-accept-blocks');
  expect(useBrowserStore.getState().comparisonFrames.map(f => f.windows.length)).toEqual([3, 3]);
  expect(useBrowserStore.getState().peakRules.filter(r => r.source === 'matched')).toHaveLength(2);
  await act(async () => useBrowserStore.getState().undo());
  expect(useBrowserStore.getState().comparisonFrames).toHaveLength(0);
  expect(useBrowserStore.getState().peakRules.filter(r => r.source === 'matched')).toHaveLength(0);
});
