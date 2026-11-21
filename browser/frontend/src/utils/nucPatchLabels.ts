/**
 * The nucpatch lane's geometry labels as an overlay (server: services/nuc/nucgeo.patch_labels). A geometry answer that
 * relabels the lane (a fold or tolerance change, another analysis) moves only the datasets' `patch_labels_identity`;
 * the labels are fetched and applied to the rows already loaded, so the reads are never reloaded for it.
 *
 * A live row's nucpatch layer carries `lk` (`<file tag>:<record>`), a `patch` quality (the patch's 1-based index in
 * its record) and `pg`, the identity of the patch generation that produced its patches (decode configuration,
 * regularity parameters, patch parameters, reference). Each dataset's overlay entry carries the `pg` of the patches
 * its labels index, for the dataset or per file tag. The overlay is applied to a row only when both carry a `pg` and
 * they are equal: patches called under other settings (rows still loaded from before a setting change, or labels
 * fetched before the rows were rebuilt) are other patches, and a label by ordinal index would land on an unrelated
 * one. Otherwise the row's own geometry/root bytes are shown until matching data arrives. Rows without `lk` (a scan's
 * or an annotated BAM's patches) always use their own bytes.
 *
 * Entries are per dataset: a row is labelled from its own dataset's entry, and a removed dataset's entry (and any
 * request in flight for it) is dropped.
 */
import { create } from 'zustand';

export interface DatasetLabels {
  identity: string;
  files: string[];
  labels: Record<string, number[][]>;
  /** The patch generation the labels index: one for the dataset's files, or per file tag. */
  pg?: string | Record<string, string> | null;
}

interface HeldLabels extends DatasetLabels {
  /** Order of application (the newest entry wins when a row names no dataset). */
  seq: number;
}

interface NucPatchLabelsState {
  /** Moves whenever the overlay changes (read tracks redraw, rule statistics recompute). */
  version: number;
  byDataset: Record<string, HeldLabels>;
}

export const useNucPatchLabels = create<NucPatchLabelsState>(() => ({ version: 0, byDataset: {} }));

let applySeq = 0;
const indexOf = new WeakMap<HeldLabels, Map<string, Map<number, [number, number]>>>();

function index(entry: HeldLabels): Map<string, Map<number, [number, number]>> {
  let m = indexOf.get(entry);
  if (m) return m;
  m = new Map();
  for (const [lk, rows] of Object.entries(entry.labels ?? {})) {
    const per = new Map<number, [number, number]>();
    for (const [i, g, r] of rows) per.set(i, [g, r]);
    m.set(lk, per);
  }
  indexOf.set(entry, m);
  return m;
}

/** The patch generation of an entry's labels for a file tag (null: none known). */
function pgOf(entry: DatasetLabels, tag: string): string | null {
  const pg = entry.pg;
  if (typeof pg === 'string') return pg || null;
  if (pg && typeof pg === 'object') { const v = pg[tag]; return typeof v === 'string' && v ? v : null; }
  return null;
}

/** The overlay's version (changes with every applied update). */
export function patchLabelsVersion(): number {
  return useNucPatchLabels.getState().version;
}

/** A row's labels by patch index (0-based), or undefined: use the row's own bytes. `lk`: the row's label key; `pg`:
 * its patch generation; `datasetId`: the dataset the row was loaded for (its entry only; without one, the newest
 * entry naming the row's file with the same patch generation). An empty map: the record's patches are in no
 * geometry. */
export function patchLabelsFor(lk: unknown, pg?: unknown, datasetId?: string | null): ReadonlyMap<number, [number, number]> | undefined {
  if (typeof lk !== 'string' || typeof pg !== 'string' || !pg) return undefined;
  const tag = lk.slice(0, lk.indexOf(':'));
  const held = useNucPatchLabels.getState().byDataset;
  const candidates = datasetId ? (held[datasetId] ? [held[datasetId]] : [])
    : Object.values(held).sort((a, b) => b.seq - a.seq);
  for (const entry of candidates) {
    if (!entry.files.includes(tag) || pgOf(entry, tag) !== pg) continue;
    return index(entry).get(lk) ?? EMPTY;
  }
  return undefined;
}
const EMPTY: ReadonlyMap<number, [number, number]> = new Map();

/** Apply a server answer (tests and the sync). */
export function applyPatchLabels(datasets: Record<string, DatasetLabels>): void {
  if (!Object.keys(datasets).length) return;
  const add = Object.fromEntries(Object.entries(datasets).map(([id, e]) => [id, { ...e, files: e.files ?? [], labels: e.labels ?? {}, seq: ++applySeq }]));
  useNucPatchLabels.setState(s => ({ version: s.version + 1, byDataset: { ...s.byDataset, ...add } }));
}

/** The identity each dataset should be labelled with (its latest `patch_labels_identity`), and the requests in flight. */
const desired = new Map<string, string>();
const pending = new Map<string, { identity: string; gen: number }>();
let generation = 0;
let current = new Set<string>();

/** Keep only the datasets still loaded: a removed dataset's entry and its pending request are dropped. */
export function reconcilePatchLabels(ids: Iterable<string>): void {
  current = new Set(ids);
  for (const id of [...desired.keys()]) if (!current.has(id)) desired.delete(id);
  for (const id of [...pending.keys()]) if (!current.has(id)) pending.delete(id);
  const held = useNucPatchLabels.getState().byDataset;
  const gone = Object.keys(held).filter(id => !current.has(id));
  if (!gone.length) return;
  const byDataset = { ...held };
  for (const id of gone) delete byDataset[id];
  useNucPatchLabels.setState(s => ({ version: s.version + 1, byDataset }));
}

/** Forget every dataset's labels (tests). */
export function resetPatchLabels(): void {
  useNucPatchLabels.setState({ version: 0, byDataset: {} });
  desired.clear(); pending.clear(); current = new Set(); generation = 0;
}

/** Fetch the labels of the datasets whose label identity differs from the one held (a dataset never labelled is
 * skipped: its rows carry none). Every call records each dataset's wanted identity, including one already held (a
 * return to earlier settings): an answer is applied only when it was asked for the identity still wanted and no newer
 * request for the dataset was started since. */
export async function syncPatchLabels(datasets: ReadonlyArray<{ id: string; patch_labels_identity?: string }>,
  fetcher: (ids: string[]) => Promise<{ datasets: Record<string, DatasetLabels> }> = fetchPatchLabels): Promise<void> {
  reconcilePatchLabels(datasets.map(d => d.id));
  for (const d of datasets) if (typeof d.patch_labels_identity === 'string') desired.set(d.id, d.patch_labels_identity);
  const held = useNucPatchLabels.getState().byDataset;
  const want = datasets.filter(d => typeof d.patch_labels_identity === 'string'
    && (held[d.id] ? held[d.id].identity !== d.patch_labels_identity : d.patch_labels_identity !== '')
    && pending.get(d.id)?.identity !== d.patch_labels_identity);
  if (!want.length) return;
  const gen = ++generation;
  for (const d of want) pending.set(d.id, { identity: d.patch_labels_identity!, gen });
  try {
    const res = await fetcher(want.map(d => d.id));
    const fresh: Record<string, DatasetLabels> = {};
    for (const [id, entry] of Object.entries(res.datasets ?? {})) {
      const asked = want.find(d => d.id === id);
      if (!asked || !entry || pending.get(id)?.gen !== gen || desired.get(id) !== asked.patch_labels_identity || !current.has(id)) continue;
      fresh[id] = { ...entry, identity: typeof entry.identity === 'string' ? entry.identity : asked.patch_labels_identity! };
    }
    applyPatchLabels(fresh);
  } catch { /* the next identity change (or dataset refresh) asks again */ } finally {
    for (const d of want) if (pending.get(d.id)?.gen === gen) pending.delete(d.id);
  }
}

async function fetchPatchLabels(ids: string[]): Promise<{ datasets: Record<string, DatasetLabels> }> {
  const { fetchJson } = await import('../api/sharedFetch');
  return fetchJson('/api/nuc/patch_labels', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasets: ids }) });
}
