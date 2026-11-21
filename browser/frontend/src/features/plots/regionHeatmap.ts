/**
 * The region heatmap (deepTools-style profile + heatmap): one row per region (selected features or BED regions), its
 * finished signal across the window (anchor ± flank, or scaled regions), the metaprofile of the groups on top on the
 * same x axis. Rows sorted by the mean signal in a window (default: the whole window), the signal at the centre, BED
 * order, a BED column (score), or k-means clusters of the rows (seeded with the plot's seed through the stable
 * sampler), drawn as row blocks with a profile per cluster. Compare: the profile shows the groups, the heatmap the
 * per-region A − B or log2(A/B). Pure: no React, no store.
 */
import { stableKey, lowestK } from '../../utils/stableSample';
import { finishProfile, poolProfiles, type ProfileFinishOptions, type RawProfile } from './profileEngine';
import type { HeatmapSettings } from './plotModel';

/** A region row's finished values per group (null: the region is not in that group, e.g. another BED set). */
export interface RegionRow { id: string; label: string; bedIndex: number; score: number | null; values: Array<(number | null)[] | null> }

/** The cluster colours (row blocks and their profiles), distinct from the dataset colours. */
export const CLUSTER_COLOURS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#393b79', '#637939'];

/** The bins of [from, to) on an axis whose bin i starts at start + i * binBp (null ends: open). */
export function binsIn(n: number, start: number, binBp: number, from: number | null, to: number | null): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = start + i * binBp;
    if ((from != null && x + binBp <= from) || (to != null && x >= to)) continue;
    out.push(i);
  }
  return out;
}

/** The centre bin: the one holding 0 (the anchor) when the axis spans it; scaled regions (or no 0): the middle. */
export function centreBin(n: number, start: number, binBp: number, scaled = false): number {
  const end = start + n * binBp;
  if (!scaled && start <= 0 && end > 0) return Math.min(n - 1, Math.max(0, Math.floor((0 - start) / binBp)));
  return Math.floor(n / 2);
}

const meanOf = (vals: Array<number | null>): number => {
  let s = 0, k = 0;
  for (const v of vals) if (v != null && Number.isFinite(v)) { s += v; k++; }
  return k ? s / k : Number.NEGATIVE_INFINITY;
};

/** A row's mean over the given bins, across the groups it is in. */
export function rowMean(r: RegionRow, bins: number[]): number {
  return meanOf(r.values.flatMap(v => (v ? bins.map(i => v[i]) : [])));
}

/**
 * k-means of the rows (Lloyd), seeded: the first centroids are the k rows with the smallest stable keys
 * (seed, 'kmeans', row id), so the same seed and rows give the same clusters in any order. Distances over the
 * concatenated groups (missing values 0). Clusters are numbered by mean signal, highest first. Returns the cluster
 * of each row (in the rows' order).
 */
export function kmeansRows(rows: RegionRow[], k: number, seed: number, maxIter = 100): number[] {
  const n = rows.length;
  if (!n) return [];
  const kk = Math.max(1, Math.min(k, n));
  const vec = rows.map(r => r.values.flatMap(v => (v ? v.map(x => (x != null && Number.isFinite(x) ? x : 0)) : [])));
  const dim = Math.max(...vec.map(v => v.length));
  const pad = vec.map(v => (v.length < dim ? [...v, ...new Array(dim - v.length).fill(0)] : v));
  const init = lowestK(rows.map((_, i) => i), kk, i => stableKey(seed, 'kmeans', rows[i].id), i => rows[i].id);
  let cent = init.map(i => pad[i].slice());
  let assign = new Array<number>(n).fill(-1);
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    const next = pad.map(v => {
      let best = 0, bd = Infinity;
      cent.forEach((c, j) => {
        let d = 0;
        for (let t = 0; t < dim; t++) { const e = v[t] - c[t]; d += e * e; }
        if (d < bd - 1e-12) { bd = d; best = j; }
      });
      return best;
    });
    for (let i = 0; i < n; i++) if (next[i] !== assign[i]) { changed = true; break; }
    assign = next;
    if (!changed) break;
    cent = cent.map((c, j) => {
      const mine = pad.filter((_, i) => assign[i] === j);
      if (!mine.length) return c;
      return c.map((_, t) => mine.reduce((a, v) => a + v[t], 0) / mine.length);
    });
  }
  // Number the clusters by mean signal (highest first), ties by their first row.
  const all = binsIn(dim, 0, 1, null, null);
  const stats = cent.map((_, j) => {
    const members = rows.filter((_, i) => assign[i] === j);
    return { j, mean: members.length ? meanOf(members.map(r => rowMean(r, all))) : Number.NEGATIVE_INFINITY, first: assign.indexOf(j) };
  }).filter(s => s.first >= 0).sort((a, b) => b.mean - a.mean || a.first - b.first);
  const rank = new Map(stats.map((s, r) => [s.j, r]));
  return assign.map(a => rank.get(a) ?? 0);
}

/** The order of the rows (indices) for a sort; ties by BED order. `clusters` (sort = cluster): the rows' clusters. */
export function sortRows(rows: RegionRow[], s: Pick<HeatmapSettings, 'sort' | 'sortFrom' | 'sortTo'>, axis: { n: number; start: number; binBp: number; scaled?: boolean }, clusters: number[] | null = null): number[] {
  const order = rows.map((_, i) => i);
  const tie = (a: number, b: number) => rows[a].bedIndex - rows[b].bedIndex || (rows[a].id < rows[b].id ? -1 : rows[a].id > rows[b].id ? 1 : 0);
  if (s.sort === 'bed') return order.sort(tie);
  if (s.sort === 'score') return order.sort((a, b) => (rows[b].score ?? Number.NEGATIVE_INFINITY) - (rows[a].score ?? Number.NEGATIVE_INFINITY) || tie(a, b));
  const bins = s.sort === 'centre' ? [centreBin(axis.n, axis.start, axis.binBp, axis.scaled)] : binsIn(axis.n, axis.start, axis.binBp, s.sortFrom, s.sortTo);
  const m = rows.map(r => rowMean(r, bins));
  return order.sort((a, b) => (clusters ? clusters[a] - clusters[b] : 0) || m[b] - m[a] || tie(a, b));
}

export interface ProfileLine { id: string; title: string; color?: string; dash?: number[]; values: (number | null)[] }

/** The metaprofile lines on top: each group pooled over its rows (exactly: raw sums, then finished); with clusters, a
 *  line per cluster (and group when there are several). */
export function regionProfileLines(groups: Array<{ id: string; title: string; color?: string }>, raws: RawProfile[][], inGroup: (gi: number, row: number) => boolean,
  opts: ProfileFinishOptions, clusters: number[] | null = null): ProfileLine[] {
  const rowsOf = (gi: number, c: number | null) => raws.map((r, i) => (inGroup(gi, i) && (c == null || clusters![i] === c) ? r[gi] : null)).filter((x): x is RawProfile => !!x);
  if (!clusters) {
    return groups.flatMap((g, gi) => {
      const parts = rowsOf(gi, null);
      return parts.length ? [{ id: g.id, title: g.title, ...(g.color ? { color: g.color } : {}), values: finishProfile(poolProfiles(parts, g.id), opts) }] : [];
    });
  }
  const k = Math.max(0, ...clusters) + 1;
  const dashes = [[], [6, 3], [2, 2], [8, 3, 2, 3]];
  return Array.from({ length: k }, (_, c) => groups.flatMap((g, gi) => {
    const parts = rowsOf(gi, c);
    if (!parts.length) return [];
    return [{ id: `${g.id}#C${c + 1}`, title: groups.length > 1 ? `C${c + 1} · ${g.title}` : `C${c + 1}`, color: CLUSTER_COLOURS[c % CLUSTER_COLOURS.length],
      ...(groups.length > 1 ? { dash: dashes[gi % dashes.length] } : {}), values: finishProfile(poolProfiles(parts, `${g.id}#C${c + 1}`), opts) }];
  })).flat();
}

/** "Accessibility (fire) per region, 1,000 BED regions ±1 kb, sorted by mean; seed 1": what the heatmap measures. */
export function regionHeatmapHeader(o: { source: string; regions: number; what: 'BED regions' | 'selected features'; window: string; sort: HeatmapSettings; seed: number; subsample?: string | null; clusters?: number | null }): string {
  const s = o.sort;
  const win = s.sortFrom == null && s.sortTo == null ? '' : ` in ${s.sortFrom ?? '−∞'} to ${s.sortTo ?? '+∞'} bp`;
  const sortText = s.sort === 'mean' ? `sorted by mean${win}` : s.sort === 'centre' ? 'sorted by the signal at the centre' : s.sort === 'cluster' ? `k-means clusters (k = ${o.clusters ?? s.k})` : s.sort === 'bed' ? 'in BED order' : `sorted by BED column ${s.scoreColumn}`;
  return `${o.source} per region, ${o.regions.toLocaleString('en-US')} ${o.what} ${o.window}, ${sortText}; seed ${o.seed}${o.subsample ? ` · ${o.subsample}` : ''}`;
}

/** A cluster's regions as a BED region set (Save cluster as BED set): 0-based half-open, strand and name kept. */
export function clusterBedSet(name: string, regions: Array<[string, number, number, '+' | '-' | '.', string]>, color: string, id: string) {
  return { id, name, path: '', color, regions, total: regions.length };
}
