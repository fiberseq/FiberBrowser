/**
 * The read rows' FiberHMM variant-layer overlay for a panel's view: fetched only while a layer is on for the
 * dataset (debounced, the previous request cancelled), cached per request.
 */
import { useEffect, useMemo, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchJson } from '../../api/sharedFetch';
import type { Dataset } from '../../types/dataset';
import type { CompactRead, SvSummary } from '../../components/tracks/read-track/types';
import {
  datasetVariantLayers, mergeOverlay, overlayQuery, type FiberhmmLayerSettings, type FiberhmmOverlay, type FiberhmmRead,
} from './model';
import { useLayerSettings } from './state';

const DEBOUNCE_MS = 250;
const MAX_CACHED = 24;
const cache = new Map<string, FiberhmmOverlay>();

function remember(url: string, overlay: FiberhmmOverlay) {
  cache.set(url, overlay);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
}

export interface FiberhmmReadLayers {
  settings: FiberhmmLayerSettings;
  /** A layer is on and the dataset has it. */
  active: boolean;
  svActive: boolean;
  overlay: FiberhmmOverlay | null;
  error: string | null;
}

export function useFiberhmmReadLayers(dataset: Pick<Dataset, 'id' | 'data_type' | 'companion_layers' | 'layer_type'> | undefined,
  chrom: string, start: number, end: number, minSvLen: number): FiberhmmReadLayers {
  const has = datasetVariantLayers(dataset);
  const raw = useLayerSettings(dataset?.id);
  const settings = useMemo(() => ({ ...raw, sv: raw.sv && has.sv, var: raw.var && has.var }), [raw, has.sv, has.var]);
  // The read track's read set (QC-fail choice; Min footprints' "All reads, including uncalled").
  const includeQcfail = useBrowserStore(s => Boolean(s.showQcFailReads));
  const hideUncalled = useBrowserStore(s => s.minFootprints !== -1);
  const includeDuplicates = useBrowserStore(s => Boolean(s.showDuplicateReads));
  const url = dataset ? overlayQuery(dataset.id, chrom, start, end, settings, minSvLen,
    { includeQcfail, hideUncalled, includeDuplicates }) : null;
  const [state, setState] = useState<{ url: string; overlay: FiberhmmOverlay | null; error: string | null }>({ url: '', overlay: null, error: null });

  useEffect(() => {
    if (!url) return;
    const hit = cache.get(url);
    if (hit) { setState({ url, overlay: hit, error: null }); return; }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      fetchJson<FiberhmmOverlay>(url, { signal: ctrl.signal })
        .then(overlay => { remember(url, overlay); if (!ctrl.signal.aborted) setState({ url, overlay, error: null }); })
        .catch(err => {
          if (ctrl.signal.aborted || (err as { name?: string })?.name === 'AbortError') return;
          setState({ url, overlay: null, error: String((err as Error)?.message ?? err).replace(/^API error \d+: /, '') });
        });
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [url]);

  // The last overlay of this dataset and chromosome stays drawn while the next one loads (no flicker on pan).
  const overlay = url && state.overlay && state.overlay.dataset_id === dataset?.id && state.overlay.region.chrom === chrom ? state.overlay : null;
  return { settings, active: Boolean(url), svActive: Boolean(url) && settings.sv, overlay, error: url && state.url === url ? state.error : null };
}

/** The panel's reads with the overlay merged on (the same array when nothing is on). */
export function useMergedReads(reads: CompactRead[], layers: FiberhmmReadLayers, start: number, end: number): FiberhmmRead[] {
  const { overlay, settings, active } = layers;
  const showDuplicates = useBrowserStore(s => Boolean(s.showDuplicateReads));
  return useMemo(() => (active ? mergeOverlay(reads, overlay, settings, start, end, { showDuplicates }) : reads),
    [reads, overlay, settings, active, start, end, showDuplicates]);
}

/** The SV band's summary: the overlay's while the SV layer is on, else the payload's. */
export function overlaySvSummary(layers: FiberhmmReadLayers, payload: SvSummary | null | undefined): SvSummary | null {
  if (layers.svActive) return layers.overlay?.sv_summary ?? null;
  return payload ?? null;
}
