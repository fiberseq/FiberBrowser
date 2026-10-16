/**
 * Splitting reads by SNP allele or allele combination (the Variants panel), through the "Split into panels"
 * machinery (utils/splitPanels.ts, feat/fb-n11-features) and the in-panel grouping (utils/accessibilityGrouping.ts).
 *
 * A grouping from /api/variants/alleles (read -> group id, the groups' names) becomes:
 * - "Group in this panel": the panel's clusters, named after the alleles (one undo step; Clear puts back what was
 *   there), or
 * - "Split into panels": a frozen split (its read names: allele groups belong to one view), one panel per ticked group,
 *   with the top groups by reads ticked. Opening more panels than the soft limit asks first; the hard limit refuses.
 */
import { getClusterColor } from '../../components/tracks/read-track/constants';
import { applyReadGroups, type AppliedGrouping } from '../../utils/readGroups';
import { BIN_COLOURS, type SplitGrouping, type SplitRow } from '../../utils/splitPanels';
import type { AlleleGroup, AlleleGrouping, Snp } from './api';
import type { SplitSnp } from '../types';
import { snpLabel } from './variantsState';

export const SPLIT_DEFAULT_TOP = 4;
export const SPLIT_SOFT_LIMIT = 8;
export const SPLIT_HARD_LIMIT = 16;

export function groupColour(group: Pick<AlleleGroup, 'id' | 'kind'>): string {
  if (group.kind === 'other') return BIN_COLOURS.other;
  if (group.kind === 'not-informative') return BIN_COLOURS.na;
  return getClusterColor(group.id);
}

/** The read names of each group. */
export function readsByGroup(grouping: Pick<AlleleGrouping, 'assignments'>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [read, id] of Object.entries(grouping.assignments)) {
    const list = out.get(id);
    if (list) list.push(read); else out.set(id, [read]);
  }
  return out;
}

/**
 * The SNPs a grouping was made by, with the index of each one's allele in its groups' `alleles` (SNP columns come
 * first, then any SVs). `known`: the scan's calls (which allele is the reference); without them, from the ids.
 */
export function groupingSnps(grouping: Pick<AlleleGrouping, 'snps' | 'columns' | 'region'>, datasetId: string,
  known: readonly Snp[] = []): { snp: SplitSnp; index: number }[] {
  const ids = grouping.columns
    ? grouping.columns.map((c, index) => ({ id: c.id, index, kind: c.kind })).filter(c => c.kind === 'snv')
    : (grouping.snps ?? []).map((id, index) => ({ id, index }));
  const chrom = grouping.region.chrom;
  return ids.flatMap(({ id, index }) => {
    const [p, kind, alleles = ''] = id.split(':');
    const pos = Number(p);
    if (!Number.isFinite(pos) || (kind !== 'snv' && kind !== 'ins' && kind !== 'del')) return [];
    const [a1 = '', a2 = ''] = alleles.split('/');
    const call = known.find(s => s.id === id);
    const ref = call ? call.ref : null;
    const alt = call ? call.alt : a2;
    const label = snpLabel(call ?? { pos, kind, ref: null, alleles: [a1, a2], alt, length: 0 }, chrom);
    return [{ snp: { datasetId, chrom, id, pos, kind, ref, alt, label }, index }];
  });
}

/** An allele grouping as a frozen split (features' SplitGrouping): one group per combination, plus the bins. */
export function variantSplitGrouping(grouping: AlleleGrouping, datasetId: string, title: string, known: readonly Snp[] = []): SplitGrouping {
  const reads = readsByGroup(grouping);
  // By SNP alleles: the rule names the SNPs; each group's panel keeps its allele at each (the SNP channel draws it).
  const snpCols = groupingSnps(grouping, datasetId, known);
  const allelesOf = (g: AlleleGroup) => (g.kind !== 'combo' || !snpCols.length ? undefined
    : snpCols.map(c => { const a = g.alleles[c.index]; return typeof a === 'string' && a ? a : null; }));
  // With SVs, a group's label is its genotype and reads ("roo+ · hobo− · jockey+ (812)"), and the insertions all
  // its reads carry can each be shown expanded in its panel.
  const svCols = (grouping.columns ?? []).map((c, i) => ({ ...c, i })).filter(c => c.kind === 'sv');
  const carried = (g: AlleleGroup) => (g.kind !== 'combo' || !svCols.length ? undefined : svCols.flatMap(c => {
    if (g.alleles[c.i] !== '+') return [];
    const [t, ref, len] = c.id.split(':');
    return t === 'I' ? [{ datasetId, chrom: grouping.region.chrom, ref: Number(ref), len: Number(len), name: c.name }] : [];
  }));
  return {
    title,
    rule: { kind: 'frozen', ...(svCols.length ? { splitSvs: svCols.map(c => ({ datasetId, chrom: grouping.region.chrom, id: c.id })) } : {}),
      ...(snpCols.length ? { splitSnps: snpCols.map(c => c.snp) } : {}) },
    ...(svCols.length ? { labelsComplete: true } : {}),
    // The view the reads were classified in (the split panels' locus), whatever panel they open beside.
    locus: { ...grouping.region, label: title },
    groups: grouping.groups.filter(g => (reads.get(g.id)?.length ?? 0) > 0).map(g => ({
      key: String(g.id),
      label: svCols.length && g.kind === 'combo' ? `${g.label} (${(reads.get(g.id)?.length ?? 0).toLocaleString()})` : g.label,
      ...(carried(g)?.length || allelesOf(g) ? { ruleExtras: {
        ...(carried(g)?.length ? { carriedInsertions: carried(g) } : {}),
        ...(allelesOf(g) ? { splitAlleles: allelesOf(g) } : {}),
      } } : {}),
      count: reads.get(g.id)?.length ?? 0,
      colour: groupColour(g),
      // 'closed' is features' bin for groups that are not variants: here the rare combinations ("Other").
      kind: g.kind === 'combo' ? 'group' as const : g.kind === 'other' ? 'closed' as const : 'na' as const,
      ids: { [datasetId]: reads.get(g.id) ?? [] },
    })),
  };
}

/**
 * The dialog's rows: the top `top` combinations by reads ticked, the other combinations together with the rare ones
 * in "Other" (not ticked), and "Not informative" (not ticked).
 */
export function variantSplitRows(grouping: SplitGrouping, top = SPLIT_DEFAULT_TOP): SplitRow[] {
  const combos = grouping.groups.filter(g => g.kind === 'group').sort((a, b) => b.count - a.count);
  const n = Math.max(0, Math.floor(top));
  const rows: SplitRow[] = combos.slice(0, n).map(g => ({
    key: g.key, label: g.label, colour: g.colour, kind: 'group', groupKeys: [g.key], count: g.count, checked: true,
  }));
  const rest = [...combos.slice(n), ...grouping.groups.filter(g => g.kind === 'closed')];
  if (rest.length) {
    const count = rest.reduce((s, g) => s + g.count, 0);
    const label = rest.length === 1 ? rest[0].label : `Other (${rest.length} combinations)`;
    rows.push({ key: '__other', label, colour: rest.length === 1 ? rest[0].colour : BIN_COLOURS.other, kind: 'other',
      groupKeys: rest.map(g => g.key), count, checked: false });
  }
  const na = grouping.groups.filter(g => g.kind === 'na');
  if (na.length) {
    rows.push({ key: '__na', label: 'Not informative', colour: BIN_COLOURS.na, kind: 'na', groupKeys: na.map(g => g.key),
      count: na.reduce((s, g) => s + g.count, 0), checked: false });
  }
  return rows;
}

export type SplitVerdict =
  | { kind: 'none'; count: 0; message: string }
  | { kind: 'ok'; count: number; message: string }
  | { kind: 'confirm'; count: number; message: string }
  | { kind: 'refuse'; count: number; message: string };

/** What opening `count` panels needs: nothing, a confirmation (over the soft limit), or fewer (over the hard limit). */
export function splitVerdict(count: number, softLimit = SPLIT_SOFT_LIMIT, hardLimit = SPLIT_HARD_LIMIT): SplitVerdict {
  const soft = Math.max(1, Math.min(hardLimit, Math.floor(softLimit)));
  if (count <= 0) return { kind: 'none', count: 0, message: 'Tick at least one group.' };
  if (count > hardLimit) {
    return { kind: 'refuse', count, message: `${count} panels is too many: at most ${hardLimit} at a time. Lower the top number or untick groups (they can go in “Other”).` };
  }
  if (count > soft) {
    return { kind: 'confirm', count, message: `This opens ${count} panels (more than ${soft}). Each is a full read panel: the view gets crowded and slower.` };
  }
  return { kind: 'ok', count, message: `${count} panel${count === 1 ? '' : 's'}.` };
}

/** The panel count rows give over `sources` panels (one per ticked row per source). */
export function expectedPanels(rows: SplitRow[], sources: number): number {
  return rows.filter(r => r.checked).length * Math.max(0, sources);
}

/** "Group in this panel": the grouping as the panel's named clusters (one undo step). */
export function groupInPanel(grouping: AlleleGrouping, datasetId: string, stateKey: string, title: string): AppliedGrouping {
  const labels: Record<number, string> = {};
  for (const g of grouping.groups) labels[g.id] = g.label;
  const present = new Set(Object.values(grouping.assignments));
  const order = grouping.groups.filter(g => present.has(g.id)).map(g => g.id);
  return applyReadGroups({
    byDataset: { [datasetId]: { ...grouping.assignments } },
    order, patterns: {}, regions: [], labels,
  }, { [datasetId]: [stateKey] }, `Group by ${title}`);
}

/** "9,463,438" (1-based) from a SNP id ("<pos0>:<kind>:<a1>/<a2>"). */
export function snpIdPosition(id: string): string {
  const pos = Number(id.split(':')[0]);
  return Number.isFinite(pos) ? (pos + 1).toLocaleString() : id;
}

/** A short title for a selection of SNPs: "chr2L:9,463,438 A>G" for one, "8,001/9,001" for two or three, "5 SNPs". */
export function selectionTitle(ids: string[], describe: (id: string) => string): string {
  if (ids.length === 1) return describe(ids[0]);
  if (ids.length <= 3) return ids.map(snpIdPosition).join('/');
  return `${ids.length} SNPs`;
}

/** A short title for a grouping: one SNP's label, "8,001/9,001", "5 SNPs", "HP tags", "10 SNP tags (informative SNPs)". */
export function groupingTitle(grouping: Pick<AlleleGrouping, 'snps' | 'tags'>, source: 'selected' | 'informative' | 'hp',
  describe: (id: string) => string): string {
  if (source === 'hp') return 'HP tags';
  if (source === 'informative' && grouping.snps.length > 1) {
    return `${grouping.snps.length} SNP tags (informative SNPs)`;
  }
  return selectionTitle(grouping.snps, describe);
}
