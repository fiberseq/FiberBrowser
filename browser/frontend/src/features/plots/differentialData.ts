/**
 * Differential features: which features are tested (the hub's sets in the plot's view, of one kind, or the hub
 * selection), the two sides A and B (datasets, clusters, read groups), the request to /api/plots/differential
 * (browser/services/differential_run.py: one test per feature, BH q), and the pure helpers the views and tests use
 * (up / down calls, sorting, volcano coordinates, TSV).
 *
 * Per read, a feature is '1' (open over a peak, a class member, carrying a geometry), '0', or not evaluated; the
 * fractions are of evaluated reads. Effects are A − B: delta = fraction A − fraction B, log2 OR of A over B.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api/sharedFetch';
import { stateRefBody } from '../../api/features';
import { useBrowserStore, type BrowserState } from '../../stores/browserStore';
import { getClusterLabel } from '../../components/tracks/ReadTrack';
import type { FootprintSizesClusters, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { hitSelectionEntry, hubProviders, onHubProvidersChanged, selectionRefs, type HubSelected } from '../hub/hubState';
import { mergeProviderSets } from '../hub/hubData';
import { GEO_TYPE_ID } from '../nucleosomes/geoHub';
import type { DiffFeatures, DiffSettings, PlotSpec } from './plotModel';
import type { ReadGroupDef } from './readGroups';

export interface DiffRow {
  key: string;
  label: string | null;
  kind: string | null;
  chrom: string | null;
  start: number | null;
  end: number | null;
  kA: number; nA: number; kB: number; nB: number;
  fracA: number | null; fracB: number | null;
  delta: number | null; deltaLo: number | null; deltaHi: number | null;
  log2or: number | null; log2orLo: number | null; log2orHi: number | null;
  p: number | null; q: number | null;
  strata: number | null;
  testable: boolean;
  reason: string | null;
}

export interface DiffSideInfo { label: string; datasets: string[] }

export interface DiffEntry {
  key: string;
  locus: { chrom: string; start: number; end: number; genome: string | null };
  rows: DiffRow[];
  groups: { A: DiffSideInfo; B: DiffSideInfo };
  /** fisher | chi2 | cmh */
  test: string;
  density: { edges: number[]; reads_without_density: number } | null;
  seeded?: boolean;
}

// ------------------------------------------------------------------ features
const TYPE_OF: Record<Exclude<DiffFeatures, 'hub-selection' | 'all'>, string> = { peaks: 'peaks.peak', classes: 'fp.class', geometries: GEO_TYPE_ID };

/** The features of a kind in a view (hub provider sets), with per-read states, by position, capped. */
export function diffCandidates(kind: DiffFeatures, view: { chrom: string; start: number; end: number }, max: number, s: BrowserState = useBrowserStore.getState()): HubSelected[] {
  let out: HubSelected[];
  if (kind === 'hub-selection') {
    out = (s.featureHub?.selected ?? []).filter(h => h.hasStates);
  } else {
    const sets = mergeProviderSets(hubProviders().flatMap(p => { try { return p.sets(s, view); } catch { return []; } }));
    const want = kind === 'all' ? null : TYPE_OF[kind];
    out = sets.filter(set => (!want || set.typeId === want) && set.source.kind === 'inline')
      .flatMap(set => (set.source.kind === 'inline' ? set.source.hits : []).map(hit => hitSelectionEntry(set, hit)))
      .filter(h => h.hasStates);
  }
  return [...out].sort((a, b) => a.chrom.localeCompare(b.chrom) || a.start - b.start || a.hitId.localeCompare(b.hitId)).slice(0, max);
}

export const featureKeyOf = (h: Pick<HubSelected, 'setId' | 'hitId'>): string => `${h.setId}|${h.hitId}`;

export function featureRequest(h: HubSelected) {
  return { key: featureKeyOf(h), label: h.label ?? h.hitId, kind: h.typeId, chrom: h.chrom, start: h.start, end: h.end,
    refs: selectionRefs([h]).map(stateRefBody) };
}

// ------------------------------------------------------------------ sides
export interface DiffSide { id: string; label: string; datasets: string[]; reads?: Record<string, string[]> }

export interface DiffSides {
  /** What A and B can be (ids: datasets, `<panel key>|<cluster>`, read group ids). */
  options: Array<{ id: string; label: string }>;
  A: DiffSide | null;
  B: DiffSide | null;
  /** Group by dataset: several datasets per side are allowed (replicates). */
  multi: boolean;
  blocker: string | null;
  /** Changes when the reads of a side change (cluster assignments, read groups). */
  signature: string;
}

/** The first two datasets (in panel order) that share no reads, by the reads shown for each (null: none known). A
 *  dataset and a subset of it (a demo and its half) share reads: a test between them is not a comparison. */
export function disjointPair(ids: string[], readIds: Record<string, readonly string[] | undefined>): [string, string] | null {
  const sets = new Map(ids.map(id => [id, new Set(readIds[id] ?? [])]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = sets.get(ids[i])!, b = sets.get(ids[j])!;
      if (!a.size || !b.size) continue;
      const [small, large] = a.size <= b.size ? [a, b] : [b, a];
      let shared = false;
      for (const r of small) if (large.has(r)) { shared = true; break; }
      if (!shared) return [ids[i], ids[j]];
    }
  }
  return null;
}

export function diffSides(plot: PlotSpec, target: FootprintSizesTarget, clusters: FootprintSizesClusters | null,
  readGroups: ReadGroupDef[] | null, assignments: Record<string, Record<string, number>>, groupsSig = '',
  readIds: Record<string, readonly string[] | undefined> = {}): DiffSides {
  const none = (blocker: string, options: DiffSides['options'] = [], multi = false): DiffSides => ({ options, A: null, B: null, multi, blocker, signature: '' });
  if (plot.groupBy === 'cluster') {
    // The followed target turns into the clustered one a moment after Group by cluster: until then it has no clusters.
    if (!clusters?.panels.length || !Array.isArray(clusters.visible)) return none('Compare by cluster needs a clustering of these reads.');
    const options: DiffSides['options'] = [];
    const sides: Record<string, DiffSide> = {};
    for (const p of clusters.panels) {
      const a = assignments[p.key] ?? {};
      for (const c of clusters.visible) {
        const id = `${p.key}|${c.cluster}`;
        const label = `${clusters.panels.length > 1 ? `${p.label} · ` : ''}${getClusterLabel(c.cluster, true)}`;
        const reads = Object.entries(a).filter(([, k]) => k === c.cluster).map(([r]) => r);
        options.push({ id, label });
        sides[id] = { id, label, datasets: [p.datasetId], reads: { [p.datasetId]: reads } };
      }
    }
    if (options.length < 2) return none('Compare needs two clusters: cluster the reads into two or more groups.', options);
    const [a, b] = pickTwo(plot.compareAB, options.map(o => o.id));
    return { options, A: sides[a], B: sides[b], multi: false, blocker: null, signature: clusters.assignmentSignature ?? '' };
  }
  if (plot.groupBy === 'read-groups' || plot.groupBy === 'classes') {
    if (!readGroups) return none('Group by read groups needs groups: a split into panels, or selected footprint classes.');
    const options = readGroups.map(g => ({ id: g.id, label: g.title }));
    if (options.length < 2) return none('Compare needs two groups.', options);
    const [a, b] = pickTwo(plot.compareAB, options.map(o => o.id));
    const side = (id: string): DiffSide => {
      const g = readGroups.find(x => x.id === id)!;
      return { id, label: g.title, datasets: Object.keys(g.members), reads: Object.fromEntries(Object.entries(g.members).map(([ds, set]) => [ds, [...set]])) };
    };
    return { options, A: side(a), B: side(b), multi: false, blocker: null, signature: groupsSig };
  }
  // By dataset (several per side: replicates).
  const seen = new Set<string>();
  const options = target.panels.filter(p => (seen.has(p.datasetId) ? false : (seen.add(p.datasetId), true)))
    .map(p => ({ id: p.datasetId, label: p.datasetLabel ?? p.label }));
  if (options.length < 2) return none('Compare needs two datasets: open a second dataset, or group by cluster or read groups.', options, true);
  const ids = new Set(options.map(o => o.id));
  let A = plot.diff.sideA.filter(id => ids.has(id));
  let B = plot.diff.sideB.filter(id => ids.has(id) && !A.includes(id));
  if (!A.length && !B.length) {
    // Default: the first two datasets that share no reads (e.g. two halves rather than a dataset and its half).
    const pair = disjointPair(options.map(o => o.id), readIds);
    if (pair) { A = [pair[0]]; B = [pair[1]]; }
  }
  if (!A.length) A = [options.find(o => !B.includes(o.id))!.id];
  if (!B.length) B = [options.find(o => !A.includes(o.id))?.id].filter((x): x is string => !!x);
  if (!B.length) return none('Put at least one dataset on each side.', options, true);
  const label = (list: string[]) => list.map(id => options.find(o => o.id === id)?.label ?? id).join(' + ');
  return { options, A: { id: A.join('+'), label: label(A), datasets: A }, B: { id: B.join('+'), label: label(B), datasets: B }, multi: true, blocker: null, signature: '' };
}

function pickTwo(ab: [string, string] | null, ids: string[]): [string, string] {
  const a = ab && ids.includes(ab[0]) ? ab[0] : ids[0];
  const b = ab && ids.includes(ab[1]) && ab[1] !== a ? ab[1] : ids.find(id => id !== a)!;
  return [a, b];
}

const sideBody = (s: DiffSide) => ({ label: s.label, datasets: s.datasets, ...(s.reads ? { reads: s.reads } : {}) });

export function diffRequestBody(features: HubSelected[], A: DiffSide, B: DiffSide, d: DiffSettings) {
  return {
    features: features.map(featureRequest), groups: { A: sideBody(A), B: sideBody(B) },
    test: d.test, density_match: d.densityMatch, density_bins: d.densityBins, replicate_aware: d.replicateAware, min_reads: d.minReads,
  };
}

export function diffRequestKey(plot: PlotSpec, target: FootprintSizesTarget, features: HubSelected[], sides: DiffSides, settingsKey: string): string {
  const d = plot.diff;
  return JSON.stringify({
    kind: 'fiberbrowser.differential.v1', view: [target.chrom, target.start, target.end, target.genome], features: features.map(featureKeyOf),
    group: plot.groupBy, A: sides.A?.id ?? null, B: sides.B?.id ?? null, sig: sides.signature,
    test: d.test, density: d.densityMatch ? d.densityBins : 0, replicate: d.replicateAware, minReads: d.minReads, settingsKey,
  });
}

/** A request key without the refresh generation (bumped by the browser, e.g. when the quality sync lands, without
 *  changing what a stored result answered), as the BED plots match their stored results. */
export function stableDiffKey(key: string): string {
  try {
    const o = JSON.parse(key) as Record<string, unknown>;
    const s = JSON.parse(String(o.settingsKey ?? '[]'));
    return JSON.stringify({ ...o, settingsKey: Array.isArray(s) ? s.slice(1) : s });
  } catch {
    return key;
  }
}

/** Whether a stored result (Gallery) answers the request (thresholds only redraw, so they are not in the key). */
export const diffSeedMatches = (seed: DiffEntry | null | undefined, key: string): boolean => !!seed && stableDiffKey(seed.key) === stableDiffKey(key);

export function useDifferentialData(o: {
  plot: PlotSpec; target: FootprintSizesTarget; clusters: FootprintSizesClusters | null; readGroups: ReadGroupDef[] | null; groupsSig?: string;
  settingsKey: string; enabled: boolean; seed?: DiffEntry | null;
}): { entry: DiffEntry | null; requestKey: string; loading: boolean; error: string | null; features: HubSelected[]; sides: DiffSides } {
  const { plot, target, clusters, readGroups, groupsSig = '', settingsKey, enabled, seed = null } = o;
  const assignments = useBrowserStore(s => s.clusterAssignments);
  // The hub's sets change with peaks, Find classes runs, geometries and the hub selection.
  const peaksByRule = useBrowserStore(s => s.peaksByRule);
  const hubSelected = useBrowserStore(s => s.featureHub?.selected);
  // Find classes runs, geometries and plugin sets live in their own stores: follow the providers (as the hub does).
  const [providerVersion, setProviderVersion] = useState(0);
  useEffect(() => {
    const bump = () => setProviderVersion(v => v + 1);
    const subs = hubProviders().flatMap(p => (p.subscribe ? [p.subscribe(bump)] : []));
    const off = onHubProvidersChanged(bump);
    return () => { subs.forEach(u => u()); off(); };
  }, []);
  // A pinned plot keeps the features it was computed on: peaks are rescanned for every view the browser moves to
  // (going to a feature would otherwise drop the peaks outside the new view and recompute the pinned plot).
  const frozen = useRef<{ kind: string; loc: string; list: HubSelected[] } | null>(null);
  const features = useMemo(() => {
    const kind = JSON.stringify([plot.diff.features, plot.diff.maxFeatures]);
    // Pinning where the plot already is (Pin, or a click on a point) keeps the list it was computed on.
    if (plot.pinned && frozen.current?.kind === kind && frozen.current.loc === JSON.stringify([plot.pinned.chrom, plot.pinned.start, plot.pinned.end]) && frozen.current.list.length) {
      return frozen.current.list;
    }
    const list = diffCandidates(plot.diff.features, target, plot.diff.maxFeatures);
    frozen.current = { kind, loc: JSON.stringify([target.chrom, target.start, target.end]), list };
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot.diff.features, plot.diff.maxFeatures, plot.pinned, target.chrom, target.start, target.end, peaksByRule, hubSelected, providerVersion]);
  // The reads shown per dataset (panel key or dataset id): which datasets share reads, for the default sides.
  const activeReadIds = useBrowserStore(s => s.activeReadIds);
  const readIds = useMemo(() => Object.fromEntries(target.panels.map(p => [p.datasetId, activeReadIds[p.key] ?? activeReadIds[p.datasetId]])),
    [target.panels, activeReadIds]);
  const sides = useMemo(() => diffSides(plot, target, clusters, readGroups, assignments as Record<string, Record<string, number>>, groupsSig, readIds),
    [plot, target, clusters, readGroups, assignments, groupsSig, readIds]);
  const requestKey = useMemo(() => diffRequestKey(plot, target, features, sides, settingsKey), [plot, target, features, sides, settingsKey]);
  const [entry, setEntry] = useState<DiffEntry | null>(seed);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => { if (seed) { setEntry(seed); entryRef.current = seed; } }, [seed]);

  useEffect(() => {
    if (!enabled) return;
    if (entryRef.current?.key === requestKey) { setLoading(false); return; }
    if (seed && diffSeedMatches(seed, requestKey)) {
      // The stored result answers this request: it is current under today's key.
      const adopted = { ...seed, key: requestKey };
      entryRef.current = adopted;
      setEntry(adopted);
      setLoading(false);
      return;
    }
    if (!sides.A || !sides.B || !features.length) { setLoading(false); return; }
    const controller = new AbortController();
    const key = requestKey;
    const locus = { chrom: target.chrom, start: target.start, end: target.end, genome: target.genome };
    const t = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      fetchJson<{ success: boolean; cancelled?: boolean; rows: DiffRow[]; groups: DiffEntry['groups']; test: string; density: DiffEntry['density'] }>('/api/plots/differential', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify(diffRequestBody(features, sides.A!, sides.B!, plot.diff)),
      })
        .then(r => {
          if (controller.signal.aborted || !r.success) return;
          setEntry({ key, locus, rows: r.rows, groups: r.groups, test: r.test, density: r.density });
        })
        .catch(err => {
          if (controller.signal.aborted || err?.name === 'AbortError') return;
          setError({ key, message: `Differential features could not be computed: ${err instanceof Error ? err.message : String(err)}` });
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 60);
    return () => { controller.abort(); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled, seed]);

  return { entry, requestKey, loading, error: error && error.key === requestKey ? error.message : null, features, sides };
}

// ------------------------------------------------------------------ pure helpers
export type DiffCall = 'up' | 'down' | 'ns' | 'untested';

/** up: higher in A (q and |delta| past the thresholds); down: higher in B. */
export function callOf(r: Pick<DiffRow, 'testable' | 'q' | 'delta'>, qMax: number, deltaMin: number): DiffCall {
  if (!r.testable || r.q == null || r.delta == null) return 'untested';
  if (r.q > qMax || Math.abs(r.delta) < deltaMin) return 'ns';
  return r.delta > 0 ? 'up' : 'down';
}

/** −log10 q for the volcano; q = 0 (underflow) sits at the cap, flagged. */
export const Q_CAP = 300;
export function negLog10Q(q: number | null): { y: number; capped: boolean } | null {
  if (q == null || !Number.isFinite(q)) return null;
  if (q <= 1e-300) return { y: Q_CAP, capped: true };
  return { y: Math.min(Q_CAP, -Math.log10(q)), capped: false };
}

export type DiffSortKey = 'feature' | 'locus' | 'fracA' | 'fracB' | 'delta' | 'log2or' | 'q' | 'n';

export function sortDiffRows(rows: DiffRow[], key: DiffSortKey, dir: 'asc' | 'desc'): DiffRow[] {
  const val = (r: DiffRow): number | string | null => {
    switch (key) {
      case 'feature': return r.label ?? r.key;
      case 'locus': return r.start ?? null;
      case 'fracA': return r.fracA;
      case 'fracB': return r.fracB;
      case 'delta': return r.delta;
      case 'log2or': return r.log2or;
      case 'q': return r.q;
      case 'n': return r.nA + r.nB;
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    // Missing values last, whatever the direction.
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string' || typeof y === 'string') return sign * String(x).localeCompare(String(y));
    return sign * (x - y) || (a.start ?? 0) - (b.start ?? 0);
  });
}

const fmt = (v: number | null, d = 4) => (v == null ? '' : Number.isInteger(v) ? String(v) : v.toPrecision(d));

export function diffTsv(entry: DiffEntry, qMax: number, deltaMin: number): string {
  const head = ['feature', 'kind', 'chrom', 'start', 'end', `frac_A(${entry.groups.A.label})`, `frac_B(${entry.groups.B.label})`, 'delta_A_minus_B', 'delta_lo95', 'delta_hi95',
    'log2_OR', 'log2_OR_lo95', 'log2_OR_hi95', 'p', 'q_BH', 'k_A', 'n_A', 'k_B', 'n_B', 'strata', 'call', 'note'];
  const lines = [`# test: ${entry.test}; A = ${entry.groups.A.label} (${entry.groups.A.datasets.join(', ')}); B = ${entry.groups.B.label} (${entry.groups.B.datasets.join(', ')}); call: q <= ${qMax}, |delta| >= ${deltaMin}`, head.join('\t')];
  for (const r of entry.rows) {
    lines.push([r.label ?? r.key, r.kind ?? '', r.chrom ?? '', r.start ?? '', r.end ?? '', fmt(r.fracA), fmt(r.fracB), fmt(r.delta), fmt(r.deltaLo), fmt(r.deltaHi),
      fmt(r.log2or), fmt(r.log2orLo), fmt(r.log2orHi), fmt(r.p), fmt(r.q), r.kA, r.nA, r.kB, r.nB, r.strata ?? '', callOf(r, qMax, deltaMin), r.reason ?? '']
      .map(v => String(v).replace(/[\t\n]/g, ' ')).join('\t'));
  }
  return lines.join('\n');
}
