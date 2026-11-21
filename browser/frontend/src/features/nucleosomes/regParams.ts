/**
 * The Regularity view's effective settings, shared by the panel (RegularityView, PatchGeometryView) and the cluster
 * views (cluster-detail/useClusterRegularity, useClusterGeometries): requests always carry the complete settings the
 * controls show, so an answer never depends on what another tab, panel or session asked last (the server keeps one
 * lane parameter set per file).
 *
 * Also the series identity every request key uses: membership enters through a digest of the sorted read ids (two
 * cohorts of equal size are different requests), with strand, haplotype, kind and cluster.
 */
import { stableId } from '../graphPanel/graphCluster';
import type { NucAutoAnalyse, NucCohort, NucObservation, NucPanelState, NucPatchSettings, NucRegularityParams } from './types';
import { cohortOf } from './types';
import { DEFAULT_AUTO_ANALYSE } from './firstOpen';

/** FiberHMM's RegularityParams defaults (fiberhmm.nuc.regularity), as the controls show them (0 = masking/thinning off). */
export const DEFAULT_REG_PARAMS: Required<Omit<NucRegularityParams, 'mask_open_bp' | 'thin_per_kb'>> & { mask_open_bp: number; thin_per_kb: number } = {
  window_bp: 2000, step_bp: 250, signal: 'm6a', band_bp: [140, 260], min_calls: 15, mask_open_bp: 0, thin_per_kb: 0,
  ends: 'blank', end_min_bp: 1000, short_min_bp: 1000,
};

export type ShownRegParams = typeof DEFAULT_REG_PARAMS;

/** The parameters the controls show: the panel's own over FiberHMM's defaults. */
export function shownRegParams(params: NucRegularityParams | null | undefined): ShownRegParams {
  const p = { ...DEFAULT_REG_PARAMS, ...(params ?? {}) } as ShownRegParams;
  if (p.mask_open_bp == null) p.mask_open_bp = 0;
  if (p.thin_per_kb == null) p.thin_per_kb = 0;
  return p;
}

/** The complete parameter set a request sends (masking and thinning off as null, as the server reads them). Two
 * settings objects that show the same values give the same request, whether or not the panel ever edited one. */
export function requestRegParams(params: NucRegularityParams | null | undefined): Required<NucRegularityParams> {
  const p = shownRegParams(params);
  return {
    window_bp: p.window_bp, step_bp: p.step_bp, signal: p.signal, band_bp: [p.band_bp[0], p.band_bp[1]], min_calls: p.min_calls,
    mask_open_bp: p.mask_open_bp > 0 ? p.mask_open_bp : null, thin_per_kb: p.thin_per_kb > 0 ? p.thin_per_kb : null,
    ends: p.ends, end_min_bp: p.end_min_bp, short_min_bp: p.short_min_bp,
  };
}

/** A series (an observation or one cluster of it) for request keys. */
type KeyedSeries = Pick<NucObservation, 'obsId' | 'datasetId' | 'kind' | 'chrom' | 'start' | 'end' | 'liftHap' | 'strand' | 'readIds'> & { cluster?: number };

/** A key that changes whenever a series' identity, scope or membership changes (planner.observationsKey plus the
 * cluster): equal-sized but different read sets are different keys. */
export function seriesIdentity(series: readonly KeyedSeries[]): string {
  return JSON.stringify(series.map(o => [o.obsId, o.datasetId, o.kind, o.chrom, o.start, o.end, o.liftHap ?? null,
    o.strand ?? null, o.cluster ?? null, o.readIds ? `${o.readIds.length}:${stableId([...o.readIds].sort())}` : null]));
}

/** The view a series set covers (datasets and windows, not membership): what "the view moved" means for the
 * automatic Analyse. A cluster or filter change keeps the view. */
export function seriesView(series: readonly KeyedSeries[]): string {
  return JSON.stringify([...new Set(series.map(o => `${o.datasetId}|${o.chrom}|${o.start}|${o.end}|${o.liftHap ?? ''}`))].sort());
}

export interface NucViewSettings {
  /** The nucleosome panel these settings come from (null: none open, FiberHMM's defaults). */
  panelId: string | null;
  regularity: Required<NucRegularityParams>;
  cohort: NucCohort;
  patches: NucPatchSettings;
  /** The panel's nucleosome analysis parameters (its Analyse). */
  analysis?: Record<string, unknown>;
  autoAnalyse: NucAutoAnalyse;
}

/** The settings the cluster views compute with: the first open nucleosome panel's (the one whose Regularity view
 * they mirror), else FiberHMM's defaults. Never "whatever the server used last". */
export function clusterViewNucSettings(panels: ReadonlyArray<{ id: string; contentType?: string; nucleosomes?: NucPanelState }>): NucViewSettings {
  const panel = panels.find(p => p.contentType === 'nucleosomes') ?? null;
  const reg = panel?.nucleosomes?.regularity ?? {};
  return {
    panelId: panel?.id ?? null,
    regularity: requestRegParams(reg.params),
    cohort: cohortOf(reg),
    patches: reg.patches ?? {},
    ...(panel?.nucleosomes?.parameters ? { analysis: panel.nucleosomes.parameters } : {}),
    autoAnalyse: reg.autoAnalyse ?? DEFAULT_AUTO_ANALYSE,
  };
}
