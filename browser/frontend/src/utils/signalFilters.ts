/** Whole-alignment evidence supplied by the BAM producer. */
export interface SignalEvidence {
  status: 'background' | 'detectable' | 'unclassified' | 'unscored' | 'unknown';
  reason?: string | null;
  schema?: number;
  assay?: string | null;
  enzyme?: string | null;
  platform?: string | null;
  model_id?: string | null;
  method?: string | null;
  calibration_status?: string | null;
  quality_policy?: string | null;
  opportunity_definition?: string | null;
  p_signal: number | null;
  background_p: number | null;
  opportunities: number | null;
  structure: { status: 'supported' | 'not_detected' | 'unclassified' | 'unscored';
    reason?: string | null; method?: string | null; score: number | null; p_value: number | null };
}

export interface SignalFilters {
  hideBackground: boolean;
  excludeUnscored: boolean;
  requireDetectable: boolean;
  requireStructure: boolean;
}
export const DEFAULT_SIGNAL_FILTERS: SignalFilters = {
  hideBackground: false, excludeUnscored: false, requireDetectable: false, requireStructure: false,
};
/** Older sessions and malformed settings start with every signal gate off. */
export function normalizeSignalFilters(value: unknown): SignalFilters {
  const raw = value && typeof value === 'object' ? value as Partial<SignalFilters> : {};
  return { hideBackground: raw.hideBackground === true, excludeUnscored: raw.excludeUnscored === true,
    requireDetectable: raw.requireDetectable === true, requireStructure: raw.requireStructure === true };
}
export interface SignalCounts {
  total: number; kept: number; hidden: number;
  background: number; detectable: number; unclassified: number; unscored: number; unknown: number;
  structure_scored: number;
}
export const SIGNAL_LABELS: Record<SignalEvidence['status'], string> = {
  background: 'Background-compatible signal', detectable: 'Detectable assay signal',
  unclassified: 'Unclassified signal evidence', unscored: 'Signal not assessed for this alignment',
  unknown: 'Signal annotation unavailable',
};
export const SIGNAL_TOOLTIP = 'Uses whole-alignment signal evidence and an assay-specific untreated control. No detectable signal can reflect low labelling or protected chromatin; it does not prove enzyme failure.';

/** Preserve the enum's distinction between unclassified and unscored. */
export function keepsSignal(signal: SignalEvidence | undefined, filters: SignalFilters): boolean {
  const status = signal?.status ?? 'unknown';
  return !(filters.hideBackground && status === 'background')
    && !(filters.excludeUnscored && (status === 'unscored' || status === 'unknown'))
    && !(filters.requireDetectable && status !== 'detectable')
    && !(filters.requireStructure && signal?.structure.status !== 'supported');
}

let source = () => DEFAULT_SIGNAL_FILTERS;
/** Installed by the store without introducing a fetch/store import cycle. */
export function setSignalFilterSource(get: () => SignalFilters): void { source = get; }
export function signalFilterParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  if (!next.has('signal_filters') && Object.values(source()).some(Boolean)) next.set('signal_filters', JSON.stringify(source()));
  return next;
}
/** Capture the predicate in the URL so shared requests cannot cross settings. */
export function signalFilterUrl(url: string): string {
  if (!url.startsWith('/api/')) return url;
  const [, query = ''] = url.split('?');
  if (new URLSearchParams(query).has('signal_filters') || !Object.values(source()).some(Boolean)) return url;
  return `${url}${query ? '&' : '?'}signal_filters=${encodeURIComponent(JSON.stringify(source()))}`;
}

/** Exact signal counts in this locus, before call filters and display sampling. */
export function signalCountText(counts: SignalCounts): string {
  const n = (value: number) => value.toLocaleString();
  return `${n(counts.kept)} of ${n(counts.total)} kept · ${n(counts.hidden)} hidden · ${n(counts.unclassified)} unclassified · ${n(counts.unscored)} unscored · ${n(counts.unknown)} unavailable`;
}
