/**
 * Where = Random reads (whole file): N reads per dataset from the whole BAM, by the stable sampling rule, through
 * POST /api/plots/random_reads in chunks (scan the contigs' segments for candidates, keep each contig's share of the
 * smallest keys, then load those reads), with progress and Cancel. The same seed gives the same reads whatever the
 * chunk sizes (each contig's selection is over all its candidates).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api/sharedFetch';
import type { FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import type { BedProgress } from './bedData';
import type { PlotSpec } from './plotModel';
import type { ProfileRead } from './profileEngine';
import type { ProfileEntry } from './useProfileData';
import { histogramAccumulate } from './sizeHistogram';

export const RANDOM_SCAN_CHUNK = 4;
export const RANDOM_READS_PER_GROUP = 200;
export const RANDOM_GROUPS_PER_REQUEST = 5;

type ScanJob = { dataset: string; contig: string; share: number; mapped: number; candidates: Array<[string, string, number]> };

/** Each contig's share of candidates with the smallest keys (ties by name): the sample. */
export function selectRandom(jobs: ScanJob[]): Array<{ dataset: string; contig: string; names: string[]; starts: number[] }> {
  const by = new Map<string, { dataset: string; contig: string; share: number; c: Array<[string, bigint, number]> }>();
  for (const j of jobs) {
    const k = `${j.dataset}\u0000${j.contig}`;
    if (!by.has(k)) by.set(k, { dataset: j.dataset, contig: j.contig, share: j.share, c: [] });
    for (const [name, key, start] of j.candidates) by.get(k)!.c.push([name, BigInt(key), start]);
  }
  const out: Array<{ dataset: string; contig: string; names: string[]; starts: number[] }> = [];
  for (const e of [...by.values()].sort((a, b) => (a.dataset + a.contig < b.dataset + b.contig ? -1 : 1))) {
    const chosen = e.c.sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : x[0] < y[0] ? -1 : 1)).slice(0, e.share).sort((x, y) => x[2] - y[2]);
    for (let i = 0; i < chosen.length; i += RANDOM_READS_PER_GROUP) {
      const part = chosen.slice(i, i + RANDOM_READS_PER_GROUP);
      out.push({ dataset: e.dataset, contig: e.contig, names: part.map(c => c[0]), starts: part.map(c => c[2]) });
    }
  }
  return out;
}

const pairs = (flat: number[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

export function randomRequestKey(plot: PlotSpec, target: FootprintSizesTarget, settingsKey: string): string {
  return JSON.stringify({ kind: 'fiberbrowser.random.v1', datasets: [...new Set(target.panels.map(p => p.datasetId))], n: plot.sampling.n, seed: plot.sampling.seed,
    source: plot.source, group: plot.groupBy, hist: plot.type === 'size-histogram' ? plot.hist : null, settingsKey });
}

export function useRandomReadsData(o: { plot: PlotSpec; target: FootprintSizesTarget; settingsKey: string; enabled: boolean; seed?: ProfileEntry | null }) {
  const { plot, target, settingsKey, enabled, seed = null } = o;
  const requestKey = useMemo(() => randomRequestKey(plot, target, settingsKey), [plot, target, settingsKey]);
  const [entry, setEntry] = useState<ProfileEntry | null>(seed);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [progress, setProgress] = useState<BedProgress | null>(null);
  const [cancelledKey, setCancelledKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ctl = useRef<AbortController | null>(null);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  useEffect(() => { if (seed) setEntry(seed); }, [seed]);
  const cancel = useCallback(() => { ctl.current?.abort(); ctl.current = null; setCancelledKey(requestKey); setLoading(false); }, [requestKey]);
  const retry = useCallback(() => { setCancelledKey(null); setAttempt(a => a + 1); }, []);

  useEffect(() => {
    if (!enabled || cancelledKey === requestKey) return;
    if (entryRef.current?.key === requestKey || (seed && seed.key === requestKey)) { setLoading(false); return; }
    const datasets = [...new Set(target.panels.map(p => p.datasetId))];
    if (!datasets.length) return;
    const controller = new AbortController();
    ctl.current = controller;
    const key = requestKey;
    const startedAt = Date.now();
    setLoading(true);
    setError(null);
    setProgress({ done: 0, total: null, startedAt });
    const post = <T,>(body: object) => fetchJson<T>('/api/plots/random_reads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(body) });
    const base = { dataset_ids: datasets, n: plot.sampling.n, seed: plot.sampling.seed };
    (async () => {
      // Phase 1: candidates per contig segment.
      const jobs: ScanJob[] = [];
      let total: number | null = null;
      for (let off = 0; total == null || off < total; off += RANDOM_SCAN_CHUNK) {
        const r = await post<{ success: boolean; jobs_total: number; jobs: ScanJob[] }>({ ...base, phase: 'scan', job_offset: off, job_limit: RANDOM_SCAN_CHUNK });
        if (!r.success || controller.signal.aborted) return null;
        total = r.jobs_total;
        jobs.push(...r.jobs);
        setProgress({ done: Math.min(total, off + RANDOM_SCAN_CHUNK), total: total * 2, startedAt });
        if (!r.jobs.length) break;
      }
      // Phase 2: the chosen reads.
      const groups = selectRandom(jobs);
      const rows: Array<{ dataset: string; reads: Array<[number, number, number[], number[], number[], string]> }> = [];
      for (let i = 0; i < groups.length; i += RANDOM_GROUPS_PER_REQUEST) {
        const r = await post<{ success: boolean; groups: typeof rows }>({ ...base, phase: 'reads', source: plot.source, groups: groups.slice(i, i + RANDOM_GROUPS_PER_REQUEST) });
        if (!r.success || controller.signal.aborted) return null;
        rows.push(...r.groups);
        const t = total ?? 0;
        setProgress({ done: t + Math.round(((i + RANDOM_GROUPS_PER_REQUEST) / Math.max(1, groups.length)) * t), total: t * 2, startedAt });
      }
      return rows;
    })()
      .then(rows => {
        if (!rows || controller.signal.aborted) return;
        const pooled = plot.groupBy === 'none';
        const groups = pooled ? [{ id: 'all|all', title: 'All datasets', color: '#52514e' }]
          : datasets.map(ds => { const p = target.panels.find(x => x.datasetId === ds)!; return { id: `${p.key}|all`, title: p.datasetLabel ?? p.label, color: p.color }; });
        const reads: ProfileRead[] = [];
        const used: Record<string, { used: number; total: number }> = {};
        for (const g of rows) {
          const gid = pooled ? 'all|all' : `${target.panels.find(x => x.datasetId === g.dataset)!.key}|all`;
          used[g.dataset] = { used: (used[g.dataset]?.used ?? 0) + g.reads.length, total: plot.sampling.n };
          for (const [start, end, src, , , name] of g.reads) reads.push({ group: gid, id: name, start, end, intervals: pairs(src) });
        }
        // No anchor: every footprint of every read counts (its whole length).
        const raws = histogramAccumulate(reads, { start: -Infinity, end: Infinity }, plot.hist, groups.map(g => g.id));
        setEntry({ key, binBp: plot.hist.binBp, locus: { chrom: 'whole file', start: 0, end: 1, genome: null }, sampled: used,
          groups: groups.map((g, i) => ({ ...g, raw: raws[i] })).filter(g => g.raw.nReads > 0) });
      })
      .catch(err => { if (!controller.signal.aborted && err?.name !== 'AbortError') setError({ key, message: `Random reads could not be read: ${err instanceof Error ? err.message : String(err)}` }); })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); setProgress(null); } if (ctl.current === controller) ctl.current = null; });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled, seed, attempt, cancelledKey]);

  return { entry, requestKey, loading, error: error && error.key === requestKey ? error.message : null, progress, cancelled: cancelledKey === requestKey, cancel, retry };
}
