/**
 * Lattice-recaller classes as one row per class and one column per channel (dataset x strand; Hia5 is pooled),
 * with pooling across chosen channels and flags for strong discrepancies between strands or assays.
 */
import type { ConsensusCatalog, RecallerStrand } from '../api/consensusWorkflow';

export interface RecallerChannel { source?: NonNullable<ConsensusCatalog['region_sources']>[string]; key: string; datasetId: string; strand: string; label: string; daf: boolean }
export interface RecallerClassRow {
  family: string; start: number; end: number;
  datasets: string[];
  /** channel key -> the class's per-strand result on that channel */
  channels: Record<string, RecallerStrand>;
  /** Read-order check (when the run had it): fraction of read orders that found the class, and the verdict. */
  orderRobustness?: number; robust?: boolean;
}
export type Weighting = 'molecules' | 'equal';
export interface Pooled { value: number | null; lower: number | null; molecules: number; supported: boolean; resolved: boolean;
  /** + one-edge-aligned wider protection; + other shapes (conservative to loose). */
  edge: number | null; loose: number | null }
export const tierEdge = (r: RecallerStrand) => r.prevalence_edge ?? r.prevalence;
export const tierLoose = (r: RecallerStrand) => r.prevalence_loose ?? tierEdge(r);
export interface DiscrepancyFlag { kind: 'one_strand' | 'strand_gap' | 'assay_gap' | 'unresolved'; strong: boolean; text: string }

/** Thresholds for flags (fractions). Strand: >2-fold and >=10 points apart; assays: >=20 points apart. */
export const DISCREPANCY = { strandFold: 2, strandMinDifference: .10, assayDifference: .20 };

const STRAND_ORDER: Record<string, number> = { CT: 0, GA: 1, pooled: 2 };
export const channelKey = (datasetId: string, strand: string) => `${datasetId}::${strand}`;

export function isRecallerCatalog(catalog: ConsensusCatalog | null | undefined): catalog is ConsensusCatalog {
  return catalog?.cr_mode === 'lattice_recaller';
}

/** Channels in dataset order (the catalog's), strands CT, GA, then pooled. */
export function recallerChannels(catalog: ConsensusCatalog, labels: Record<string, string>): RecallerChannel[] {
  const out: RecallerChannel[] = [];
  for (const [datasetId, dataset] of Object.entries(catalog.datasets)) {
    const strands = new Set<string>();
    for (const f of dataset.catalog ?? []) for (const s of Object.keys(f.recaller ?? {})) strands.add(s);
    const label = labels[datasetId] ?? datasetId;
    for (const strand of [...strands].sort((a, b) => (STRAND_ORDER[a] ?? 9) - (STRAND_ORDER[b] ?? 9) || a.localeCompare(b)))
      out.push({ source: catalog.region_sources?.[datasetId], key: channelKey(datasetId, strand), datasetId, strand, daf: strand === 'CT' || strand === 'GA',
        label: strand === 'pooled' ? label : `${label} ${strand}` });
  }
  return out;
}

/** One row per class (classes share ids across datasets in a recaller run), in genomic order. */
export function recallerClassRows(catalog: ConsensusCatalog): RecallerClassRow[] {
  const rows = new Map<string, RecallerClassRow>();
  for (const [datasetId, dataset] of Object.entries(catalog.datasets)) {
    for (const f of dataset.catalog ?? []) {
      if (!f.recaller) continue;
      const row = rows.get(f.family) ?? { family: f.family, start: f.consensus_start, end: f.consensus_end, datasets: [], channels: {},
        ...(typeof f.robust === 'boolean' ? { robust: f.robust, orderRobustness: f.order_robustness } : {}) };
      row.datasets.push(datasetId);
      for (const [strand, r] of Object.entries(f.recaller)) row.channels[channelKey(datasetId, strand)] = r;
      rows.set(f.family, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.family.localeCompare(b.family));
}

export function wilsonLower(k: number, n: number, z = 1.96): number | null {
  if (n <= 0) return null;
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return Math.max(0, (c - r) / d);
}

/**
 * Prevalence pooled over channels. 'molecules' weights each channel by its molecules (the same as pooling the
 * molecules; Wilson lower bound on the pooled counts); 'equal' averages the channels (no interval).
 */
export function pooledPrevalence(row: RecallerClassRow, keys: string[], weighting: Weighting): Pooled {
  const parts = keys.map(k => row.channels[k]).filter((r): r is RecallerStrand => !!r && r.molecules > 0);
  if (!parts.length) return { value: null, lower: null, molecules: 0, supported: false, resolved: false, edge: null, loose: null };
  const molecules = parts.reduce((n, r) => n + r.molecules, 0);
  const supported = parts.some(r => r.supported), resolved = parts.some(r => r.resolved);
  const mean = (f: (r: RecallerStrand) => number) => weighting === 'equal'
    ? parts.reduce((s, r) => s + f(r), 0) / parts.length
    : parts.reduce((s, r) => s + f(r) * r.molecules, 0) / molecules;
  const value = mean(r => r.prevalence);
  return { value, lower: weighting === 'equal' ? null : wilsonLower(Math.round(value * molecules), molecules), molecules, supported, resolved,
    edge: mean(tierEdge), loose: mean(tierLoose) };
}

const pct = (v: number) => `${(100 * v).toFixed(1)}%`;

/** Strong discrepancies between strands of a DAF dataset and between datasets; notes for unresolved channels. */
export function discrepancyFlags(row: RecallerClassRow, channels: RecallerChannel[]): DiscrepancyFlag[] {
  const flags: DiscrepancyFlag[] = [];
  const byDataset = new Map<string, RecallerChannel[]>();
  for (const c of channels) if (row.channels[c.key]) byDataset.set(c.datasetId, [...(byDataset.get(c.datasetId) ?? []), c]);
  const datasetLabel = (cs: RecallerChannel[]) => cs[0].strand === 'pooled' ? cs[0].label : cs[0].label.replace(/ (CT|GA)$/, '');
  for (const cs of byDataset.values()) {
    const ct = cs.find(c => c.strand === 'CT'), ga = cs.find(c => c.strand === 'GA');
    if (!ct || !ga) continue;
    const a = row.channels[ct.key], b = row.channels[ga.key], name = datasetLabel(cs);
    if (a.supported !== b.supported) {
      flags.push({ kind: 'one_strand', strong: true, text: `${name}: ${a.supported ? 'CT' : 'GA'} only (CT ${pct(a.prevalence)}, GA ${pct(b.prevalence)})` });
    } else if (a.supported && b.supported) {
      const fold = Math.abs(Math.log2((a.prevalence + .01) / (b.prevalence + .01)));
      if (Math.max(a.prevalence, b.prevalence) >= .1 && fold > Math.log2(DISCREPANCY.strandFold)
          && Math.abs(a.prevalence - b.prevalence) >= DISCREPANCY.strandMinDifference)
        flags.push({ kind: 'strand_gap', strong: true, text: `${name}: CT ${pct(a.prevalence)} vs GA ${pct(b.prevalence)}` });
    }
  }
  const levels = [...byDataset.values()].map(cs => ({ name: datasetLabel(cs), p: pooledPrevalence(row, cs.map(c => c.key), 'molecules') }))
    .filter(d => d.p.value != null && d.p.supported);
  for (let i = 0; i < levels.length; i++) for (let j = i + 1; j < levels.length; j++) {
    const x = levels[i], y = levels[j];
    if (Math.abs(x.p.value! - y.p.value!) >= DISCREPANCY.assayDifference)
      flags.push({ kind: 'assay_gap', strong: x.p.resolved && y.p.resolved,
        text: `${x.name} ${pct(x.p.value!)} vs ${y.name} ${pct(y.p.value!)}${x.p.resolved && y.p.resolved ? '' : ' (one side unresolved)'}` });
  }
  const unresolved = channels.filter(c => row.channels[c.key] && !row.channels[c.key].resolved);
  if (unresolved.length) flags.push({ kind: 'unresolved', strong: false, text: `unresolved on ${unresolved.map(c => c.label).join(', ')}` });
  return flags;
}

/** For sorting: the largest strand or assay difference in the row (fraction). */
export function discrepancyScore(row: RecallerClassRow, channels: RecallerChannel[]): number {
  let best = 0;
  const ds = new Map<string, number>();
  for (const c of channels) {
    const r = row.channels[c.key];
    if (!r) continue;
    const other = channels.find(o => o.datasetId === c.datasetId && o.key !== c.key && o.daf && c.daf);
    if (other && row.channels[other.key]) best = Math.max(best, Math.abs(r.prevalence - row.channels[other.key].prevalence));
    if (!ds.has(c.datasetId)) {
      const p = pooledPrevalence(row, channels.filter(o => o.datasetId === c.datasetId).map(o => o.key), 'molecules').value;
      if (p != null) ds.set(c.datasetId, p);
    }
  }
  const values = [...ds.values()];
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) best = Math.max(best, Math.abs(values[i] - values[j]));
  return best;
}

/** Save/filter targets for the chosen channels: a DAF dataset with one strand chosen is restricted to that strand. */
export function channelTargets(keys: string[], channels: RecallerChannel[]): { datasetId: string; strand: 'CT' | 'GA' | null }[] {
  const chosen = channels.filter(c => keys.includes(c.key));
  const out: { datasetId: string; strand: 'CT' | 'GA' | null }[] = [];
  for (const datasetId of [...new Set(chosen.map(c => c.datasetId))]) {
    const mine = chosen.filter(c => c.datasetId === datasetId);
    const all = channels.filter(c => c.datasetId === datasetId);
    const one = mine.length === 1 && mine[0].daf && all.filter(c => c.daf).length > 1 ? (mine[0].strand as 'CT' | 'GA') : null;
    out.push({ datasetId, strand: one });
  }
  return out;
}

/** What counts as a class, any combination of: strict members ('core'); clean-core molecules whose protected run lines
 * up with a class edge ('edge'); clean-core molecules under other protection ('loose', any overlap). */
export type RecallerTier = 'core' | 'edge' | 'loose';
export const TIERS: RecallerTier[] = ['core', 'edge', 'loose'];
export const TIER_LABEL: Record<RecallerTier, string> = { core: 'strict', edge: 'edge', loose: 'overlap' };
export const parseTiers = (spec?: string | null): RecallerTier[] => {
  const parts = TIERS.filter(t => String(spec ?? '').split('+').includes(t));
  return parts.length ? parts : ['core'];
};
export const tierSpec = (parts: RecallerTier[]) => TIERS.filter(t => parts.includes(t)).join('+') || 'core';
/** Each category's share: strict, edge-only and overlap-only parts of the cumulative tiers. */
export const tierParts = (core: number, edge: number, loose: number): Record<RecallerTier, number> =>
  ({ core, edge: Math.max(0, edge - core), loose: Math.max(0, loose - edge) });
export const tierSum = (core: number, edge: number, loose: number, parts: RecallerTier[]) => {
  const p = tierParts(core, edge, loose); return parts.reduce((s, t) => s + p[t], 0);
};
export const classFilterKey = (family: string, targets: { datasetId: string; strand?: string | null }[], spec = 'core') =>
  `class:${family}:${targets.map(t => `${t.datasetId}/${t.strand ?? '*'}`).join(',')}${spec === 'core' ? '' : `:${spec}`}`;

/** The class table as TSV: one row per class and channel, all three prevalence tiers, support, resolution and flags. */
/**
 * The class table as TSV. `notes`: header lines written first as `# …`
 * comments (the region the run analysed); read it with comment='#'.
 */
export function formatRecallerTableTsv(rows: RecallerClassRow[], channels: RecallerChannel[], name: (row: RecallerClassRow) => string, notes: string[] = []): string {
  const head = ['class', 'class_id', 'start', 'end', 'bp', 'channel', 'molecules', 'prevalence_core', 'prevalence_edge', 'prevalence_loose',
    'prevalence_lower_bound', 'supported', 'support_gain_nats', 'resolved', 'resolution_nats', 'broader', 'other_shape', 'accessible', 'spots',
    'edge_contraction', 'flags'];
  const out = [...notes.map(n => `# ${n.replace(/[\r\n]+/g, ' ')}`), head.join('\t')];
  for (const row of rows) {
    const flags = discrepancyFlags(row, channels).map(f => f.text).join('; ');
    for (const c of channels) {
      const r = row.channels[c.key];
      if (!r) continue;
      out.push([name(row), row.family, Math.round(row.start), Math.round(row.end), Math.round(row.end - row.start), c.label, r.molecules,
        r.prevalence, tierEdge(r), tierLoose(r), r.prevalence_lower_bound, r.supported, r.support_gain_nats ?? '', r.resolved, r.resolution_nats,
        r.broader, r.other_shape, r.accessible, r.spots ?? '', r.edge_contraction ?? '', flags].map(v => String(v).replace(/[\t\n]/g, ' ')).join('\t'));
    }
  }
  return out.join('\n') + '\n';
}

/** "12 of 19 classes are robust to read order" for a run with the read-order check; null for a run without it. */
export function robustnessSummary(rows: RecallerClassRow[]): { robust: number; total: number; text: string } | null {
  const checked = rows.filter(r => typeof r.robust === 'boolean');
  if (!rows.length || checked.length !== rows.length) return null;
  const robust = checked.filter(r => r.robust).length;
  return { robust, total: rows.length,
    text: `${robust} of ${rows.length} class${rows.length === 1 ? ' is' : 'es are'} robust to read order` };
}

/** How many of the run's read orders found a class ("found in 2 of 3 read orders"). */
export function robustnessDetail(row: RecallerClassRow, orderings: number | undefined): string {
  if (typeof row.robust !== 'boolean') return '';
  const n = orderings && orderings > 0 ? orderings : null;
  const found = n != null && row.orderRobustness != null ? Math.round(row.orderRobustness * n) : null;
  const share = found != null ? `found in ${found} of ${n} read orders` : `found in ${Math.round(100 * (row.orderRobustness ?? 0))}% of read orders`;
  return row.robust ? `Robust to read order: ${share}.` : `Not robust to read order: ${share}. Classes close to the detection threshold can depend on the order the reads are processed in.`;
}
