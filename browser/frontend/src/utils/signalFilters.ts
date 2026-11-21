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
  duplicate_hidden?: number; qcfail_hidden?: number; chimera_hidden?: number;
  /** Reads without footprint calls in view, and how many Min footprints hid as uncalled. */
  uncalled?: number; uncalled_hidden?: number;
  /** Min footprints' threshold, and the reads in view it hid for fewer footprint calls. */
  min_footprints?: number; min_footprints_hidden?: number; few_footprints?: number;
  /** Alignment extents [start, end) of the uncalled reads hidden (views loaded without a threshold). */
  uncalled_extents?: [number, number][];
}
export const SIGNAL_LABELS: Record<SignalEvidence['status'], string> = {
  background: 'Background-compatible signal', detectable: 'Detectable assay signal',
  unclassified: 'Unclassified signal evidence', unscored: 'Signal not assessed for this alignment',
  unknown: 'Signal annotation unavailable',
};
export const SIGNAL_TOOLTIP = 'Uses whole-alignment signal evidence and an assay-specific untreated control. No detectable signal can reflect low labelling or protected chromatin; it does not prove enzyme failure.';

/** Whether any loaded dataset carries producer signal evidence: the server's layer probe (a sample of records
 *  and the header) saw bg/me/db record tags or the signal tagger's header comment (`signal_tags`). Without it
 *  the signal filters are not offered and do not apply (every read would be "annotation unavailable"). */
export function datasetsCarrySignal(datasets: ReadonlyArray<{ signal_tags?: boolean }>): boolean {
  return datasets.some(d => d.signal_tags === true);
}

/** The signal filters requests and the read track apply: the saved ones when a loaded dataset carries signal
 *  evidence, else none (a saved filter waits, inert, for a dataset that has the tags). */
export function effectiveSignalFilters(state: {
  signalFilters: SignalFilters; datasets: ReadonlyArray<{ signal_tags?: boolean }>;
}): SignalFilters {
  return datasetsCarrySignal(state.datasets) ? state.signalFilters : DEFAULT_SIGNAL_FILTERS;
}

/** Preserve the enum's distinction between unclassified and unscored. */
export function keepsSignal(signal: SignalEvidence | undefined, filters: SignalFilters): boolean {
  const status = signal?.status ?? 'unknown';
  return !(filters.hideBackground && status === 'background')
    && !(filters.excludeUnscored && (status === 'unscored' || status === 'unknown'))
    && !(filters.requireDetectable && status !== 'detectable')
    && !(filters.requireStructure && signal?.structure.status !== 'supported');
}

let source = () => DEFAULT_SIGNAL_FILTERS;
let hideUncalledSource = () => true;
/** Installed by the store without introducing a fetch/store import cycle. */
export function setSignalFilterSource(get: () => SignalFilters): void { source = get; }
/** Whether Min footprints hides reads without footprint calls (every choice but "All reads,
 *  including uncalled"), installed by the store. */
export function setHideUncalledSource(get: () => boolean): void { hideUncalledSource = get; }
export function signalFilterParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  if (!next.has('signal_filters') && Object.values(source()).some(Boolean)) next.set('signal_filters', JSON.stringify(source()));
  if (!next.has('hide_uncalled') && !hideUncalledSource()) next.set('hide_uncalled', 'false');
  return next;
}
/** Capture the predicate in the URL so shared requests cannot cross settings. Every
 *  analysis request also says when reads without footprint calls are shown
 *  (hide_uncalled=false; the server hides them by default), so it sees the
 *  reads the read track shows. */
export function signalFilterUrl(url: string): string {
  if (!url.startsWith('/api/')) return url;
  const [, query = ''] = url.split('?');
  const present = new URLSearchParams(query);
  const parts: string[] = [];
  if (!present.has('signal_filters') && Object.values(source()).some(Boolean)) {
    parts.push(`signal_filters=${encodeURIComponent(JSON.stringify(source()))}`);
  }
  if (!present.has('hide_uncalled') && !hideUncalledSource()) parts.push('hide_uncalled=false');
  if (!parts.length) return url;
  return `${url}${query ? '&' : '?'}${parts.join('&')}`;
}

/** Exact signal counts in this locus, before call filters and display sampling. */
export function readPolicyHiddenText(counts: SignalCounts): string {
  const n = (value: number) => value.toLocaleString();
  return [
    counts.duplicate_hidden ? `${n(counts.duplicate_hidden)} duplicate reads hidden` : '',
    counts.qcfail_hidden ? `${n(counts.qcfail_hidden)} QC-fail reads hidden` : '',
    counts.chimera_hidden ? `${n(counts.chimera_hidden)} chimeric reads hidden (FiberHMM QC fail)` : '',
    minFootprintsHiddenText(counts.uncalled_hidden ?? 0, counts.min_footprints_hidden ?? 0, counts.min_footprints ?? 0),
  ].filter(Boolean).join(' · ');
}

/** The reads Min footprints hid, by reason: "312 uncalled · 40 with < 5 footprints hidden". */
export function minFootprintsHiddenText(uncalled: number, fewer: number, threshold: number): string {
  const parts = [
    uncalled > 0 ? `${uncalled.toLocaleString()} uncalled` : '',
    fewer > 0 && threshold > 0 ? `${fewer.toLocaleString()} with < ${threshold} footprints` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} hidden` : '';
}

export function signalCountText(counts: SignalCounts): string {
  const n = (value: number) => value.toLocaleString();
  const hidden = readPolicyHiddenText(counts);
  return `${hidden ? hidden + ' · ' : ''}${n(counts.kept)} of ${n(counts.total)} kept · ${n(counts.hidden)} hidden · ${n(counts.unclassified)} unclassified · ${n(counts.unscored)} unscored · ${n(counts.unknown)} unavailable`;
}
