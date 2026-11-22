/**
 * Browser actions a notebook queues (BrowserClient.queue_browser_actions and its wrappers) for features added since
 * 3.0: the meta-locus (open a BED as a pool, More reads, Resample, Find more like this, back to the real locus) and
 * Plots (Keep the builder's plot in the Gallery). Each does what its button does. Returns null for other types.
 */
import { useBrowserStore } from '../stores/browserStore';
import {
  backToRealLocus, clearExtra, DEFAULT_FLANK, findMoreLikeThis, moreReads, MORE_STEP, openMetaLocus, resample,
  returnToMetaLocus, selectedReadsByDataset, useMetaLocusStore,
} from '../features/metaLocus/metaLocusStore';
import type { MetaLocusSpec } from '../features/metaLocus/api';
import { META_LOCUS_PREVIEW } from '../features/metaLocus/preview';
import { previewHidden, setPreviewsEnabled } from '../utils/previewFeatures';
import { useGalleryStore, workingFor } from '../features/plots/gallery';
import { keepPlotEntry } from '../features/plots/galleryActions';

type Action = { type: string; [key: string]: unknown };

const ANCHORS = new Set(['centre', 'start', 'end']);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The meta-locus is a Preview feature: a notebook turns Preview on with enable_preview, as Settings does. */
function metaLocusAllowed(action: Action): string | null {
  if (!previewHidden(META_LOCUS_PREVIEW)) return null;
  if (action.enable_preview === true) { setPreviewsEnabled(true); return null; }
  return `${action.type}: the meta-locus is a Preview feature; turn on Preview features in Settings or pass enable_preview=True.`;
}

export function metaLocusSpecFromAction(action: Action): MetaLocusSpec | { error: string } {
  const bed = str(action.bed_path);
  if (!bed) return { error: 'open_meta_locus needs bed_path (a BED file the server can read).' };
  const anchor = str(action.anchor) ?? 'centre';
  if (!ANCHORS.has(anchor)) return { error: `open_meta_locus: anchor must be centre, start or end (got ${anchor}).` };
  const flank = num(action.flank_bp) ?? DEFAULT_FLANK;
  const datasets = Array.isArray(action.dataset_ids) ? action.dataset_ids.filter((d): d is string => typeof d === 'string' && !!d) : [];
  return {
    bed_path: bed, anchor: anchor as MetaLocusSpec['anchor'], flank_bp: Math.max(0, Math.round(flank)),
    ...(str(action.name) ? { name: str(action.name) } : {}),
    ...(datasets.length ? { dataset_ids: datasets } : {}),
    ...(str(action.policy) ? { policy: str(action.policy) } : {}),
    ...(str(action.count_unit) ? { count_unit: str(action.count_unit) } : {}),
  };
}

export async function executeNotebookAction(action: Action): Promise<string | null> {
  const type = action.type;
  if (type === 'open_meta_locus') {
    const blocked = metaLocusAllowed(action);
    if (blocked) return blocked;
    const spec = metaLocusSpecFromAction(action);
    if ('error' in spec) return spec.error;
    const count = num(action.count);
    const seed = num(action.seed);
    await openMetaLocus(spec, {
      ...(count !== undefined ? { count: Math.max(1, Math.round(count)) } : {}),
      ...(seed !== undefined ? { seed: Math.max(0, Math.round(seed)) } : {}),
      navigate: action.navigate !== false,
    });
    const err = useMetaLocusStore.getState().error;
    if (err) throw new Error(err);
    return `Meta-locus opened from ${spec.bed_path}.`;
  }
  if (type === 'meta_locus_more_reads' || type === 'meta_locus_resample' || type === 'meta_locus_find_more'
    || type === 'meta_locus_clear_extra' || type === 'meta_locus_back' || type === 'meta_locus_return') {
    const blocked = metaLocusAllowed(action);
    if (blocked) return blocked;
    if (!useMetaLocusStore.getState().status) return `${type}: no meta-locus is open.`;
    if (type === 'meta_locus_more_reads') { await moreReads(Math.max(1, Math.round(num(action.count) ?? MORE_STEP))); return 'More reads added to the meta-locus.'; }
    if (type === 'meta_locus_resample') { const seed = num(action.seed); await resample(seed !== undefined ? Math.max(0, Math.round(seed)) : undefined); return `Meta-locus resampled (seed ${useMetaLocusStore.getState().seed}).`; }
    if (type === 'meta_locus_clear_extra') { await clearExtra(); return 'Added meta-locus reads taken out.'; }
    if (type === 'meta_locus_back') return backToRealLocus() ? 'Back at the real locus.' : 'meta_locus_back: not on the meta-locus.';
    if (type === 'meta_locus_return') return returnToMetaLocus() ? 'Back on the meta-locus.' : 'meta_locus_return: no meta-locus to return to.';
    // Find more like this: the selected reads (or the reads the notebook names, per dataset).
    const given = action.read_ids_by_dataset && typeof action.read_ids_by_dataset === 'object'
      ? action.read_ids_by_dataset as Record<string, string[]> : null;
    const reads = given ?? selectedReadsByDataset();
    const summary = await findMoreLikeThis(reads, Math.max(1, Math.round(num(action.k) ?? 200)));
    if (!summary) return 'meta_locus_find_more: select reads on a ready meta-locus first.';
    return `Find more like this: ${summary.requested} read(s) looked for.`;
  }
  if (type === 'plots_keep') {
    const ws = (useBrowserStore.getState() as unknown as { plotsWorkspace?: { current?: { id: string } } }).plotsWorkspace;
    const plotId = ws?.current?.id;
    const working = plotId ? workingFor(useGalleryStore.getState(), plotId) : null;
    if (!working) return 'plots_keep: the plot in Plots has no result yet (draw it first).';
    const kept = keepPlotEntry(working.id, str(action.name));
    return kept ? `Kept "${kept.name}" in the Gallery.` : 'plots_keep: nothing to keep.';
  }
  return null;
}
