import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { EMPTY_HUB, ensureHubKind, hitSelectionEntry, normalizeHub, selectionRefs } from './hubState';
import { asAnchors, asSplit, asFilter, asClusterRegions, conditioningSet, asRegionCatalog, asHighlight, hitExportText } from './actions';
import { queryHubPage, pageSets } from './paging';
import { drawableHits, selectFromGraph } from './graphHits';
import { useHubData } from './hubData';
import { graphSets, publishGraphHub, resetGraphHub } from '../graphPanel/hubProvider';
import type { FeatureSet, FeatureHit } from './types';
import type { HubScope } from './paging';

const initial = useBrowserStore.getState();
const view = { chrom: 'chrT', start: 0, end: 1000 };
const kinds = ['fp.class', 'nfr.region', 'nfr.variant', 'nuc.seg.regular', 'peaks.peak', 'var.sv', 'var.diff', 'var.snp', 'graph.bubble'];
function fixture(typeId: string): { set: FeatureSet; hit: FeatureHit } {
  const hit: FeatureHit = { hitId: 'var:12345678:chrT:10-10:insertion:geometry-x', idAliases: ['legacy'], setId: 'browser:test', typeId,
    frame: { kind: 'linear', chrom: 'chrT' }, chrom: 'chrT', start: 10, end: 10, anchor: 10, label: 'Hit\tlabel',
    scores: { prevalence: .5 }, values: { all: { prevalence: { v: .5, lo: .2, hi: .8, n: 8, nCallable: 10 } } }, stateSpec: { kind: 'open' } };
  const set: FeatureSet = { setId: hit.setId, typeId, type: { typeId, module: 'browser', label: typeId, plural: typeId,
    provides: ['hit', 'state'], scores: [], anchor: 'start', zeroWidth: true }, frame: hit.frame,
    provenance: { producer: 'browser', module: 'test', inputs: ['sample'], units: 'view' }, datasets: ['sample'], groups: [],
    coverage: { territory: 'view' }, status: 'complete', source: { kind: 'inline', hits: [hit] } };
  ensureHubKind(set.type);
  return { set, hit };
}
beforeEach(() => {
  useBrowserStore.setState({ ...initial, ...view, currentGenome: 'synthetic', featureHub: EMPTY_HUB, highlights: [],
    panels: [{ id: 'p', datasetId: 'sample', stateKey: 'sample', contentType: 'dataset' }] as never,
    selectedFeatures: [], peaksByRule: {}, selectedPeaks: new Set(), peakModes: {}, clusterPeakMode: 'accessibility',
    datasets: [{ id: 'sample', label: 'Sample', path: '/data/sample.bam', data_type: 'bam' }] as never });
  useSplitPanelStore.setState({ pending: null });
  useHubData.setState({ scans: [], hits: {}, providers: [] });
});
afterEach(() => { vi.restoreAllMocks(); resetGraphHub(); });

it.each(kinds)('%s supports anchors, split, highlight, catalog, BED and values', async typeId => {
  const { set, hit } = fixture(typeId);
  const selected = [hitSelectionEntry(set, hit)];
  expect(selected[0].hasStates).toBe(true);
  const restored = normalizeHub(JSON.parse(JSON.stringify({ selected })));
  expect(restored.selected).toEqual(selected);
  expect(selectionRefs(restored.selected)[0].hubHit?.stateSpec).toEqual({ kind: 'open' });
  expect(asAnchors(selected)).toBeNull();
  expect(asSplit(selected)).toBeNull();
  expect(useSplitPanelStore.getState().pending?.source.kind).toBe('patterns');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ features: [{ datasets: ['sample'] }], by_dataset: { sample: { synthetic: '1' } } })));
  expect(await asFilter(selected)).toBeNull();
  expect(useBrowserStore.getState().filteredReadIds.sample?.has('synthetic')).toBe(true);
  expect(await asClusterRegions(selected, false)).toBeNull();
  expect(useBrowserStore.getState().selectedPeaks.size).toBe(1);
  expect(await asHighlight(selected)).toBeNull();
  expect(useBrowserStore.getState().highlights).toMatchObject([{ chrom: 'chrT', start: 10, end: 11 }]);
  expect(asRegionCatalog(selected)).toBeNull();
  expect(useRegionCatalogStore.getState().catalogFor('synthetic').entries.some(e => e.start === 10 && e.end === 11)).toBe(true);
  expect(hitExportText(selected, 'bed')).toContain('chrT\t10\t10\tHit label\t500\t.');
  expect(hitExportText(selected, 'values')).toContain('0.5\t0.2\t0.8\t8\t10');
  expect(hitExportText(selected, 'values')).toContain('provenance=');
});

it('an unbound scan is read-only while geometric actions and exports remain available', () => {
  const { set, hit } = fixture('fp.class');
  const unbound = { ...set, setId: 'hub:foreign', datasets: [], source: { kind: 'scan', scanId: 'foreign', module: 'fp' } } as FeatureSet;
  const selected = hitSelectionEntry(unbound, { ...hit, stateSpec: undefined });
  expect(selected.hasStates).toBe(false);
  expect(asSplit([selected])).toContain('per-record states');
  expect(asAnchors([selected])).toBeNull();
  expect(hitExportText([selected], 'bed')).toContain('chrT');
});

const scopes: HubScope[] = [{ kind: 'view' }, { kind: 'genome' }, { kind: 'scan', scanId: 'scan' },
  { kind: 'bed', bed: '/data/regions.bed' }, { kind: 'genes', genes: ['GENE_A'] }, { kind: 'anchors', anchorSetId: 'a', flank: 0 }];
it.each(scopes)('sends $kind scope and bounded server-side sorting/filtering', async scope => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ rows: [], total: 100_001, limit: 100, offset: 200, hasMore: true })));
  await queryHubPage({ ...EMPTY_HUB.ui, scope, offset: 200, pageSize: 100, maxQ: .05, minStrength: 2,
    sort: { key: 'q', dir: 'asc' } }, view, [], [{ id: 'a', anchors: [{ chrom: 'chrT', pos: 10 }] }], new AbortController().signal);
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(body).toMatchObject({ offset: 200, limit: 100, maxQ: .05, minStrength: 2, sort: { key: 'q', dir: 'asc' } });
  if (scope.kind === 'anchors') expect(body.scope.anchors).toEqual([['chrT', 10]]);
  if (scope.kind === 'view') expect(body.scope).toMatchObject(view);
  expect(body.scope.kind).toBe(scope.kind);
});

it('persists scope, sorting, filters, and embedding/re-scan metadata', () => {
  const saved = { ...EMPTY_HUB, ui: { ...EMPTY_HUB.ui, scope: { kind: 'genes', genes: ['GENE_A'] }, offset: 100, pageSize: 50, minStrength: 3, maxQ: .01 },
    scans: [{ path: '/data/scan', scanId: 's', source: 'cache', embedding: 'reference', rescanPrompt: 'Locate or re-scan', label: 'Scan', manifestDigest: 'sha' }] };
  expect(normalizeHub(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
});

it('provider graph columns draw and select the same hit as the list', () => {
  const { set, hit } = fixture('graph.bubble');
  hit.graph = { registration: 'g', target: 'ref', binding: 'alt', anchor: [10, 10], columns: [['inserted', 0, 5]], size: 5,
    paths: { alt: { status: 'carried', carried: 5, total: 5, datasets: ['sample'], label: 'H1', hap: 'H1' } } };
  useHubData.setState({ providers: [set] });
  expect(drawableHits()[0].hit.graph?.columns).toEqual([['inserted', 0, 5]]);
  expect(selectFromGraph({ setId: set.setId, hitId: hit.hitId } as never, false)).toBe(true);
  expect(useBrowserStore.getState().featureHub.selected[0]).toMatchObject({ hitId: hit.hitId, graph: hit.graph });
  expect(pageSets({ rows: [{ source: set.setId, setId: set.setId, hit }], total: 1, offset: 0, limit: 100, hasMore: false }, [], [set])[0].source).toMatchObject({ hits: [hit] });
});


it('conditions on exactly the selected hits across pages and kinds', async () => {
  const chosen = ['var.sv', 'nfr.region'].map(type => { const f = fixture(type); return hitSelectionEntry(f.set, { ...f.hit, hitId: type }); });
  const set = conditioningSet(chosen)!;
  expect(set.count).toBe(2);
  const { setChoices } = await import('./assocRequest');
  const choice = setChoices([set], [], view)[0];
  expect(choice.hasStates).toBe(true);
  expect(choice.ref.hits?.map(h => h.hubHit)).toEqual(chosen);
});
