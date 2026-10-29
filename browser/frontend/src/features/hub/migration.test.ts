import '../../lab/testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { useBrowserStore } from '../../stores/browserStore';
import { applyImportedState, collectFrontendState, exportSession } from '../../api/session';
import { applyImportedState as restore301 } from '../../api/__fixtures__/session301';
import { EMPTY_HUB, ensureHubKind, hubProviders } from './hubState';
import { cartPins, dualWriteFrontend, restoreHubOnly } from './migration';
import { mergeProviderSets } from './hubData';
import { rigidMatchedRegions } from '../../utils/matchedRegions';
import { peakHitId } from './peakMigration';
import { snpSets } from '../variants/snpHubProvider';
import { graphSets, publishGraphHub } from '../graphPanel/hubProvider';
import { adoptLegacyRuns, legacySets, resetLegacyRuns } from './legacyRuns';
import type { BrowserState } from '../../stores/browserStore';
import type { FirePeak } from '../../types';

const dir = resolve(process.cwd(), '../../tests/fixtures/sessions');
const corpus = readdirSync(dir).filter(f => f.endsWith('.json')).map(name => ({ name, session: JSON.parse(readFileSync(resolve(dir, name), 'utf8')) }));
const initial = useBrowserStore.getState();
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function reset() {
  useBrowserStore.setState({ ...initial, featureHub: EMPTY_HUB, _historyStack: [], _historyPointer: -1 });
  resetLegacyRuns();
}
function panels() { return plain(useBrowserStore.getState().panels); }
function peakView() {
  const s = useBrowserStore.getState();
  return { selected: [...s.selectedPeaks].sort(), modes: s.peakModes };
}
function restore(session: any, importer = applyImportedState) {
  importer({ success: true, viewport: session.viewport, datasets: session.datasets, frontend: plain(session.frontend) });
}

beforeEach(reset);

describe('3.0.x session corpus', () => {
  for (const { name, session } of corpus) {
    it(`${name}: panels and peak controls equal the release importer`, () => {
      restore(session, restore301);
      const expected = panels(), expectedPeaks = peakView();
      reset();
      restore(session);
      expect(panels()).toEqual(expected);
      expect(peakView()).toEqual(expectedPeaks);
    });
    it(`${name}: import, export, import keeps the legacy panels`, () => {
      restore(session);
      const expected = panels(), expectedPeaks = peakView();
      const saved = plain(collectFrontendState());
      reset();
      restore({ ...session, frontend: saved });
      expect(panels()).toEqual(expected);
      expect(peakView()).toEqual(expectedPeaks);
    });
    if (session._corpus.release === '3.0.1') it(`${name}: new-build export restores with the 3.0.1 importer`, () => {
      restore(session);
      const expected = panels(), expectedPeaks = peakView();
      const saved = plain(collectFrontendState());
      reset();
      restore({ ...session, frontend: saved }, restore301);
      expect(panels()).toEqual(expected);
      expect(peakView()).toEqual(expectedPeaks);
    });
  }
  it('converts both carts into pins, retains curation and removes deleted pins on save', () => {
    const session = corpus.find(c => c.name === '301-carts.json')!.session;
    restore(session);
    expect(useBrowserStore.getState().featureHub.pinned).toHaveLength(2);
    expect(cartPins(useBrowserStore.getState()).map(p => p.typeId)).toEqual(['fp.class', 'nfr.variant']);
    const saved = collectFrontendState();
    expect(saved.footprintGroups).toMatchObject(session.frontend.footprintGroups);
    expect(saved.savedNfrVariants).toMatchObject(session.frontend.savedNfrVariants);
    useBrowserStore.setState({ footprintGroups: [], savedNfrVariants: [] });
    expect((collectFrontendState().featureHub as any).pinned).toEqual([]);
  });
  it('migrates an insertion selection to a boundary without changing its legacy stub', () => {
    restore(corpus.find(c => c.name === '301-variants.json')!.session);
    expect(useBrowserStore.getState().featureHub.selected[0]).toMatchObject({ start: 400, end: 400, typeId: 'var.sv' });
    expect((collectFrontendState().selectedFeatures as any[])[0]).toMatchObject({ start: 400, end: 401 });
  });
});

describe('peak identity transaction', () => {
  function load() { restore(corpus.find(c => c.name === '301-peaks-history.json')!.session); }
  const p = (start: number, end = start + 20): FirePeak => ({ start, end, index: 0 });
  it('preserves selection on a count-only rescan and clears it when loading a preset', () => {
    load();
    const s = useBrowserStore.getState(), before = peakView();
    s.setPeaksByRule('rule-a', s.peaksByRule['rule-a'].map(peak => ({ ...peak, hitId: undefined, score: 42 })));
    expect(peakView()).toEqual(before);
    useBrowserStore.setState({ savedPeakPresets: [{ name: 'Replacement', rules: s.peakRules.map(r => ({ ...r })) }] });
    s.loadPeakPreset('Replacement');
    expect(peakView()).toEqual({ selected: [], modes: {} });
    expect(useBrowserStore.getState().peaksByRule).toEqual({});
  });
  it('survives inserted, reordered and removed peaks in the same rule, including modes and tree nodes', () => {
    load();
    useBrowserStore.getState().setPeaksByRule('rule-a', [p(100), p(400), p(200)]);
    expect(peakView()).toEqual({ selected: [1, 10000].sort(), modes: { 1: 'tf', 10000: 'nucleosome' } });
    useBrowserStore.getState().setPeaksByRule('rule-a', [p(400)]);
    expect(peakView()).toEqual({ selected: [0, 10000].sort(), modes: { 0: 'tf', 10000: 'nucleosome' } });
    const node = useBrowserStore.getState().clusterTreeNodes['node-a'];
    expect(node.selectedPeakIndices).toEqual([0, 10000]);
    expect(node.peakModes).toEqual({ 0: 'tf', 10000: 'nucleosome' });
    expect(useBrowserStore.getState().savedClusters[0].selectedPeakIndices).toEqual([0, 10000]);
    expect(useBrowserStore.getState()._historyStack[0].state.selectedPeaks).toEqual([1, 10000]);
  });
  it('drops a vanished selected hit rather than selecting the next peak at its old index', () => {
    load();
    useBrowserStore.getState().setPeaksByRule('rule-a', [p(200), p(500)]);
    expect([...useBrowserStore.getState().selectedPeaks]).toEqual([10000]);
    expect(useBrowserStore.getState().peakModes[1]).toBeUndefined();
    expect(useBrowserStore.getState().clusterTreeNodes['node-a'].selectedPeakIndices).toEqual([10000]);
  });
  it('keeps identities and modes across rule reordering and removal', () => {
    load();
    useBrowserStore.getState().reorderPeakRules(0, 1);
    expect(peakView()).toEqual({ selected: [0, 10001].sort(), modes: { 0: 'nucleosome', 10001: 'tf' } });
    useBrowserStore.getState().removePeakRule('custom');
    expect(peakView()).toEqual({ selected: [1], modes: { 1: 'tf' } });
  });
  it('gives custom, matched, graph and reference-specific peaks distinct identities', () => {
    const peak = p(200);
    const ids = [peakHitId(peak, 'custom', 'chrT'), peakHitId(peak, 'matched', 'chrT'),
      peakHitId({ ...peak, memberPanelId: 'member-a' }, 'matched', 'chrT'),
      peakHitId({ ...peak, genome: 'another' }, 'custom', 'chrT')];
    expect(new Set(ids).size).toBe(4);
  });
  it('leaves another viewport’s saved clustering indices with its own cache', () => {
    load();
    const state = useBrowserStore.getState();
    const elsewhere = { ...state.savedClusters[0], id: 'elsewhere', start: 2000, end: 3000, selectedPeakIndices: [4], peakModes: { 4: 'tf' } };
    useBrowserStore.setState({ savedClusters: [...state.savedClusters, elsewhere] });
    state.setPeaksByRule('rule-a', [p(400)]);
    expect(useBrowserStore.getState().savedClusters[1]).toEqual(elsewhere);
  });
  it('restores saved custom selection after the custom peaks have been cleared', () => {
    load();
    const s = useBrowserStore.getState();
    // This fixture's custom rule is selected together with a scanned peak.
    useBrowserStore.setState({ clusterAssignments: { 'sample-a': { [String(7)]: 0 } } });
    s.saveCurrentClustering('Saved peaks');
    const list = useBrowserStore.getState().savedClusters;
    const saved = list[list.length - 1];
    s.clearCustomPeaks();
    expect(useBrowserStore.getState().peaksByRule.custom).toBeUndefined();
    s.restoreSavedCluster(saved.id);
    expect(useBrowserStore.getState().peaksByRule.custom).toHaveLength(1);
    expect([...useBrowserStore.getState().selectedPeaks]).toContain(10000);
    expect(useBrowserStore.getState().peakModes[10000]).toBe('nucleosome');
  });
  it('keeps graph insertion peaks distinct at a shared target boundary while counts change', () => {
    load();
    const graph = (label: string): FirePeak => ({ start: 400, end: 401, index: 0,
      graph: { kind: 'insertion', label, carriers: [label], frame_peaks: [[0, 20]] } });
    const s = useBrowserStore.getState();
    s.setPeaksByRule('rule-a', [graph('allele-a'), graph('allele-b')]);
    useBrowserStore.setState({ selectedPeaks: new Set([1]), peakModes: { 1: 'tf' } });
    s.setPeaksByRule('rule-a', [graph('allele-b'), graph('allele-c'), graph('allele-a')]);
    expect([...useBrowserStore.getState().selectedPeaks]).toEqual([0]);
    expect(useBrowserStore.getState().peakModes).toEqual({ 0: 'tf' });
  });
  it('keeps matched partners selected with their modes when another partner is inserted', () => {
    load();
    const s = useBrowserStore.getState();
    const regions = rigidMatchedRegions([p(200), p(400)], 'chrT');
    const id = s.upsertMatchedGroup({ id: 'matched', name: 'Matched', regions });
    s.selectMatchedGroup(id);
    const offset = useBrowserStore.getState().peaksByRule[id][0].index;
    s.setPeakMode(offset, 'tf');
    const old = useBrowserStore.getState().peaksByRule[id];
    s.setPeaksByRule(id, [{ ...old[0], hitId: undefined, start: 100, end: 120, match: { ...old[0].match!, label: 'new' } }, ...old]);
    expect([...useBrowserStore.getState().selectedPeaks].filter(i => i >= offset)).toEqual([offset + 1, offset + 2]);
    expect(useBrowserStore.getState().peakModes[offset + 2]).toBe('tf');
  });
  it('exports stable peak identities inside history and dual-writes legacy indices', async () => {
    load();
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_url, request) => {
      body = JSON.parse(request.body);
      return new Response(JSON.stringify({ version: '2.0', frontend: body.frontend_state }));
    }));
    try {
      await exportSession();
      expect(body.frontend_state.selectedPeaks).toEqual([1, 10000]);
      expect(body.frontend_state.featureHub.peakSelection.selected).toHaveLength(2);
      expect(body.frontend_state.historySnapshots).toHaveLength(1);
      expect(body.frontend_state.historySnapshots[0].state.featureHub.peakSelection.selected).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('legacy session dual-write', () => {
  const scan = { kind: 'fp-class', source: 'hub:scan', id: 'hit', datasetId: 'sample-a', chrom: 'chrT', start: 10, end: 20 };
  it('retains scan-only refs and split definitions in the hub, writes a frozen 3.0.1 fallback with membership', () => {
    const input = { selectedFeatures: [scan], panels: [{ id: 'split', datasetId: 'sample-a', stateKey: 'split-key',
      readSubset: { rule: { kind: 'features', datasetId: 'sample-a', features: [scan] } } }], splitPanelReads: { 'split-key': [] } };
    const saved = dualWriteFrontend(input);
    expect(saved.selectedFeatures).toEqual([]);
    expect(saved.panels[0].readSubset.rule).toEqual({ kind: 'frozen', datasetId: 'sample-a', readIds: [] });
    expect(restoreHubOnly(saved)).toMatchObject(input);
    expect(dualWriteFrontend(saved)).toEqual(saved);
  });
  it('round-trips a scan-only split in the new store and opens its frozen membership in 3.0.1', () => {
    const session = plain(corpus.find(c => c.name === '301-feature-split.json')!.session);
    session.frontend.panels[1].readSubset.rule.features = [scan];
    restore(session);
    const key = 'sample-a';
    useSplitPanelStore.setState({ reads: { [key]: { ids: new Set([String(7)]), state: 'ready' } } });
    const saved = plain(collectFrontendState());
    expect(saved.panels[1].readSubset.rule).toEqual({ kind: 'frozen', datasetId: 'sample-a', readIds: [String(7)] });
    reset();
    restore({ ...session, frontend: saved });
    expect(useBrowserStore.getState().panels[1].readSubset!.rule.features).toEqual([scan]);
    reset();
    restore({ ...session, frontend: saved }, restore301);
    expect(useBrowserStore.getState().panels[1].readSubset!.rule).toEqual({ kind: 'frozen', datasetId: 'sample-a', readIds: [String(7)] });
    useSplitPanelStore.setState({ reads: {} });
  });
  it('exports an edited split instead of resurrecting the imported hub rule', () => {
    const session = plain(corpus.find(c => c.name === '301-feature-split.json')!.session);
    session.frontend.panels[1].readSubset.rule.features = [scan];
    restore(session);
    const first = plain(collectFrontendState());
    reset();
    restore({ ...session, frontend: first });
    useBrowserStore.setState(s => ({ panels: s.panels.map((p, i) => i === 1 ? { ...p, readSubset: { ...p.readSubset!, rule: { kind: 'frozen', datasetId: 'sample-a', readIds: [] } } } : p) }));
    const second = collectFrontendState();
    expect((second.featureHub as any).splitRules).toBeUndefined();
    expect((second.panels as any[])[1].readSubset.rule.kind).toBe('frozen');
  });
  it('dual-writes insertion refs as one-base stubs in selections, splits and history', () => {
    const ref = { kind: 'sv', source: 'sample-a', id: 'I:100:40', datasetId: 'sample-a', chrom: 'chrT', start: 100, end: 100 };
    const saved = dualWriteFrontend({ selectedFeatures: [ref], panels: [{ id: 'split', readSubset: { rule: { kind: 'features', features: [ref] } } }],
      historySnapshots: [{ state: { selectedFeatures: [ref] } }] });
    expect(saved.selectedFeatures[0].end).toBe(101);
    expect(saved.panels[0].readSubset.rule.features[0].end).toBe(101);
    expect(saved.historySnapshots[0].state.selectedFeatures[0].end).toBe(101);
  });
});

describe('legacy adapters', () => {
  it('lists saved SNPs after import, without a transient scan', () => {
    restore(corpus.find(c => c.name === '301-variants.json')!.session);
    const sets = snpSets(useBrowserStore.getState(), { chrom: 'chrT', start: 100, end: 900 });
    expect(sets).toHaveLength(1);
    expect(sets[0].source).toMatchObject({ hits: [{ typeId: 'var.snp', start: 150, end: 151 }] });
  });
  it('lists custom and rule peaks', () => {
    restore(corpus.find(c => c.name === '301-peaks-history.json')!.session);
    const sets = hubProviders().find(p => p.id === 'peaks')!.sets(useBrowserStore.getState(), { chrom: 'chrT', start: 100, end: 900 });
    expect(sets.map(s => s.setId)).toEqual(['browser:peaks:rule-a', 'browser:peaks:custom']);
  });
  it('keeps restored job mappings available with their legacy state refs', () => {
    const row = { jobId: 'class-job', family: 'class_001', datasetId: 'sample-a', setId: 'browser:fp-class:class-job', hitId: 'fp-class:class-job:class_001',
      typeId: 'fp.class', chrom: 'chrT', start: 200, end: 220, anchor: 210, label: 'Class', legacyRef: { kind: 'fp-class', source: 'class-job', id: 'class_001', datasetId: 'sample-a' } };
    adoptLegacyRuns({ runs: [{ jobId: 'class-job', kind: 'consensus', mappings: [row] }], problems: [] });
    const sets = legacySets(useBrowserStore.getState(), { chrom: 'chrT', start: 100, end: 900 });
    expect(sets[0].source).toMatchObject({ hits: [{ legacyRefs: [row.legacyRef] }] });
  });
  it('merges cart pins and restored facades into their live set without duplicate rows', () => {
    restore(corpus.find(c => c.name === '301-carts.json')!.session);
    const provider = hubProviders().find(p => p.id === 'pinned')!;
    const pins = provider.sets(useBrowserStore.getState(), { chrom: 'chrT', start: 100, end: 900 });
    const merged = mergeProviderSets([...pins, ...pins]);
    expect(merged).toHaveLength(2);
    expect(merged.every(s => s.source.kind === 'inline' && s.source.hits.length === 1 && s.source.hits[0].setId === s.setId)).toBe(true);
  });
  it('publishes a graph insertion boundary with revision-scoped identity', () => {
    useBrowserStore.setState({ panels: [{ id: 'graph', contentType: 'graph-view' }] as any });
    const reg = { id: 'package', revisions: { package: 'p', graph: 'g', db: 'd', maps: 'm' }, bindings: [{ key: 'target', path: { contig: 'chrT' } }] };
    publishGraphHub('graph', reg as any, { interval: { start: 100, end: 900 }, target: 'target', complete: true,
      chain: [{ kind: 'group', id: 'locus', type: 'bubble', target: { start: 400, end: 400 }, base: { chain: [] }, alts: [{ id: 'alt', bp: 70, carriers: ['hap-a'] }], unavailable: [] }] } as any);
    const sets = graphSets(useBrowserStore.getState(), { chrom: 'chrT', start: 100, end: 900 });
    expect(sets[0].source).toMatchObject({ hits: [{ start: 400, end: 400, typeId: 'graph.bubble', detail: { locusKey: 'locus' } }] });
  });
});
