import { describe, it, expect, beforeAll } from 'vitest';
import { clusterRunHeadline, clusterRunPlan, clusterTargetPlan } from './clusterTargets';
import { registerFeatureKind } from '../stores/featureStore';
import { selectedKindNotes } from './featureClustering';
import { registerPanelTraits } from './panelExtensions';
import { useSplitPanelStore } from '../stores/splitPanelStore';
import type { PanelConfig } from '../types';

const ALT = 'fasta:alt_1';
const LOCUS = { chrom: 'chrSV', start: 8000, end: 16000, label: 'INS 400 bp @ chrSV:14,001' };
const panel = (o: Partial<PanelConfig> & { id: string }): PanelConfig => ({
  contentType: 'dataset', datasetId: 'sv', subTracks: [], ...o,
} as unknown as PanelConfig);

function state(selected: string[] = [], extra: Partial<Record<string, unknown>> = {}) {
  const panels = [
    panel({ id: 'src', collapsed: true }),
    panel({ id: 'ref', stateKey: 'sv:split:0', readSubset: { groupId: 'g', label: 'INS 400 bp @ chrSV:14,001 · Reference', locus: LOCUS, colour: '#000', count: 15, sourcePanelId: 'src', rule: { kind: 'frozen', datasetId: 'sv', groupKeys: [] } } }),
    panel({ id: 'car', datasetId: 'sv_alt', stateKey: 'car~alt', genome: ALT, viewportOverride: { chrom: 'chrSV_INS', start: 8000, end: 16399 },
      readSubset: { groupId: 'g', label: 'INS 400 bp @ chrSV:14,001 · Carriers', locus: LOCUS, colour: '#f00', count: 9, sourcePanelId: 'src', rule: { kind: 'frozen', datasetId: 'sv', groupKeys: [] } },
      altAllele: {} as never }),
  ];
  return {
    panels, datasets: [{ id: 'sv', label: 'sv_demo' }, { id: 'sv_alt', label: 'sv_demo alt' }] as never,
    selectedDatasets: new Set(selected), chrom: 'chrSV', start: 8000, end: 16000, currentGenome: 'dm6',
    filteredReadIds: {}, selectedPeaks: new Set<number>(), peakModes: {}, clusterPeakMode: 'accessibility', clusterFeatureRules: [],
    selectedGenes: new Set(), selectedFeatures: [], getAllPeaks: () => [], ...extra,
  } as never;
}
const names = (g: string | null) => (g === ALT ? 'Alt allele chrSV:14,000 +400 bp' : 'dm6');

describe('clusterTargetPlan', () => {
  beforeAll(() => {
    registerPanelTraits(p => (p.altAllele ? { ownContig: true } : null));
    // The Reference split panel's own reads (as the split stores them once classified).
    useSplitPanelStore.getState().setReads('sv:split:0', { state: 'ready', ids: new Set(['r1', 'r2']) } as never);
  });

  it('a peak in the expanded Carriers: Carriers clustered, Reference excluded with its reason (before running)', () => {
    const plan = clusterTargetPlan(state(), [{ start: 14020, end: 14379, chrom: 'chrSV_INS', genome: ALT }], names);
    expect(plan.refusal).toBeNull();
    expect(plan.rows.find(r => r.panelId === 'car')).toMatchObject({ inRun: true, reason: null, short: 'Carriers' });
    const ref = plan.rows.find(r => r.panelId === 'ref')!;
    expect(ref.inRun).toBe(false);
    expect(ref.reason).toContain('different coordinates from Carriers');
    expect(plan.summary).toBe('Cluster at 1 selected peak in Carriers · Reference left out: different coordinates');
    expect(plan.headline).toBe('Cluster at 1 selected peak in Carriers');
    expect(plan.chip).toBe('Panels: Carriers · 1 left out');
    // The folded source panel is not on screen: not listed.
    expect(plan.rows.some(r => r.panelId === 'src')).toBe(false);
  });

  it('a dm6 peak: Reference clustered, Carriers excluded (its own coordinates)', () => {
    const plan = clusterTargetPlan(state(), [{ start: 9000, end: 9100 }], names);
    expect(plan.refusal).toBeNull();
    expect(plan.rows.find(r => r.panelId === 'ref')?.inRun).toBe(true);
    expect(plan.rows.find(r => r.panelId === 'car')?.reason).toContain('its own coordinates');
  });

  it('refuses before running when a targeted panel would be left out', () => {
    const plan = clusterTargetPlan(state(['ref', 'car']), [{ start: 14020, end: 14379, chrom: 'chrSV_INS', genome: ALT }], names);
    expect(plan.explicit).toBe(true);
    expect(plan.refusal).toMatch(/^Cluster can't include Reference: different coordinates from Carriers/);
    expect(plan.refusal).toContain('Panels ▾');
  });

  it('a targeted compatible panel runs; untargeted panels are "not targeted", not "excluded"', () => {
    const plan = clusterTargetPlan(state(['car']), [{ start: 14020, end: 14379, chrom: 'chrSV_INS', genome: ALT }], names);
    expect(plan.refusal).toBeNull();
    expect(plan.rows.find(r => r.panelId === 'ref')).toMatchObject({ inRun: false, reason: null, targeted: false });
    expect(plan.summary).toBe('Cluster at 1 selected peak in Carriers');
    expect(plan.chip).toBe('Panels: Carriers');
  });

  it('a panel filtered to nothing is excluded with its reason', () => {
    const plan = clusterTargetPlan(state([], { filteredReadIds: { 'sv:split:0': new Set() } }), [{ start: 9000, end: 9100 }], names);
    expect(plan.rows.find(r => r.panelId === 'ref')?.reason).toBe('no reads pass the read filter');
    const all = clusterTargetPlan(state(), [], names);
    expect(all.where).toBe('all panels');
    expect(all.chip).toBe('Panels: all');
  });

  it('one panel, nothing targeted: the chip says "Panels: all", not the dataset name (round 2, N7)', () => {
    const one = { ...(state() as unknown as Record<string, unknown>), panels: [panel({ id: 'only', datasetId: 'sv' })] } as never;
    const plan = clusterTargetPlan(one, [], names);
    expect(plan.where).toBe('sv_demo');
    expect(plan.chip).toBe('Panels: all');
  });

  it('a split panel whose reads are not classified yet has none to cluster (as the run sees it)', () => {
    useSplitPanelStore.getState().setReads('sv:split:0', { state: 'loading' } as never);
    try {
      const plan = clusterTargetPlan(state(), [{ start: 9000, end: 9100 }], names);
      expect(plan.rows.find(r => r.panelId === 'ref')?.reason).toBe('no reads of its own to cluster here');
    } finally {
      useSplitPanelStore.getState().setReads('sv:split:0', { state: 'ready', ids: new Set(['r1', 'r2']) } as never);
    }
  });

});

// Round 3, R6/B5: with SVs ticked and a peak selected, Cluster (not Combinatorial) runs on the peak; the tooltip said
// "Cluster reads at INS 9.2k, INS 5k: …" with the notes of kinds not selected. One plan now words the tooltip, the picker and the result.
describe('clusterRunPlan: what the run clusters on', () => {
  beforeAll(() => {
    registerPanelTraits(p => (p.altAllele ? { ownContig: true } : null));
    registerFeatureKind({ kind: 'sv', perDataset: true, keyedByChrom: true, layerLabel: 'SV genotype', noun: 'SVs', regionMode: () => null,
      actions: { cluster: async () => null, sortFilter: '', mixed: '', Chip: () => null } } as never);
    // Another registered kind with notes of its own (a plugin pack's): never named for a selection without it.
    registerFeatureKind({ kind: 'other-kind', layerLabel: 'other layer', pluralName: 'others', layerNote: 'others on their own layer' } as never);
    useSplitPanelStore.getState().setReads('sv:split:0', { state: 'ready', ids: new Set(['r1', 'r2']) } as never);
  });
  const svs = [
    { kind: 'sv', source: 'sv', id: 'I:14000:400', datasetId: 'sv', chrom: 'chrSV', start: 14000, end: 14001, label: 'INS 400' },
    { kind: 'sv', source: 'sv', id: 'I:15000:5000', datasetId: 'sv', chrom: 'chrSV', start: 15000, end: 15001, label: 'INS 5k' },
  ];
  const peak = { index: 3, start: 14020, end: 14379, chrom: 'chrSV_INS', genome: ALT };
  const st = (extra: Record<string, unknown>) => state(['car'], {
    selectedFeatures: svs, selectedPeaks: new Set([3]), getAllPeaks: () => [peak], clusterMethod: 'kmeans', ...extra,
  });

  it('SVs ticked + a peak, a region method: the peak, in the targeted Carriers; the SVs said to need Combinatorial', () => {
    const plan = clusterRunPlan(st({}), names);
    expect(plan.basis.kind).toBe('peaks');
    expect(plan.basis.regions).toHaveLength(1);
    expect(plan.headline).toBe('Cluster at 1 selected peak in Carriers');
    expect(plan.notes).toEqual(['ticked SVs group reads only with Combinatorial']);
    expect(plan.summary).toBe('Cluster at 1 selected peak in Carriers · ticked SVs group reads only with Combinatorial');
    expect(plan.summary).not.toMatch(/INS|others/);
    expect(clusterRunHeadline(plan, 'Subcluster')).toBe('Subcluster at 1 selected peak in Carriers');
    expect(clusterRunHeadline({ basis: plan.basis, where: 'no panel' })).toBe('Cluster at 1 selected peak: no panel to cluster');
    // The tooltip's layer notes are the selected kinds' only (SVs have none): never another kind's.
    expect(selectedKindNotes(plan.basis.features, 'layerNote')).toEqual([]);
  });

  it('the same with Combinatorial: the SVs group the reads; the peak does not count', () => {
    const plan = clusterRunPlan(st({ clusterMethod: 'combinatorial' }), names);
    expect(plan.basis.kind).toBe('combinatorial');
    expect(plan.basis.regions).toEqual([]);
    expect(plan.headline).toBe('Group reads by their state at INS 400, INS 5k');
    expect(plan.notes).toEqual([]);
  });

  it('Combinatorial on SVs names the panel their grouping goes to, not the targets (Codex review)', () => {
    registerFeatureKind({ kind: 'sv', perDataset: true, keyedByChrom: true, layerLabel: 'SV genotype', noun: 'SVs', regionMode: () => null,
      actions: { cluster: async () => null, groupsPanel: () => 'src', sortFilter: '', mixed: '', Chip: () => null } } as never);
    const plan = clusterRunPlan(st({ clusterMethod: 'combinatorial' }), names);
    expect(plan.headline).toBe('Group reads by their state at INS 400, INS 5k in sv_demo (folded away)');
    const car = plan.rows.find(r => r.panelId === 'car')!;
    expect(car.inRun).toBe(false);
    expect(car.reason).toBe("the ticked SVs group the reads of their dataset's panel");
    expect(plan.chip).toBe('Panels: none · 1 left out');
  });

  it('SVs ticked and no peak: nothing to cluster on, and why', () => {
    const plan = clusterRunPlan(st({ selectedPeaks: new Set() }), names);
    expect(plan.basis.kind).toBe('none');
    expect(plan.headline).toMatch(/nothing to cluster on yet \(select peaks\)/);
    expect(plan.basis.unused).toBe('ticked SVs group reads only with Combinatorial');
  });

  it('rows lead with the name the header leads with, the rest on a second line (no repeat)', () => {
    const plan = clusterRunPlan(st({}), names);
    const ref = plan.rows.find(r => r.panelId === 'ref')!;
    expect(ref.short).toBe('Reference');
    expect(ref.detail).toBe('INS 400 bp @ chrSV:14,001 · sv_demo');
    expect(ref.label).toBe('Reference · INS 400 bp @ chrSV:14,001 · sv_demo');
  });
});
