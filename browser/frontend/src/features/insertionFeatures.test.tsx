/**
 * The insertion and variant features' contributions through the core extension points (a core module, features/): their
 * panels and rail tiles, their menu items on the reads and the SV row, the SV row's own kind menu, their rows'
 * placement, their feature kinds and their panel traits.
 */
import './testSetup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAllAnalysisPanels, getAnalysisPanel, getGroupedAnalysisPanels } from '../plugins/registry';
import { getPreviewFeature, resetPreviewsForTests } from '../utils/previewFeatures';
import { svRowSelection } from '../components/tracks/svRowSelection';
import { loadedPacks } from '../plugins/packRegistry';
import { buildReadMenu, svClusterMenu, type ReadMenuItem } from '../components/tracks/read-track/readMenuModel';
import { isTrackListed, trackMenuItems } from '../components/tracks/trackRegistry';
import { createDefaultSubTracks, ensureBuiltinSubTracks } from '../stores/utils';
import { featureKindDef } from '../stores/featureStore';
import { panelTraits } from '../utils/panelExtensions';
import { HIDDEN_PANELS } from '../components/tracks/AnalysisStrip';
import { railTileColor } from '../utils/railTileColor';
import type { PanelConfig } from '../types';

const base = {
  readId: 'r1', footprint: null, readSelected: false, selectedCount: 0, hasReadFilter: false, excludedCount: 0,
  readHighlighted: false, anyHighlight: false, isMac: true,
};
const actions = (entries: ReturnType<typeof buildReadMenu>) => entries.filter((e): e is ReadMenuItem => e.kind === 'item').map(i => i.action);

beforeAll(() => resetPreviewsForTests(true));
afterAll(() => resetPreviewsForTests(false));

describe('the insertion and variant features', () => {
  it('are core: registered without any plugin pack', () => {
    expect(loadedPacks()).toEqual([]);
  });

  it('the insertion lens and the Variants panel (both supported), each with its icon', () => {
    expect(getAnalysisPanel('insertion-lens')?.label).toBe('Insertion lens');
    expect(getAnalysisPanel('insertion-lens')?.icon).toBeTypeOf('function');
    expect(getAnalysisPanel('insertion-lens')?.preview).toBeUndefined();
    expect(getAnalysisPanel('variants')?.label).toBe('Variants');
    expect(getAnalysisPanel('variants')?.icon).toBeTypeOf('function');
    expect(getAnalysisPanel('variants')?.preview).toBeUndefined();
    expect(getPreviewFeature('variants')).toBeUndefined();
    expect(getPreviewFeature('alt-allele')?.limitations.join(' ')).toMatch(/25–40 s/);
  });

  it('previews off (the default): no launcher or menu item of a Preview feature; the lens and Variants stay', () => {
    resetPreviewsForTests(false);
    const launchers = getGroupedAnalysisPanels().flatMap(g => g.plugins.map(p => p.contentType));
    expect(launchers).toContain('insertion-lens');
    expect(launchers).toContain('variants');
    const ins = svClusterMenu({ cluster: 'INS 9.2 kb', insertion: true, splitActive: false, splitAllowed: true, bamReads: true });
    expect(actions(ins)).toContain('ext:insertion-lens');
    expect(actions(ins)).not.toContain('ext:alt-allele');
    expect(ins.find((e): e is ReadMenuItem => e.kind === 'item' && e.action === 'sv-split-this-panels')!.title).not.toMatch(/insert expanded/);
    const panel = { id: 'p', contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 } as PanelConfig;
    const labels = trackMenuItems('sv', { panel, type: 'sv', datasetId: 'd', stateKey: 'd' }).map(i => i.label);
    expect(labels).toContain('Insertion lens panel');
    expect(labels).toContain('Variants (SNPs, SVs)');
    expect(isTrackListed('snps')).toBe(true);
    expect(svRowSelection()).not.toBeNull();
    expect(featureKindDef('sv')).toBeDefined();
    resetPreviewsForTests(true);
  });

  it('rail tiles: every panel its own colour (Variants pink)', () => {
    const shown = getAllAnalysisPanels().filter(p => !HIDDEN_PANELS.has(p.contentType));
    const byColour = new Map<string, string[]>();
    for (const p of shown) {
      const c = railTileColor(p.headerColor).toLowerCase();
      byColour.set(c, [...(byColour.get(c) ?? []), p.contentType]);
    }
    expect([...byColour.values()].filter(types => types.length > 1)).toEqual([]);
    const colour = (t: string) => shown.find(p => p.contentType === t)?.headerColor.toLowerCase();
    expect(colour('variants')).toBe('#db2777');
  });

  it('the insertion lens on BAM reads (a read and empty track space), nowhere else', () => {
    expect(actions(buildReadMenu(base))).not.toContain('ext:insertion-lens');
    const lens = buildReadMenu({ ...base, bamReads: true }).find((e): e is ReadMenuItem => e.kind === 'item' && e.action === 'ext:insertion-lens');
    expect(lens!.label).toBe('Open insertion lens');
    expect(actions(buildReadMenu({ ...base, bamReads: true, readId: null }))).toContain('ext:insertion-lens');
  });

  it('an insertion of the SV row: the lens and the carriers with the insert expanded (BAM panels)', () => {
    const ins = svClusterMenu({ cluster: 'INS 9.2 kb, 3267/3600', insertion: true, splitActive: true, splitAllowed: true, bamReads: true });
    expect(actions(ins)).toEqual(['sv-split-this', 'sv-split-this-panels', 'sv-highlight-supporting', 'sv-highlight-putative', 'sv-highlight-ambiguous', 'ext:insertion-lens', 'ext:alt-allele', 'sv-split-panels', 'sv-clear-split']);
    const split = ins.find((e): e is ReadMenuItem => e.kind === 'item' && e.action === 'sv-split-this-panels')!;
    expect(split.title).toMatch(/an insertion's Carriers open with the insert expanded/);
    // VAR-11: this insertion in the lens, apart from the panel item ("Insertion lens panel") of the row's menu.
    expect(ins.find((e): e is ReadMenuItem => e.kind === 'item' && e.action === 'ext:insertion-lens')!.label).toBe('Open this insertion in the lens');
    const noLens = svClusterMenu({ cluster: 'INS 9.2 kb', insertion: true, splitActive: false, splitAllowed: true, bamReads: false });
    expect(actions(noLens).some(a => a.startsWith('ext:'))).toBe(false);
    const del = svClusterMenu({ cluster: 'DEL 1 kb', insertion: false, splitActive: false, splitAllowed: true, bamReads: true });
    expect(actions(del).some(a => a.startsWith('ext:'))).toBe(false);
  });

  it('the SV row\'s menu opens the lens and Variants', () => {
    const panel = { id: 'p', contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 } as PanelConfig;
    const items = trackMenuItems('sv', { panel, type: 'sv', datasetId: 'd', stateKey: 'd' });
    expect(items.map(i => i.label)).toEqual(expect.arrayContaining(['Insertion lens panel', 'Variants (SNPs, SVs)']));
    expect(items.find(i => i.panel === 'variants')?.preview).toBeUndefined();
    expect(getGroupedAnalysisPanels().flatMap(g => g.plugins.map(p => p.contentType))).toContain('variants');
    expect(svRowSelection()).not.toBeNull();
  });

  it('its rows take their places in new panels and in older ones that lack them', () => {
    const order = createDefaultSubTracks().map(t => t.type);
    expect(order.indexOf('snps')).toBe(order.indexOf('sv') - 1);
    const old = ensureBuiltinSubTracks([{ type: 'axis', visible: true }, { type: 'reads', visible: true }]).map(t => t.type);
    expect(old).toContain('snps');
    expect(old.indexOf('snps')).toBeLessThan(old.indexOf('reads'));
    // Not in a genome-only panel (no reads).
    expect(ensureBuiltinSubTracks([{ type: 'axis', visible: true }]).map(t => t.type)).not.toContain('snps');
  });

  it('SVs are a feature kind with actions of their own (not a region to cluster on)', () => {
    const sv = featureKindDef('sv')!;
    expect(sv.perDataset && sv.keyedByChrom).toBe(true);
    expect(sv.regionMode?.({ kind: 'sv', source: 'd', id: 'I:1:2' })).toBeNull();
    expect(sv.actions?.sortFilter).toMatch(/for SVs use the feature chip/);
  });

  it('an alt-allele panel is on its own contig, kept while its source is open', () => {
    const panel = { id: 'p', contentType: 'dataset', datasetId: 'alt1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
      altAllele: { cluster: { datasetId: 'numb', chrom: 'chr2L' } } } as unknown as PanelConfig;
    expect(panelTraits(panel)).toMatchObject({ ownContig: true, keptWithDataset: 'numb' });
    expect(panelTraits({ ...panel, altAllele: undefined })).toEqual({});
  });
});
