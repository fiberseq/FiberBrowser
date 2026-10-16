import type { PanelConfig } from '../../types';
/**
 * SVs as selectable features (fb-n13): shift-click SV clusters in the SV row, or tick them in the Variants
 * panel's SVs tab; they join the feature selection (stores/featureStore.ts) and its chip in the main
 * toolbar. Two to four selected SVs split the reads by their combined genotype ("roo+ · hobo− · jockey+":
 * carrier / reference / not informative at each, the single-SV split's classification), in this panel or
 * into panels (the SNP combinations' dialog and limits); the Combinations tab mixes them with SNPs.
 */
import { groupByAlleles, DEFAULT_SNP_PARAMS, type AlleleGrouping, type SnpParams } from './api';
import { useBrowserStore } from '../../stores/browserStore';
import type { FeatureRef } from '../../stores/featureStore';
import { create } from 'zustand';
import { variantScanTarget } from './scanTarget';
import { datasetPanelView } from '../../utils/panelScope';
import { sameChrom } from '../../utils/chromAliases';
import { insertFamilyName } from '../insertion/identifyModel';

export interface SvLike { t: 'D' | 'I'; ref: number; len: number }

export const SV_COMBO_MAX = 4;

/** Said under "Require calls at all selected SVs" (audit VAR-6). */
export const REQUIRE_ALL_SVS_HELP = 'On: only reads with a call (carrier or reference) at every selected SV are grouped; '
  + 'reads that miss one go to Not informative. Off: reads called at some of them are grouped too, with ? at the others.';

/** "INS 9.2k", "DEL 1.5k", "INS 400" (short: genotype labels repeat it per SV). */
export function svShortName(sv: SvLike): string {
  const size = sv.len >= 1000 ? `${(sv.len / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(sv.len);
  return `${sv.t === 'I' ? 'INS' : 'DEL'} ${size}`;
}

/** The SV's name: the family Identify found for this insertion (roo, hobo…), else its short name. */
export function svName(sv: SvLike, datasetId: string, chrom: string): string {
  if (sv.t === 'I') {
    for (const p of useBrowserStore.getState().panels) {
      for (const [key, saved] of Object.entries(p.insertionIdentify ?? {})) {
        const [ds, c, ref, len] = key.split('|');
        if (ds !== datasetId || !sameChrom(c, chrom)) continue;
        if (Math.abs(Number(ref) - sv.ref) > 50) continue;
        if (len && Number.isFinite(Number(len)) && Math.abs(Number(len) - sv.len) > Math.max(50, sv.len * 0.1)) continue;
        const family = insertFamilyName(saved.result);
        if (family && family !== 'insert') return family;
      }
    }
  }
  return svShortName(sv);
}

export function svFeatureRef(sv: SvLike, datasetId: string, chrom: string, colour?: string): FeatureRef {
  return {
    kind: 'sv', source: datasetId, id: `${sv.t}:${sv.ref}:${sv.len}`, datasetId, chrom,
    start: sv.ref, end: sv.t === 'D' ? sv.ref + sv.len : sv.ref + 1,
    label: svName(sv, datasetId, chrom), colour: colour ?? (sv.t === 'I' ? '#7c3aed' : '#dc2626'),
  };
}

/** The SV a feature stands for. */
export function svOfFeature(f: FeatureRef): SvLike | null {
  if (f.kind !== 'sv') return null;
  const [t, ref, len] = f.id.split(':');
  if ((t !== 'D' && t !== 'I') || !Number.isFinite(Number(ref)) || !Number.isFinite(Number(len))) return null;
  return { t, ref: Number(ref), len: Number(len) };
}

/** Whether a cluster (as the SV band draws it) is this SV (positions jitter a little between views). */
export function svMatches(a: SvLike, b: SvLike): boolean {
  return a.t === b.t && Math.abs(a.ref - b.ref) <= 50 && Math.abs(a.len - b.len) <= Math.max(50, 0.05 * Math.max(a.len, b.len));
}

/** Whether a selected SV feature is this SV of this dataset on this chromosome. */
export function svFeatureIs(f: FeatureRef, sv: SvLike, datasetId: string, chrom: string): boolean {
  if (f.kind !== 'sv' || f.datasetId !== datasetId || (f.chrom && !sameChrom(f.chrom, chrom))) return false;
  const own = svOfFeature(f);
  return Boolean(own && svMatches(own, sv));
}

/** The selected SV features of a dataset (on a chromosome, if given). */
export function selectedSvFeatures(datasetId?: string, chrom?: string): FeatureRef[] {
  return useBrowserStore.getState().selectedFeatures.filter(f => f.kind === 'sv'
    && (!datasetId || f.datasetId === datasetId) && (!chrom || !f.chrom || sameChrom(f.chrom, chrom)));
}

/** Whether a selected SV lies in a view (its chromosome, and its span overlapping the view's). */
export function svFeatureInView(f: FeatureRef, view: { chrom: string; start: number; end: number }): boolean {
  if (f.chrom && !sameChrom(f.chrom, view.chrom)) return false;
  const start = f.start ?? 0;
  const end = Math.max(start + 1, f.end ?? start + 1);
  return end > view.start && start < view.end;
}

/**
 * Where the selected SVs are, for a selection that is not in view (round 3, R13/B6): "chr2L:9,467,039", or
 * "chr2L:9,467,039–9,487,241" for several; and the view that shows them all ("Go there": the current view's width
 * when they fit in it, else their span with a margin).
 */
export function svSelectionPlace(features: FeatureRef[], width: number): { label: string; view: { chrom: string; start: number; end: number } } | null {
  const placed = features.filter(f => f.chrom && f.start != null);
  if (!placed.length) return null;
  const chrom = placed[0].chrom!;
  const same = placed.filter(f => sameChrom(f.chrom!, chrom));
  const lo = Math.min(...same.map(f => f.start!));
  const hi = Math.max(...same.map(f => Math.max(f.start! + 1, f.end ?? f.start! + 1)));
  const label = hi - lo <= 1 ? `${chrom}:${(lo + 1).toLocaleString()}` : `${chrom}:${(lo + 1).toLocaleString()}–${hi.toLocaleString()}`;
  const span = hi - lo;
  const w = Math.max(width, Math.ceil(span * 1.2), 2_000);
  const start = Math.max(0, Math.round((lo + hi) / 2 - w / 2));
  return { label: same.length < placed.length ? `${label} (and another chromosome)` : label, view: { chrom, start, end: start + w } };
}

/** Shift-click: add or remove an SV from the feature selection. */
export function toggleSvFeature(sv: SvLike, datasetId: string, chrom: string): void {
  const store = useBrowserStore.getState();
  // The same SV seen in another view (its position jitters a little): off again.
  const same = store.selectedFeatures.find(f => svFeatureIs(f, sv, datasetId, chrom));
  if (same) { store.setSelectedFeatures(store.selectedFeatures.filter(f => f !== same)); return; }
  store.selectFeature(svFeatureRef(sv, datasetId, chrom), true);
}

/** "roo + hobo + jockey" for titles. */
export function svSelectionTitle(features: FeatureRef[]): string {
  return features.map(f => f.label || f.id).join(' + ');
}

/**
 * The dataset panel the combined genotypes are read in (the split dialog opens the panels beside it). A "Split into
 * panels" panel stands for the panel it was split from: all its reads, as Variants › SVs lists them.
 */
export function svComboPanel(datasetId: string) {
  const s = useBrowserStore.getState();
  const own = s.panels.filter(p => p.contentType === 'dataset' && p.datasetId === datasetId);
  let panel: PanelConfig | undefined;
  if (s.navigationMode !== 'perPanel' && !own.some(p => s.selectedDatasets.has(p.id))) {
    const main = own.filter(p => !p.readSubset && !p.altAllele);
    panel = main.find(p => !p.viewportOverride) ?? main[0];
  } else {
    const view = datasetPanelView(s, datasetId);
    panel = s.panels.find(p => p.id === view.panelId);
  }
  const seen = new Set<string>();
  while (panel?.readSubset && !seen.has(panel.id)) {
    seen.add(panel.id);
    const source = s.panels.find(p => p.id === panel!.readSubset!.sourcePanelId && p.contentType === 'dataset');
    if (!source) break;
    panel = source;
  }
  return panel;
}

/** Why "Group in this panel" can't group a dataset's reads now (its panel is hidden by its split panels), else null. */
export const SV_GROUP_SPLIT_NOTE = 'The reads are split into panels: close the split to group them in one panel, or use Split into panels.';
export function svGroupBlocked(datasetId: string): string | null {
  return svComboPanel(datasetId)?.collapsedBySplitGroup ? SV_GROUP_SPLIT_NOTE : null;
}

/** The view the combined genotypes are read in: the main view, or the dataset panel's own. */
export function svComboView(datasetId: string): { chrom: string; start: number; end: number } {
  const s = useBrowserStore.getState();
  return svComboPanel(datasetId)?.viewportOverride ?? { chrom: s.chrom, start: s.start, end: s.end };
}

/** "Go there" for SVs out of the view they are read in: that panel's own view when it has one, else the main view. */
export function goToSvView(datasetId: string, view: { chrom: string; start: number; end: number }): void {
  const s = useBrowserStore.getState();
  const panel = svComboPanel(datasetId);
  if (panel?.viewportOverride) s.navigatePanel(panel.id, view.chrom, view.start, view.end);
  else s.setViewport(view.chrom, view.start, view.end);
}

/**
 * The reads of a dataset grouped by their genotype at the selected SVs (and SNPs, if any), in the view.
 * A string when it can't be done (why).
 */
export async function svGenotypeGrouping(features: FeatureRef[], opts: { partial?: boolean; minFraction?: number; snps?: string[];
  params?: SnpParams; signal?: AbortSignal } = {}): Promise<AlleleGrouping | string> {
  const svs = features.filter(f => f.kind === 'sv');
  if (!svs.length) return 'Select SVs first (shift-click them in the SV row, or tick them in Variants › SVs).';
  const datasets = [...new Set(svs.map(f => f.datasetId))];
  if (datasets.length > 1) return 'The selected SVs are in different datasets: select SVs of one dataset.';
  if (svs.length > SV_COMBO_MAX) return `${svs.length} SVs selected: combine ${SV_COMBO_MAX} or fewer.`;
  const datasetId = datasets[0]!;
  const view = svComboView(datasetId);
  const away = svs.filter(f => f.chrom && !sameChrom(f.chrom, view.chrom));
  if (away.length) return 'The selected SVs are on another chromosome than the view: go to them first.';
  // Not in this view: their reads aren't here, so no read would be informative (round 3, B6: the refusal blamed
  // "Require calls at all selected SVs").
  const outside = svs.filter(f => !svFeatureInView(f, view));
  if (outside.length) {
    const place = svSelectionPlace(outside, view.end - view.start);
    return `${outside.length === svs.length ? 'The selected SVs are' : `${svSelectionTitle(outside)} ${outside.length === 1 ? 'is' : 'are'}`} not in this view${place ? ` (at ${place.label})` : ''}: go to them first.`;
  }
  const s = useBrowserStore.getState();
  return groupByAlleles(variantScanTarget(useBrowserStore.getState(), datasetId, svComboPanel(datasetId)?.id), opts.params ?? DEFAULT_SNP_PARAMS,
    Boolean(s.showDuplicateReads), {
      source: 'selected', snps: opts.snps ?? [], partial: Boolean(opts.partial), minFraction: opts.minFraction ?? 0.02,
      autoPhase: false, asCombination: true,
      svs: svs.map(f => ({ ...svOfFeature(f)!, name: f.label || svShortName(svOfFeature(f)!) })),
    }, opts.signal);
}

/** The combined-genotype split dialog, opened from anywhere (the feature chip, the SV row): components/controls/variants/SvComboHost.tsx. */
export const useSvComboStore = create<{
  pending: { grouping: AlleleGrouping; title: string } | null;
  open: (grouping: AlleleGrouping, title: string) => void;
  close: () => void;
}>(set => ({
  pending: null,
  open: (grouping, title) => set({ pending: { grouping, title } }),
  close: () => set({ pending: null }),
}));

/** "Group in this panel" by the selected SVs' combined genotype. Returns an error message, or null. */
export async function groupBySelectedSvs(features: FeatureRef[], partial = false): Promise<string | null> {
  // Only the SVs (other features also selected are not part of a genotype split; the chip says so).
  const svs = features.filter(f => f.kind === 'sv');
  const blocked = svs[0]?.datasetId ? svGroupBlocked(svs[0].datasetId) : null;
  if (blocked) return blocked;
  try {
    const grouping = await svGenotypeGrouping(svs, { partial });
    if (typeof grouping === 'string') return grouping;
    if (!grouping.groups.some(g => g.kind === 'combo' && g.count > 0)) {
      return `No read is informative at all of ${svSelectionTitle(svs)} in this view${partial ? '' : ' (untick Require calls at all selected SVs to group reads that see some of them)'}.`;
    }
    const { groupDatasetPanel } = await import('./alleleActions');
    // The panel the genotypes were read in (svComboView), the one Cluster's plan names: not a reference copy beside it.
    const notice = groupDatasetPanel(grouping, svSelectionTitle(svs), svComboPanel(grouping.dataset_id)?.id);
    return notice.startsWith('Open a read panel') ? notice : null;
  } catch (e) {
    return `Could not group the reads by ${svSelectionTitle(svs)}: ${String((e as Error)?.message ?? e).replace(/^API error \d+: /, '')}`;
  }
}

/** "Split into panels" by the selected SVs' combined genotype: the panel-count dialog (top 4, confirm above 8, at most 16). */
export async function splitBySelectedSvs(features: FeatureRef[], partial = false): Promise<string | null> {
  // Only the SVs (other features also selected are not part of a genotype split; the chip says so).
  const svs = features.filter(f => f.kind === 'sv');
  try {
    const grouping = await svGenotypeGrouping(svs, { partial });
    if (typeof grouping === 'string') return grouping;
    if (!grouping.groups.some(g => g.kind === 'combo' && g.count > 0)) {
      return `No read is informative at all of ${svSelectionTitle(svs)} in this view${partial ? '' : ' (untick Require calls at all selected SVs to group reads that see some of them)'}.`;
    }
    useSvComboStore.getState().open(grouping, svSelectionTitle(svs));
    return null;
  } catch (e) {
    return `Could not split the reads by ${svSelectionTitle(svs)}: ${String((e as Error)?.message ?? e).replace(/^API error \d+: /, '')}`;
  }
}
