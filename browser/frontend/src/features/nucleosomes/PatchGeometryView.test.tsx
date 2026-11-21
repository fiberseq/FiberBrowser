import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchGeometryView, DEFAULT_PATCH_PARAMS, DEFAULT_LOW_PARAMS, requestPatchParams } from './PatchGeometryView';
import { useNucGeoFocusStore } from '../../stores/nucGeoFocusStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { nucGeometries } from './api';
import { applyReadGroups } from '../../utils/readGroups';
import { useBrowserStore } from '../../stores/browserStore';
import { buildNucRegRows, describeNucPatch, nucGeoColor, nucPatchRows, nucRegInReach, NUC_PATCH_COLOR, NUC_PATCH_LOW_COLOR } from '../../utils/nucLayers';
import { drawNucRegLane, NUC_REG_HATCH } from '../../components/tracks/read-track/nucRegCanvas';
import { drawNucPatchLane } from '../../components/tracks/read-track/nucPatchCanvas';
import type { RegSeries } from './RegularityView';
import { registerGeometryFeatures, geoHitId, GEO_KIND } from './geoHub';
import { registerSavedGeometries, matchSaved } from './savedGeometries';
import { useNucGeoRuns } from './geoRuns';
import { geometryTrackLanes } from './GeometryFeatureTrack';
import { hubProviders, hitSelectionEntry, selectionRefs } from '../hub/hubState';
import { featureKey, featureKindDef } from '../../stores/featureStore';
import { useNucJob } from './nucJob';
import type { NucGeometryResult, NucPanelState } from './types';

vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), nucGeometries: vi.fn() }));
vi.mock('./nucJob', async original => ({ ...(await original<typeof import('./nucJob')>()), refreshNucDatasets: vi.fn(async () => undefined) }));
vi.mock('../../utils/readGroups', async original => ({ ...(await original<typeof import('../../utils/readGroups')>()), applyReadGroups: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const enc = (s: number) => 1 + Math.round(Math.min(1, Math.max(0, (s + 2) / 10)) * 254);

describe('patch and gap helpers', () => {
  it('decodes nucpatch rows: flags, geometry and root', () => {
    const rows = nucPatchRows({ intervals: [[500, 2000, 1500], [100, 300, 200]],
      qualities: [[enc(5), enc(4)], [90, 86], [1 | 8, 0], [4, 0], [2, 0]] })!;
    expect(rows.map(r => r.start)).toEqual([100, 500]);
    const p = rows[1];
    expect(p.openStart && p.snappedEnd && !p.openEnd).toBe(true);
    expect(p.geometry).toBe(4); expect(p.root).toBe(2); expect(p.period).toBe(190);
    expect(describeNucPatch(p)).toContain('G4 (part of G2)');
    expect(describeNucPatch(p)).toContain('open start');
  });

  it('marks gaps inside the window reach as too few calls and leaves the rest empty', () => {
    const rows = buildNucRegRows({ intervals: [[1000, 1250, 250], [1250, 1500, 250], [2000, 2250, 250]],
      qualities: [[enc(3), enc(5), enc(7)], [90, 90, 90]], reach: [500, 3000] } as never)!;
    expect(rows.reach).toEqual([500, 3000]);
    expect(nucRegInReach(rows, 1700)).toBe(true);
    expect(nucRegInReach(rows, 3200)).toBe(false);
    const fills: Array<{ x: number; c: string }> = [];
    const ctx = { save() {}, restore() {}, globalAlpha: 1, fillStyle: '', fillRect(x: number) { fills.push({ x, c: String(this.fillStyle) }); } };
    drawNucRegLane(ctx as never, rows, { y: 0, bodyH: 10, linkedOffset: 0, regionWidth: 4000, toX: v => v, full: false });
    const hatched = fills.filter(f => f.c === NUC_REG_HATCH).map(f => f.x);
    expect(hatched.some(x => x > 1600 && x < 1900)).toBe(true);     // the unscored window between tiles
    expect(hatched.some(x => x >= 500 && x < 1000)).toBe(true);     // inside reach before the first tile
    expect(hatched.every(x => x >= 500 && x < 3000)).toBe(true);    // never beyond reach
    // stretched outer tiles (read-end modes) do not widen the interpolation step
    const ext = buildNucRegRows({ intervals: [[0, 1125, 1125], [1125, 1375, 250], [1375, 1625, 250]],
      qualities: [[enc(3), enc(4), enc(5)], [90, 90, 90]] })!;
    expect(ext.step).toBe(250);
  });

  it('draws one bar per patch in its geometry colour', () => {
    const fills: Array<{ w: number; c: string }> = [];
    const ctx = { save() {}, restore() {}, globalAlpha: 1, fillStyle: '', fillRect(_x: number, _y: number, w: number) { fills.push({ w, c: String(this.fillStyle) }); } };
    const rows = nucPatchRows({ intervals: [[0, 1000, 1000], [2000, 3000, 1000]], qualities: [[enc(5), enc(5)], [90, 90], [0, 0], [3, 0], [1, 0]] })!;
    expect(drawNucPatchLane(ctx as never, rows, { y: 0, bodyH: 10, linkedOffset: 0, regionWidth: 4000, toX: v => v / 10, withRegLane: true })).toBe(2);
    expect(fills[0].c).toBe(nucGeoColor(1));
    expect(fills[1].c).toBe(NUC_PATCH_COLOR);
  });

  it('decodes the low-regularity flag and colours low patches in the cool palette; focus dims the others', () => {
    const rows = nucPatchRows({ intervals: [[0, 1000, 1000], [2000, 3000, 1000], [3500, 3800, 300]],
      qualities: [[enc(5), enc(-1), enc(-1)], [90, 0, 0], [0, 16, 16], [1, 2, 0], [1, 2, 0]] })!;
    expect(rows.map(r => r.kind)).toEqual(['high', 'low', 'low']);
    expect(describeNucPatch(rows[1])).toContain('low-regularity patch · L2');
    const fills: Array<{ c: string; a: number }> = [];
    const ctx = { save() {}, restore() {}, globalAlpha: 1, fillStyle: '', fillRect() { fills.push({ c: String(this.fillStyle), a: this.globalAlpha }); } };
    drawNucPatchLane(ctx as never, rows, { y: 0, bodyH: 10, linkedOffset: 0, regionWidth: 4000, toX: v => v / 10, withRegLane: true, focused: new Set(['low:2']) });
    expect(fills[0]).toEqual({ c: nucGeoColor(1, 'high'), a: 0.22 });
    expect(fills[1]).toEqual({ c: nucGeoColor(2, 'low'), a: 1 });
    expect(fills.some(f => f.c === NUC_PATCH_LOW_COLOR)).toBe(true);
    expect(nucGeoColor(1, 'low')).not.toBe(nucGeoColor(1, 'high'));
  });
});

const series: RegSeries[] = [
  { obsId: 'a', datasetId: 'a', panelId: 'pa', stateKey: 'a', label: '2-4 h', color: '#111', kind: 'linear', chrom: 'chr2R', start: 1000, end: 9000, seriesColor: '#111', datasetIndex: 0 },
  { obsId: 'b', datasetId: 'b', panelId: 'pb', stateKey: 'b', label: '6-8 h', color: '#222', kind: 'linear', chrom: 'chr2R', start: 1000, end: 9000, seriesColor: '#222', dash: '5 3', datasetIndex: 1 },
];

const per = (full: number, partial: number) => ({ molecules: 100, full, partial, callable: 90, fullShare: full / 100, partialShare: partial / 100, score: 4.1 });
const geo = (i: number, start: number, end: number, parentIndex: number | null, partial = 0, kind: 'high' | 'low' = 'high', number = i + 1) => ({
  id: `${kind === 'low' ? 'L' : 'G'}${number}`, kind, number, rootNumber: parentIndex != null ? parentIndex + 1 : number,
  geometryId: `G${i + 1}_x`, start, end, width: end - start, openLeft: false, openRight: i === 0, molecules: 30, patches: 31,
  startMad: 200, endMad: 150, score: 4.2, period: 188, parent: parentIndex != null ? `G${parentIndex + 1}` : null, parentIndex,
  children: [], perObservation: { a: per(6, partial), b: per(21, partial) }, densityMatched: { a: 0.07, b: 0.18 },
});

const result = (fold: string): NucGeometryResult => ({
  window: { chrom: 'chr2R', start: 1000, end: 9000 }, params: { patch: {}, geometry: { fold }, view: {} },
  references: { a: 3.01, b: 3.27 }, errors: {}, nMolecules: 200, nPatches: 340, kinds: ['high', 'low'], nPatchesByKind: { high: 300, low: 40 },
  geometries: fold === 'none' ? [geo(0, 4000, 9000, null), geo(1, 4000, 6000, null), geo(2, 1500, 3000, null, 0, 'low', 1)]
    : [geo(0, 4000, 9000, null, 38), geo(1, 4000, 6000, 0), geo(2, 1500, 3000, null, 0, 'low', 1)],
  nested: [{ kind: 'high', child: 'G2', parent: 'G1', shared: 'start', moved: 3000, near: false, folded: fold !== 'none', rest: [6000, 9000],
    shortOnly: 0.8, longCarriers: 1.6, noGeometry: 0.2, nShortOnly: 20 }],
  stack: [{ id: 'G1', n: 31, patches: [[4000, 9000], [4100, 8900]] }, { id: 'G2', n: 31, patches: [[4000, 6000]] }, { id: 'L1', kind: 'low', n: 5, patches: [[1500, 3000]] }],
  profiles: { edges: [1000, 3000, 5000, 7000, 9000], carriers: { G1: [0.1, 1, 2, 2], G2: [0.1, 2, 1, 0.5], L1: [-1, -1, 0, 0] }, none: [0, 0.2, 0.3, 0.1],
    share: { a: [0.1, 0.2, 0.3, 0.2], b: [0.2, 0.3, 0.4, 0.3] }, shareLow: { a: [0.05, 0, 0, 0], b: [0.02, 0, 0, 0] } },
  patchStats: { a: { molecules: 100, patches: 160, perMolecule: 1.6, shareInPatches: 0.21, medianClosed: 1750, score: 4.3, lengths: { edges: [0, 1000, 2000], counts: [3, 5], n: 8 },
    low: { molecules: 100, patches: 20, perMolecule: 0.2, shareInPatches: 0.03, medianClosed: 750, score: 1.2, lengths: { edges: [0, 1000, 2000], counts: [4, 1], n: 5 } } },
    b: { molecules: 100, patches: 180, perMolecule: 1.8, shareInPatches: 0.25, medianClosed: 1750, score: 4.6, lengths: { edges: [0, 1000, 2000], counts: [2, 6], n: 8 } } },
  assignments: { a: { group: { r1: 1, r2: 0, r3: 2 }, groupLow: { r1: 0, r2: 3, r3: 0 }, carried: { r1: [1], r2: [3], r3: [2] }, partial: { r1: [], r2: [], r3: [1] } },
    b: { group: { r4: 1 }, groupLow: { r4: 0 }, carried: { r4: [1] }, partial: {} } },
  association: { sites: [{ pos: 3000, share: 0.4 }], site: 3000, state: 'nfr', show: 'patch', stateNames: ['closed', 'open'],
    profiles: { edges: [1000, 5000, 9000], series: [{ obsId: 'a', state: 0, n: 40, values: [0.1, 0.2] }, { obsId: 'a', state: 1, n: 60, values: [0.2, 0.3] }] },
    table: [{ obsId: 'a', state: 0, molecules: 40, m6aPerKb: 55, upShare: 0.1, upScore: 0.2, downShare: 0.2, downScore: 0.3, matched: null, upLowShare: 0.02, downLowShare: 0.01 },
      { obsId: 'a', state: 1, molecules: 60, m6aPerKb: 70, upShare: 0.15, upScore: 0.3, downShare: 0.25, downScore: 0.5, matched: { up: 0.01, down: -0.02 },
        upLowShare: 0.01, downLowShare: 0.0, matchedLow: { up: -0.01, down: 0 } }],
    tests: { rows: [{ a: 'G1', b: 'site', n: 90, or_mh: 1.4, p_exact: 0.3, q: 0.5 }], method: 'fiberhmm.assoc.cooccur' } },
  timings: { total: 1.2 }, updatedDatasets: [], cached: false,
});

describe('PatchGeometryView', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.mocked(nucGeometries).mockReset();
    vi.mocked(applyReadGroups).mockReset();
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

  // The settings drawer open, so every control is in the DOM; `tab` picks the panel tab (default: the geometries).
  const render = async (settings: NucPanelState, setSettings = vi.fn(), tab: 'geometries' | 'charts' | 'site' = 'geometries') => {
    await act(async () => { root.render(<PatchGeometryView series={series} cohort="overlapping" settings={settings} setSettings={setSettings} revision="0" includeDuplicates={false}
      settingsOpen tab={tab} />); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve(); });
    return setSettings;
  };

  it('a view needing an Analyse while another panel’s runs waits (never an empty list); afterwards it offers the button', async () => {
    const empty = { ...result('near'), nMolecules: 0, nPatches: 0, geometries: [], patchStats: {}, nested: [], stack: [] } as never;
    vi.mocked(nucGeometries).mockResolvedValue(empty);
    useNucJob.setState({ job: { job_id: 'other', status: 'running', datasets: ['x'], results: {}, created_at: 0 } as never, panelId: 'other-panel' });
    const view = () => <PatchGeometryView series={series} cohort="overlapping" settings={{}} setSettings={vi.fn()} revision="0" includeDuplicates={false}
      needsAnalyse={['a', 'b']} onAnalyseView={vi.fn()} />;
    await act(async () => { root.render(view()); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="nuc-geo-analysing"]')?.textContent).toMatch(/Another panel/);
    expect(container.querySelector('[data-testid="nuc-geo-card"]')).toBeNull();
    await act(async () => { useNucJob.setState({ job: null, panelId: null }); });
    expect(container.querySelector('[data-testid="nuc-geo-needs-analyse"]')).not.toBeNull();
  });

  it('asks for nothing while closed', async () => {
    await render({ regularity: { patches: { open: false } } });
    expect(nucGeometries).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="nuc-patch-controls"]')).toBeNull();
  });

  it('is open by default (the Regularity view discrete calls) and asks with low-regularity calling on', async () => {
    vi.mocked(nucGeometries).mockResolvedValue(result('near'));
    await render({});
    expect(nucGeometries).toHaveBeenCalledTimes(1);
    expect(vi.mocked(nucGeometries).mock.calls[0][1].patches).toEqual({ low: {} });
    expect(requestPatchParams({ low: null })).toEqual({ low: null });
  });

  it('sends the cohort; shows each dataset’s reference source and lets a dataset adopt an open scan’s reference', async () => {
    vi.mocked(nucGeometries).mockResolvedValue({ ...result('near'),
      referenceSources: { a: { kind: 'calibration', regions: 40, files: 2 }, b: { kind: 'override', label: 'set by hand' } },
      scanReferences: { a: [{ scanId: 's1', label: 'scan_eve', median: 2.96 }], b: [] } } as never);
    const setSettings = await render({});
    expect(vi.mocked(nucGeometries).mock.calls[0][1].cohort).toBe('overlapping');
    const src = [...container.querySelectorAll('[data-testid="nuc-patch-ref-source"]')].map(e => e.textContent);
    expect(src[0]).toContain('calibration population of 40 windows');
    expect(src[0]).toContain('2 files pooled');
    expect(src[1]).toContain('set by hand');
    const pick = container.querySelectorAll('[data-testid="nuc-patch-ref-scan"]');
    expect(pick.length).toBe(1);                                    // only the dataset with a scan reference
    await act(async () => {
      const sel = pick[0] as HTMLSelectElement;
      sel.value = 'scan:s1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setSettings).toHaveBeenCalledWith({ regularity: { patches: { reference: { a: 'scan:s1' } } } });
  });

  it('opening switches the patch layer on and stores the open state', async () => {
    const toggle = vi.spyOn(useBrowserStore.getState(), 'toggleModType');
    const setSettings = await render({ regularity: { patches: { open: false } } });
    await act(async () => { (container.querySelector('[data-testid="nuc-patches-toggle"]') as HTMLButtonElement).click(); });
    expect(setSettings).toHaveBeenCalledWith({ regularity: { patches: { open: true } } });
    expect(toggle).toHaveBeenCalledWith('nucpatch', true);
  });

  it('lists geometries as classes: lanes, rows with full and partial carriers per series, kinds, nested pairs and the association', async () => {
    vi.mocked(nucGeometries).mockResolvedValue(result('all'));
    await render({ regularity: { patches: { open: true, params: { fold: 'all' } } } });
    expect(nucGeometries).toHaveBeenCalledTimes(1);
    expect(vi.mocked(nucGeometries).mock.calls[0][1].patches).toEqual({ fold: 'all', low: {} });
    const rows = [...container.querySelectorAll('[data-testid="nuc-geo-row"]')];
    expect(rows.map(r => r.getAttribute('data-geometry'))).toEqual(['G1', 'G2', 'L1']);
    expect(rows.map(r => r.getAttribute('data-kind'))).toEqual(['high', 'high', 'low']);
    expect(container.querySelectorAll('[data-testid="nuc-geo-lanes-lane"]').length).toBe(3);
    const table = container.querySelector('[data-testid="nuc-geo-table"]')!.textContent!;
    expect(table).toContain('part of G1');
    const g1 = rows[0].querySelectorAll('[data-testid="nuc-geo-share"]');
    expect(g1[0].textContent).toContain('6%');
    expect(g1[0].textContent).toContain('+38 pp');
    expect(g1[1].textContent).toContain('21%');
    expect(rows[0].querySelector('[data-testid="nuc-geo-spread"]')!.textContent).toContain('±200');
    expect(container.querySelector('[data-testid="nuc-geo-count"]')!.textContent).toContain('2 high · 1 low');
    // the summary table leads the tab: high and low patch shares per series
    expect(container.querySelectorAll('[data-testid="nuc-reg-summary-row"]').length).toBe(2);
    await act(async () => { (container.querySelector('[data-testid="nuc-geo-nested-toggle"]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="nuc-geo-nested"]')!.textContent).toContain('3,000 bp *');
    for (const id of ['nuc-geo-lanes', 'nuc-geo-stack', 'nuc-geo-profile']) {
      expect(container.querySelector(`[data-testid="${id}"]`)?.tagName.toLowerCase()).toBe('svg');
    }
    expect(container.textContent).not.toMatch(/problem|error/i);
    // Charts: the patch charts and the detail table; no second request
    await render({ regularity: { patches: { open: true, params: { fold: 'all' } } } }, vi.fn(), 'charts');
    expect(container.querySelectorAll('[data-testid="nuc-patch-summary-row"][data-kind="low"]').length).toBe(1);
    expect(container.querySelector('[data-testid="nuc-patch-share"]')?.tagName.toLowerCase()).toBe('svg');
    expect(container.querySelector('[data-testid="nuc-geo-card"]')).toBeNull();
    // Near a site: the association
    await render({ regularity: { patches: { open: true, params: { fold: 'all' } } } }, vi.fn(), 'site');
    expect(container.querySelector('[data-testid="nuc-assoc-table"]')!.textContent).toContain('+1 · −2 points');
    expect(container.querySelector('[data-testid="nuc-assoc-table"]')!.textContent).toContain('low: −1 · +0');
    expect(container.querySelector('[data-testid="nuc-assoc-tests"]')!.textContent).toContain('or_mh');
    expect(container.querySelector('[data-testid="nuc-assoc-profile"]')?.tagName.toLowerCase()).toBe('svg');
    expect(nucGeometries).toHaveBeenCalledTimes(1);
  });

  it('a click on a geometry focuses it (lane dims, carriers highlighted); the kind filter and inspect work', async () => {
    vi.mocked(nucGeometries).mockResolvedValue(result('all'));
    const setSettings = await render({ regularity: { patches: { open: true } } });
    await act(async () => { (container.querySelector('[data-geometry="G1"] [data-testid="nuc-geo-name"]') as HTMLButtonElement).click(); });
    expect([...useNucGeoFocusStore.getState().focused]).toEqual(['high:1']);
    // G1's carriers with the geometry folded into it carried partly (r3)
    expect([...useReadActionsStore.getState().highlight!.ids].sort()).toEqual(['r1', 'r3', 'r4']);
    expect(container.querySelector('[data-geometry="G1"]')!.getAttribute('data-selected')).toBe('true');
    // alt-click adds to the focus (shift-click selects for the toolbar: geoFeatures.test.tsx)
    await act(async () => { (container.querySelector('[data-geometry="L1"] [data-testid="nuc-geo-name"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })); });
    expect([...useNucGeoFocusStore.getState().focused].sort()).toEqual(['high:1', 'low:1']);
    await act(async () => { (container.querySelector('[data-geometry="L1"] [data-testid="nuc-geo-inspect"]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="nuc-geo-inspect-panel"]')!.getAttribute('data-geometry')).toBe('L1');
    await act(async () => { (container.querySelector('[data-testid="nuc-geo-group-one"]') as HTMLButtonElement).click(); });
    expect(vi.mocked(applyReadGroups).mock.calls.at(-1)![0].byDataset.a).toEqual({ r1: 2, r2: 0, r3: 2 });
    const low = [...container.querySelectorAll('button')].find(b => b.textContent === 'Low')!;
    await act(async () => { low.click(); });
    expect(setSettings).toHaveBeenLastCalledWith({ regularity: { patches: { open: true, kindFilter: 'low' } } });
  });

  it('every parameter edit goes to the settings; a fold change refetches; low calling can be switched off and tuned', async () => {
    vi.mocked(nucGeometries).mockResolvedValue(result('near'));
    const setSettings = await render({ regularity: { patches: { open: true } } });
    const fold = container.querySelector('[data-testid="nuc-geo-fold"]') as HTMLSelectElement;
    await act(async () => { fold.value = 'none'; fold.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(setSettings).toHaveBeenLastCalledWith({ regularity: { patches: { open: true, params: { fold: 'none' } } } });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    // the snapping details sit behind "edge settings…"
    await act(async () => { (container.querySelector('[data-testid="nuc-patch-edge-details"]') as HTMLButtonElement).click(); });
    for (const [id, key] of [['nuc-patch-enter', 'enter'], ['nuc-patch-min-tiles', 'min_tiles'], ['nuc-geo-tol', 'tol_bp'], ['nuc-patch-search-bp', 'search_bp']] as const) {
      const el = container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
      await act(async () => { setter.call(el, '3'); el.dispatchEvent(new Event('input', { bubbles: true })); });
      expect(setSettings.mock.calls.at(-1)![0].regularity.patches.params[key]).toBe(3);
    }
    const lowEnter = container.querySelector('[data-testid="nuc-patch-low-enter"]') as HTMLInputElement;
    await act(async () => { setter.call(lowEnter, '-2'); lowEnter.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(setSettings.mock.calls.at(-1)![0].regularity.patches.params.low).toEqual({ enter: -2, extend: -0.75 });
    const lowOn = container.querySelector('[data-testid="nuc-patch-low"]') as HTMLInputElement;
    await act(async () => { lowOn.click(); });
    expect(setSettings.mock.calls.at(-1)![0].regularity.patches.params.low).toBeNull();
    vi.mocked(nucGeometries).mockResolvedValue(result('none'));
    await render({ regularity: { patches: { open: true, params: { fold: 'none' } } } }, setSettings);
    expect(vi.mocked(nucGeometries).mock.calls.at(-1)![1].patches).toEqual({ fold: 'none', low: {} });
    expect(container.querySelector('[data-testid="nuc-geo-table"]')!.textContent).not.toContain('part of');
  });

  it('groups reads by the root geometry of each kind they carry, none last; exports the table', async () => {
    vi.mocked(nucGeometries).mockResolvedValue(result('all'));
    await render({ regularity: { patches: { open: true } } });
    await act(async () => { (container.querySelector('[data-testid="nuc-geo-group"]') as HTMLButtonElement).click(); });
    expect(applyReadGroups).toHaveBeenCalledTimes(1);
    const [input, keys] = vi.mocked(applyReadGroups).mock.calls[0];
    expect(input.byDataset.a).toEqual({ r1: 0, r2: 3, r3: 1 });
    expect(input.order).toEqual([0, 3]);
    expect(input.labels![3]).toBe('no high-regularity geometry');
    expect(keys).toEqual({ a: ['a'], b: ['b'] });
    await act(async () => { (container.querySelector('[data-testid="nuc-geo-group-low"]') as HTMLButtonElement).click(); });
    const low = vi.mocked(applyReadGroups).mock.calls[1][0];
    expect(low.byDataset.a).toEqual({ r1: 3, r2: 2, r3: 3 });
    expect(low.order).toEqual([2, 3]);
    expect(container.querySelector('[data-testid="nuc-geo-export-tsv"]')).not.toBeNull();
  });

  it('keeps FiberHMM defaults', () => {
    expect(DEFAULT_LOW_PARAMS).toMatchObject({ enter: -1.5, extend: -0.75, min_tiles: 2, edges: 'snap', snap_rule: 'open', open_bp: 300 });
    expect(DEFAULT_PATCH_PARAMS).toMatchObject({ enter: 2, extend: 1.25, min_tiles: 2, edges: 'snap', snap_rule: 'open', open_bp: 300,
      search_bp: 1000, tol_bp: 500, min_share: 0.03, fold: 'near', near_max_bp: 1250 });
  });
});

describe('geometries as features: hub, selection, saved, track, first open', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    registerGeometryFeatures();
    registerSavedGeometries();
    vi.useFakeTimers();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.mocked(nucGeometries).mockReset();
    useNucGeoRuns.getState().clear();
    useBrowserStore.setState({ selectedFeatures: [], savedNucGeometries: [] } as never);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); useNucJob.setState({ job: null }); });

  const render = async (settings: NucPanelState = { regularity: { patches: { open: true } } }, analysing = false) => {
    await act(async () => { root.render(<PatchGeometryView series={series} cohort="overlapping" settings={settings} setSettings={vi.fn()} revision="0"
      includeDuplicates={false} panelId="nuc1" analysing={analysing} />); });
    await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve(); });
  };

  it('publishes the panel\'s geometries as a hub set: the scan\'s type, hit ids and state rule; shares per dataset, raw and density matched', async () => {
    vi.mocked(nucGeometries).mockResolvedValue(result('near'));
    await render();
    const run = useNucGeoRuns.getState().runs.nuc1;
    expect(run.request.observations.map(o => o.obsId)).toEqual(['a', 'b']);
    expect(run.request.patches).toEqual({ low: {} });
    expect(featureKindDef(GEO_KIND)?.typeId).toBe('nuc.geometry');
    const provider = hubProviders().find(p => p.id === 'nuc-geometries')!;
    const sets = provider.sets(useBrowserStore.getState(), { chrom: 'chr2R', start: 0, end: 20000 });
    expect(sets).toHaveLength(1);
    const set = sets[0];
    expect(set.setId).toBe('browser:nuc-geometry:nuc1');
    expect(set.typeId).toBe('nuc.geometry');
    expect(set.type.provides).toContain('state');
    const hits = set.source.kind === 'inline' ? set.source.hits : [];
    expect(hits.map(h => h.hitId)).toEqual(['geometry:4000-9000', 'geometry:4000-6000', 'geometry-low:1500-3000']);
    expect(hits[2].label).toBe('L1');
    expect(hits[0].values!['ds:a'].share.v).toBeCloseTo(0.06);
    expect(hits[0].values!['ds:b'].share_dm.v).toBeCloseTo(0.18);
    expect(hits[0].values!['ds:b'].prevalence.v).toBeCloseTo(0.18);      // the hub's column: density matched
    // pooled: carriers among callable molecules (27 / 180), as fiberhmm-scan's 'all' share_dm; the raw share beside it
    expect(hits[0].values!.all.prevalence.v).toBeCloseTo(0.15);
    expect(hits[0].values!.all.share_dm.v).toBeCloseTo(0.15);
    expect(hits[0].values!.all.share.v).toBeCloseTo(0.135);
    expect(hits[0].stateSpec).toMatchObject({ kind: 'nuc-geometry', geometryId: 'G1_x' });
    expect((hits[0].stateSpec as { request: unknown }).request).toBe(run.request);
    expect(hitSelectionEntry(set, hits[0]).hasStates).toBe(true);
    expect(geoHitId({ kind: 'low', start: 1, end: 2 })).toBe('geometry-low:1-2');
    // outside the window: no set
    expect(provider.sets(useBrowserStore.getState(), { chrom: 'chr2R', start: 50000, end: 60000 })).toHaveLength(0);
  });

  it('shift-click selects a geometry for the toolbar with the hub hit\'s identity; a plain click still focuses', async () => {
    vi.mocked(nucGeometries).mockResolvedValue(result('near'));
    await render();
    const name = () => container.querySelector('[data-geometry="L1"] [data-testid="nuc-geo-name"]') as HTMLButtonElement;
    await act(async () => { name().dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); });
    const sel = useBrowserStore.getState().selectedFeatures;
    expect(sel).toHaveLength(1);
    expect(sel[0]).toMatchObject({ kind: 'nuc-geometry', source: 'browser:nuc-geometry:nuc1', id: 'geometry-low:1500-3000', label: 'L1' });
    const set = hubProviders().find(p => p.id === 'nuc-geometries')!.sets(useBrowserStore.getState(), { chrom: 'chr2R', start: 0, end: 20000 })[0];
    const hit = set.source.kind === 'inline' ? set.source.hits[2] : null;
    expect(featureKey(sel[0])).toBe(featureKey(selectionRefs([hitSelectionEntry(set, hit!)])[0]));
    expect(sel[0].hubHit?.stateSpec).toBeTruthy();
    expect(container.querySelector('[data-geometry="L1"]')!.getAttribute('data-feature-selected')).toBe('true');
    expect(useNucGeoFocusStore.getState().focused.size).toBe(0);
    await act(async () => { name().dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); });
    expect(useBrowserStore.getState().selectedFeatures).toHaveLength(0);
    await act(async () => { name().click(); });
    expect([...useNucGeoFocusStore.getState().focused]).toEqual(['low:1']);
  });

  it('the star saves a geometry; the Saved list matches it to the analysis by its edges and removes it', async () => {
    vi.mocked(nucGeometries).mockResolvedValue(result('near'));
    await render();
    await act(async () => { (container.querySelector('[data-geometry="G2"] [data-testid="nuc-geo-star"]') as HTMLButtonElement).click(); });
    const saved = useBrowserStore.getState().savedNucGeometries;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ label: 'G2', kind: 'high', chrom: 'chr2R', start: 4000, end: 6000, tolBp: 500 });
    expect(saved[0].shares.a.full).toBeCloseTo(0.06);
    expect(container.querySelector('[data-geometry="G2"] [data-testid="nuc-geo-star"]')!.getAttribute('data-starred')).toBe('true');
    // the card's Saved view
    expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Saved (1)')).toBeTruthy();
    await render({ regularity: { patches: { open: true, list: 'saved' } } });
    const row = container.querySelector('[data-testid="nuc-geo-saved-row"]')!;
    expect(row.getAttribute('data-match')).toBe('G2');
    expect(matchSaved({ ...saved[0], start: 4400, end: 5600 }, 'chr2R', result('near').geometries, 500)).toBe(1);
    expect(matchSaved({ ...saved[0], start: 4600 }, 'chr2R', result('near').geometries, 500)).toBeNull();
    expect(matchSaved({ ...saved[0], kind: 'low' }, 'chr2R', result('near').geometries, 500)).toBeNull();
    await act(async () => { (row.querySelector('[data-testid="nuc-geo-saved-name"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); });
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['geometry:4000-6000']);
    await act(async () => { (container.querySelector('[data-testid="nuc-geo-saved-remove"]') as HTMLButtonElement).click(); });
    expect(useBrowserStore.getState().savedNucGeometries).toHaveLength(0);
    expect(container.querySelector('[data-testid="nuc-geo-saved"]')).toBeNull();
    expect(container.querySelector('[data-testid="nuc-geo-saved-empty"]')).not.toBeNull();
  });

  it('a fresh view shows Analysing instead of an empty list, and publishes nothing', async () => {
    const empty = { ...result('near'), window: null, geometries: [], nMolecules: 0, nPatches: 0,
      errors: { a: 'No regularity reference yet: run Analyse first', b: 'No regularity reference yet: run Analyse first' } };
    vi.mocked(nucGeometries).mockResolvedValue(empty);
    await render(undefined, true);
    expect(container.querySelector('[data-testid="nuc-geo-analysing"]')!.getAttribute('data-state')).toBe('analysing');
    expect(container.querySelector('[data-testid="nuc-patch-analysing"]')).not.toBeNull();
    expect(container.textContent).not.toContain('run Analyse first');
    expect(container.querySelector('[data-testid="nuc-geo-card"]')).toBeNull();
    expect(useNucGeoRuns.getState().runs.nuc1).toBeUndefined();
  });

  it('track lanes: high geometries on the upper lanes, low ones below, overlapping ones apart', () => {
    const G = result('none').geometries;
    const { lanes, count, highLanes } = geometryTrackLanes(G);
    expect(highLanes).toBe(2);
    expect(count).toBe(3);
    expect(lanes).toEqual([0, 1, 2]);
  });
});

