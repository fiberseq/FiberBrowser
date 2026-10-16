import type { BrowserState } from '../stores/browserStore';
import type { FirePeak, PanelConfig } from '../types';
import type { MatchedGroupInput } from './matchedRegions';
import { variantPositionBlocks, type PositionBlock } from './equivalentPositions';

function member(panel: PanelConfig, chrom: string, blocks: PositionBlock[], length: number, label: string): FirePeak {
  return { chrom, genome: panel.genome, index: 0, start: Math.min(...blocks.map(b => b.genomic[0])), end: Math.max(...blocks.map(b => b.genomic[1])),
    match: { groupId: '', label, panelId: panel.id, datasetId: panel.datasetId ?? undefined, length, reversed: false, blocks } };
}

/** SV panels declare the same correspondence as accepted sequence or hand-linked regions. */
export function svCorrespondences(s: BrowserState): MatchedGroupInput[] {
  const out: MatchedGroupInput[] = [];
  const expanded = new Set<string>();
  for (const panel of s.panels) {
    const alt = panel.altAllele;
    if (!alt) continue;
    const l = alt.layout;
    if (!l || !Number.isFinite(l.ref)) continue;
    const partners = s.panels.filter(p => p.id !== panel.id && !p.collapsed && !p.altAllele && p.datasetId === alt.cluster.datasetId
      && (p.genome ?? null) === (alt.sourceGenome ?? null)
      && (!panel.readSubset || p.readSubset?.groupId === panel.readSubset.groupId)
      && (p.viewportOverride?.chrom ?? s.chrom) === l.chrom);
    if (!partners.length) continue;
    if (panel.readSubset) expanded.add(panel.readSubset.groupId);
    const map = variantPositionBlocks(l.ref - l.flank_left, l.ref + l.flank_right, l.ref, 0, l.insert_len);
    out.push({ id: `sv-equivalence-${panel.id}`, name: 'SV flanks matched', matchGroup: { origin: 'sv' },
      regions: [member(panel, l.name, map.alternate, map.length, 'Carriers'),
        ...partners.map((p, i) => member(p, l.chrom, map.reference, map.length, `Reference ${i + 1}`))] });
  }
  const groups = new Set(s.panels.flatMap(p => p.readSubset ? [p.readSubset.groupId] : []));
  for (const group of groups) {
    if (expanded.has(group)) continue;
    const panels = s.panels.filter(p => p.readSubset?.groupId === group && !p.collapsed && !p.altAllele);
    const source = s.panels.find(p => p.id === panels[0]?.readSubset?.sourcePanelId);
    const def = source && s.svSplits[source.stateKey ?? source.datasetId ?? source.id];
    if (!def || panels.length < 2) continue;
    const map = variantPositionBlocks(Math.min(def.viewStart, def.ref), Math.max(def.viewEnd, def.end), def.ref, def.t === 'D' ? def.len : 0, 0);
    if (!map.reference.length) continue;
    out.push({ id: `sv-equivalence-${group}`, name: 'SV flanks matched', matchGroup: { origin: 'sv' },
      regions: panels.map((p, i) => member(p, def.chrom, map.reference, map.length, `W${i + 1}`)) });
  }
  return out;
}

/** Reconcile geometry without rewriting unchanged groups when panel presentation changes. */
export function updateSvCorrespondences(s: BrowserState): void {
  const maps = svCorrespondences(s);
  for (const rule of s.peakRules.filter(r => r.matchGroup?.origin === 'sv')) {
    if (!maps.some(m => m.id === rule.id)) s.removeMatchedGroup(rule.id);
  }
  const geometry = (peaks: FirePeak[]) => JSON.stringify(peaks.map(p => ({ chrom: p.chrom, genome: p.genome,
    start: p.start, end: p.end, match: { ...p.match!, groupId: '' } })));
  for (const map of maps) {
    const previous = s.peakRules.find(r => r.id === map.id);
    if (previous && geometry(s.peaksByRule[map.id!] ?? []) === geometry(map.regions)) continue;
    s.upsertMatchedGroup({ ...map, name: previous?.name ?? map.name });
  }
}
