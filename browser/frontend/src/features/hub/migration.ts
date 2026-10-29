/** Additive 3.x session bridge. Legacy forms remain the owning panels' editable state. */
import type { BrowserState } from '../../stores/browserStore';
import { hubSpanOf, type FeatureRef } from '../../stores/featureStore';
import { typeOfKind } from './kinds';
import type { FeatureHubState, HubSelected } from './hubState';
import { capturePeakSelection, identifyPeaks, migratePeakOwners, migrateSavedPeakOwners, projectPeakSelection, type PeakSelection } from './peakMigration';

export interface PinnedHit extends HubSelected { cart: 'class' | 'nfr'; cartId: string }

/** Pins are views over carts: editing or removing a cart is reflected immediately, without copying its curation. */
export function cartPins(s: Pick<BrowserState, 'footprintGroups' | 'chrom'> & { savedNfrVariants?: unknown }): PinnedHit[] {
  const pins: PinnedHit[] = [];
  for (const g of s.footprintGroups ?? []) {
    if (!g.savedClass || !g.consensusJobId) continue;
    const c = g.savedClass, chrom = g.referenceChrom ?? s.chrom;
    const ds = g.consensusDatasetId ?? g.sourceDatasetId;
    pins.push({ cart: 'class', cartId: g.id, setId: `browser:fp-class:${g.consensusJobId}`, hitId: `fp-class:${g.consensusJobId}:${c.family}`,
      typeId: 'fp.class', chrom, start: c.start, end: c.end, anchor: Math.floor((c.start + c.end) / 2), label: g.name,
      datasets: ds ? [ds] : [], ...(g.referenceGenome ? { frame: { kind: 'linear' as const, chrom, genome: g.referenceGenome } } : {}), legacyRefs: [{ kind: 'fp-class', source: g.consensusJobId, id: c.family, ...(ds ? { datasetId: ds } : {}),
        chrom, start: c.start, end: c.end, label: g.name }] });
  }
  for (const raw of Array.isArray(s.savedNfrVariants) ? s.savedNfrVariants : []) {
    const n = raw as { id: string; name: string; jobId: string; nfrId: string; chrom: string; nfrStart: number; nfrEnd: number;
      datasetIds: string[]; variants: { variantId: string; name: string; start: number; end: number; shown: boolean }[] };
    if (!n?.jobId || !n.chrom || !Array.isArray(n.variants)) continue;
    for (const v of n.variants) pins.push({ cart: 'nfr', cartId: n.id, setId: `browser:nfr-variant:${n.jobId}`,
      hitId: `nfr-variant:${n.jobId}:${v.variantId}`, typeId: 'nfr.variant', chrom: n.chrom, start: Math.floor(v.start), end: Math.ceil(v.end),
      anchor: Math.floor((v.start + v.end) / 2), label: `${n.name} ${v.name}`, datasets: n.datasetIds,
      legacyRefs: [{ kind: 'nfr-variant', source: n.jobId, id: v.variantId, chrom: n.chrom, start: v.start, end: v.end }] });
  }
  return pins;
}

function legacySelection(refs: FeatureRef[]): HubSelected[] {
  return refs.flatMap(ref => {
    const span = hubSpanOf(ref), typeId = typeOfKind(ref.kind);
    if (!span || !ref.chrom || !typeId) return [];
    const prefix = ref.kind === 'sv' ? 'browser:sv' : `browser:${ref.kind}:${ref.source}`;
    return [{ setId: prefix, hitId: ref.kind === 'sv' ? `sv:${ref.chrom}:${ref.id}` : `${ref.kind}:${ref.source}:${ref.id}`,
      typeId, chrom: ref.chrom, ...span, anchor: Math.floor((span.start + span.end) / 2), legacyRefs: [ref],
      ...(ref.datasetId ? { datasets: [ref.datasetId] } : {}), ...(ref.label ? { label: ref.label } : {}) }];
  });
}

/** Run only after viewport, peaks, carts and historical snapshots have all been restored. */
export function migrateHubSession(s: BrowserState): Partial<BrowserState> {
  if (!s.featureHub) return {};
  const peaksByRule = identifyPeaks(s.peaksByRule, s.chrom);
  const selected = s.featureHub.selected.length ? s.featureHub.selected : legacySelection(s.selectedFeatures);
  return { peaksByRule,
    ...(s.featureHub.peakSelection ? projectPeakSelection(peaksByRule, s.chrom, s.featureHub.peakSelection) : {}),
    clusterTreeNodes: migratePeakOwners(s.clusterTreeNodes, peaksByRule, peaksByRule, s.chrom),
    savedClusters: migrateSavedPeakOwners(s, peaksByRule),
    featureHub: { ...s.featureHub, selected, pinned: cartPins(s),
      peakSelection: s.featureHub.peakSelection ?? capturePeakSelection(peaksByRule, s.chrom, s.selectedPeaks, s.peakModes) } };
}

export function hubForSave(s: BrowserState): FeatureHubState {
  const { splitRules: _splitRules, ...hub } = s.featureHub ?? {};
  const pinned = cartPins(s), peakSelection = capturePeakSelection(s.peaksByRule, s.chrom, s.selectedPeaks, s.peakModes);
  return { ...hub,
    ...(pinned.length || s.featureHub?.pinned ? { pinned } : {}),
    ...(peakSelection.selected.length || Object.keys(peakSelection.modes).length || s.featureHub?.peakSelection ? { peakSelection } : {}),
    ...(s.selectedFeatures.length || s.featureHub?.selectedFeatures ? { selectedFeatures: s.selectedFeatures } : {}) };
}

/** Only old resolvable identities go into legacy feature fields. Insertion stubs are required by 3.0.1. */
export function legacyRefs(refs: FeatureRef[]): FeatureRef[] {
  return refs.filter(r => !r.source.startsWith('hub:') && !r.source.startsWith('browser:')
    && ['fp-class', 'nfr', 'nfr-variant', 'sv'].includes(r.kind)).map(r => r.kind === 'sv' && r.id.startsWith('I:') && r.start != null
      ? { ...r, end: r.start + 1 } : r);
}

/** Returns a copy, including history. Hub-only split definitions stay alongside their frozen legacy fallback. */
export function dualWriteFrontend<T extends Record<string, unknown>>(saved: T): T {
  const out: Record<string, unknown> = { ...saved };
  const hub = { ...((out.featureHub as Record<string, unknown>) ?? {}) };
  if (Array.isArray(out.selectedFeatures)) {
    const refs = out.selectedFeatures as FeatureRef[];
    // Match hubForSave: an absent empty selection must stay absent across undo/redo.
    if (refs.length || hub.selectedFeatures) hub.selectedFeatures = hub.selectedFeatures ?? refs;
    out.selectedFeatures = legacyRefs(refs);
  }
  if (Array.isArray(out.panels)) {
    const splits: Record<string, unknown> = {};
    out.panels = out.panels.map(raw => {
      const p = raw as { id: string; readSubset?: { readIds?: string[]; rule?: { kind: string; features?: FeatureRef[]; datasetId: string } } };
      const rule = (hub.splitRules as Record<string, { kind: string; features?: FeatureRef[]; datasetId: string }> | undefined)?.[p.id] ?? p.readSubset?.rule;
      if (!rule?.features) return p;
      const features = legacyRefs(rule.features);
      if (features.length === rule.features.length) return { ...p, readSubset: { ...p.readSubset, rule: { ...rule, features } } };
      splits[p.id] = rule;
      return { ...p, readSubset: { ...p.readSubset, rule: { kind: 'frozen', datasetId: rule.datasetId, readIds: (out.splitPanelReads as Record<string, string[]> | undefined)?.[(p as { stateKey?: string; datasetId?: string }).stateKey ?? (p as { datasetId?: string }).datasetId ?? p.id] ?? [] } } };
    });
    if (Object.keys(splits).length) hub.splitRules = splits;
  }
  out.featureHub = hub;
  if (Array.isArray(out.historySnapshots)) out.historySnapshots = out.historySnapshots.map(raw => {
    const snapshot = raw as { state?: Record<string, unknown> };
    return snapshot.state ? { ...snapshot, state: dualWriteFrontend(snapshot.state) } : snapshot;
  });
  return out as T;
}

/** Hub-only identities are restored in this build, while older builds use the dual-written fallback. */
export function restoreHubOnly(saved: Record<string, unknown>): Record<string, unknown> {
  const hub = saved.featureHub as Record<string, unknown> | undefined;
  if (!hub) return saved;
  const rules = hub.splitRules as Record<string, unknown> | undefined;
  return { ...saved, ...(Array.isArray(hub.selectedFeatures) ? { selectedFeatures: hub.selectedFeatures } : {}),
    ...(rules && Array.isArray(saved.panels) ? { panels: saved.panels.map(raw => {
      const p = raw as { id: string; readSubset?: unknown };
      return rules[p.id] ? { ...p, readSubset: { ...(p.readSubset as object), rule: rules[p.id] } } : p;
    }) } : {}) };
}

export function normalizePeakSelection(v: unknown): PeakSelection | undefined {
  const p = v as PeakSelection | undefined;
  if (!p || !Array.isArray(p.selected) || !p.modes || typeof p.modes !== 'object') return undefined;
  return { selected: p.selected.filter(x => typeof x === 'string'),
    modes: Object.fromEntries(Object.entries(p.modes).filter(([, x]) => typeof x === 'string')) };
}
