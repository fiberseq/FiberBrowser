import type { BrowserState } from './browserStore';
import { clampMinSvLen, SV_MIN_LEN_DEFAULT, clampMinSvSupport, SV_MIN_SUPPORT_DEFAULT } from '../components/tracks/read-track/svDrawing';

/**
 * Structural-variant display and the SV allele split (fb-n9-sv).
 *
 * The split is a group source for the existing clusters: its groups are
 * `clusterAssignments[stateKey]` (0 carriers, 1 reference, 2 not informative)
 * like any clustering's, so sort/group-by, per-group metaprofiles, Footprints
 * per focused group and the exports work unchanged. `svSplits` keeps the
 * split's definition (the SV, not the reads), so the groups survive pan/zoom
 * within the locus: setViewport keeps them while the locus is in view and the
 * read track re-classifies the reads of each new view. `clusterGroupLabels`
 * names a key's groups where the cluster id alone would say "Cluster 1".
 */
export interface SvSplitDef {
  datasetId: string;
  chrom: string;
  t: 'D' | 'I';
  ref: number;
  len: number;
  /** ref + len (deletion) or ref (insertion). */
  end: number;
  margin: number;
  label: string;
  /** Group sizes at the last classification: carriers, reference, not informative. */
  counts: [number, number, number];
  /** The view the reads were last classified for. */
  viewStart: number;
  viewEnd: number;
  /** Duplicate reads were classified too (the panel showed them). */
  includeDuplicates?: boolean;
  includePutative?: boolean;
  evidenceCounts?: { confirmed: number; putative: number; ambiguous: number };
}

export interface SvSlice {
  /** Draw SVs of at least svMinLen on reads, and the SV track (a per-panel row: trackRegistry 'sv'). */
  svDisplayEnabled: boolean;
  svMinLen: number;
  svMinSupport: number;
  /** The cluster selected in an SV band (its supporting reads are highlighted), by state key. */
  svSelectedCluster: Record<string, string>;
  svSplits: Record<string, SvSplitDef>;
  clusterGroupLabels: Record<string, Record<number, string>>;
  setSvDisplayEnabled: (on: boolean) => void;
  setSvMinLen: (value: number) => void;
  setSvMinSupport: (value: number) => void;
  setSvSelectedCluster: (stateKey: string, clusterId: string | null) => void;
  setSvSplit: (stateKey: string, def: SvSplitDef | null, labels?: Record<number, string> | null) => void;
}

type SetState = (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void;

export function createSvSlice(set: SetState, _get: () => BrowserState): SvSlice {
  return {
    svDisplayEnabled: true,
    svMinLen: SV_MIN_LEN_DEFAULT,
    svMinSupport: SV_MIN_SUPPORT_DEFAULT,
    svSelectedCluster: {},
    svSplits: {},
    clusterGroupLabels: {},
    setSvDisplayEnabled: (on) => set({ svDisplayEnabled: Boolean(on) }),
    setSvMinLen: (value) => set({ svMinLen: clampMinSvLen(value) }),
    setSvMinSupport: (value) => set({ svMinSupport: clampMinSvSupport(value) }),
    setSvSelectedCluster: (stateKey, clusterId) => set(state => {
      const next = { ...state.svSelectedCluster };
      if (clusterId) next[stateKey] = clusterId; else delete next[stateKey];
      return { svSelectedCluster: next };
    }),
    setSvSplit: (stateKey, def, labels) => set(state => {
      const svSplits = { ...state.svSplits };
      const clusterGroupLabels = { ...state.clusterGroupLabels };
      if (def) {
        svSplits[stateKey] = def;
        if (labels) clusterGroupLabels[stateKey] = labels;
      } else {
        delete svSplits[stateKey];
        delete clusterGroupLabels[stateKey];
      }
      return { svSplits, clusterGroupLabels };
    }),
  };
}

/** Split definitions from a session or snapshot, validated. */
export function normalizeSvSplits(raw: unknown): Record<string, SvSplitDef> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, SvSplitDef> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const d = value as Partial<SvSplitDef> | null;
    if (!d || (d.t !== 'D' && d.t !== 'I') || typeof d.chrom !== 'string'
      || !Number.isFinite(d.ref) || !Number.isFinite(d.len)) continue;
    const ref = Number(d.ref);
    const len = Number(d.len);
    out[key] = {
      datasetId: String(d.datasetId ?? key), chrom: d.chrom, t: d.t, ref, len,
      end: Number.isFinite(d.end) && Number(d.end) >= ref ? Number(d.end) : d.t === 'D' ? ref + len : ref,
      margin: Number.isFinite(d.margin) ? Number(d.margin) : 100,
      label: String(d.label ?? ''),
      counts: Array.isArray(d.counts) && d.counts.length === 3 ? d.counts.map(Number) as [number, number, number] : [0, 0, 0],
      viewStart: Number.isFinite(d.viewStart) ? Number(d.viewStart) : ref,
      viewEnd: Number.isFinite(d.viewEnd) ? Number(d.viewEnd) : ref + len,
      includeDuplicates: Boolean(d.includeDuplicates),
      includePutative: Boolean(d.includePutative),
      evidenceCounts: d.evidenceCounts,
    };
  }
  return out;
}

export function normalizeClusterGroupLabels(raw: unknown): Record<string, Record<number, string>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, Record<number, string>> = {};
  for (const [key, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (!labels || typeof labels !== 'object') continue;
    const inner: Record<number, string> = {};
    for (const [id, label] of Object.entries(labels as Record<string, unknown>)) {
      if (Number.isFinite(Number(id)) && typeof label === 'string') inner[Number(id)] = label;
    }
    out[key] = inner;
  }
  return out;
}

/**
 * setViewport's clustering reset, with the SV splits whose locus stays in
 * view kept (their assignments, order and labels). A split whose locus left
 * the view (or another chromosome) is dropped with its groups.
 */
export function keepSvSplitsInView(
  state: Pick<BrowserState, 'svSplits' | 'clusterGroupLabels' | 'clusterAssignments' | 'clusterOrder'>,
  partial: Partial<BrowserState>,
  chrom: string,
  start: number,
  end: number,
): Partial<BrowserState> {
  const keys = Object.keys(state.svSplits ?? {});
  // Other named groups (a plugin pack's groupings, feature clusters): their names go with their groups. A reset of every panel's
  // clusters takes them; a path that keeps the clusters keeps them.
  const otherLabels: Record<string, Record<number, string>> = {};
  if (!('clusterAssignments' in partial)) {
    for (const [key, labels] of Object.entries(state.clusterGroupLabels ?? {})) if (!(key in (state.svSplits ?? {}))) otherLabels[key] = labels;
  }
  if (keys.length === 0) {
    const hadOthers = Object.keys(state.clusterGroupLabels ?? {}).length > 0;
    return hadOthers && 'clusterAssignments' in partial ? { ...partial, clusterGroupLabels: {} } : partial;
  }
  const kept: Record<string, SvSplitDef> = {};
  const keptLabels: Record<string, Record<number, string>> = { ...otherLabels };
  for (const key of keys) {
    const def = state.svSplits[key];
    if (def.chrom === chrom && def.ref < end && def.end + 1 > start) {
      kept[key] = def;
      if (state.clusterGroupLabels[key]) keptLabels[key] = state.clusterGroupLabels[key];
    }
  }
  const out: Partial<BrowserState> = { ...partial, svSplits: kept, clusterGroupLabels: keptLabels };
  const dropped = keys.filter(key => !(key in kept));
  if (dropped.length > 0 && !('clusterAssignments' in partial)) {
    // A path that keeps clusterings (a selected peak still in view) must not
    // keep a split's groups once its locus left the view (nameless "Cluster 0").
    const assignments = { ...state.clusterAssignments };
    const order = { ...state.clusterOrder };
    for (const key of dropped) {
      delete assignments[key];
      delete order[key];
    }
    out.clusterAssignments = assignments;
    out.clusterOrder = order;
  }
  if (Object.keys(kept).length === 0) return out;
  // The reset cleared every panel's groups: put back the kept splits'.
  if ('clusterAssignments' in partial) {
    const assignments = { ...(partial.clusterAssignments ?? {}) };
    const order = { ...(partial.clusterOrder ?? state.clusterOrder ?? {}) };
    for (const key of Object.keys(kept)) {
      if (state.clusterAssignments[key]) assignments[key] = state.clusterAssignments[key];
      if (state.clusterOrder[key]) order[key] = state.clusterOrder[key];
    }
    out.clusterAssignments = assignments;
    out.clusterOrder = order;
  }
  return out;
}
