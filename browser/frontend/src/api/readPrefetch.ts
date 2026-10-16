import { waitForViewIdle } from '../utils/viewIdle';
import { canProjectReadRegion, hasReadRegionSpan, readRegionGeneration, rememberReadRegion, releaseReadRegions } from './loadedReadRegion';
import { clearReadBinaryExpansions, readBinaryBytes } from './readBinary';
import { READ_STREAM_TYPE } from './readStream';
import { fetchJsonSharedGet, withSortedParams } from './sharedFetch';
import type { ReadsResponse } from '../components/tracks/read-track/types';

interface Span { start: number; end: number }
interface Plan {
  dataset: string;
  scope: string;
  params: URLSearchParams;
  generation: number;
  controller: AbortController;
  anchor: Span;
  latest: Span;
  projectable: boolean;
  queued: boolean;
  running: boolean;
  failures: number;
  sampleLevel: number;
}
const plans = new Map<string, Plan>();
const warmed = new Map<string, Array<Span & { scope: string; sampleLevel: number }>>();
let marginFraction = 0.5;
let serverMultiplier = 10;
let queue = Promise.resolve();

function scopeOf(params: URLSearchParams): string {
  const key = new URLSearchParams(params);
  for (const name of ['start', 'end']) key.delete(name);
  key.sort();
  return `${readRegionGeneration()}:${key}`;
}

function spanOf(params: URLSearchParams): Span {
  return { start: Number(params.get('start')), end: Number(params.get('end')) };
}

export function setReadPrefetchMargin(fraction: number, multiplier = 10): void {
  marginFraction = Math.max(0, fraction);
  serverMultiplier = Math.max(1, multiplier);
  for (const plan of plans.values()) plan.controller.abort();
  plans.clear();
  warmed.clear();
}

/** Closing a panel or changing its data releases unfinished work. A pan does not. */
export function cancelReadPrefetch(datasetId: string): void {
  plans.get(datasetId)?.controller.abort();
  plans.delete(datasetId);
  if (marginFraction === 0) {
    warmed.delete(datasetId);
    releaseReadRegions(datasetId);
    clearReadBinaryExpansions();
  }
}

/** Keep a neighborhood's progress through local pans; discard obsolete jobs on jumps. */
export function prepareReadNavigation(params: URLSearchParams): void {
  const dataset = params.get('dataset_id') || '';
  const plan = plans.get(dataset);
  if (!plan) return;
  const next = spanOf(params), width = plan.anchor.end - plan.anchor.start;
  const distance = Math.max(next.start - plan.latest.end, plan.latest.start - next.end, 0);
  if (plan.scope !== scopeOf(params) || distance > width * serverMultiplier
    || next.end - next.start > width * 4 || next.end - next.start < width / 4) {
    cancelReadPrefetch(dataset);
  } else {
    plan.latest = next;
  }
}

function nextSpan(plan: Plan): Span | undefined {
  const { latest, anchor } = plan;
  const width = anchor.end - anchor.start;
  if (plan.projectable) {
    const margin = Math.ceil((latest.end - latest.start) * marginFraction);
    const span = { start: Math.max(0, latest.start - margin), end: latest.end + margin };
    return hasReadRegionSpan(plan.params, span.start, span.end) ? undefined : span;
  }
  // Overlapping tiles let each finished portion become useful immediately.
  // Five views cover a local target first; subsequent tiles grow outward.
  // The grid stays anchored across pans, so nearby movement never restarts it.
  const tileWidth = width * Math.min(5, serverMultiplier);
  const step = Math.max(width, tileWidth - 2 * width);
  const origin = anchor.start - Math.floor((tileWidth - width) / 2);
  const margin = Math.ceil((latest.end - latest.start) * (serverMultiplier - 1) / 2);
  const first = Math.floor((Math.max(0, latest.start - margin) - origin) / step);
  const last = Math.max(first, Math.ceil((latest.end + margin - origin - tileWidth) / step));
  const completed = warmed.get(plan.dataset) ?? [];
  const candidates: Span[] = [];
  for (let index = first; index <= last; index++) {
    const start = Math.max(0, origin + index * step);
    const end = origin + index * step + tileWidth;
    if (end <= start || completed.some(s => s.scope === plan.scope && s.sampleLevel === plan.sampleLevel && s.start <= start && s.end >= end)) continue;
    candidates.push({ start, end });
  }
  const center = (latest.start + latest.end) / 2;
  candidates.sort((a, b) => Math.abs((a.start + a.end) / 2 - center) - Math.abs((b.start + b.end) / 2 - center));
  return candidates[0];
}

function valid(plan: Plan): boolean {
  return !plan.controller.signal.aborted && plan.generation === readRegionGeneration() && plans.get(plan.dataset) === plan;
}

function schedule(plan: Plan): void {
  if (!valid(plan) || plan.queued || plan.running || plan.failures >= 3 || !nextSpan(plan)) return;
  plan.queued = true;
  const run = async () => {
    plan.queued = false;
    if (!valid(plan)) return;
    plan.running = true;
    let span: Span | undefined;
    let complete = false;
    try {
      await waitForViewIdle(plan.controller.signal, true);
      if (!valid(plan) || !(span = nextSpan(plan))) return;
      const request = new URLSearchParams(plan.params);
      request.set('start', String(span.start));
      request.set('end', String(span.end));
      request.set('max_reads', plan.projectable ? '0' : '1');
      if (!plan.projectable) {
        request.set('full_working_set', plan.sampleLevel > 0 ? 'false' : 'true');
        request.set('include_metaprofile', 'false');
        request.set('include_sv_summary', 'false');
      }
      request.set('viewport_start', String(plan.latest.start));
      request.set('viewport_end', String(plan.latest.end));
      request.set('prefetch', 'true');
      request.set('prefetch_sample_level', String(plan.sampleLevel));
      performance.mark?.('read-prefetch-start', { detail: { datasetId: plan.dataset, ...span } });
      const data = await fetchJsonSharedGet<ReadsResponse>(withSortedParams('/api/reads/compact', request), {
        signal: plan.controller.signal, headers: { Accept: READ_STREAM_TYPE }, priority: 'low',
      } as RequestInit);
      if (!valid(plan) || data.warning || (data as ReadsResponse & { success?: boolean }).success === false) return;
      if (plan.projectable) {
        const bytes = readBinaryBytes.get(data);
        if (bytes === undefined) return;
        const params = new URLSearchParams(plan.params);
        params.set('start', String(span.start));
        params.set('end', String(span.end));
        rememberReadRegion(params, data, bytes, plan.generation, true);
        if (!hasReadRegionSpan(plan.params, span.start, span.end)) return;
      } else {
        const previous = warmed.get(plan.dataset) ?? [];
        warmed.set(plan.dataset, [...previous, { ...span, scope: plan.scope, sampleLevel: plan.sampleLevel }].slice(-64));
      }
      complete = true;
      plan.failures = 0;
    } catch (error) {
      if (valid(plan) && error instanceof Error && error.message === 'Incomplete read stream') plan.failures++;
      else plan.failures = 3;
    } finally {
      plan.running = false;
      if (span) performance.mark?.('read-prefetch-end', { detail: { datasetId: plan.dataset, ...span, complete } });
      // One tile per turn gives the other datasets their nearby coverage too.
      if (complete || (plan.failures > 0 && plan.failures < 3)) schedule(plan);
    }
  };
  queue = queue.then(run);
}

export function prefetchReadRegion(params: URLSearchParams, generation: number, data: ReadsResponse): void {
  if (marginFraction === 0 || generation !== readRegionGeneration()) return;
  const span = spanOf(params);
  if (span.end <= span.start || span.end - span.start > 100000 || !data?.reads?.length
    || ['filter_ids', 'filter_set', 'cluster_focus', 'strand', 'fill_gap_size'].some(key => params.has(key))) return;
  prepareReadNavigation(params);
  const dataset = params.get('dataset_id') || '';
  let plan = plans.get(dataset);
  const sampleLevel = data.working_sampling?.level ?? 0;
  if (plan && plan.sampleLevel !== sampleLevel) {
    cancelReadPrefetch(dataset);
    warmed.delete(dataset);
    plan = undefined;
  }
  if (!plan) {
    plan = { dataset, scope: scopeOf(params), params: new URLSearchParams(params), generation,
      controller: new AbortController(), anchor: span, latest: span,
      projectable: canProjectReadRegion(params) && hasReadRegionSpan(params, span.start, span.end),
      queued: false, running: false, failures: 0, sampleLevel };
    plans.set(dataset, plan);
  }
  const current = plan;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(() => schedule(current)));
  else schedule(current);
}
