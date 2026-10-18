/**
 * Undo/redo of closing a dataset. A history step that closed datasets keeps
 * where they came from (paths or URLs, label); undoing it opens them again
 * through the server, redoing it closes them again. Loaded through a dynamic
 * import from the history slice (no store/API cycle at module load).
 */
import { addDataset, getDatasets, removeDataset } from '../api/datasets';
import { activateConsensus } from '../api/consensusWorkflow';
import { loadDerivedLayers } from '../api/footprints';
import { useBrowserStore } from '../stores/browserStore';
import { remapDatasetIds, type SerializedDataset } from '../stores/historySlice';
import { attachPanelGenome } from '../api/panelGenomes';
import { usePanelGenomeStore } from '../stores/panelGenomeStore';
import { useGenomeCheckStore } from '../stores/genomeCheckStore';

type DerivedLayerRecord = {
  kind?: string;
  consensus_job_id?: string | null;
  bundle_path?: string | null;
  bundle_paths?: string[] | null;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Layers the dataset had attached that its files don't bring back on their
 * own: footprint-class layers of a class run (re-attached by activating that
 * run) and `.fiberlayers` bundles loaded from elsewhere (loaded again).
 */
export function derivedLayerSources(dataset: SerializedDataset): { consensusJobs: string[]; bundles: string[] } {
  const consensusJobs: string[] = [];
  const bundles: string[] = [];
  for (const meta of Object.values(dataset.derived_layers ?? {}) as DerivedLayerRecord[]) {
    if (!meta || typeof meta !== 'object') continue;
    if (meta.kind === 'consensus-workflow') {
      if (meta.consensus_job_id && !consensusJobs.includes(meta.consensus_job_id)) consensusJobs.push(meta.consensus_job_id);
      continue;
    }
    for (const path of meta.bundle_paths ?? [meta.bundle_path]) {
      if (typeof path === 'string' && path && !bundles.includes(path)) bundles.push(path);
    }
  }
  return { consensusJobs, bundles };
}

/**
 * Put back the derived layers of datasets an undo reopened (the class track,
 * loaded bundles), then refresh the datasets' layer lists from the server.
 * A class run is re-activated only when no other run's layers are showing:
 * undoing a close must not replace a newer run.
 */
async function restoreDerivedLayers(reopened: Array<{ id: string; dataset: SerializedDataset }>, errors: string[]): Promise<void> {
  const store = useBrowserStore;
  const jobs = new Map<string, string[]>();
  let changed = false;
  for (const { id, dataset } of reopened) {
    const { consensusJobs, bundles } = derivedLayerSources(dataset);
    const current = store.getState().datasets.find(d => d.id === id) as { derived_layers?: Record<string, DerivedLayerRecord> } | undefined;
    const attached = new Set(Object.values(current?.derived_layers ?? {}).flatMap(m => m?.bundle_paths ?? [m?.bundle_path]));
    for (const path of bundles) {
      if (attached.has(path)) continue;
      try {
        const res = await loadDerivedLayers(path, [id]);
        if (res.success) changed = true;
        else errors.push(`${dataset.label}: layers from ${path} — ${res.error ?? 'not attached'}`);
      } catch (error) {
        errors.push(`${dataset.label}: layers from ${path} — ${errorText(error)}`);
      }
    }
    for (const job of consensusJobs) jobs.set(job, [...(jobs.get(job) ?? []), dataset.label]);
  }
  for (const [job, labels] of jobs) {
    const otherRun = store.getState().datasets.some(d => Object.values((d as { derived_layers?: Record<string, DerivedLayerRecord> }).derived_layers ?? {})
      .some(m => m?.kind === 'consensus-workflow' && m.consensus_job_id && m.consensus_job_id !== job));
    if (otherRun) {
      errors.push(`${labels.join(', ')}: footprint classes not shown again (another class run is active; open its run from the Footprints panel)`);
      continue;
    }
    try {
      await activateConsensus(job);
      changed = true;
    } catch (error) {
      errors.push(`${labels.join(', ')}: footprint classes — ${errorText(error)}`);
    }
  }
  if (!changed) return;
  try {
    const response = await getDatasets();
    const state = store.getState();
    state.setDatasets(state.datasets.map(d => {
      const server = response.datasets.find(v => v.id === d.id);
      return server ? { ...d, available_layers: server.available_layers, derived_layers: server.derived_layers } : d;
    }));
    store.getState().triggerRefresh();
  } catch (error) {
    errors.push(`layer list — ${errorText(error)}`);
  }
}

/** Every history step's panels of this dataset that had a reference of their own: on `key`. */
function renamePanelGenome(datasetId: string, key: string): void {
  useBrowserStore.setState(s => {
    let changed = false;
    const stack = s._historyStack.map(snap => {
      const panels = (snap.state?.panels ?? []) as Array<{ datasetId?: string; genome?: string }>;
      if (!panels.some(p => p?.datasetId === datasetId && p.genome && p.genome !== key)) return snap;
      changed = true;
      return { ...snap, state: { ...snap.state, panels: panels.map(p => (p?.datasetId === datasetId && p.genome ? { ...p, genome: key } : p)) } };
    });
    return changed ? { _historyStack: stack } : {};
  });
}

/**
 * Give datasets an undo reopened the reference of their own they had when
 * closed (the server closed it with them), under their id now, and wait for
 * the panels' reference list: the step's panels, put back next, carry it.
 */
async function restoreReferences(reopened: Array<{ id: string; dataset: SerializedDataset }>, errors: string[]): Promise<void> {
  let attached = false;
  for (const { id, dataset } of reopened) {
    const reference = dataset.reference;
    if (!reference) continue;
    try {
      const res = await attachPanelGenome({ dataset_ids: [id], ...reference.source });
      if (res.success) {
        attached = true;
        // Its key now may differ (another reference took the old one, a contigs key with a new id):
        // the steps' panels of this dataset follow it, so their loci are kept.
        if (res.genome?.key) renamePanelGenome(id, res.genome.key);
      }
      else errors.push(`${dataset.label}: its reference ${reference.key} — ${res.error ?? 'not loaded'}`);
    } catch (error) {
      errors.push(`${dataset.label}: its reference ${reference.key} — ${errorText(error)}`);
    }
  }
  if (!attached) return;
  await usePanelGenomeStore.getState().refresh();
  void useGenomeCheckStore.getState().refresh();
}

/**
 * Bring the open datasets in line with a history step. Datasets are matched by
 * id, not by file: two copies of one file are separate datasets, and only the
 * one the step closed is reopened or closed again. History pausing and the
 * "Reopening …" status are owned by the history slice (jobs run in order).
 */
export async function reconcileClosedDatasets(
  changes: { reopen: SerializedDataset[]; close: SerializedDataset[] },
): Promise<void> {
  const store = useBrowserStore;
  const errors: string[] = [];
  const isOpen = (id: string) => store.getState().datasets.some(d => d.id === id);
  for (const ds of changes.close) {
    if (!isOpen(ds.id)) continue;
    try {
      const res = await removeDataset(ds.id);
      if (res.success) store.getState().removeDataset(ds.id);
      else errors.push(`${ds.label}: ${res.error ?? 'could not be closed'}`);
    } catch (error) {
      errors.push(`${ds.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // One at a time: a dataset that comes back under a new id is renamed in
  // every step at once (so this step and later Undo/Redo steps find it), and
  // so are the ones still to reopen here (its new id may be one of theirs).
  let pending = [...changes.reopen];
  const reopened: Array<{ id: string; dataset: SerializedDataset }> = [];
  while (pending.length) {
    const ds = pending.shift()!;
    if (isOpen(ds.id)) continue;
    try {
      const res = ds.live_lift
        // A live-lift dataset comes back through its own route (its map and settings), never as a plain BAM.
        ? await (await import('../features/liveLift/api')).addLiveLiftDataset({
          paths: ds.paths, manifest: ds.live_lift.manifest, haplotypes: ds.live_lift.haplotypes,
          settings: ds.live_lift.settings, label: ds.label })
        : await addDataset(ds.paths.length > 1 ? ds.paths : ds.paths[0], ds.label);
      if (res.success && res.dataset) {
        store.getState().addDataset(res.dataset);
        reopened.push({ id: res.dataset.id, dataset: ds });
        if (res.dataset.id !== ds.id) {
          const renamed = store.getState().remapHistoryDatasetIds({ [ds.id]: res.dataset.id });
          pending = remapDatasetIds(pending, renamed);
        }
      } else {
        errors.push(`${ds.label}: ${res.error ?? 'could not be opened'}`);
      }
    } catch (error) {
      errors.push(`${ds.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (reopened.length) await restoreReferences(reopened, errors);
  if (reopened.length) await restoreDerivedLayers(reopened, errors);
  // The history slice then re-applies the current step.
  if (errors.length) store.getState().setError(`Undo could not reopen or close every dataset — ${errors.join('; ')}`);
}
