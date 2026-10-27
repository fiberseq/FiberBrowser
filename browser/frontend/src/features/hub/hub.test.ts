import '../testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { featureKey, featureKindDef, featureRegionMode, hubSpanOf, normalizeFeatureRefs, type FeatureRef } from '../../stores/featureStore';
import { serializeExtensions, storeExtensions } from '../../stores/storeExtensions';
import { svFeatureRef } from '../variants/svFeatures';
import { kindOfType, kindsAreDistinct, typeOfKind } from './kinds';
import { EMPTY_HUB, ensureHubKind, normalizeHub, selectionRefs, type HubSelected } from './hubState';
import { scanColumnKey, scanHitToFeature } from './hubData';
import { clusterRegionsOf, newAnchorSet } from './actions';
import type { ScanHit, ScanSetInfo } from './api';
import type { FeatureTypeDecl } from './types';

const SCAN_TYPE: FeatureTypeDecl = {
  typeId: 'fp.class', module: 'fp', label: 'Footprint class', plural: 'Footprint classes', provides: ['hit', 'state'],
  anchor: 'centre', zeroWidth: false, scores: [{ name: 'prevalence', label: 'Prevalence', kind: 'fraction', better: 'high', perGroup: true }],
  roles: { prevalence: 'prevalence' },
};

describe('kind <-> typeId table', () => {
  it('keeps the existing kinds and hyphenates new ones, one to one', () => {
    expect(kindOfType('fp.class')).toBe('fp-class');
    expect(kindOfType('nfr.region')).toBe('nfr');
    expect(kindOfType('nfr.variant')).toBe('nfr-variant');
    expect(kindOfType('var.sv')).toBe('sv');
    expect(kindOfType('peaks.peak')).toBe('peaks-peak');
    expect(kindOfType('nuc.seg.low_information')).toBe('nuc-seg-low-information');
    expect(typeOfKind('sv')).toBe('var.sv');
    expect(typeOfKind('nuc-seg-regular', ['nuc.seg.regular', 'peaks.peak'])).toBe('nuc.seg.regular');
    expect(kindsAreDistinct(['fp.class', 'nfr.region', 'nfr.variant', 'var.sv', 'peaks.peak', 'peaks.broad', 'var.diff',
      'graph.bubble', 'nuc.seg.regular', 'nuc.patch.phased'])).toBe(true);
  });
  it('registered kinds carry their type ids (no kind string checks in callers)', () => {
    expect(featureKindDef('fp-class')?.typeId).toBe('fp.class');
    expect(featureKindDef('sv')?.typeId).toBe('var.sv');
    ensureHubKind({ ...SCAN_TYPE, typeId: 'peaks.peak', module: 'peaks' });
    expect(featureKindDef('peaks-peak')?.typeId).toBe('peaks.peak');
    expect(featureKindDef('peaks-peak')?.regionMode?.({ kind: 'peaks-peak', source: 'hub:x', id: 'p' } as FeatureRef)).toBe('accessibility');
  });
  it('footprint classes pick their layer through their FeatureKindDef', () => {
    const f = { kind: 'fp-class', source: 'job', id: 'class_1', datasetId: 'a' } as FeatureRef;
    expect(featureRegionMode(f)).toBe('tf');
    expect(featureRegionMode(f, { tf_rc: true })).toBe('tf_rc');
    expect(featureRegionMode(f, { tf_cr: true })).toBe('tf_cr');
    expect(featureRegionMode({ kind: 'sv', source: 'a', id: 'I:5:300', datasetId: 'a' } as FeatureRef)).toBeNull();
  });
});

describe('zero width (DESIGN §5.3)', () => {
  it('SV insertion refs convert to the boundary; 1 bp deletions do not', () => {
    const ins = svFeatureRef({ t: 'I', ref: 1000, len: 300 }, 'a', 'chr3');
    const del1 = svFeatureRef({ t: 'D', ref: 2000, len: 1 }, 'a', 'chr3');
    expect([ins.start, ins.end]).toEqual([1000, 1001]);           // stored as before (3.0.x sessions)
    expect(hubSpanOf(ins)).toEqual({ start: 1000, end: 1000, zeroWidth: true });
    expect([del1.start, del1.end]).toEqual([2000, 2001]);
    expect(hubSpanOf(del1)).toEqual({ start: 2000, end: 2001, zeroWidth: false });
  });
  it('normalizeFeatureRefs keeps zero-width coordinates only for kinds that declare them', () => {
    const refs = normalizeFeatureRefs([
      { kind: 'sv', source: 'a', id: 'I:7:50', datasetId: 'a', chrom: 'chr3', start: 7, end: 7 },
      { kind: 'fp-class', source: 'job', id: 'c', datasetId: 'a', chrom: 'chr3', start: 9, end: 9 },
    ]);
    expect([refs[0].start, refs[0].end]).toEqual([7, 7]);
    expect(refs[1].start).toBeUndefined();
  });
  it('existing selections load unchanged', () => {
    const saved = [
      { kind: 'fp-class', source: 'job1', id: 'class_3', datasetId: 'ds', chrom: 'chr3', start: 10, end: 30, label: 'Class 3', colour: '#123456' },
      { kind: 'sv', source: 'ds', id: 'I:500:300', datasetId: 'ds', chrom: 'chr3', start: 500, end: 501, label: 'INS 300' },
      { kind: 'sv', source: 'ds', id: 'D:900:1', datasetId: 'ds', chrom: 'chr3', start: 900, end: 901 },
    ];
    expect(normalizeFeatureRefs(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(featureKey(saved[0] as FeatureRef)).toBe('fp-class|job1|class_3|ds');
  });
});

describe('featureHub session state', () => {
  beforeEach(() => useBrowserStore.setState({ featureHub: EMPTY_HUB }));
  it('round-trips through the session extension; old sessions get the empty hub', () => {
    const s = useBrowserStore.getState();
    s.setFeatureHub({
      scans: [{ path: '/data/scan', scanId: 'abc', manifestDigest: 'd1', label: 'scan', source: 'opened' }],
      anchors: [newAnchorSet([{ setId: 'hub:1', hitId: 'h1', typeId: 'fp.class', chrom: 'chr3', start: 10, end: 20, anchor: 15, label: 'C1' }], 'A')],
      selected: [{ setId: 'hub:1', hitId: 'h1', typeId: 'fp.class', chrom: 'chr3', start: 10, end: 20, anchor: 15, datasets: ['ds'] }],
      ui: { ...EMPTY_HUB.ui, minPrevalence: 0.2, hiddenSets: ['hub:2'] },
    });
    const saved = JSON.parse(JSON.stringify(serializeExtensions(useBrowserStore.getState())));
    const ext = storeExtensions().find(e => e.id === 'featureHub')!;
    const restored = ext.importSession!(saved, useBrowserStore.getState()) as { featureHub: typeof EMPTY_HUB };
    expect(restored.featureHub).toEqual(useBrowserStore.getState().featureHub);
    expect(restored.featureHub.anchors[0].anchors[0]).toMatchObject({ chrom: 'chr3', pos: 15, hitId: 'h1' });
    expect(ext.importSession!(undefined, useBrowserStore.getState())).toEqual({ featureHub: EMPTY_HUB });
    // Hub refs never enter the legacy selection.
    expect(useBrowserStore.getState().selectedFeatures).toEqual([]);
  });
  it('drops malformed entries', () => {
    expect(normalizeHub({ scans: [{ path: '' }], anchors: [{ id: 'a', anchors: [{ chrom: 'chr1' }] }], selected: [{ setId: 's' }] }))
      .toEqual({ ...EMPTY_HUB, anchors: [{ id: 'a', label: 'Anchors', sources: [], createdAt: '', anchors: [] }] });
  });
});

describe('hub refs and Use as', () => {
  const sel = (over: Partial<HubSelected> = {}): HubSelected => ({ setId: 'hub:0123456789abcdef', hitId: 'fp:class:chr3:150:aaaaaaaa',
    typeId: 'fp.class', chrom: 'chr3', start: 140, end: 160, anchor: 150, datasets: ['a', 'b'], ...over });
  it('a hub hit is one ref (the scan provider reads every bound dataset); legacy sets keep their legacy refs', () => {
    const refs = selectionRefs([sel()]);
    expect(refs.map(r => [r.kind, r.source, r.id, r.datasetId])).toEqual([
      ['fp-class', 'hub:0123456789abcdef', 'fp:class:chr3:150:aaaaaaaa', undefined]]);
    const legacy = { kind: 'fp-class', source: 'job', id: 'class_1', datasetId: 'a' } as FeatureRef;
    expect(selectionRefs([sel({ legacyRefs: [legacy] })])).toEqual([legacy]);
  });
  it('cluster regions: hits in the main view, on their kind\'s layer; zero-width hits get a window', () => {
    useBrowserStore.setState({ chrom: 'chr3', start: 0, end: 10_000 });
    const regions = clusterRegionsOf([sel(), sel({ hitId: 'sv', typeId: 'var.sv', start: 500, end: 500, anchor: 500 }),
      sel({ hitId: 'far', start: 50_000, end: 50_100 })]);
    expect(regions).toEqual([{ start: 140, end: 160, mode: 'tf', label: undefined }, { start: 475, end: 525, mode: 'accessibility', label: undefined }]);
  });
  it('scan hits map their columns to the bound datasets', () => {
    const set = { setId: 'hub:1', typeId: 'fp.class', type: SCAN_TYPE, frame: { kind: 'linear', chrom: 'chr3' },
      groups: [{ id: 'all', kind: 'all', label: 'All' }, { id: 'dataset_1', kind: 'dataset', label: 'HP2', datasetId: 'hp2', scanDataset: 'dataset_1' },
        { id: 'dataset_2', kind: 'dataset', label: 'dataset_2', scanDataset: 'dataset_2' }],
      provenance: { producer: 'fiberhmm-scan', module: 'fp', inputs: [], units: 'grid' }, datasets: ['hp2'], coverage: { territory: 'units' },
      status: 'complete', source: { kind: 'scan', scanId: 's1', module: 'fp' } } as unknown as ScanSetInfo;
    expect(scanColumnKey(set, 'dataset_1', 's1')).toBe('ds:hp2');
    expect(scanColumnKey(set, 'dataset_2', 's1')).toBe('scan:s1:dataset_2');
    const hit: ScanHit = { hitId: 'fp:class:chr3:150:a', typeId: 'fp.class', chrom: 'chr3', start: 140, end: 160, anchor: 150, label: 'class_001',
      score: 0.4, flags: [], zeroWidth: false, raw: {}, groupKinds: {}, module: {},
      columns: { all: { prevalence: { v: 0.4, n: 20 } }, dataset_1: { prevalence: { v: 0.4, n: 20 } } } };
    const f = scanHitToFeature(set, 's1', hit);
    expect(f.values).toEqual({ all: { prevalence: { v: 0.4, n: 20 } }, 'ds:hp2': { prevalence: { v: 0.4, n: 20 } } });
    expect(f.scores.prevalence).toBe(0.4);
  });
});

describe('the states request', () => {
  it('sends hub refs with their dataset and legacy kinds as before', async () => {
    const calls: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls.push(JSON.parse(String((init as RequestInit).body)));
      return new Response(JSON.stringify({ features: [], by_dataset: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const { getFeatureStates } = await import('../../api/features');
    await getFeatureStates([
      { kind: 'fp-class', source: 'job', id: 'c', datasetId: 'a' } as FeatureRef,
      { kind: 'nfr', source: 'job2', id: 'N1' } as FeatureRef,
      { kind: 'peaks-peak', source: 'hub:0123456789abcdef', id: 'p', datasetId: 'b' } as FeatureRef,
    ]);
    expect(calls[0]).toEqual({ features: [{ kind: 'fp-class', source: 'job', id: 'c', dataset_id: 'a' }, { kind: 'nfr', source: 'job2', id: 'N1' },
      { kind: 'peaks-peak', source: 'hub:0123456789abcdef', id: 'p', dataset_id: 'b' }] });
    fetchSpy.mockRestore();
  });
});

describe('review fixes (round 1)', () => {
  const sel = (over: Partial<HubSelected> = {}): HubSelected => ({ setId: 'hub:0123456789abcdef', hitId: 'h', typeId: 'fp.class',
    chrom: 'chr3', start: 140, end: 160, anchor: 150, datasets: ['a'], ...over });
  it('hits of another assembly never become cluster regions, anchors without their frame, or a target view', async () => {
    useBrowserStore.setState({ chrom: 'chr3', start: 0, end: 10_000 });
    const source = sel({ frame: { kind: 'source', assembly: 'hg002', contig: 'chr3_MATERNAL' } });
    expect(clusterRegionsOf([source])).toEqual([]);
    const { asClusterRegions, goToHits } = await import('./actions');
    expect(await asClusterRegions([source], false)).toMatch(/another assembly/);
    expect(goToHits([source])).toMatch(/another assembly/);
    expect(newAnchorSet([source]).anchors[0].frame).toEqual(source.frame);
    // and the frame survives a session
    expect(normalizeHub({ selected: [source], anchors: [newAnchorSet([source], 'x')] }).selected[0].frame).toEqual(source.frame);
  });
  it('Use as cluster regions makes way for its regions over an active cluster rule and selected features', async () => {
    const { clusterBasis } = await import('../../utils/clusterTargets');
    const { asClusterRegions } = await import('./actions');
    useBrowserStore.setState({ chrom: 'chr3', start: 0, end: 10_000, clusterPeakMode: 'cluster_rule:old' as never,
      selectedFeatures: [{ kind: 'fp-class', source: 'job', id: 'c', datasetId: 'a', chrom: 'chr3', start: 10, end: 20 }] });
    expect(await asClusterRegions([sel()], false)).toBeNull();
    const st = useBrowserStore.getState();
    expect(st.clusterPeakMode).toBe('accessibility');
    expect(st.selectedFeatures).toEqual([]);
    const basis = clusterBasis(st);
    expect(basis.kind).toBe('peaks');
    expect(basis.regions).toEqual([{ start: 140, end: 160, mode: 'tf', chrom: 'chr3' }]);
  });
  it('a session imported while scans are being restored gets its own scans reopened', async () => {
    const opened: string[] = [];
    let releaseA: (() => void) | null = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/api/scan/list')) return reply({ scans: [] });
      if (u.includes('/api/scan/open')) {
        const path = JSON.parse(String((init as RequestInit).body)).path as string;
        if (path === '/scan/A') await new Promise<void>(r => { releaseA = () => r(); });
        opened.push(path);
        return reply({ scanId: path, path, label: path, source: 'opened', manifestDigest: '', sets: [], datasets: [], annotated: [], modules: {}, units: { mode: 'grid' }, annotate: false });
      }
      return reply({ datasets: [] });
    });
    const { restoreSessionScans } = await import('./hubData');
    useBrowserStore.setState({ featureHub: { ...EMPTY_HUB, scans: [{ path: '/scan/A', scanId: 'A', manifestDigest: '', label: 'A', source: 'opened' }] } });
    const first = restoreSessionScans();
    await vi.waitFor(() => { if (!releaseA) throw new Error('not yet'); }, { timeout: 5000 });
    useBrowserStore.setState({ featureHub: { ...EMPTY_HUB, scans: [{ path: '/scan/B', scanId: 'B', manifestDigest: '', label: 'B', source: 'opened' }] } });
    void restoreSessionScans();
    releaseA!();
    await first;
    expect(opened).toEqual(['/scan/A', '/scan/B']);
    fetchSpy.mockRestore();
  }, 15_000);
});

describe('review fixes (round 2)', () => {
  it('peaks and SVs of a panel on another reference are not listed as this genome\'s hits', async () => {
    const { hubProviders } = await import('./hubState');
    const { useTrackFeedStore } = await import('../../stores/trackFeedStore');
    useBrowserStore.setState({ chrom: 'chr3', start: 0, end: 10_000,
      peakRules: [{ id: 'r1', name: 'Acc', source: 'accessibility', enabled: true, color: '#000', opacity: 1, useGradient: false, smoothWidth: 100, thresholds: [0.6, 0.4, 0.2, 0.08], minPeakWidth: 80, minReads: 5 }],
      peaksByRule: { r1: [{ start: 100, end: 200, index: 0, chrom: 'chr3' }, { start: 240, end: 260, index: 1, chrom: 'chr3', genome: 'hg002' }] },
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'a', stateKey: 'a' }, { id: 'p2', contentType: 'dataset', datasetId: 'b', stateKey: 'b', genome: 'hg002' }] as never });
    const sv = (datasetId: string) => ({ datasetId, chrom: 'chr3', start: 0, end: 10_000, dataChrom: 'chr3', dataStart: 0, dataEnd: 10_000, zoomedOut: false,
      sv: { min_len: 50, margin: 50, scope: 'all', n_reads: 10, clips: [], clusters: [{ id: 'x', t: 'D', ref: 140, len: 20, end: 160, support: 3, informative: 10, sa_support: 0 }] } });
    useTrackFeedStore.setState({ byStateKey: { a: sv('a') as never, b: sv('b') as never } });
    const s = useBrowserStore.getState();
    const view = { chrom: 'chr3', start: 0, end: 10_000 };
    const peaks = hubProviders().find(p => p.id === 'peaks')!.sets(s, view);
    expect(peaks[0].source.kind === 'inline' && peaks[0].source.hits.map(h => h.start)).toEqual([100]);
    const svs = hubProviders().find(p => p.id === 'sv')!.sets(s, view);
    expect(svs[0].datasets).toEqual(['a']);
  });
  it('Use as cluster regions takes this genome\'s custom peak, not another genome\'s with the same span', async () => {
    const { asClusterRegions } = await import('./actions');
    const { clusterBasis } = await import('../../utils/clusterTargets');
    const { DEFAULT_PEAK_RULES } = await import('../../types/peak');
    useBrowserStore.setState({ chrom: 'chr3', start: 0, end: 10_000, selectedFeatures: [], clusterPeakMode: 'accessibility' as never, panels: [] as never,
      peakRules: DEFAULT_PEAK_RULES.map(r => ({ ...r })), peaksByRule: {}, selectedPeaks: new Set(), peakModes: {} });
    useBrowserStore.getState().addCustomPeak(140, 160, 'chr3', 'other-genome');
    expect(await asClusterRegions([{ setId: 'hub:0123456789abcdef', hitId: 'h', typeId: 'fp.class', chrom: 'chr3', start: 140, end: 160, anchor: 150, datasets: ['a'] }], false)).toBeNull();
    const basis = clusterBasis(useBrowserStore.getState());
    expect(basis.regions).toEqual([{ start: 140, end: 160, mode: 'tf', chrom: 'chr3' }]);
  });
  it('the hub lists only the session\'s scans; a live scan\'s scans join it when it finishes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const scan = (path: string, source: string) => ({ scanId: path, path, label: path, source, manifestDigest: '', sets: [], datasets: [], annotated: [], modules: {}, units: { mode: 'grid' }, annotate: false });
      const body = String(url).includes('/api/scan/list') ? { scans: [scan('/old/cache', 'cache'), scan('/new/cache', 'cache')] } : { datasets: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const { refreshScans, adoptScans, useHubData } = await import('./hubData');
    useBrowserStore.setState({ featureHub: EMPTY_HUB });
    await refreshScans();
    expect(useHubData.getState().scans).toEqual([]);
    expect(useBrowserStore.getState().featureHub.scans).toEqual([]);
    await adoptScans(['/new/cache']);
    expect(useHubData.getState().scans.map(s => s.path)).toEqual(['/new/cache']);
    expect(useBrowserStore.getState().featureHub.scans.map(s => s.path)).toEqual(['/new/cache']);
    fetchSpy.mockRestore();
  });
});

describe('review fixes (round 3)', () => {
  it('work for a replaced session never writes into the imported one', async () => {
    let hold: (() => void) | null = null;
    const opened: Array<{ path: string; generation?: number }> = [];
    const scan = (path: string) => ({ scanId: path, path, label: path, source: 'cache', manifestDigest: '', sets: [], datasets: [], annotated: [], modules: {}, units: { mode: 'grid' }, annotate: false });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/api/scan/list')) return reply({ scans: [scan('/old/cache')], generation: 3 });
      if (u.includes('/api/scan/open')) {
        const body = JSON.parse(String((init as RequestInit).body));
        if (body.path === '/a/1') await new Promise<void>(r => { hold = () => r(); });
        opened.push(body);
        return reply(scan(body.path));
      }
      return reply({ datasets: [] });
    });
    const { restoreSessionScans, resetHubData, adoptScans, hubGeneration } = await import('./hubData');
    // A restore of session A (two scans) is under way; session B is imported while the first open is pending.
    useBrowserStore.setState({ featureHub: { ...EMPTY_HUB, scans: ['/a/1', '/a/2'].map(p => ({ path: p, scanId: p, manifestDigest: '', label: p, source: 'opened' as const })) } });
    const restoring = restoreSessionScans();
    await vi.waitFor(() => { if (!hold) throw new Error('not yet'); }, { timeout: 5000 });
    const oldGeneration = hubGeneration();
    resetHubData();
    useBrowserStore.setState({ featureHub: EMPTY_HUB });
    hold!();
    await restoring;
    expect(opened.map(o => o.path)).toEqual(['/a/1']);        // /a/2 is never opened for the replaced session
    expect(opened[0].generation).toBe(3);                      // the server refuses it if its generation moved on
    // A live scan of session A finishing after the import doesn't join session B.
    await adoptScans(['/old/cache'], oldGeneration);
    expect(useBrowserStore.getState().featureHub.scans).toEqual([]);
    fetchSpy.mockRestore();
  }, 15_000);
});


describe('agy review fixes', () => {
  it('Use as filter uses only hits with per-read states and says what it left out', async () => {
    const { asFilter } = await import('./actions');
    expect(await asFilter([{ setId: 'browser:peaks:r1', hitId: 'p', typeId: 'peaks.peak', chrom: 'chr3', start: 1, end: 2, anchor: 1, hasStates: false }]))
      .toMatch(/per-read states/);
  });
  it('Use as cluster regions merges hits with one span and leaves the store as it was when Cluster would not use them', async () => {
    const { asClusterRegions, clusterRegionsOf } = await import('./actions');
    const { DEFAULT_PEAK_RULES } = await import('../../types/peak');
    const base = { setId: 'hub:0123456789abcdef', chrom: 'chr3', start: 140, end: 160, anchor: 150, datasets: ['a'] };
    useBrowserStore.setState({ chrom: 'chr3', start: 0, end: 10_000, selectedFeatures: [], clusterPeakMode: 'accessibility' as never, panels: [] as never,
      peakRules: DEFAULT_PEAK_RULES.map(r => ({ ...r })), peaksByRule: {}, selectedPeaks: new Set(), peakModes: {} });
    expect(clusterRegionsOf([{ ...base, hitId: 'r', typeId: 'nfr.region' }, { ...base, hitId: 'v', typeId: 'fp.class' }])).toHaveLength(2);
    expect(await asClusterRegions([{ ...base, hitId: 'r', typeId: 'nfr.region' }, { ...base, hitId: 'v', typeId: 'fp.class' }], false)).toBeNull();
    expect([...useBrowserStore.getState().selectedPeaks]).toHaveLength(1);
    expect(Object.values(useBrowserStore.getState().peakModes)).toEqual(['tf']);
    // The custom rule off: refused before anything changes.
    const rules = DEFAULT_PEAK_RULES.map(r => ({ ...r, enabled: r.source === 'custom' ? false : r.enabled }));
    useBrowserStore.setState({ peakRules: rules, peaksByRule: {}, selectedPeaks: new Set(), peakModes: {} });
    expect(await asClusterRegions([{ ...base, hitId: 'v', typeId: 'fp.class' }], false)).toMatch(/Custom peak rule/);
    expect(useBrowserStore.getState().peaksByRule).toEqual({});
  });
});

describe('record-keyed read filters', () => {
  it('split panels and cluster scopes match lifted rows to a filter of record keys', async () => {
    const { splitReadFilter } = await import('../../stores/splitPanelStore');
    const { recordKey } = await import('../../utils/recordKeys');
    const row = 'lift-cohort:v1 ["g|q1","q1","abc:0",1,"primary"]';
    const other = 'lift-cohort:v1 ["g|q2","q2","def:0",0,"primary"]';
    const filter = new Set([recordKey(row)!]);
    const out = splitReadFilter({ state: 'ready', ids: new Set([row, other]) } as never, filter);
    expect([...(out ?? [])]).toEqual([row]);
  });
});
