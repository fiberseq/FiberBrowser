import { geneTss } from './coordinates';
import type { FeatureHubPayload } from '../api/readOperations';
import { idSetHas, qnameOfId, recordKey } from './recordKeys';
import { DEFAULT_MOLECULE_METRIC, moleculeMetricShortName, moleculeMetricUnitSuffix } from './moleculeMetrics';
import type {
  AnalysisRuleGenePart,
  AnalysisRuleScope,
  AnalysisRuleScopeKind,
  AnalysisFilterOperator,
  AnalysisFilterRule,
  AnalysisSortMetric,
  AnalysisSortRule,
  ClusterFeatureRule,
  ClusterFeatureRuleTerm,
  ClusterFeatureRuleTermSource,
  FirePeak,
  Gene,
  PeakMode,
  QualityGate,
  Region,
  TranscriptionStateRuleKind,
} from '../types';

export const DEFAULT_ANALYSIS_RULE_SCOPE: AnalysisRuleScope = {
  kind: 'selectedPeaks',
  peakLevelMin: null,
  peakLevelMax: null,
};

const VALID_SCOPE_KINDS: AnalysisRuleScopeKind[] = [
  'selectedPeaks',
  'allPeaks',
  'currentWindow',
  'gene',
  'transcript',
  'customRegion',
];

const VALID_GENE_PARTS: AnalysisRuleGenePart[] = ['full', 'tss', 'geneBody', 'exon', 'intron'];
const VALID_TRANSCRIPTION_STATES: TranscriptionStateRuleKind[] = ['pause', 'pic', 'elongating'];

export const TRANSCRIPTION_STATE_RULE_OPTIONS: Array<{ value: TranscriptionStateRuleKind; label: string }> = [
  { value: 'pause', label: 'Pause' },
  { value: 'pic', label: 'PIC' },
  { value: 'elongating', label: 'Elongating' },
];

/**
 * Pol II states that existed in older builds but were removed. Saved sessions,
 * autosaves and rule sets may still reference them; rules using them are
 * dropped on load instead of being silently remapped to another state.
 */
const REMOVED_TRANSCRIPTION_STATES = new Set(['hyperburst']);

export function isRemovedTranscriptionStateTerm(term: unknown): boolean {
  if (!term || typeof term !== 'object') return false;
  const raw = term as Record<string, unknown>;
  if (raw.source !== 'transcription_state') return false;
  const state = raw.transcriptionState ?? raw.transcription_state;
  return typeof state === 'string' && REMOVED_TRANSCRIPTION_STATES.has(state);
}

export interface ClusterRegionWithMode {
  /** Absolute genomic start. The clustering API converts this to viewport-relative coordinates. */
  start: number;
  /** Absolute genomic end. */
  end: number;
  mode?: PeakMode;
}

interface ResolveClusterScopeContext {
  allPeaks: FirePeak[];
  selectedPeaks: Iterable<number>;
  peakModes: Record<number, PeakMode>;
  mode: PeakMode;
  chrom: string;
  viewportStart: number;
  viewportEnd: number;
  selectedGenes: Gene[];
}

function clampPeakLevel(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(3, parsed));
}

export function normalizeAnalysisRuleScope(scope: unknown): AnalysisRuleScope {
  if (!scope || typeof scope !== 'object') return { ...DEFAULT_ANALYSIS_RULE_SCOPE };
  const raw = scope as Record<string, unknown>;
  const kind = VALID_SCOPE_KINDS.includes(raw.kind as AnalysisRuleScopeKind)
    ? raw.kind as AnalysisRuleScopeKind
    : DEFAULT_ANALYSIS_RULE_SCOPE.kind;
  const genePart = VALID_GENE_PARTS.includes(raw.genePart as AnalysisRuleGenePart)
    ? raw.genePart as AnalysisRuleGenePart
    : 'full';
  const region = normalizeRegion(raw.region);

  return {
    kind,
    peakLevelMin: clampPeakLevel(raw.peakLevelMin),
    peakLevelMax: clampPeakLevel(raw.peakLevelMax),
    geneId: raw.geneId == null ? null : String(raw.geneId),
    geneName: raw.geneName == null ? null : String(raw.geneName),
    genePart,
    transcriptId: raw.transcriptId == null ? null : String(raw.transcriptId),
    transcriptName: raw.transcriptName == null ? null : String(raw.transcriptName),
    region,
    regionLabel: raw.regionLabel == null ? null : String(raw.regionLabel),
  };
}

function normalizeRegion(region: unknown): Region | null {
  if (!region || typeof region !== 'object') return null;
  const raw = region as Record<string, unknown>;
  const chrom = raw.chrom == null ? '' : String(raw.chrom);
  const start = Math.max(0, Math.round(Number(raw.start)));
  const end = Math.max(0, Math.round(Number(raw.end)));
  if (!chrom || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { chrom, start, end };
}

function layerLabel(term: ClusterFeatureRuleTerm, layerLabels?: Record<string, string>): string {
  const key = term.layer ?? '';
  if (layerLabels?.[key]) return layerLabels[key];
  if (key === '') return 'Primary FP';
  if (key === 'tf') return 'TF';
  if (key === 'nuc') return 'Nuc';
  if (key === 'msp') return 'Accessibility';
  if (key === 'fire') return 'Accessibility';
  return key;
}

function sizeSummary(term: Pick<ClusterFeatureRuleTerm, 'sizeMin' | 'sizeMax'>): string {
  const min = Math.max(0, Math.round(Number(term.sizeMin ?? 0)) || 0);
  const max = term.sizeMax == null ? null : Math.max(0, Math.round(Number(term.sizeMax)) || 0);
  if (min === 0 && max == null) return '';
  if (max == null) return `${min}+bp`;
  return `${min}-${max}bp`;
}

function gateSummary(gates?: QualityGate[]): string {
  if (!gates || gates.length === 0) return '';
  return gates
    .map(gate => {
      const name = gate.qualityName || 'q';
      const min = Math.round(Number(gate.minValue ?? 0));
      const max = gate.maxValue == null ? null : Math.round(Number(gate.maxValue));
      return max == null ? `${name}>=${min}` : `${name} ${min}-${max}`;
    })
    .join(',');
}

export function normalizeTranscriptionStateRuleKind(value: unknown): TranscriptionStateRuleKind {
  return VALID_TRANSCRIPTION_STATES.includes(value as TranscriptionStateRuleKind)
    ? value as TranscriptionStateRuleKind
    : 'elongating';
}

export function transcriptionStateRuleLabel(value: unknown): string {
  const kind = normalizeTranscriptionStateRuleKind(value);
  return TRANSCRIPTION_STATE_RULE_OPTIONS.find(option => option.value === kind)?.label ?? 'Elongating';
}

export function summarizeClusterFeatureRuleTerm(
  term: ClusterFeatureRuleTerm,
  layerLabels?: Record<string, string>,
): string {
  if (term.source === 'transcription_state') {
    return `Pol II ${transcriptionStateRuleLabel(term.transcriptionState)}`;
  }
  if (term.source === 'label_rule') {
    return term.labelRuleName || term.rule?.name || 'Label class';
  }
  if (term.source === 'footprint_group' || term.source === 'footprint_class') {
    return term.footprintGroupName || term.group?.name || 'Footprint class';
  }
  if (term.source === 'molecule_metric') {
    return moleculeMetricShortName(term.moleculeMetric);
  }
  if (term.source === 'feature_hub') {
    return `Hub hits (${term.hubHits?.length ?? 0}) state ${term.hubState === '0' ? '0' : '1'}`;
  }

  const parts = [layerLabel(term, layerLabels)];
  const size = sizeSummary(term);
  const gates = gateSummary(term.qualityGates);
  if (size) parts.push(size);
  if (gates) parts.push(gates);
  return parts.join(' ');
}

export function summarizeAnalysisRuleScope(scopeInput: unknown, options?: { omitDefault?: boolean }): string {
  const scope = normalizeAnalysisRuleScope(scopeInput);
  const levelRange = peakLevelRangeLabel(scope);
  if (scope.kind === 'selectedPeaks') {
    return options?.omitDefault && !levelRange ? '' : `selected peaks${levelRange}`;
  }
  if (scope.kind === 'allPeaks') return `all peaks${levelRange}`;
  if (scope.kind === 'currentWindow') return 'current window';
  if (scope.kind === 'gene') {
    const gene = scope.geneName || scope.geneId || 'selected gene';
    const part = scope.genePart && scope.genePart !== 'full' ? ` ${scope.genePart}` : '';
    return `${gene}${part}`;
  }
  if (scope.kind === 'transcript') {
    return scope.transcriptName || scope.transcriptId || 'selected transcript';
  }
  if (scope.kind === 'customRegion') {
    return scope.regionLabel || (scope.region ? `${scope.region.chrom}:${scope.region.start}-${scope.region.end}` : 'custom region');
  }
  return 'selected peaks';
}

function peakLevelRangeLabel(scope: AnalysisRuleScope): string {
  const min = scope.peakLevelMin;
  const max = scope.peakLevelMax;
  if (min == null && max == null) return '';
  if (min != null && max != null && min === max) return ` L${min}`;
  if (min == null) return ` L0-${max}`;
  if (max == null) return ` L${min}-3`;
  return ` L${min}-${max}`;
}

export function buildClusterFeatureRuleAutoName(
  rule: Pick<ClusterFeatureRule, 'terms' | 'scope'>,
  layerLabels?: Record<string, string>,
): string {
  const termText = (rule.terms ?? [])
    .map(term => summarizeClusterFeatureRuleTerm(term, layerLabels))
    .filter(Boolean)
    .join(' OR ');
  const source = termText || 'New cluster rule';
  const scope = summarizeAnalysisRuleScope(rule.scope, { omitDefault: true });
  return scope ? `${source} @ ${scope}` : source;
}

/** '' for 'value': a molecule metric's name is the metric. */
export function sortMetricLabel(metric: AnalysisSortMetric): string {
  if (metric === 'occupancy') return 'occupancy';
  if (metric === 'rate') return 'FP rate';
  if (metric === 'accessibility') return 'accessibility';
  if (metric === 'value') return '';
  return 'count';
}

/** The metric a rule's first term is measured by: a molecule metric's value, a hub term's count. */
function ruleMetric(rule: { terms?: ClusterFeatureRuleTerm[]; metric: AnalysisSortMetric }): AnalysisSortMetric {
  const source = rule.terms?.[0]?.source;
  if (source === 'molecule_metric') return 'value';
  if (source === 'feature_hub') return 'count';
  return rule.metric === 'value' ? 'count' : rule.metric;
}

/** A molecule's scalar and the hits' own states read the whole view: names leave that scope out. */
function scopeSummaryFor(rule: { terms?: ClusterFeatureRuleTerm[]; scope?: AnalysisRuleScope }): string {
  const terms = rule.terms ?? [];
  if (terms.length > 0 && terms.every(isScopeFreeTerm) && normalizeAnalysisRuleScope(rule.scope).kind === 'currentWindow') return '';
  return summarizeAnalysisRuleScope(rule.scope, { omitDefault: true });
}

function isScopeFreeTerm(term: ClusterFeatureRuleTerm): boolean {
  return term.source === 'molecule_metric' || term.source === 'feature_hub';
}

export function buildAnalysisSortRuleAutoName(
  rule: Pick<AnalysisSortRule, 'terms' | 'scope' | 'metric' | 'descending'>,
  layerLabels?: Record<string, string>,
): string {
  const termText = (rule.terms ?? [])
    .map(term => summarizeClusterFeatureRuleTerm(term, layerLabels))
    .filter(Boolean)
    .join(' OR ');
  const source = termText || 'Feature';
  const direction = rule.descending === false ? 'low to high' : 'high to low';
  const scope = scopeSummaryFor(rule);
  const base = [source, sortMetricLabel(ruleMetric(rule)), direction].filter(Boolean).join(' ');
  return scope ? `${base} @ ${scope}` : base;
}

export function filterOperatorLabel(operator: AnalysisFilterOperator): string {
  if (operator === 'gt') return '>';
  if (operator === 'gte') return '>=';
  if (operator === 'lt') return '<';
  if (operator === 'lte') return '<=';
  if (operator === 'between') return 'between';
  return '=';
}

/** A between rule's bounds, low first (the upper bound defaults to the lower). */
export function filterRuleBounds(rule: Pick<AnalysisFilterRule, 'threshold' | 'thresholdMax'>): [number, number] {
  const lo = Number.isFinite(rule.threshold) ? rule.threshold : 1;
  const hi = rule.thresholdMax != null && Number.isFinite(rule.thresholdMax) ? rule.thresholdMax : lo;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

export function buildAnalysisFilterRuleAutoName(
  rule: Pick<AnalysisFilterRule, 'terms' | 'scope' | 'metric' | 'operator' | 'threshold'> & Partial<Pick<AnalysisFilterRule, 'thresholdMax'>>,
  layerLabels?: Record<string, string>,
): string {
  const termText = (rule.terms ?? [])
    .map(term => summarizeClusterFeatureRuleTerm(term, layerLabels))
    .filter(Boolean)
    .join(' OR ');
  const source = termText || 'Feature';
  const scope = scopeSummaryFor(rule);
  const threshold = Number.isFinite(rule.threshold) ? rule.threshold : 1;
  const term = rule.terms?.[0];
  const unit = term?.source === 'molecule_metric' ? moleculeMetricUnitSuffix(term.moleculeMetric) : '';
  let comparison: string;
  if (rule.operator === 'between') {
    const [lo, hi] = filterRuleBounds(rule);
    comparison = `between ${lo} and ${hi}${unit}`;
  } else {
    comparison = `${filterOperatorLabel(rule.operator)} ${threshold}${unit}`;
  }
  const base = [source, sortMetricLabel(ruleMetric(rule)), comparison].filter(Boolean).join(' ');
  return scope ? `${base} @ ${scope}` : base;
}

// ------------------------------------------------------------------ term sources without a layer

const RULE_TERM_SOURCES: ClusterFeatureRuleTermSource[] = [
  'layer', 'label_rule', 'footprint_group', 'footprint_class', 'transcription_state', 'molecule_metric', 'feature_hub',
];

/** A saved term's source (unknown sources read as layer terms). */
export function normalizeRuleTermSource(value: unknown): ClusterFeatureRuleTermSource {
  return RULE_TERM_SOURCES.includes(value as ClusterFeatureRuleTermSource) ? value as ClusterFeatureRuleTermSource : 'layer';
}

type HubHit = NonNullable<ClusterFeatureRuleTerm['hubHits']>[number];

function normalizeHubHits(value: unknown): HubHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    const h = raw as Record<string, unknown>;
    if (!h || typeof h !== 'object') return [];
    const setId = h.setId ?? h.set_id, hitId = h.hitId ?? h.hit_id;
    const start = Number(h.start), end = Number(h.end);
    if (typeof setId !== 'string' || !setId || typeof hitId !== 'string' || !hitId) return [];
    if (typeof h.chrom !== 'string' || !h.chrom || !Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{ setId, hitId, chrom: h.chrom, start, end, ...(typeof h.label === 'string' && h.label ? { label: h.label } : {}) }];
  });
}

/** The fields of the layer-free sources a saved term keeps (sessions, rule sets, imports, every store update). */
export function normalizeRuleTermSourceFields(
  source: ClusterFeatureRuleTermSource,
  raw: Record<string, unknown>,
): Partial<ClusterFeatureRuleTerm> {
  if (source === 'molecule_metric') {
    const metric = raw.moleculeMetric ?? raw.molecule_metric;
    return { layer: null, moleculeMetric: typeof metric === 'string' && metric ? metric : DEFAULT_MOLECULE_METRIC };
  }
  if (source === 'feature_hub') {
    const state = raw.hubState ?? raw.hub_state;
    return { layer: null, hubHits: normalizeHubHits(raw.hubHits ?? raw.hub_hits), hubState: state === '0' ? '0' : '1' };
  }
  return {};
}

/** Terms that read no layer: no `layer` and no size rule go with their request. */
export function isLayerFreeRuleTerm(term: ClusterFeatureRuleTerm | undefined): boolean {
  return term?.source === 'molecule_metric' || term?.source === 'feature_hub' || term?.source === 'transcription_state';
}

export type FeatureHubRequest = FeatureHubPayload;

export function featureHubRequest(term: ClusterFeatureRuleTerm | undefined): FeatureHubRequest | undefined {
  if (term?.source !== 'feature_hub') return undefined;
  return {
    hits: (term.hubHits ?? []).map(h => ({ set_id: h.setId, hit_id: h.hitId, chrom: h.chrom, start: h.start, end: h.end })),
    state: term.hubState === '0' ? '0' : '1',
  };
}

/** Why a rule cannot run as it is (null: it can). */
export function analysisRuleTermProblem(term: ClusterFeatureRuleTerm | undefined): string | null {
  if (term?.source === 'feature_hub' && !(term.hubHits?.length)) return 'has no hub hits: select hits in the feature hub and use them in Rules';
  return null;
}

/** The new request fields of a filter rule (molecule metric, between, hub hits); layer and size rule are the caller's. */
export function filterRuleRequestFields(rule: Pick<AnalysisFilterRule, 'terms' | 'metric' | 'operator' | 'threshold' | 'thresholdMax'>): {
  metric: AnalysisSortMetric;
  operator: AnalysisFilterOperator;
  threshold: number;
  thresholdMax?: number;
  moleculeMetric?: string;
  featureHub?: FeatureHubRequest;
  layerFree: boolean;
} {
  const term = rule.terms[0];
  const between = rule.operator === 'between';
  const [lo, hi] = filterRuleBounds(rule);
  return {
    metric: ruleMetric(rule),
    operator: rule.operator,
    threshold: between ? lo : (Number.isFinite(rule.threshold) ? rule.threshold : 1),
    ...(between ? { thresholdMax: hi } : {}),
    ...(term?.source === 'molecule_metric' ? { moleculeMetric: term.moleculeMetric || DEFAULT_MOLECULE_METRIC } : {}),
    ...(term?.source === 'feature_hub' ? { featureHub: featureHubRequest(term) } : {}),
    layerFree: isLayerFreeRuleTerm(term),
  };
}

/** The sort_by and new fields of a sort rule's layer-free term (null for the other sources). */
export function sortRuleRequestFields(rule: Pick<AnalysisSortRule, 'terms'>):
  { sortBy: 'value'; moleculeMetric: string } | { sortBy: 'feature_hub'; featureHub: FeatureHubRequest } | null {
  const term = rule.terms[0];
  if (term?.source === 'molecule_metric') return { sortBy: 'value', moleculeMetric: term.moleculeMetric || DEFAULT_MOLECULE_METRIC };
  if (term?.source === 'feature_hub') return { sortBy: 'feature_hub', featureHub: featureHubRequest(term)! };
  return null;
}

/**
 * A filter result kept within the panel's current filter (rule combine 'and'). Identity-aware, as cluster targets
 * are: a lifted row's id matches a kept QNAME or record key. No current filter: the result as it is.
 */
export function intersectWithCurrentFilter(resultIds: Iterable<string>, current: ReadonlySet<string> | null | undefined): Set<string> {
  const ids = Array.from(resultIds);
  if (!current) return new Set(ids);
  return new Set(ids.filter(id => idSetHas(current, [id, qnameOfId(id)], recordKey(id))));
}

/** The filter chip's label: "Rules > A", or "Rules > A AND B" when B was applied within A. */
export function analysisFilterLabel(ruleName: string, previous?: { label?: string } | null): string {
  if (!previous) return `Rules > ${ruleName}`;
  return `${previous.label?.trim() || 'Current filter'} AND ${ruleName}`;
}

export function resolveClusterFeatureRuleName(
  rule: Pick<ClusterFeatureRule, 'name' | 'autoName' | 'terms' | 'scope'>,
  layerLabels?: Record<string, string>,
): string {
  const name = rule.name?.trim();
  if (name) return name;
  const autoName = rule.autoName?.trim();
  return autoName || buildClusterFeatureRuleAutoName(rule, layerLabels);
}

export function clusterRuleUsesSelectedPeaks(rule?: Pick<ClusterFeatureRule, 'scope'> | null): boolean {
  return normalizeAnalysisRuleScope(rule?.scope).kind === 'selectedPeaks';
}

export function resolveClusterRuleRegions(
  rule: Pick<ClusterFeatureRule, 'scope'> | null | undefined,
  context: ResolveClusterScopeContext,
): ClusterRegionWithMode[] {
  const scope = normalizeAnalysisRuleScope(rule?.scope);
  if (scope.kind === 'allPeaks') {
    return context.allPeaks
      .filter(peak => peakInContext(peak, context.chrom))
      .filter(peak => peakPassesLevelScope(peak, scope))
      .map(peak => peakToRegion(peak, context.mode));
  }
  if (scope.kind === 'currentWindow') {
    return context.viewportEnd > context.viewportStart
      ? [{ start: context.viewportStart, end: context.viewportEnd, mode: context.mode }]
      : [];
  }
  if (scope.kind === 'gene') {
    return resolveGeneRegions(scope, context).map(region => ({ ...region, mode: context.mode }));
  }
  if (scope.kind === 'customRegion' && scope.region) {
    // Alias-aware (chr1 / 1), like the gene and peak scopes; a region with no
    // chromosome matches nothing.
    if (!scope.region.chrom || !chromNamesMatch(scope.region.chrom, context.chrom)) return [];
    const region = clipAbsoluteRegionToViewport(scope.region.start, scope.region.end, context);
    return region ? [{ ...region, mode: context.mode }] : [];
  }

  const selected = new Set(context.selectedPeaks);
  return context.allPeaks
    .filter(peak => peakInContext(peak, context.chrom))
    .filter(peak => selected.has(peak.index))
    .filter(peak => peakPassesLevelScope(peak, scope))
    .map(peak => peakToRegion(peak, context.peakModes[peak.index] || context.mode));
}

function peakPassesLevelScope(peak: FirePeak, scope: AnalysisRuleScope): boolean {
  if (scope.peakLevelMin == null && scope.peakLevelMax == null) return true;
  if (typeof peak.layer !== 'number') return false;
  if (scope.peakLevelMin != null && peak.layer < scope.peakLevelMin) return false;
  if (scope.peakLevelMax != null && peak.layer > scope.peakLevelMax) return false;
  return true;
}

function peakToRegion(peak: FirePeak, mode: PeakMode): ClusterRegionWithMode {
  return { start: peak.start, end: peak.end, mode };
}

function peakInContext(peak: FirePeak, chrom: string): boolean {
  return !peak.chrom || chromNamesMatch(peak.chrom, chrom);
}

function resolveGeneRegions(scope: AnalysisRuleScope, context: ResolveClusterScopeContext): Array<{ start: number; end: number }> {
  const gene = resolveSelectedGene(scope, context.selectedGenes);
  if (!gene || !chromNamesMatch(gene.chrom, context.chrom)) return [];

  const part = scope.genePart ?? 'full';
  const absoluteSegments = genePartSegments(gene, part);
  return absoluteSegments
    .map(segment => clipAbsoluteRegionToViewport(segment.start, segment.end, context))
    .filter((segment): segment is { start: number; end: number } => !!segment);
}

function resolveSelectedGene(scope: AnalysisRuleScope, selectedGenes: Gene[]): Gene | null {
  if (selectedGenes.length === 0) return null;
  if (scope.geneId) {
    const byId = selectedGenes.find(candidate => candidate.id === scope.geneId);
    if (byId) return byId;
  }
  if (scope.geneName) {
    const name = scope.geneName.toLowerCase();
    const byName = selectedGenes.find(candidate => (candidate.name || '').toLowerCase() === name);
    if (byName) return byName;
  }
  // A rule naming a gene that isn't selected any more matches nothing; only a
  // rule naming none means "the first selected gene".
  if (scope.geneId || scope.geneName) return null;
  return selectedGenes[0];
}

function normalizeChromName(chrom: string | null | undefined): string {
  const raw = String(chrom || '').trim().toLowerCase();
  return raw.startsWith('chr') ? raw.slice(3) : raw;
}

function chromNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  return normalizeChromName(a) === normalizeChromName(b);
}

function genePartSegments(gene: Gene, part: AnalysisRuleGenePart): Array<{ start: number; end: number }> {
  if (part === 'tss') {
    const tss = geneTss(gene);
    return [{ start: Math.max(0, tss - 250), end: tss + 250 }];
  }
  if (part === 'exon' && gene.exons.length > 0) {
    return gene.exons.map(exon => ({ start: exon.start, end: exon.end }));
  }
  if (part === 'intron') {
    // Fewer than two exons: no introns (not the whole gene).
    const exons = [...gene.exons].sort((a, b) => a.start - b.start);
    const introns: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < exons.length - 1; i += 1) {
      const start = exons[i].end;
      const end = exons[i + 1].start;
      if (end > start) introns.push({ start, end });
    }
    return introns;
  }
  return [{ start: gene.start, end: gene.end }];
}

function clipAbsoluteRegionToViewport(
  absoluteStart: number,
  absoluteEnd: number,
  context: Pick<ResolveClusterScopeContext, 'viewportStart' | 'viewportEnd'>,
): { start: number; end: number } | null {
  const start = Math.max(context.viewportStart, Math.round(absoluteStart));
  const end = Math.min(context.viewportEnd, Math.round(absoluteEnd));
  if (end <= start) return null;
  return { start, end };
}
