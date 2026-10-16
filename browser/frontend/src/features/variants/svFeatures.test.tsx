import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { normalizeFeatureRefs } from '../../stores/featureStore';
import { SV_GROUP_SPLIT_NOTE, groupBySelectedSvs, splitBySelectedSvs, svComboPanel, svFeatureInView, svFeatureRef, svSelectionPlace, svMatches, svName, svOfFeature, toggleSvFeature, useSvComboStore } from './svFeatures';
import { variantSplitGrouping } from './variantSplit';
import { openSplitPanels } from '../../utils/splitPanels';
import { clusterSelectedFeatures, featurePeakRegions } from '../../utils/featureClustering';
import { FeatureSelectionChip } from '../../components/controls/FeatureSelectionChip';
import type { AlleleGrouping } from './api';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ROO = { t: 'I' as const, ref: 9_467_038, len: 9_211 };
const HOBO = { t: 'I' as const, ref: 9_471_224, len: 1_888 };
const panel: PanelConfig = { id: 'p1', contentType: 'dataset', datasetId: 'numb', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 };

beforeEach(() => {
  useBrowserStore.setState({ selectedFeatures: [], panels: [panel], chrom: 'chr2L', start: 9_440_000, end: 9_500_000, datasets: [] } as never);
  useSvComboStore.setState({ pending: null });
});

describe('SVs as selectable features', () => {
  it('toggle in and out of the feature selection, survive a session, and match clusters across views', () => {
    toggleSvFeature(ROO, 'numb', 'chr2L');
    toggleSvFeature(HOBO, 'numb', 'chr2L');
    const sel = useBrowserStore.getState().selectedFeatures;
    expect(sel.map(f => f.id)).toEqual(['I:9467038:9211', 'I:9471224:1888']);
    expect(normalizeFeatureRefs(JSON.parse(JSON.stringify(sel)))).toHaveLength(2);
    expect(normalizeFeatureRefs([{ kind: 'sv', source: 'numb', id: 'I:1:2' }])).toHaveLength(0);  // needs its dataset
    toggleSvFeature({ ...ROO, ref: ROO.ref + 3 }, 'numb', 'chr2L');  // the same SV: off again
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['I:9471224:1888']);
    expect(svMatches(svOfFeature(sel[0])!, { t: 'I', ref: ROO.ref + 20, len: ROO.len - 40 })).toBe(true);
    expect(svMatches(svOfFeature(sel[0])!, HOBO)).toBe(false);
    // An SV is not a region to cluster on.
    expect(featurePeakRegions(sel)).toEqual([]);
  });

  it('is named after the family Identify found for it, else its size', () => {
    expect(svName(ROO, 'numb', 'chr2L')).toBe('INS 9.2k');
    useBrowserStore.setState({ panels: [panel, { ...panel, id: 'lens', contentType: 'variants' as never,
      insertionIdentify: { 'numb|chr2L|9467038|9211': { seqSha: 'x', at: '2026', result: { te: { calls: [{ family: 'roo', related: false }] }, genome: {} } } } } as never] } as never);
    expect(svName(ROO, 'numb', 'chr2L')).toBe('roo');
    expect(svFeatureRef(ROO, 'numb', 'chr2L').label).toBe('roo');
  });

  it('SVs and other features are not mixed in one Cluster', async () => {
    useBrowserStore.setState({ selectedFeatures: [svFeatureRef(ROO, 'numb', 'chr2L'), { kind: 'fp-class', source: 'job', id: 'C1', chrom: 'chr2L', datasetId: 'numb' }] } as never);
    expect(await clusterSelectedFeatures()).toMatch(/can.t be combined/);
  });
});

const grouping: AlleleGrouping = {
  groups: [
    { id: 0, key: '+--', label: 'roo+ · hobo− · jockey+', alleles: ['+', '-', '+'], count: 812, kind: 'combo' },
    { id: 1, key: '-+-', label: 'roo− · hobo+ · jockey−', alleles: ['-', '+', '-'], count: 300, kind: 'combo' },
    { id: 2, key: 'other', label: 'Other', alleles: [], count: 0, kind: 'other' },
    { id: 3, key: 'not-informative', label: 'Not informative', alleles: [], count: 2, kind: 'not-informative' },
  ],
  assignments: { a: 0, b: 0, c: 1, d: 3, e: 3 }, n_reads: 5, covering: 3, threshold: 3, distinct: 2, snps: [], phase: null, tags: null,
  scan_key: 'k', dataset_id: 'numb', region: { chrom: 'chr2L', start: 9_440_000, end: 9_500_000 }, mode: 'sv',
  svs: ['I:9467038:9211', 'I:9471224:1888', 'I:9487240:5000'],
  columns: [{ id: 'I:9467038:9211', name: 'roo', kind: 'sv' }, { id: 'I:9471224:1888', name: 'hobo', kind: 'sv' }, { id: 'I:9487240:5000', name: 'jockey', kind: 'sv' }],
};

describe('the combined-SV split', () => {
  it('names each panel by its genotype and reads, and knows which insertions all its reads carry', () => {
    const split = variantSplitGrouping(grouping, 'numb', 'roo + hobo + jockey');
    expect(split.groups.map(g => g.label)).toEqual(['roo+ · hobo− · jockey+ (2)', 'roo− · hobo+ · jockey− (1)', 'Not informative']);
    expect(split.groups[0].ruleExtras!.carriedInsertions!.map(i => i.name)).toEqual(['roo', 'jockey']);
    expect(split.groups[1].ruleExtras!.carriedInsertions!.map(i => i.name)).toEqual(['hobo']);
    const rows = split.groups.filter(g => g.kind === 'group').map(g => ({ key: g.key, label: g.label, colour: g.colour, kind: 'group' as const, groupKeys: [g.key], count: g.count, checked: true }));
    openSplitPanels(split, rows, [panel]);
    const made = useBrowserStore.getState().panels.filter(p => p.readSubset);
    // Several SVs: the panels stay on the reference; each can expand an insertion its reads all carry.
    expect(made.every(p => !p.altAllele)).toBe(true);
    expect(made[0].readSubset!.rule.carriedInsertions!.map(i => [i.name, i.ref])).toEqual([['roo', 9_467_038], ['jockey', 9_487_240]]);
  });

  it('after Split into panels, the combined split reads the source panel\'s reads (as Variants › SVs lists them); Group says why not', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return { ok: true, json: async () => grouping } as Response;
    }));
    const subset = (label: string, key: string) => ({ groupId: 'g1', label, colour: '#000', count: 2, sourcePanelId: 'p1',
      rule: { kind: 'frozen', datasetId: 'numb', groupKeys: [key], readIds: ['r1', 'r2'] } });
    useBrowserStore.setState({
      panels: [{ ...panel, collapsed: true, collapsedBySplitGroup: 'g1' },
        { ...panel, id: 'pc', stateKey: 'pc', readSubset: subset('Carriers', '0') },
        { ...panel, id: 'pr', stateKey: 'pr', readSubset: subset('Reference', '1') }],
      selectedDatasets: new Set(['pr']),
      selectedFeatures: [svFeatureRef(ROO, 'numb', 'chr2L'), svFeatureRef(HOBO, 'numb', 'chr2L')],
    } as never);
    expect(svComboPanel('numb')?.id).toBe('p1');
    expect(await splitBySelectedSvs(useBrowserStore.getState().selectedFeatures)).toBeNull();
    expect(calls[0].url).toContain('/api/variants/alleles');
    expect(calls[0].body).toMatchObject({ dataset_id: 'numb', chrom: 'chr2L', start: 9_440_000, end: 9_500_000 });
    expect(calls[0].body.read_ids).toBeUndefined();
    expect(await groupBySelectedSvs(useBrowserStore.getState().selectedFeatures)).toBe(SV_GROUP_SPLIT_NOTE);
    expect(calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('the feature chip groups or splits by the selected SVs', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return { ok: true, json: async () => grouping } as Response;
    }));
    useBrowserStore.setState({ selectedFeatures: [svFeatureRef(ROO, 'numb', 'chr2L'), svFeatureRef(HOBO, 'numb', 'chr2L')] } as never);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<FeatureSelectionChip />));
    expect(container.querySelector('[data-testid="feature-sv-group"]')).not.toBeNull();
    act(() => (container.querySelector('[data-testid="feature-sv-require-all"]') as HTMLInputElement).click());
    await act(async () => { (container.querySelector('[data-testid="feature-split-panels"]') as HTMLButtonElement).click(); await new Promise(r => setTimeout(r, 0)); });
    expect(calls[0].url).toContain('/api/variants/alleles');
    expect(calls[0].body).toMatchObject({ dataset_id: 'numb', chrom: 'chr2L', start: 9_440_000, end: 9_500_000, partial: true,
      svs: [{ t: 'I', ref: ROO.ref, len: ROO.len, name: 'INS 9.2k' }, { t: 'I', ref: HOBO.ref, len: HOBO.len, name: 'INS 1.9k' }] });
    expect(useSvComboStore.getState().pending?.title).toBe('INS 9.2k + INS 1.9k');
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('groups the panel the genotypes are read in, not a reference copy beside it (round 3 integration)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => grouping }) as Response));
    const src = { ...panel, id: 'src', collapsed: true };
    const copy = { ...panel, id: 'copy', stateKey: 'numb~copy1', viewportOverride: { chrom: 'chr2R', start: 1_000, end: 20_000 } };
    useBrowserStore.setState({ panels: [src, copy] } as never);
    const notice = await groupBySelectedSvs([svFeatureRef(ROO, 'numb', 'chr2L'), svFeatureRef(HOBO, 'numb', 'chr2L')]);
    expect(notice).toBeNull();
    const assigned = Object.keys(useBrowserStore.getState().clusterAssignments ?? {});
    expect(assigned).toContain('numb');
    expect(assigned).not.toContain('numb~copy1');
    vi.unstubAllGlobals();
  });

  it('with another feature also selected (a footprint class), splits by the SVs only and names only them', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return { ok: true, json: async () => grouping } as Response;
    }));
    const other = { kind: 'fp-class' as const, source: 'job', id: 'C5', chrom: 'chr2L', datasetId: 'numb', start: 9_450_000, end: 9_450_400, label: 'C5' };
    useBrowserStore.setState({ selectedFeatures: [svFeatureRef(ROO, 'numb', 'chr2L'), other] } as never);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<FeatureSelectionChip />));
    expect(container.querySelector('[data-testid="feature-split-panels"]')!.getAttribute('title')).toContain('the 1 other feature also selected is left out');
    act(() => root.unmount());
    container.remove();
    expect(await splitBySelectedSvs(useBrowserStore.getState().selectedFeatures)).toBeNull();
    expect(calls[0].body.svs).toHaveLength(1);
    expect(useSvComboStore.getState().pending?.title).toBe('INS 9.2k');
    vi.unstubAllGlobals();
  });
});

describe('closing a split by the selected SVs (audit SV-9)', () => {
  it('clears those SVs from the feature chip (by dataset and coordinates), nothing else', async () => {
    const { clearSvSelectionOfSplit } = await import('./register');
    toggleSvFeature(ROO, 'numb', 'chr2L');
    toggleSvFeature(HOBO, 'numb', 'chr2L');
    clearSvSelectionOfSplit([{ readSubset: { rule: {} } }]);
    expect(useBrowserStore.getState().selectedFeatures).toHaveLength(2);
    // Same label elsewhere (another dataset): left alone.
    clearSvSelectionOfSplit([{ readSubset: { rule: { splitSvs: [{ datasetId: 'other', chrom: 'chr2L', id: 'I:9467038:9211' }] } } }]);
    expect(useBrowserStore.getState().selectedFeatures).toHaveLength(2);
    clearSvSelectionOfSplit([{ readSubset: { rule: { splitSvs: [{ datasetId: 'numb', chrom: 'chr2L', id: 'I:9467040:9200' }] } } }]);
    expect(useBrowserStore.getState().selectedFeatures.map(f => f.id)).toEqual(['I:9471224:1888']);
  });

  it('a combined-SV split records its SVs on its rule', () => {
    const grouping = { groups: [{ id: 0, key: '++', label: 'roo+ · hobo+', alleles: ['+', '+'], count: 1, kind: 'combo' }], assignments: { r1: 0 },
      columns: [{ kind: 'sv', id: 'I:9467038:9211', name: 'roo' }, { kind: 'sv', id: 'I:9471224:1888', name: 'hobo' }],
      region: { chrom: 'chr2L', start: 1, end: 2 } } as unknown as AlleleGrouping;
    expect(variantSplitGrouping(grouping, 'numb', 'roo + hobo').rule.splitSvs).toEqual([
      { datasetId: 'numb', chrom: 'chr2L', id: 'I:9467038:9211' }, { datasetId: 'numb', chrom: 'chr2L', id: 'I:9471224:1888' }]);
  });

  it('SVs not in the view: refused with where they are, before any request (round 3, B6)', async () => {
    toggleSvFeature(ROO, 'numb', 'chr2L');
    toggleSvFeature(HOBO, 'numb', 'chr2L');
    const sel = useBrowserStore.getState().selectedFeatures;
    expect(sel.every(f => svFeatureInView(f, { chrom: 'chr2L', start: 9_440_000, end: 9_500_000 }))).toBe(true);
    useBrowserStore.setState({ start: 9_600_000, end: 9_630_000 } as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const message = await groupBySelectedSvs(sel);
    expect(message).toBe('The selected SVs are not in this view (at chr2L:9,467,039–9,471,225): go to them first.');
    expect(message).not.toContain('Require calls');
    expect(await splitBySelectedSvs(sel)).toContain('not in this view');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(svSelectionPlace([sel[0]], 30_000)).toEqual({ label: 'chr2L:9,467,039', view: { chrom: 'chr2L', start: 9_452_039, end: 9_482_039 } });
  });
});
