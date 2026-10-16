/**
 * Accessibility (preview): pure helpers for the panel, the arcs and the matrix (no React, no store).
 */
import type { ContactArc } from '../../types/dafc';
import type { AccessibilityElement, AccessibilityGroups, AccessibilityPair, AccessibilityResult, NfrRegionResult, NfrVariant } from './api';
import type { ArcSelection } from './accessibilityStore';
import { CLUSTER_COLORS } from '../../components/tracks/read-track/constants';
import { OPEN_BAM_HINT } from '../../utils/openBamHint';

/** Distinct colours per NFR region (variants of one NFR share a hue family) and for footprint classes. */
export const NFR_COLORS = ['#a21caf', '#0369a1', '#b45309', '#4d7c0f', '#be123c', '#4338ca'];
export const CLASS_COLOR = '#059669';
export const CO_COLOR = '#c2410c';
export const ANTI_COLOR = '#1d4ed8';

export function nfrColor(nfrId: string | undefined): string {
  const n = Number(String(nfrId ?? '').replace(/\D/g, '')) || 1;
  return NFR_COLORS[(n - 1) % NFR_COLORS.length];
}

export function elementColor(e: Pick<AccessibilityElement, 'kind' | 'nfr'>): string {
  return e.kind === 'tf' ? CLASS_COLOR : nfrColor(e.nfr);
}

/** "N1 V2" for variants, "class 008" for footprint classes. */
export function shortElement(e: AccessibilityElement | undefined, id: string): string {
  if (!e) return id;
  if (e.kind === 'tf') return e.label.replace(/^class /, 'C');
  return e.id.replace(':', ' ');
}

export const pct = (v: number | null | undefined, digits = 0): string =>
  v == null || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(digits)}%`;

/** A share as a percentage with one decimal below 10% ("2.7%", "6%", "37%"). */
export const share = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '–' : v > 0 && v < 0.001 ? '<0.1%' : v < 0.1 && Math.round(v * 1000) % 10 !== 0 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`;

/** A detected NFR's open share and the view's background: "open in 6% of reads · background 2.7%" (null when given). */
export function nfrDetectionLine(nfr: Pick<NfrRegionResult, 'source' | 'profile_peak' | 'detection'>): string | null {
  if (nfr.source !== 'detected') return null;
  const peak = nfr.detection?.peak ?? nfr.profile_peak;
  if (peak == null) return null;
  const b = nfr.detection?.background;
  return `open in ${share(peak)} of reads${b != null ? ` · background ${share(b)}` : ''}${nfr.detection?.fold != null ? ` · ${Number(nfr.detection.fold.toFixed(1))}× background` : ''}${nfr.detection?.q != null ? ` · q ${formatQ(nfr.detection.q)}` : ''}`;
}

/** The run's detection in words, for the result line: "NFRs open in ≥ 5% · background 2.7% · called at ≥ 5.4% here". */
export function runDetectionLine(result: Pick<AccessibilityResult, 'detection' | 'parameters'> & Partial<Pick<AccessibilityResult, 'nfrs'>>): string | null {
  const d = result.detection;
  if (!d) {
    const given = result.parameters?.nfr_regions;
    if (Array.isArray(given) && given.length) return 'NFR regions given';
    const t = result.parameters?.detect_threshold;
    return typeof t === 'number' ? `NFRs: fixed rule, > ${share(t)} of reads` : null;
  }
  if (d.method === 'given') return 'NFR regions given';
  if (d.method === 'fixed') return `NFRs: fixed rule, > ${share(d.threshold ?? (result.parameters?.detect_threshold as number))} of reads`;
  const mf = d.min_fraction ?? (result.parameters?.min_fraction as number | undefined);
  const folds = (result.nfrs ?? []).flatMap(n => n.detection?.fold == null ? [] : [n.detection.fold]).filter(Number.isFinite);
  const qs = (result.nfrs ?? []).flatMap(n => n.detection?.q == null ? [] : [n.detection.q]).filter(Number.isFinite);
  const range = (values: number[], format: (v: number) => string) => {
    const lo = Math.min(...values), hi = Math.max(...values);
    return lo === hi ? format(lo) : `${format(lo)}–${format(hi)}`;
  };
  const evidence = `${folds.length ? ` · NFR peaks ${range(folds, v => Number(v.toFixed(1)).toString())}× background` : ''}${qs.length ? ` · q ${range(qs, formatQ)}` : ''}`;
  if (d.method === 'raw' || d.enrichment_gates === false) return `NFRs open in ≥ ${share(mf)} of reads · background ${share(d.background)} · fold and q are informative, not gates${evidence}`;
  if (!d.enrichment_test || d.background == null) return `NFRs open in ≥ ${share(mf)} · no background (see note)`;
  const level = Math.max(mf ?? 0, (d.min_fold ?? 2) * d.background);
  return `NFRs open in ≥ ${share(mf)} · background ${share(d.background)} · called at ≥ ${share(level)} here${evidence}`;
}

/**
 * The two prevalence estimates as a range, lower first ("27–29%"; one value when they round the same). Strict
 * (reads at least 90% sure) is usually the lower one, but neither bounds the other, so the tooltip names both.
 */
export function prevalenceRange(v: Pick<NfrVariant, 'strict' | 'prevalence'>): string {
  const [lo, hi] = [v.strict, v.prevalence].sort((x, y) => x - y);
  const a = pct(lo), b = pct(hi);
  return a === b ? b : `${a.replace('%', '')}–${b}`;
}

export function prevalenceTitle(v: Pick<NfrVariant, 'strict' | 'prevalence'>): string {
  return `EM estimate ${pct(v.prevalence, 1)}; strict (reads at least 90% sure) ${pct(v.strict, 1)}`;
}

export function bp(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function formatQ(q: number | null | undefined): string {
  if (q == null || !Number.isFinite(q)) return 'n/a';
  return q < 0.001 ? q.toExponential(1) : q.toFixed(3);
}

export function signed(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

/**
 * DAF strand (CT / GA) prevalence of a variant, "CT 17% · GA 20%" ("napa CT 17% · …" with several datasets);
 * '' when no channel is a DAF strand (Hia5).
 */
export function strandSplit(v: NfrVariant, datasetLabel: (id: string) => string = id => id): string {
  const entries = Object.entries(v.by_channel ?? {}).filter(([ch]) => /::(CT|GA)$/.test(ch));
  if (!entries.length) return '';
  const datasets = new Set(entries.map(([ch]) => ch.split('::')[0]));
  return entries.map(([ch, s]) => {
    const [ds, strand] = [ch.slice(0, ch.lastIndexOf('::')), ch.split('::').pop()];
    return `${datasets.size > 1 ? `${datasetLabel(ds)} ` : ''}${strand} ${pct(s.em)}`;
  }).join(' · ');
}

export interface ElementArc extends ContactArc {
  pair: AccessibilityPair;
  a: AccessibilityElement | undefined;
  b: AccessibilityElement | undefined;
  /** Above the axis: co-accessible (MH log2 OR > 0); below: anti. */
  side: 'up' | 'down';
  /** Stroke width ~ -log10 q (1-6 px). */
  lineWidth: number;
  dash: 'solid' | 'dotted' | 'dashed';
  significant: boolean;
}

/** The openness-adjusted (MH) log2 OR; null when it is undefined (e.g. a combination never seen within strata). */
export function pairEffect(pair: AccessibilityPair): number | null {
  return pair.mh != null && Number.isFinite(pair.mh) ? pair.mh : null;
}

/** The pair filters shared by the arcs, the matrix, the pair list and the arc track over the reads. */
export interface PairFilter {
  /** Significant at q <= qMax (and called co-accessible or anti). */
  qMax: number;
  /** |openness-adjusted log2 OR| at least this. */
  minEffect: number;
  /** Only the strongest N (by |effect|, then q); null: all that pass. */
  topN: number | null;
  /** Only the pairs of one element (a variant, a class: its id) or of one NFR with all its variants ('N5'). */
  focus: string | null;
  includeClasses: boolean;
}

export const DEFAULT_PAIR_FILTER: Omit<PairFilter, 'includeClasses' | 'focus'> = { qMax: 0.05, minEffect: 1, topN: 20 };

export function pairSignificant(pair: AccessibilityPair, qMax: number): boolean {
  return pair.q <= qMax && (pair.class === 'co-accessible' || pair.class === 'anti');
}

/** Whether an element belongs to the focus: the element itself, or a variant (or whole-NFR element) of the focused NFR. */
export function inFocus(id: string, focus: string | null, byId?: Map<string, AccessibilityElement>): boolean {
  if (!focus) return true;
  if (id === focus) return true;
  const e = byId?.get(id);
  const nfr = e?.nfr ?? (id.includes(':') ? id.split(':')[0] : null);
  return !focus.includes(':') && nfr === focus && e?.kind !== 'tf';
}

/** Pairs passing the filter, strongest first (|effect|, then q). Pairs without an adjusted effect never pass. */
export function filterPairs(result: AccessibilityResult | null, f: PairFilter): AccessibilityPair[] {
  if (!result) return [];
  const byId = new Map(result.elements.map(e => [e.id, e]));
  const out = result.pairs.filter(pair => {
    const effect = pairEffect(pair);
    if (effect == null) return false;
    if (!f.includeClasses && (pair.kind_a === 'tf' || pair.kind_b === 'tf')) return false;
    if (!pairSignificant(pair, f.qMax) || Math.abs(effect) < f.minEffect) return false;
    return !f.focus || inFocus(pair.a, f.focus, byId) || inFocus(pair.b, f.focus, byId);
  }).sort((x, y) => Math.abs(pairEffect(y)!) - Math.abs(pairEffect(x)!) || x.q - y.q);
  return f.topN != null && f.topN > 0 ? out.slice(0, f.topN) : out;
}

/** How many pairs pass each part of the filter (for the strip's counts). */
export function pairCounts(result: AccessibilityResult | null, f: PairFilter): { tested: number; significant: number; shown: number } {
  if (!result) return { tested: 0, significant: 0, shown: 0 };
  const pairs = result.pairs.filter(p => f.includeClasses || (p.kind_a !== 'tf' && p.kind_b !== 'tf'));
  return { tested: pairs.length, significant: pairs.filter(p => pairSignificant(p, f.qMax)).length, shown: filterPairs(result, f).length };
}

/** Arcs of the pairs that pass the filter. */
export function filteredArcs(result: AccessibilityResult | null, f: PairFilter): ElementArc[] {
  if (!result) return [];
  const keep = new Set(filterPairs(result, f));
  return pairsToArcs({ ...result, pairs: result.pairs.filter(p => keep.has(p)) }, 'all', f.includeClasses, f.qMax);
}

/**
 * Pairs -> arcs. strength = |openness-adjusted MH log2 OR| (the arc height); above the axis when > 0.
 * Dotted: a footprint class inside the NFR variant; dashed: at its edge.
 */
export function pairsToArcs(result: AccessibilityResult | null, selection: ArcSelection, includeClasses: boolean, qMax = 0.1): ElementArc[] {
  if (!result) return [];
  const byId = new Map(result.elements.map(e => [e.id, e]));
  const out: ElementArc[] = [];
  for (const pair of result.pairs) {
    const effect = pairEffect(pair);
    if (effect == null || !Number.isFinite(effect)) continue;
    if (!includeClasses && (pair.kind_a === 'tf' || pair.kind_b === 'tf')) continue;
    const significant = pairSignificant(pair, qMax);
    if (selection === 'significant' && !significant) continue;
    const a = byId.get(pair.a), b = byId.get(pair.b);
    if (!a || !b) continue;
    const ca = (a.start + a.end) / 2, cb = (b.start + b.end) / 2;
    out.push({
      start: Math.min(ca, cb), end: Math.max(ca, cb), strength: Math.abs(effect), count: pair.n, distance: Math.abs(cb - ca),
      pair, a, b, side: effect >= 0 ? 'up' : 'down',
      lineWidth: Math.max(1, Math.min(6, -Math.log10(Math.max(pair.q, 1e-300)) / 4 + 1)),
      dash: pair.nested === 'inside' ? 'dotted' : pair.nested === 'edge' ? 'dashed' : 'solid',
      significant,
    });
  }
  return out;
}

/** One direction vocabulary for a pair (arcs, matrix, pair table, drill-down card). */
export const DIRECTION: Record<string, string> = {
  'co-accessible': 'open together', anti: 'rarely together', 'independence-compatible': 'consistent with independence', unresolved: 'not resolved',
};
export const directionWord = (cls: string | null | undefined): string => (cls ? DIRECTION[cls] ?? cls : '');

/** What q is: evidence against independence, adjusted over the run's tests, not a proof that the pair is linked. */
export const Q_HELP = 'q: the Benjamini–Hochberg adjusted p-value over every pair tested in this run. A small q is stronger evidence that '
  + 'the two open together (or apart) more than read openness explains; it is evidence, not proof, and says nothing about cause.';

/** The tooltip for an arc or a matrix cell: plain words first, numbers after. */
export function pairTooltip(pair: AccessibilityPair, byId: Map<string, AccessibilityElement>): string {
  const a = byId.get(pair.a), b = byId.get(pair.b);
  const verdict = pair.class === 'co-accessible' ? 'open together (more often than read openness explains)'
    : pair.class === 'anti' ? 'rarely together (less often than read openness explains)'
      : pair.class === 'independence-compatible' ? 'consistent with independence' : 'not resolved with these reads';
  const lines = [
    `${a?.label ?? pair.a}  ×  ${b?.label ?? pair.b}: ${verdict}`,
    pairEffect(pair) == null
      ? 'Adjusted log₂ OR: not defined (some combination never occurs within the openness strata)'
      : `Adjusted log₂ OR (openness strata pooled) ${signed(pair.mh)} [${signed(pair.mh_lo)}, ${signed(pair.mh_hi)}]`,
    `Pooled log₂ OR (unadjusted) ${signed(pair.log2or)}`,
    `q = ${formatQ(pair.q)} (evidence against independence, not proof) · ${pair.n.toLocaleString()} reads span both${pair.shared ? ` · ${pair.shared.toLocaleString()} shared openings left out` : ''}`,
    `Both open ${pair.table[0]} · only first ${pair.table[1]} · only second ${pair.table[2]} · neither ${pair.table[3]}`,
  ];
  if (pair.nested) lines.push(pair.nested === 'inside' ? 'The footprint class lies inside the NFR variant.' : 'The footprint class sits at the NFR variant’s edge.');
  if (pair.cluster != null && Number.isFinite(pair.cluster)) lines.push(`Within read clusters (re-clustered without these two): log2 OR ${signed(pair.cluster)} (${pair.cluster_n} reads)`);
  if (pair.adjust && pair.adjust !== 'openness x channel') lines.push(`Adjustment: ${pair.adjust}`);
  return lines.join('\n');
}

/** Matrix cell colour for a log2 odds ratio (red: together, blue: apart), like the co-occupancy triangle. */
export function effectColor(effect: number | null | undefined): string {
  if (effect == null || !Number.isFinite(effect)) return 'transparent';
  const x = Math.max(-3, Math.min(3, effect));
  const alpha = Math.abs(x) / 3 * 0.6;
  return x >= 0 ? `rgba(194, 65, 12, ${alpha})` : `rgba(29, 78, 216, ${alpha})`;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Cluster-store shape for "Group reads by NFR variant": one cluster per most-likely configuration. */
export function groupsToClusters(groups: AccessibilityGroups) {
  return {
    order: groups.groups.map(g => g.id),
    patterns: Object.fromEntries(groups.groups.map(g => [g.id, g.pattern])) as Record<number, number[]>,
    regions: groups.variants.map(v => ({ start: Math.floor(v.start), end: Math.ceil(v.end), mode: 'accessibility' as const })),
    byDataset: groups.by_dataset,
    labels: Object.fromEntries(groups.groups.map(g => [g.id, g.display_label || g.label])) as Record<number, string>,
  };
}

/** A distinct colour per variant of an NFR (V1, V2, …), the same in every view of the panel and in the read panels:
 * variant k is cluster colour k - 1, and grouping reads by an NFR's configurations gives the single-variant
 * configuration Vk cluster k - 1 (services/accessibility_workflow.read_groups). */
export const VARIANT_COLORS = CLUSTER_COLORS.slice(0, 12);
export function variantColor(name: string | undefined): string {
  const n = Number(String(name ?? '').replace(/\D/g, '')) || 1;
  return VARIANT_COLORS[(n - 1) % VARIANT_COLORS.length];
}

/** "41%" with its interval "[39–43]" (the interval holds the variant set fixed). */
export function prevalenceWithInterval(p: number | null | undefined, ci: [number, number] | null | undefined): { value: string; interval: string } {
  return { value: pct(p), interval: ci ? `${Math.round(ci[0] * 100)}–${Math.round(ci[1] * 100)}` : '' };
}

/** Display names of the four cells of a pair split: "N1 V2+ N2 V1−". */
export const SPLIT_CELL_HINT: Record<string, string> = {
  '11': 'both open', '10': 'only the first open', '01': 'only the second open', '00': 'neither open', na: 'not in the test',
};

/** Cluster-store input for a split response (groups keep their ids: 0-3 the 2x2 cells, 4 not informative). */
export function splitToGroups(split: { groups: { id: number; pattern: number[] | null; label?: string }[]; by_dataset: Record<string, Record<string, number>> },
  regions: { start: number; end: number; mode?: string }[]) {
  return {
    order: split.groups.map(g => g.id),
    patterns: Object.fromEntries(split.groups.filter(g => g.pattern).map(g => [g.id, g.pattern as number[]])) as Record<number, number[]>,
    regions: regions.map(r => ({ start: Math.floor(r.start), end: Math.ceil(r.end), mode: r.mode ?? 'accessibility' })),
    byDataset: split.by_dataset,
    labels: Object.fromEntries(split.groups.filter(g => g.label).map(g => [g.id, g.label as string])) as Record<number, string>,
  };
}

/** What the panel says when no dataset is loaded: the one empty-state sentence of every analysis panel (R12). */
export const NO_DATASET_HINT = OPEN_BAM_HINT;

/**
 * An error in plain words (N10): the server's own sentence without the "API error 422:" prefix, and the no-dataset
 * refusal as what to do about it. Network and other errors keep their message.
 */
export function plainError(e: unknown): string {
  const text = String((e as Error)?.message ?? e ?? '').trim();
  const m = /^API error (\d{3})(?::\s*([\s\S]*))?$/.exec(text);
  if (!m) return text || 'Something went wrong.';
  const status = Number(m[1]);
  const detail = (m[2] ?? '').trim();
  if (/distinct datasets|no dataset|dataset_ids/i.test(detail)) return `There is no dataset in view to analyse. ${NO_DATASET_HINT}.`;
  if (status === 404) return detail ? `Not found: ${detail}` : 'Not found on the server (it may have restarted).';
  if (status >= 500) return detail ? `The server failed: ${detail}` : 'The server failed; try again.';
  if (!detail) return `The server did not accept this request (error ${status}).`;
  return detail.charAt(0).toUpperCase() + detail.slice(1);
}

/** Native marking opportunities in long gaps, when the engine reports them. */
export function opportunityDiagnosticLine(result: Pick<AccessibilityResult, 'detection'>): string | null {
  const d = result.detection?.opportunity_diagnostic;
  if (!d) return null;
  const b = d.background?.median_opportunities_per_100bp, n = d.nfr?.median_opportunities_per_100bp;
  if (!d.available || b == null) return 'Long gaps outside NFRs: not enough marking-site data to compare with gaps inside NFRs.';
  return `Long gaps outside NFRs have a median of ${Number(b.toFixed(1))} marking sites per 100 bp${n == null ? '' : ` (inside NFRs: ${Number(n.toFixed(1))})`}: some may be missed marks rather than openings.`;
}
