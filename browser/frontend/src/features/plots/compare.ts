/**
 * Compare for the size plots: log2 ratios (or A − B) of footprint size × position distributions, made explicit.
 *
 * - Each vs rest (default for clusters, and for 3+ datasets): one map per group, the group over every other group
 *   of the same dataset panel (clusters) or every other dataset (datasets).
 * - Each vs all: one map per group, the group over all groups together (itself included).
 * - A vs B (default for exactly 2 datasets): one map, any two groups picked.
 *
 * Every comparison reads counts (normalisation "counts", no log) so groups can be summed into "rest" and "all"; each
 * side is divided by its own total first, so a ratio compares distributions, not read numbers. A cell is blank where
 * either side has no count. Every comparison panel shares one symmetric scale centred on 0.
 */
import type { SizeMatrix } from '../../utils/footprintSizeMatrix';
import type { PlotGroupBy } from './plotModel';

export type CompareMode = 'auto' | 'each-vs-rest' | 'each-vs-all' | 'a-vs-b';
export type ResolvedCompareMode = Exclude<CompareMode, 'auto'>;

export const COMPARE_MODES: readonly { value: CompareMode; label: string; help: string }[] = [
  { value: 'auto', label: 'Default', help: 'Clusters: each vs rest. Datasets: A vs B with two, each vs rest with more.' },
  { value: 'each-vs-rest', label: 'Each vs rest', help: 'One map per group: the group over every other group (of the same dataset, for clusters).' },
  { value: 'each-vs-all', label: 'Each vs all', help: 'One map per group: the group over all groups together.' },
  { value: 'a-vs-b', label: 'A vs B', help: 'One map: the two groups you pick.' },
];

export function resolveCompareMode(mode: CompareMode, groupBy: PlotGroupBy, nGroups: number): ResolvedCompareMode {
  if (mode !== 'auto') return mode;
  if (groupBy === 'cluster') return 'each-vs-rest';
  return nGroups === 2 ? 'a-vs-b' : 'each-vs-rest';
}

export interface CompareGroup {
  id: string;
  /** "C3", "Early". */
  title: string;
  /** Groups sharing a panel are each other's "rest" (clusters of one dataset); else all groups are. */
  panelKey: string;
  /** Counts (normalisation "counts", no log). */
  matrix: SizeMatrix;
}

export interface Comparison {
  id: string;
  /** "C3 vs rest", "Early vs Late". */
  label: string;
  a: string;
  b: string | 'rest' | 'all';
  /** log2 ratio of fractions; null = blank. */
  matrix: SizeMatrix;
}

function total(m: SizeMatrix): number {
  let t = 0;
  for (const row of m) for (const v of row) if (v != null && Number.isFinite(v) && v > 0) t += v;
  return t;
}

function sum(ms: SizeMatrix[]): SizeMatrix {
  const rows = Math.max(0, ...ms.map(m => m.length));
  const cols = Math.max(0, ...ms.map(m => m[0]?.length ?? 0));
  const out: SizeMatrix = Array.from({ length: rows }, () => new Array<number | null>(cols).fill(0));
  for (const m of ms) m.forEach((row, i) => row.forEach((v, j) => { if (v != null && Number.isFinite(v)) out[i][j] = (out[i][j] as number) + v; }));
  return out;
}

/** log2((a / Σa) / (b / Σb)) per cell; null where either side has no count. */
export function log2FractionRatio(a: SizeMatrix, b: SizeMatrix): SizeMatrix {
  return log2Ratio(a, b);
}

function log2Ratio(a: SizeMatrix, b: SizeMatrix): SizeMatrix {
  const ta = total(a), tb = total(b);
  if (!(ta > 0) || !(tb > 0)) return a.map(row => row.map(() => null));
  return a.map((row, i) => row.map((va, j) => {
    const vb = b[i]?.[j];
    if (va == null || vb == null || !(va > 0) || !(vb > 0)) return null;
    return Math.log2((va / ta) / (vb / tb));
  }));
}

/** (a / Σa) − (b / Σb) per cell: the difference of shares; null where neither side has a count. */
export function fractionDifference(a: SizeMatrix, b: SizeMatrix): SizeMatrix {
  const ta = total(a), tb = total(b);
  if (!(ta > 0) || !(tb > 0)) return a.map(row => row.map(() => null));
  return a.map((row, i) => row.map((va, j) => {
    const vb = b[i]?.[j];
    const x = va != null && va > 0 ? va : 0, y = vb != null && vb > 0 ? vb : 0;
    if (x === 0 && y === 0) return null;
    return x / ta - y / tb;
  }));
}

export type SizeCompareOp = 'log2ratio' | 'diff';

export function comparisons(groups: CompareGroup[], mode: ResolvedCompareMode, ab: [string, string] | null = null, op: SizeCompareOp = 'log2ratio'): Comparison[] {
  if (groups.length < 2) return [];
  const log2FractionRatio = op === 'diff' ? fractionDifference : log2Ratio;
  if (mode === 'a-vs-b') {
    const a = groups.find(g => g.id === ab?.[0]) ?? groups[0];
    const b = groups.find(g => g.id === ab?.[1] && g.id !== a.id) ?? groups.find(g => g.id !== a.id)!;
    return [{ id: `${a.id}~${b.id}`, label: `${a.title} vs ${b.title}`, a: a.id, b: b.id, matrix: log2FractionRatio(a.matrix, b.matrix) }];
  }
  const out: Comparison[] = [];
  for (const g of groups) {
    const samePanel = groups.filter(o => o.panelKey === g.panelKey);
    // Clusters of one dataset compare within it; groups alone in their panel (datasets) compare across panels.
    const pool = samePanel.length > 1 ? samePanel : groups;
    if (mode === 'each-vs-rest') {
      const rest = pool.filter(o => o.id !== g.id);
      if (!rest.length) continue;
      out.push({ id: `${g.id}~rest`, label: `${g.title} vs rest`, a: g.id, b: 'rest', matrix: log2FractionRatio(g.matrix, sum(rest.map(o => o.matrix))) });
    } else {
      out.push({ id: `${g.id}~all`, label: `${g.title} vs all`, a: g.id, b: 'all', matrix: log2FractionRatio(g.matrix, sum(pool.map(o => o.matrix))) });
    }
  }
  return out;
}

/** Why a comparison can't be drawn (null: it can). */
export function compareBlocker(nGroups: number, groupBy: PlotGroupBy): string | null {
  if (nGroups >= 2) return null;
  return groupBy === 'cluster'
    ? 'Compare needs at least two clusters here: cluster the reads into two or more groups.'
    : 'Compare needs two groups: this view has one dataset. Open a second dataset, or Group by cluster to compare clusters.';
}
