/**
 * Unmerge (fb-n5-projection): every merge of clusters — Merge (selected
 * clusters), Merge similar clusters, Delete (a cluster's reads to the nearest
 * clusters) — is recorded as a step, so the clustering before the merges and
 * the one after them can be switched back and forth without recomputing, and
 * one merged-away cluster can be split back on its own.
 *
 * A step keeps only the reads it moved (read -> [cluster before, cluster
 * after]), per panel state key: the clustering before the merges is the
 * current one with every step undone, newest first; the merged one is the
 * original with every step redone. The log is valid only while the current
 * clustering is one of the two (its signature matches): a new Cluster run, a
 * restored snapshot or another branch shows another clustering, and the
 * Unmerge switch hides itself (an undo back to it brings it back).
 *
 * Plain JSON (no Sets): it goes into undo steps and sessions as it is.
 */

export type ClusterMergeKind = 'manual' | 'similar' | 'dissolve';

/** The settings a Merge similar clusters step used (provenance). */
export interface ClusterMergeSettingsRecord {
  strategy: string;
  threshold: number;
  minFraction: number;
}

export interface ClusterMergeStep {
  id: string;
  /** Plain-language name ("Merge C3, C7", "Merge similar clusters"). */
  label: string;
  kind: ClusterMergeKind;
  /** Per state key: read id -> [cluster before, cluster after], the reads this step moved. */
  moved: Record<string, Record<string, [number, number]>>;
  /** Clusters this step merged away (no reads left in them after it). */
  removed: number[];
  settings?: ClusterMergeSettingsRecord;
}

export interface ClusterMergeLog {
  /** The panels (state keys) the merges changed. */
  stateKeys: string[];
  steps: ClusterMergeStep[];
  /** Which clustering is on show. */
  showing: 'merged' | 'original';
  /** Signatures of the merged clustering and of the one before the merges (over stateKeys). */
  mergedSig: string;
  originalSig: string;
  /** Cluster order of the clustering not on show, per state key. */
  otherOrder: Record<string, number[]>;
  /** Clusters before the merges and after them (all panels together). */
  originalCount: number;
  mergedCount: number;
}

export type Assignments = Record<string, Record<string, number>>;
export type Orders = Record<string, number[]>;

const UNASSIGNED = -1;

// ---------------------------------------------------------------------------
// Signatures

const sigCache = new WeakMap<object, string>();

function hashEntries(assignments: Record<string, number>): string {
  const cached = sigCache.get(assignments);
  if (cached !== undefined) return cached;
  const ids = Object.keys(assignments).sort();
  let h1 = 2166136261;
  let h2 = 5381;
  for (const id of ids) {
    const token = `${id}:${assignments[id]}|`;
    for (let i = 0; i < token.length; i++) {
      const c = token.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = (Math.imul(h2, 33) + c) | 0;
    }
  }
  const sig = `${ids.length}.${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
  sigCache.set(assignments, sig);
  return sig;
}

/**
 * A signature of the clustering of these panels (cached per assignment map):
 * each panel's hash, in the order of `stateKeys` (a log's stable order), so
 * two panels swapping their clusterings is another clustering (fb-n6-integ).
 * It doesn't name the panels: a dataset reopened under another id (its state
 * key renamed in place in a session or undo step) keeps its signature.
 */
export function clusteringSignature(assignments: Assignments, stateKeys: string[]): string {
  return stateKeys.map(key => hashEntries(assignments[key] ?? {})).join(';');
}


function clusterCount(assignments: Assignments, stateKeys: string[]): number {
  const ids = new Set<number>();
  for (const key of stateKeys) {
    for (const cluster of Object.values(assignments[key] ?? {})) {
      if (cluster !== UNASSIGNED) ids.add(cluster);
    }
  }
  return ids.size;
}

// ---------------------------------------------------------------------------
// Applying steps

/** The clustering with these steps undone, newest first (before = true) or redone, oldest first. */
function replay(assignments: Assignments, steps: ClusterMergeStep[], direction: 'undo' | 'redo', stateKeys: string[]): Assignments {
  const out: Assignments = { ...assignments };
  for (const key of stateKeys) {
    if (!steps.some(step => step.moved[key])) continue;
    const next = { ...(assignments[key] ?? {}) };
    const ordered = direction === 'undo' ? [...steps].reverse() : steps;
    for (const step of ordered) {
      for (const [readId, [before, after]] of Object.entries(step.moved[key] ?? {})) {
        next[readId] = direction === 'undo' ? before : after;
      }
    }
    out[key] = next;
  }
  return out;
}

/** Cluster ids present in a clustering, in the given order first, then the rest ascending. */
function orderFor(assignments: Record<string, number> | undefined, preferred: number[] | undefined): number[] {
  const present = new Set(Object.values(assignments ?? {}));
  const order = (preferred ?? []).filter((c, i, arr) => present.has(c) && arr.indexOf(c) === i);
  for (const c of [...present].sort((a, b) => a - b)) if (!order.includes(c)) order.push(c);
  return order;
}

/** Whether the current clustering is the merged one, the one before the merges, or neither (null). */
export function mergeLogStatus(log: ClusterMergeLog | null | undefined, assignments: Assignments): 'merged' | 'original' | null {
  if (!log || log.steps.length === 0) return null;
  const sig = clusteringSignature(assignments, log.stateKeys);
  if (sig === log.mergedSig) return 'merged';
  if (sig === log.originalSig) return 'original';
  return null;
}

let stepCounter = 0;
const newStepId = () => `merge-${Date.now().toString(36)}-${(++stepCounter).toString(36)}`;

/**
 * Record a merge: `before` is the clustering just before it, `after` the
 * current one. Continues the log when `before` is its merged clustering,
 * else starts a new one. Returns the log unchanged when no read moved.
 */
export function recordMergeStep(
  log: ClusterMergeLog | null | undefined,
  before: { assignments: Assignments; order: Orders },
  after: { assignments: Assignments; order: Orders },
  stateKeys: string[],
  info: { label: string; kind: ClusterMergeKind; settings?: ClusterMergeSettingsRecord },
): ClusterMergeLog | null {
  const moved: ClusterMergeStep['moved'] = {};
  // Clusters gone from any panel the step changed (a cluster can go from one panel and stay in another).
  const removed = new Set<number>();
  for (const key of stateKeys) {
    const b = before.assignments[key] ?? {};
    const a = after.assignments[key] ?? {};
    const afterIds = new Set(Object.values(a));
    for (const c of Object.values(b)) if (!afterIds.has(c) && c !== UNASSIGNED) removed.add(c);
    const changes: Record<string, [number, number]> = {};
    for (const [readId, cluster] of Object.entries(b)) {
      const now = a[readId];
      if (now !== undefined && now !== cluster) changes[readId] = [cluster, now];
    }
    if (Object.keys(changes).length > 0) moved[key] = changes;
  }
  const changedKeys = Object.keys(moved);
  if (changedKeys.length === 0) return log ?? null;
  const step: ClusterMergeStep = {
    id: newStepId(),
    label: info.label,
    kind: info.kind,
    moved,
    removed: [...removed].sort((x, y) => x - y),
    ...(info.settings ? { settings: { ...info.settings } } : {}),
  };
  const continues = !!log && log.steps.length > 0 && log.showing === 'merged'
    && clusteringSignature(before.assignments, log.stateKeys) === log.mergedSig;
  const keys = continues ? [...new Set([...log!.stateKeys, ...changedKeys])] : changedKeys;
  const steps = continues ? [...log!.steps, step] : [step];
  const otherOrder: Orders = continues ? { ...log!.otherOrder } : {};
  for (const key of changedKeys) {
    if (!(key in otherOrder)) otherOrder[key] = [...(before.order[key] ?? orderFor(before.assignments[key], undefined))];
  }
  const original = replay(after.assignments, steps, 'undo', keys);
  return {
    stateKeys: keys,
    steps,
    showing: 'merged',
    mergedSig: clusteringSignature(after.assignments, keys),
    originalSig: clusteringSignature(original, keys),
    otherOrder,
    originalCount: clusterCount(original, keys),
    mergedCount: clusterCount(after.assignments, keys),
  };
}

/**
 * Switch between the merged clustering and the one before the merges. The
 * current clustering must be one of them (mergeLogStatus); null otherwise.
 */
export function toggleMerge(
  log: ClusterMergeLog,
  current: { assignments: Assignments; order: Orders },
): { assignments: Assignments; order: Orders; log: ClusterMergeLog } | null {
  const status = mergeLogStatus(log, current.assignments);
  if (!status) return null;
  const toOriginal = status === 'merged';
  const assignments = replay(current.assignments, log.steps, toOriginal ? 'undo' : 'redo', log.stateKeys);
  const order: Orders = { ...current.order };
  const otherOrder: Orders = {};
  for (const key of log.stateKeys) {
    otherOrder[key] = [...(current.order[key] ?? orderFor(current.assignments[key], undefined))];
    order[key] = orderFor(assignments[key], log.otherOrder[key]);
  }
  return {
    assignments,
    order,
    log: { ...log, showing: toOriginal ? 'original' : 'merged', otherOrder },
  };
}

/** One merged-away cluster: what it was merged into, by which step, and how many reads. */
export interface MergedClusterInfo {
  stepId: string;
  stepLabel: string;
  kind: ClusterMergeKind;
  cluster: number;
  /** Where most of its reads are now (the merged clustering). */
  target: number | null;
  reads: number;
}

/** The clusters the merges took away, oldest step first. */
export function mergedClusters(log: ClusterMergeLog | null | undefined): MergedClusterInfo[] {
  if (!log) return [];
  const out: MergedClusterInfo[] = [];
  log.steps.forEach((step, index) => {
    const later = log.steps.slice(index + 1);
    for (const cluster of step.removed) {
      const targets = new Map<number, number>();
      let reads = 0;
      for (const [key, moved] of Object.entries(step.moved)) {
        for (const [readId, [before, after]] of Object.entries(moved)) {
          if (before !== cluster) continue;
          reads += 1;
          let final = after;
          for (const next of later) {
            const hop = next.moved[key]?.[readId];
            if (hop) final = hop[1];
          }
          targets.set(final, (targets.get(final) ?? 0) + 1);
        }
      }
      if (reads === 0) continue;
      const target = [...targets.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
      out.push({ stepId: step.id, stepLabel: step.label, kind: step.kind, cluster, target, reads });
    }
  });
  return out;
}

/**
 * Split one merged-away cluster back out of the merged clustering: its reads
 * (as it was just before the step that removed it) return to it; every other
 * merge stays. The merged clustering must be on show. Returns the new
 * clustering and log (null log: nothing left merged).
 */
export function splitBackCluster(
  log: ClusterMergeLog,
  current: { assignments: Assignments; order: Orders },
  stepId: string,
  cluster: number,
): { assignments: Assignments; order: Orders; log: ClusterMergeLog | null } | null {
  if (mergeLogStatus(log, current.assignments) !== 'merged') return null;
  const index = log.steps.findIndex(step => step.id === stepId);
  if (index < 0) return null;
  const step = log.steps[index];
  if (!step.removed.includes(cluster)) return null;
  const assignments: Assignments = { ...current.assignments };
  const order: Orders = { ...current.order };
  const steps = log.steps.map(s => ({ ...s, moved: { ...s.moved } }));
  let restoredAny = false;
  for (const [key, moved] of Object.entries(step.moved)) {
    const restore = Object.entries(moved).filter(([, [before]]) => before === cluster).map(([readId]) => readId);
    if (restore.length === 0) continue;
    restoredAny = true;
    const next = { ...(assignments[key] ?? {}) };
    for (const readId of restore) next[readId] = cluster;
    assignments[key] = next;
    // Those reads are no longer moved by this step or any later one.
    for (let j = index; j < steps.length; j++) {
      const m = steps[j].moved[key];
      if (!m) continue;
      const kept = { ...m };
      for (const readId of restore) delete kept[readId];
      if (Object.keys(kept).length > 0) steps[j].moved[key] = kept;
      else delete steps[j].moved[key];
    }
    // Back in the order where it was before the merges.
    const original = log.otherOrder[key] ?? [];
    const now = (order[key] ?? orderFor(current.assignments[key], undefined)).filter(c => c !== cluster);
    const at = original.indexOf(cluster);
    let insertAt = 0;
    for (let i = at - 1; i >= 0; i--) {
      const pos = now.indexOf(original[i]);
      if (pos >= 0) { insertAt = pos + 1; break; }
    }
    now.splice(insertAt, 0, cluster);
    order[key] = now;
  }
  if (!restoredAny) return null;
  steps[index] = { ...steps[index], removed: steps[index].removed.filter(c => c !== cluster) };
  const remaining = steps.filter(s => Object.keys(s.moved).length > 0);
  if (remaining.length === 0) return { assignments, order, log: null };
  const keys = log.stateKeys;
  const original = replay(assignments, remaining, 'undo', keys);
  return {
    assignments,
    order,
    log: {
      ...log,
      steps: remaining,
      mergedSig: clusteringSignature(assignments, keys),
      originalSig: clusteringSignature(original, keys),
      mergedCount: clusterCount(assignments, keys),
      originalCount: clusterCount(original, keys),
    },
  };
}

/**
 * The log for a clustering brought back (fb-n6-integ: a saved clustering
 * restored): each of the log's panels goes with the panel that now shows the
 * clustering it had (the same panel first; a state key renamed or a dataset's
 * result restored to another panel follows it), and a panel showing another
 * clustering (left as it was by a partial restore, or closed) drops out of the
 * log with its moves. `targets` limits the panels it may go with. Null when
 * no panel is left (or the log was never valid).
 */
export function restoreMergeLog(
  log: ClusterMergeLog | null | undefined,
  assignments: Assignments,
  targets?: ReadonlySet<string>,
): ClusterMergeLog | null {
  if (!log || log.steps.length === 0) return null;
  const shown = (log.showing === 'merged' ? log.mergedSig : log.originalSig).split(';');
  if (shown.length !== log.stateKeys.length) return null;
  const allowed = (key: string) => (!targets || targets.has(key)) && !!assignments[key];
  const keyMap = new Map<string, string>();
  const taken = new Set<string>();
  // The same panel first, then any other panel showing that clustering.
  log.stateKeys.forEach((key, i) => {
    if (allowed(key) && hashEntries(assignments[key]) === shown[i]) {
      keyMap.set(key, key);
      taken.add(key);
    }
  });
  log.stateKeys.forEach((key, i) => {
    if (keyMap.has(key)) return;
    const other = Object.keys(assignments).find(k => !taken.has(k) && !log.stateKeys.includes(k) && allowed(k)
      && hashEntries(assignments[k]) === shown[i]);
    if (other) {
      keyMap.set(key, other);
      taken.add(other);
    }
  });
  if (keyMap.size === 0) return null;
  const unchanged = keyMap.size === log.stateKeys.length && [...keyMap].every(([from, to]) => from === to);
  if (unchanged) return log;
  const keys = log.stateKeys.filter(key => keyMap.has(key)).map(key => keyMap.get(key)!);
  const steps = log.steps.map(step => {
    const moved: ClusterMergeStep['moved'] = {};
    for (const [key, reads] of Object.entries(step.moved)) {
      const to = keyMap.get(key);
      if (to) moved[to] = reads;
    }
    return { ...step, moved };
  }).filter(step => Object.keys(step.moved).length > 0);
  if (steps.length === 0) return null;
  const otherOrder: Orders = {};
  for (const [from, to] of keyMap) if (log.otherOrder[from]) otherOrder[to] = log.otherOrder[from];
  const other = replay(assignments, steps, log.showing === 'merged' ? 'undo' : 'redo', keys);
  const merged = log.showing === 'merged' ? assignments : other;
  const original = log.showing === 'merged' ? other : assignments;
  return {
    ...log,
    stateKeys: keys,
    steps,
    otherOrder,
    mergedSig: clusteringSignature(merged, keys),
    originalSig: clusteringSignature(original, keys),
    mergedCount: clusterCount(merged, keys),
    originalCount: clusterCount(original, keys),
  };
}

/** A log read back from a session or undo step (null when it isn't one). */
export function normalizeMergeLog(value: unknown): ClusterMergeLog | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<ClusterMergeLog>;
  if (!Array.isArray(v.stateKeys) || !Array.isArray(v.steps) || v.steps.length === 0) return null;
  if (typeof v.mergedSig !== 'string' || typeof v.originalSig !== 'string') return null;
  return {
    stateKeys: v.stateKeys.filter((k): k is string => typeof k === 'string'),
    steps: v.steps.filter(s => s && typeof s === 'object' && s.moved && typeof s.moved === 'object').map(s => ({
      id: String(s.id),
      label: String(s.label ?? 'Merge'),
      kind: (s.kind === 'manual' || s.kind === 'dissolve') ? s.kind : 'similar',
      moved: s.moved,
      removed: Array.isArray(s.removed) ? s.removed.filter((c): c is number => typeof c === 'number') : [],
      ...(s.settings ? { settings: s.settings } : {}),
    })),
    showing: v.showing === 'original' ? 'original' : 'merged',
    mergedSig: v.mergedSig,
    originalSig: v.originalSig,
    otherOrder: (v.otherOrder && typeof v.otherOrder === 'object') ? v.otherOrder : {},
    originalCount: Number(v.originalCount) || 0,
    mergedCount: Number(v.mergedCount) || 0,
  };
}
