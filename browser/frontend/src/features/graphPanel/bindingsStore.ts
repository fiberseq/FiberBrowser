/**
 * Which registered graph packages bind each loaded dataset (graph primary, DESIGN_GRAPH_PRIMARY §1.2): read once per
 * registration from `GET /api/graph/read_bindings` (explicit identities, checked by the server) and again whenever
 * the datasets or the registrations change. The header's "View as graph", the default view of a new lifted dataset
 * and "Add panels to this graph" read it; a dataset no package binds is offered linear only, with the reason.
 */
import { create } from 'zustand';
import { getReadBindings } from './api';
import { useGraphStatusStore } from './statusStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useServerDatasetsStore } from '../../stores/serverDatasetsStore';
import type { GraphReadBinding, GraphRegistration } from './types';

export interface DatasetGraphBinding { registration: GraphRegistration; binding: GraphReadBinding }

interface BindingsState {
  /** Dataset id -> the registrations whose paths it binds (at least one path), in registration order. */
  byDataset: Record<string, DatasetGraphBinding[]>;
  /** Dataset id -> why no package binds it (problems the server listed), when it has none. */
  problems: Record<string, string[]>;
  /** The datasets + registrations key the answer is for (null: not read yet). */
  key: string | null;
  /** The dataset ids the answer covers. */
  covered: string[];
  loading: boolean;
  /** `extra`: anything else that changes what binds (the server's datasets key from the heartbeat). */
  refresh: (datasetIds: string[], extra?: string) => Promise<void>;
}

let inflight: { key: string; promise: Promise<void> } | null = null;

export const useGraphBindingsStore = create<BindingsState>((set, get) => ({
  byDataset: {},
  problems: {},
  key: null,
  covered: [],
  loading: false,
  refresh: (datasetIds: string[], extra = '') => {
    const regs = useGraphStatusStore.getState().status?.registrations ?? [];
    const key = `${datasetIds.join(',')}|${extra}|${regs.map(r => `${r.id}@${r.revisions.package}`).join(',')}`;
    if (get().key === key) return Promise.resolve();
    if (inflight?.key === key) return inflight.promise;
    set({ loading: true });
    let failed = false;
    const promise = Promise.all(regs.map(r => getReadBindings(r.id).then(list => [r, list] as const)
      .catch(() => { failed = true; return [r, [] as GraphReadBinding[]] as const; })))
      .then(all => {
        if (inflight?.key !== key) return;
        // A failed read is not an answer: nothing is recorded, the next change (or heartbeat) reads again.
        if (failed) { set({ loading: false }); return; }
        const byDataset: Record<string, DatasetGraphBinding[]> = {};
        const problems: Record<string, string[]> = {};
        for (const [registration, list] of all) {
          for (const binding of list) {
            if (Object.keys(binding.paths).length) (byDataset[binding.dataset_id] ??= []).push({ registration, binding });
            else if (binding.problems.length) (problems[binding.dataset_id] ??= []).push(...binding.problems);
          }
        }
        set({ byDataset, problems, key, covered: [...datasetIds], loading: false });
      })
      .finally(() => { if (inflight?.key === key) inflight = null; });
    inflight = { key, promise };
    return promise;
  },
}));

/** The first package binding a dataset (null: none, or not known yet). */
export function graphBindingFor(datasetId: string | null | undefined, state = useGraphBindingsStore.getState()): DatasetGraphBinding | null {
  if (!datasetId) return null;
  return state.byDataset[datasetId]?.[0] ?? null;
}

/** The package path a panel of this dataset is a member for: its haplotype's path (a split lifted panel), the
 * target (a native panel), null for a pooled lifted panel (every path its dataset binds). */
export function memberBindingFor(liftHap: string | null | undefined, binding: GraphReadBinding, targetKey: string | null,
  registration?: GraphRegistration | null): string | null {
  if (binding.kind === 'native') return targetKey && targetKey in binding.paths ? targetKey : Object.keys(binding.paths)[0] ?? null;
  if (!liftHap) return null;
  const want = liftHap.toUpperCase();
  // The haplotype's path compared with this target (a map source of it): a dataset binds every contig's path.
  const mapped = new Set((registration?.maps ?? []).filter(m => m.target === targetKey).map(m => m.source));
  const hits = Object.entries(binding.haps ?? {}).filter(([, label]) => label.toUpperCase() === want).map(([k]) => k);
  return hits.find(k => mapped.has(k)) ?? (registration ? null : hits[0] ?? null);
}

let watching = false;

/**
 * Keep the bindings current: whenever the datasets (here or on the server) or the registrations change. Started by the
 * first dataset panel header (so a page with no dataset panel never asks the helper); the graph status is read once a
 * BAM-backed dataset is open.
 */
export function watchGraphBindings(): void {
  if (watching) return;
  watching = true;
  const refresh = () => {
    const s = useBrowserStore.getState();
    const ids = s.datasets.filter(d => d.data_type === 'bam' || d.data_type === 'bam_livelift').map(d => d.id);
    if (!ids.length) return;
    const status = useGraphStatusStore.getState();
    if (!status.status) { if (!status.loading) void status.load(); return; }
    void useGraphBindingsStore.getState().refresh(ids, `${useServerDatasetsStore.getState().key ?? ''}|${s.refreshGeneration}`);
  };
  useBrowserStore.subscribe((s, prev) => { if (s.datasets !== prev.datasets || s.refreshGeneration !== prev.refreshGeneration) refresh(); });
  useServerDatasetsStore.subscribe(refresh);
  useGraphStatusStore.subscribe((s, prev) => { if (s.status !== prev.status) refresh(); });
  refresh();
}
