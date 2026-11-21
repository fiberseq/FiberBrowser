/** Regressions for the round-2 frontend audit fixes (geometry hub, label overlay, scopes, full view, export). */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { canonicalJson, geoChrom, geoHit, geoSetId, reconcileGeoSelection, registerGeometryFeatures, settingsOf, geoFeatureRef } from './geoHub';
import { geoRunFor, keepsGeometriesOutOfView, releaseGeoRun, pruneGeoRuns, useNucGeoRuns, type NucGeoRun } from './geoRuns';
import { matchSaved } from './savedGeometries';
import { clusterViewScope, geometryRequestBody, panelScope, scopeFields, TAB_INSTANCE } from './api';
import { hubProviders } from '../hub/hubState';
import { sameChrom } from '../../utils/chromAliases';
import { REFRESHED_DATASET_FIELDS, sameDatasetIntent } from '../../utils/progressiveAnalysis';
import { applyPatchLabels, resetPatchLabels } from '../../utils/nucPatchLabels';
import { buildRuleMatchContext, readMatchesRule } from '../../utils/ruleMatching';
import { PanelActiveContext, PanelDisplayContext, useFrozenWhileInactive, usePanelDisplayStore } from '../../hooks/usePanelDisplayStore';
import type { ColorRule } from '../../types';
import type { NucGeometryResult, NucGeometryRow } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, start: number, end: number, extra: Partial<NucGeometryRow> = {}): NucGeometryRow => ({
  id, kind: 'high', number: 1, rootNumber: 1, geometryId: `${id}_x`, start, end, width: end - start, openLeft: false, openRight: false,
  molecules: 10, patches: 10, startMad: 1, endMad: 1, score: 3, period: 180, parent: null, parentIndex: null, children: [],
  perObservation: {}, densityMatched: {}, ...extra,
});
const result = (geometries: NucGeometryRow[], extra: Partial<NucGeometryResult> = {}): NucGeometryResult => ({
  window: { chrom: 'chr1', start: 0, end: 20000 }, params: { patch: {}, geometry: { tol_bp: 500 }, view: {} }, references: {}, errors: {},
  nMolecules: 10, nPatches: 10, geometries, nested: [], stack: [], profiles: { edges: [], carriers: {}, none: [], share: {} },
  patchStats: {}, assignments: {}, ...extra,
} as NucGeometryResult);
const body = (regularity: Record<string, unknown>, patches: Record<string, unknown> = {}) => geometryRequestBody(
  [{ obsId: 'o', datasetId: 'a', panelId: 'p', stateKey: 'a', label: 'a', color: '#000', kind: 'linear', chrom: 'chr1', start: 0, end: 20000 }],
  { cohort: 'overlapping', regularity: regularity as never, patches: patches as never, reference: { a: null } });
const run = (geometries: NucGeometryRow[], request = body({ ends: 'blank' }), extra: Partial<NucGeometryResult> = {}): NucGeoRun => ({
  panelId: 'nuc1', request, result: result(geometries, extra), datasets: ['a'], seriesDataset: { o: 'a' }, origin: null, updatedAt: 1,
});

describe('geometry selections follow nested settings edits', () => {
  it('settingsOf sees nested changes (regularity ends, patch thresholds, references) and ignores routing', () => {
    const base = body({ ends: 'blank', window_bp: 1750 }, { enter: 2 });
    expect(settingsOf(body({ ends: 'extend', window_bp: 1750 }, { enter: 2 }))).not.toBe(settingsOf(base));
    expect(settingsOf(body({ ends: 'blank', window_bp: 1750 }, { enter: 2.5 }))).not.toBe(settingsOf(base));
    expect(settingsOf({ ...base, reference: { a: 3.1 } })).not.toBe(settingsOf(base));
    // key order and routing fields never matter
    expect(settingsOf(body({ window_bp: 1750, ends: 'blank' }, { enter: 2 }))).toBe(settingsOf(base));
    expect(settingsOf({ ...base, requestScope: 'x', adopt: false })).toBe(settingsOf(base));
    expect(canonicalJson({ b: { y: 1, x: [2, { d: 1, c: 0 }] }, a: undefined })).toBe('{"b":{"x":[2,{"c":0,"d":1}],"y":1}}');
  });

  it('a selected geometry is re-selected with the new request after a nested settings change at the same span', () => {
    registerGeometryFeatures();
    const g = row('G1', 1000, 5000);
    const before = run([g], body({ ends: 'blank' }));
    const ref = geoFeatureRef(useBrowserStore.getState(), before, g, 0);
    useBrowserStore.setState({ selectedFeatures: [ref] } as never);
    const after = run([g], body({ ends: 'extend' }));
    reconcileGeoSelection(after);
    const sel = useBrowserStore.getState().selectedFeatures[0];
    expect((sel.hubHit?.stateSpec as { request: unknown }).request).toBe(after.request);
  });
});

describe('geometries on several chromosomes', () => {
  const twoChrom = () => run([row('G1', 1000, 5000, { chrom: 'chr1' }), row('G2', 1200, 5100, { chrom: 'chr2' })], undefined,
    { chromosomes: ['chr1', 'chr2'] });

  it('each hub hit, saved entry and track lookup uses the geometry\'s own chromosome', () => {
    const r = twoChrom();
    expect(geoHit(r, r.result.geometries[1]).chrom).toBe('chr2');
    expect(geoHit(r, r.result.geometries[1]).frame).toEqual({ kind: 'linear', chrom: 'chr2' });
    expect(geoChrom(row('G', 1, 2), r.result)).toBe('chr1');           // an older answer: the window's
    // the hub's view on chr2 lists only the chr2 geometry
    registerGeometryFeatures();
    useNucGeoRuns.getState().setRun(r);
    const provider = hubProviders().find(p => p.id === 'nuc-geometries')!;
    const on2 = provider.sets(useBrowserStore.getState(), { chrom: 'chr2', start: 0, end: 20000 });
    const hits2 = on2[0].source.kind === 'inline' ? on2[0].source.hits : [];
    expect(hits2.map(h => [h.label, h.chrom])).toEqual([['G2', 'chr2']]);
    expect(on2[0].coverage.ref).toBeUndefined();
    // the track: a run drawn on chr2 for its chr2 geometry
    expect(geoRunFor({ nuc1: r }, 'a', 'chr2', 1000, 2000, sameChrom)?.panelId).toBe('nuc1');
    expect(geoRunFor({ nuc1: r }, 'a', 'chr3', 1000, 2000, sameChrom)).toBeNull();
    // a saved chr2 geometry matches the chr2 one only
    expect(matchSaved({ kind: 'high', chrom: 'chr2', start: 1200, end: 5100, tolBp: 500 }, 'chr1', r.result.geometries, 500)).toBe(1);
    expect(matchSaved({ kind: 'high', chrom: 'chr1', start: 1200, end: 5100, tolBp: 500 }, 'chr1', r.result.geometries, 500)).toBe(0);
    useNucGeoRuns.getState().clear();
  });
});

describe('pooled hub prevalence', () => {
  it('pooled share_dm divides by callable molecules, like fiberhmm-scan; a dataset without a matched estimate has none', () => {
    const g = row('G1', 1000, 5000, { perDataset: { a: { molecules: 100, full: 10, partial: 0, callable: 20 } }, densityMatched: { a: 0.5 } });
    const h = geoHit(run([g]), g);
    expect(h.values!.all.prevalence.v).toBeCloseTo(0.5);
    expect(h.values!.all.share_dm.v).toBeCloseTo(0.5);
    expect(h.values!.all.share.v).toBeCloseTo(0.1);
    expect(h.values!['ds:a'].prevalence.v).toBeCloseTo(0.5);
    const noDm = geoHit(run([{ ...g, densityMatched: { a: null } }]), { ...g, densityMatched: { a: null } });
    expect(noDm.values!['ds:a'].prevalence.v).toBeNull();          // never the raw share in its place
    expect(noDm.values!['ds:a'].share.v).toBeCloseTo(0.1);
  });
});

describe('label refreshes during a Cluster refinement', () => {
  it('a patch-label identity refresh is an output refresh, not a change of intent', () => {
    expect(REFRESHED_DATASET_FIELDS.has('patch_labels_identity')).toBe(true);
    const a = [{ id: 'a', label: 'A', patch_labels_identity: 'l1' }] as never;
    expect(sameDatasetIntent(a, [{ id: 'a', label: 'A', patch_labels_identity: 'l2' }] as never)).toBe(true);
  });
});

describe('rules on the regularity patches read the label overlay', () => {
  afterEach(() => resetPatchLabels());
  it('a geometry quality gate matches the geometry the lane draws (overlay of the same patch generation)', () => {
    const read = { id: 'r', intervals: [] as [number, number, number][], layers: { nucpatch: {
      intervals: [[0, 100, 100]] as [number, number, number][], quality_names: ['score', 'period', 'flags', 'geometry', 'root', 'patch'],
      qualities: [[200], [90], [0], [1], [1], [1]], lk: 'f1:abc:0', pg: 'P' } as never } };
    const rule = { id: 'g2', enabled: true, sizeMin: 0, sizeMax: null, targetLayers: ['nucpatch'], conditions: [],
      qualityGates: [{ qualityName: 'geometry', minValue: 2, maxValue: 2 }] } as unknown as ColorRule;
    const ctx = buildRuleMatchContext([], [], [], 0, 1000, [rule], 'chr1');
    expect(readMatchesRule(read, rule, ctx, 'ds')).toBe(false);       // own bytes: G1
    applyPatchLabels({ ds: { identity: 'x', files: ['f1'], labels: { 'f1:abc:0': [[0, 2, 2]] }, pg: 'P' } });
    expect(readMatchesRule(read, rule, ctx, 'ds')).toBe(true);        // relabelled G2, as the lane shows
    applyPatchLabels({ ds: { identity: 'y', files: ['f1'], labels: { 'f1:abc:0': [[0, 2, 2]] }, pg: 'OTHER' } });
    expect(readMatchesRule(read, rule, ctx, 'ds')).toBe(false);       // labels of other patches: own bytes
  });
});

describe('request scopes', () => {
  it('a panel\'s scope names this page instance; the cluster views get their own non-adopting scope', () => {
    expect(TAB_INSTANCE).toBeTruthy();
    expect(scopeFields('nuc1')).toEqual({ requestScope: `${TAB_INSTANCE}:nuc1` });
    expect(scopeFields(panelScope('nuc1'))).toEqual({ requestScope: `${TAB_INSTANCE}:nuc1` });
    expect(scopeFields(clusterViewScope('nuc1'))).toEqual({ requestScope: `cluster:${TAB_INSTANCE}:nuc1`, adopt: false });
    expect(scopeFields(undefined)).toEqual({});
    // never in the replayable request
    expect(Object.keys(body({}))).not.toContain('requestScope');
    expect(Object.keys(body({}))).not.toContain('adopt');
  });
});

describe('a geometry run outlives an export of another panel', () => {
  beforeEach(() => useNucGeoRuns.getState().clear());
  it('kept across an export unmount; dropped on any other unmount or when the panel closes', () => {
    const panels = [{ id: 'nuc1', nucleosomes: { mode: 'regularity' } }];
    useNucGeoRuns.getState().setRun(run([row('G1', 1, 2)]));
    useBrowserStore.setState({ exportInProgress: true } as never);
    releaseGeoRun('nuc1', keepsGeometriesOutOfView, panels);
    expect(useNucGeoRuns.getState().runs.nuc1).toBeDefined();
    pruneGeoRuns([]);                                                  // the panel closed
    expect(useNucGeoRuns.getState().runs.nuc1).toBeUndefined();
    useNucGeoRuns.getState().setRun(run([row('G1', 1, 2)]));
    useBrowserStore.setState({ exportInProgress: false } as never);
    releaseGeoRun('nuc1', keepsGeometriesOutOfView, panels);
    expect(useNucGeoRuns.getState().runs.nuc1).toBeUndefined();
    expect(geoSetId('nuc1')).toBe('browser:nuc-geometry:nuc1');
  });
});

describe('panels hidden by full view', () => {
  it('see the store as it was when hidden, and the live store when shown again', () => {
    useBrowserStore.setState({ chrom: 'chr1', start: 100, end: 200, panels: [{ id: 'p' }] as never });
    const seen: string[] = [];
    function Track() {
      const v = usePanelDisplayStore(s => `${s.chrom}:${s.start}`);
      const frozen = useFrozenWhileInactive(useBrowserStore(s => s.start));
      seen.push(`${v}|${frozen}`);
      return null;
    }
    const div = document.createElement('div'), root = createRoot(div);
    const show = (active: boolean) => act(() => root.render(<PanelDisplayContext.Provider value="p">
      <PanelActiveContext.Provider value={active}><Track /></PanelActiveContext.Provider></PanelDisplayContext.Provider>));
    show(true);
    show(false);
    act(() => useBrowserStore.setState({ start: 500 }));
    expect(seen.at(-1)).toBe('chr1:100|100');
    show(true);
    expect(seen.at(-1)).toBe('chr1:500|500');
    act(() => root.unmount());
  });
});
