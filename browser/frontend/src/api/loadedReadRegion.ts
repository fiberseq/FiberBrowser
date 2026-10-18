import { cachedReadExpansion, clearReadBinaryExpansions, readAlignmentBounds, readBinaryBytes, readRegionProjectionSafe, readTerminalGaps } from './readBinary';
import { readRegionProfiles } from './readRegionProfiles';
import type { CompactRead, ReadsResponse } from '../components/tracks/read-track/types';

interface Entry {
  key: string;
  start: number;
  end: number;
  bytes: number;
  data: ReadsResponse;
  prefetched: boolean;
  exact?: boolean;
}
const entries = new Map<string, Entry>();
let MAX_BYTES = 3 * 1024 * 1024 * 1024;
let retainedBytes = 0;
let generation = 0;
export function setReadRegionBudget(bytes: number): void {
  MAX_BYTES = Math.max(0, bytes);
  clearLoadedReadRegions();
}
export function readRegionDiagnostics() { return { budget: MAX_BYTES, retained: retainedBytes, entries: entries.size }; }

/** Release a closed dataset's spans without dropping other panels' cohorts. */
export function releaseReadRegions(datasetId: string): void {
  for (const [id, entry] of entries) {
    const params = new URLSearchParams(entry.key);
    if (params.get('dataset_id') !== datasetId && !(params.get('dataset_ids') || '').split(',').includes(datasetId)) continue;
    retainedBytes -= entry.bytes;
    entries.delete(id);
  }
}
const positionFields = ['methyl', 'methyl_m6a', 'methyl_m5c', 'possible_deam_ct', 'possible_deam_ga'] as const;

/** Mutations and explicit refreshes must not revive an older cohort. */
export function clearLoadedReadRegions(): void {
  generation++;
  entries.clear();
  retainedBytes = 0;
  clearReadBinaryExpansions();
}
export function readRegionGeneration(): number { return generation; }

/** Whether a complete, projectable cohort already covers a speculative span. */
export function hasReadRegionSpan(params: URLSearchParams, start: number, end: number, prefetchedOnly = false): boolean {
  const key = keyFor(params);
  return [...entries.values()].some(entry => !entry.exact && entry.key === key && entry.start <= start && entry.end >= end
    && (!prefetchedOnly || entry.prefetched)
    && readRegionProjectionSafe.has(entry.data));
}

function keyFor(params: URLSearchParams): string {
  const key = new URLSearchParams(params);
  key.delete('start');
  key.delete('end');
  key.sort();
  return key.toString();
}

export function canProjectReadRegion(params: URLSearchParams): boolean {
  return params.get('full_working_set') === 'true'
    && params.get('spanning') === 'false'
    && params.get('hide_terminal_gaps') === 'false'
    && Number(params.get('terminal_gap_threshold') || 0) === 0
    && params.get('include_cigar') !== 'true'
    && (params.get('include_metaprofile') !== 'true' || params.get('profile_max_reads') === '0')
    && !['filter_ids', 'filter_set', 'cluster_focus', 'strand', 'lift_hap', 'fill_gap_size'].some(key => params.has(key))
    && Number(params.get('min_footprints') || 0) === 0
    && Number(params.get('min_fp_quality') || 0) === 0;
}

function makeRoom(bytes: number): void {
  while (entries.size && retainedBytes + bytes > MAX_BYTES) {
    const [id, oldest] = entries.entries().next().value!;
    retainedBytes -= oldest.bytes;
    entries.delete(id);
  }
}

/** Samples and filtered views are reusable at identical coordinates only. */
export function rememberExactReadResponse(url: string, data: unknown, startedGeneration: number): void {
  if (startedGeneration !== generation || !data || typeof data !== 'object') return;
  const payload = data as ReadsResponse & { success?: boolean; error?: string; datasets?: Record<string, ReadsResponse> };
  const parts = payload.datasets ? Object.values(payload.datasets) : [payload];
  if (!parts.length || [payload, ...parts].some(p => p.warning || (p as typeof payload).success === false || (p as typeof payload).error)
    || parts.some(p => !Array.isArray(p.reads))) return;
  const rows = parts.reduce((n, p) => n + p.reads.length, 0);
  const binary = readBinaryBytes.get(data);
  // JSON samples already have expanded evidence. Budget their strings and
  // containers conservatively; never force lazy binary marks to expand.
  const bytes = binary === undefined ? JSON.stringify(data).length * 4 + rows * 1024 + 4096 : binary + rows * 8192 + 4096;
  if (bytes > MAX_BYTES) return;
  const id = `exact:${url}`, old = entries.get(id);
  if (old) { retainedBytes -= old.bytes; entries.delete(id); }
  makeRoom(bytes);
  entries.set(id, { key: url.slice(url.indexOf('?') + 1), start: 0, end: 0, bytes,
    data: payload, prefetched: false, exact: true });
  retainedBytes += bytes;
}

export function lookupExactReadResponse<T>(url: string): T | undefined {
  const id = `exact:${url}`, entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  entries.set(id, entry);
  return { ...entry.data, server_elapsed_ms: 0, server_timings: { client_exact_hit: 1 } } as T;
}

function lazy(record: object, key: string, get: () => unknown): void {
  if (key === 'deam' || positionFields.includes(key as typeof positionFields[number])) {
    const token = {};
    Object.defineProperty(record, key, { enumerable: true, configurable: true,
      get: () => cachedReadExpansion(token, get, key === 'deam' ? 80 : 8) });
    return;
  }
  let resolved = false, value: unknown;
  Object.defineProperty(record, key, { enumerable: true, configurable: true, get() {
    if (!resolved) { value = get(); resolved = true; }
    return value;
  } });
}

/** Project geometry only; dense marks remain unexpanded until a consumer needs them. */
export function projectLoadedReads(data: ReadsResponse, offset: number, width: number, regionStart: number): ReadsResponse | undefined {
  if (offset < 0 || width <= 0 || offset + width > data.width) return;
  const reads: CompactRead[] = [];
  let spanning = 0;
  for (const read of data.reads) {
    if (read.cigar?.length || read.circular_ids?.length) return;
    const bounds = readAlignmentBounds.get(read);
    if (!bounds) return;
    const intervals = read.intervals;
    if (!intervals.length) return;
    const lo = intervals[0][0], hi = intervals[intervals.length - 1][1];
    if (hi <= offset || lo >= offset + width) continue;
    // A boundary gap may have been split by a deletion. Without its full
    // bounds, its size cannot identify a terminal gap reliably.
    const terminals = readTerminalGaps.get(read);
    if (!terminals && (intervals[0][2] < 0 || intervals[intervals.length - 1][2] < 0)) return;
    if (bounds[0] <= regionStart + offset && bounds[1] >= regionStart + offset + width) spanning++;
    const next = Object.defineProperties({}, Object.getOwnPropertyDescriptors(read)) as CompactRead;
    const shift = (values: [number, number, number][]) => values.map(([s, e, n]) => [s-offset, e-offset, n] as [number, number, number]);
    const visible = (values: [number, number, number][]) => values.flatMap(([s, e, n], index) => (
      e > offset && s < offset + width ? [{ index, interval: [Math.max(0, s-offset), Math.min(width, e-offset), n] as [number, number, number] }] : []
    ));
    const primary = visible(intervals);
    if (!primary.length) return;
    if (terminals) for (const item of primary) {
      const [s, e, n] = intervals[item.index];
      const gap = n < 0 && terminals.find(([lo, hi]) => lo <= regionStart + s && regionStart + e <= hi);
      if (gap) {
        // Deletion-split pieces keep their parent gap's visible length.
        item.interval[2] = -(Math.min(regionStart + offset + width, gap[1]) - Math.max(regionStart + offset, gap[0]));
      }
    }
    next.intervals = primary.map(item => item.interval);
    if (read.sv?.length) {
      const start = regionStart + offset, end = start + width;
      // Cluster membership near a clipped breakpoint can change. Such views
      // use a fresh server summary rather than cropping a possibly different cluster.
      if (read.sv.some(ev => (ev.t === 'D' || ev.t === 'I') && [ev.ref, ev.ref + (ev.t === 'D' ? ev.len : 1)]
        .some(p => Math.abs(p - start) <= Math.max(50, ev.len * 0.1) || Math.abs(p - end) <= Math.max(50, ev.len * 0.1)))) return;
      const kept = read.sv.filter(ev => ev.t !== 'SA' && ev.ref < end && ev.ref + (ev.t === 'D' ? ev.len : 1) > start);
      Object.defineProperty(next, 'sv', { configurable: true, enumerable: true, writable: true,
        value: kept.length ? [...kept, ...read.sv.filter(ev => ev.t === 'SA')] : undefined });
    }
    if (read.qualities) {
      let index = 0;
      const qualities = new Map(intervals.flatMap((iv, i) => iv[2] > 0 ? [[i, read.qualities![index++]] as const] : []));
      Object.defineProperty(next, 'qualities', { enumerable: true, configurable: true, writable: true,
        value: primary.filter(item => item.interval[2] > 0).map(item => qualities.get(item.index)!),
      });
      if (!next.qualities?.length) delete next.qualities;
    }
    for (const key of ['annotation_names', 'circular_ids'] as const) {
      if (read[key]?.length === intervals.length) Object.defineProperty(next, key, { enumerable: true, configurable: true, writable: true,
        value: primary.map(item => read[key]![item.index]),
      });
    }
    for (const key of positionFields) if (key in read) {
      lazy(next, key, () => read[key]?.filter(p => p >= offset && p < offset + width).map(p => p-offset));
    }
    if ('deam' in read) lazy(next, 'deam', () => read.deam?.filter(([p]) => p >= offset && p < offset + width).map(([p, k]) => [p-offset, k]));
    if ('fire' in read) lazy(next, 'fire', () => read.fire && visible(read.fire).map(item => item.interval));
    if ('layers' in read) lazy(next, 'layers', () => Object.fromEntries(Object.entries(read.layers || {}).flatMap(([name, layer]) => {
      const kept = visible(layer.intervals);
      if (!kept.length) return [];
      const selected = <T,>(values: T[]) => kept.map(item => values[item.index]);
      return [[name, {
        ...layer, intervals: kept.map(item => item.interval),
        ...(layer.qualities ? { qualities: layer.qualities.map(selected) } : {}),
        ...(layer.annotation_names ? { annotation_names: selected(layer.annotation_names) } : {}),
        ...(layer.refinement_kinds ? { refinement_kinds: selected(layer.refinement_kinds) } : {}),
        ...(layer.circular_ids ? { circular_ids: selected(layer.circular_ids) } : {}),
        ...(layer.source_intervals ? { source_intervals: shift(selected(layer.source_intervals)) } : {}),
        ...(layer.family_intervals ? { family_intervals: shift(selected(layer.family_intervals)) } : {}),
      }]];
    })));
    reads.push(next);
  }
  // SV support denominators describe the original cohort. Changing that
  // cohort needs server-side reclassification of carriers and reference reads.
  if (data.sv_summary && reads.length !== data.reads.length) return;
  const start = regionStart + offset, end = start + width;
  const summary = data.sv_summary && { ...data.sv_summary,
    clusters: data.sv_summary.clusters.filter(c => c.ref < end && (c.t === 'D' ? c.end : c.ref + 1) > start),
    clips: readRegionClips(reads) };
  return { ...data, reads, width, sv_summary: summary && (summary.clusters.length || summary.clips.length) ? summary : undefined,
    ...(data.signal_counts ? { signal_counts: { ...data.signal_counts,
      total: reads.length, kept: reads.length, unknown: reads.length } } : {}),
    count: reads.length, display_count: reads.length,
    total: reads.length, total_in_scope: reads.length, working_count: reads.length,
    total_overlapping: reads.length, total_spanning: spanning,
    has_methylation: reads.some(read => Boolean(read.methyl?.length)), server_elapsed_ms: 0,
    server_timings: { client_region_hit: 1 } };
}

function readRegionClips(reads: CompactRead[]): NonNullable<ReadsResponse['sv_summary']>['clips'] {
  const clips: { side: 'L' | 'R'; ref: number; id: string }[] = [];
  for (const read of reads) for (const ev of read.sv || []) {
    if (ev.t === 'S') clips.push({ side: ev.side, ref: ev.ref, id: read.id });
  }
  clips.sort((a, b) => a.side.localeCompare(b.side) || a.ref - b.ref);
  const result: NonNullable<ReadsResponse['sv_summary']>['clips'] = [];
  for (let i = 0; i < clips.length;) {
    let j = i + 1;
    const ids = new Set([clips[i].id]);
    while (j < clips.length && clips[j].side === clips[i].side && clips[j].ref - clips[j - 1].ref <= 20) ids.add(clips[j++].id);
    const mid = i + Math.floor((j - i) / 2);
    const median = (j - i) % 2 ? clips[mid].ref : (clips[mid - 1].ref + clips[mid].ref) / 2;
    const lo = Math.floor(median);
    const ref = median - lo === 0.5 ? lo + lo % 2 : Math.round(median);
    result.push({ side: clips[i].side, ref, n: ids.size });
    i = j;
  }
  return result;
}

/** Keep complete binary cohorts in an LRU bounded by retained transport and object bytes. */
export function rememberReadRegion(params: URLSearchParams, data: ReadsResponse, bytes: number, startedGeneration: number, prefetched = false): void {
  if (startedGeneration !== generation || params.get('full_working_set') !== 'true' || data.warning || data.working_sampling
    || data.reads.length !== data.total_overlapping || data.reads.length !== data.working_count) return;
  const start = Number(params.get('start')), end = Number(params.get('end'));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return;
  // Dense evidence expansion has its own global 128 MiB LRU. Reserve room
  // here for compact buffers, read wrappers and expanded interval metadata.
  const retained = bytes + data.reads.length * 8192 + 4096;
  if (retained > MAX_BYTES) return;
  const key = keyFor(params), id = `${key}:${start}:${end}`;
  for (const [oldId, entry] of entries) {
    if (entry.exact || entry.key !== key || start > entry.start || end < entry.end) continue;
    // A larger cohort keeps existing row order and appends newly seen reads.
    // Only its compact columns survive; contained responses are superseded.
    const identity = (read: CompactRead) => `${read.id}\0${readAlignmentBounds.get(read)?.join(':') || ''}`;
    const ranks = new Map<string, number[]>();
    entry.data.reads.forEach((read, i) => {
      const name = identity(read), values = ranks.get(name);
      if (values) values.push(i); else ranks.set(name, [i]);
    });
    const used = new Map<string, number>();
    data.reads = data.reads.map((read, i) => {
      const name = identity(read), occurrence = used.get(name) || 0;
      used.set(name, occurrence + 1);
      return { read, rank: ranks.get(name)?.[occurrence] ?? entry.data.reads.length + i };
    }).sort((a, b) => a.rank - b.rank).map(item => item.read);
    retainedBytes -= entry.bytes;
    entries.delete(oldId);
  }
  const old = entries.get(id);
  if (old) { retainedBytes -= old.bytes; entries.delete(id); }
  makeRoom(retained);
  entries.set(id, { key, start, end, bytes: retained, data, prefetched });
  retainedBytes += retained;
}

export function lookupReadRegion(params: URLSearchParams): ReadsResponse | undefined {
  if (params.get('full_working_set') !== 'true') return;
  const start = Number(params.get('start')), end = Number(params.get('end'));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return;
  const key = keyFor(params);
  for (const [id, entry] of entries) {
    if (entry.exact || entry.key !== key || start < entry.start || end > entry.end) continue;
    const exact = start === entry.start && end === entry.end;
    if (!exact && (!canProjectReadRegion(params) || !readRegionProjectionSafe.has(entry.data))) continue;
    const result = exact ? { ...entry.data, server_elapsed_ms: 0, server_timings: { client_region_hit: 1 } }
      : projectLoadedReads(entry.data, start-entry.start, end-start, entry.start);
    if (!result) continue;
    const limit = Number(params.get('max_reads') || 0);
    if (limit > 0 && result.reads.length > limit) continue;
    if (!exact && params.get('include_metaprofile') === 'true' && result.reads.length) {
      result.metaprofile = readRegionProfiles(result.reads, end - start, (params.get('metaprofile_layers') || '').split(','));
      result.metaprofile_read_count = result.reads.length;
    }
    if (!result.reads.length) {
      delete result.metaprofile;
      delete result.metaprofile_read_count;
      delete result.profile_max_reads;
    }
    entries.delete(id);
    entries.set(id, entry);
    return result;
  }
}
