/** The nucleosome panel's routes (browser/routers/nuc.py). */
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import type { NucDatasetStatus, NucJob, NucObservation } from './types';

/** The toolbar's Show QC-fail reads (incl. FiberHMM chimeras), sent wherever the duplicate policy is. */
export const includeQcFail = () => Boolean(useBrowserStore.getState().showQcFailReads);

const withReadPolicy = (body: unknown) => (body && typeof body === 'object' && 'include_duplicates' in body
  && !('include_qcfail' in body) ? { ...body, include_qcfail: includeQcFail() } : body);

const json = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withReadPolicy(body)), ...(signal ? { signal } : {}),
});

export const nucAvailable = () => fetchJson<{ available: boolean; reason?: string; fiberhmm?: string; version?: string;
  settingsHash?: string; experimental?: boolean }>('/api/nuc/available');

export const nucStatus = (datasets: string[], parameters?: Record<string, unknown>, includeDuplicates = false) =>
  fetchJson<{ available: boolean; reason?: string; settingsHash?: string; version?: string; datasets: NucDatasetStatus[] }>(
    '/api/nuc/status', json({ datasets, include_duplicates: includeDuplicates, ...(parameters ? { parameters } : {}) }));

export interface NucJobRequest {
  datasets: string[];
  /** One view (all datasets), or each dataset's own views (a live-lift view resolves to source windows). */
  chrom?: string; start?: number; end?: number;
  views?: Array<{ datasetId: string; chrom: string; start: number; end: number }>;
  sourceRegions?: Array<{ datasetId: string; contig: string; start: number; end: number }>;
  parameters?: Record<string, unknown>;
  include_duplicates?: boolean;
  include_qcfail?: boolean;
  workers?: number;
}

export const submitNucJob = (request: NucJobRequest) => fetchJson<NucJob>('/api/nuc/jobs', json(request));
export const listNucJobs = () => fetchJson<{ jobs: NucJob[] }>('/api/nuc/jobs');
export const getNucJob = (jobId: string) => fetchJson<NucJob>(`/api/nuc/jobs/${encodeURIComponent(jobId)}`);
export const cancelNucJob = (jobId: string) => fetchJson<NucJob>(`/api/nuc/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });

const descriptor = (o: NucObservation) => ({
  obsId: o.obsId, label: o.label, datasetId: o.datasetId, kind: o.kind, chrom: o.chrom, start: o.start, end: o.end,
  ...(o.liftHap ? { liftHap: o.liftHap } : {}), ...(o.strand ? { strand: o.strand } : {}),
  ...(o.readIds ? { readIds: o.readIds } : {}), ...(o.graph ? { graph: o.graph } : {}),
});

/**
 * Who sends a request, for the server's cancellation and lane rules (never part of a saved or replayed request):
 *
 * - `requestScope`: the panel, prefixed with this page's instance id, so two browser tabs restored from one saved
 *   session (same panel ids) never cancel each other's requests nor share lane-choice history;
 * - `adopt: false`: a request that must never move the datasets' lane parameters nor relabel the patch lane (the
 *   cluster views: they mirror a nucleosome panel's settings, and their pooled cohort is the clustered series).
 */
export interface NucScope { scope: string; adopt: boolean }

function makeInstanceId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID().slice(0, 13);
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
/** This page's instance (a new one per tab and per load; never saved). */
export const TAB_INSTANCE = makeInstanceId();
/** A nucleosome panel's own requests: its scope in this tab; its parameter changes move the lanes. */
export const panelScope = (panelId: string): NucScope => ({ scope: `${TAB_INSTANCE}:${panelId}`, adopt: true });
/** The cluster views' requests mirroring a panel: a `cluster:` scope (the server's non-adopting scopes: computed with
 * their own settings, never moving or relabelling the lanes, never cancelling the panel's or each other's requests),
 * and `adopt: false` as well. */
export const clusterViewScope = (panelId: string | null | undefined): NucScope =>
  ({ scope: `cluster:${TAB_INSTANCE}:${panelId ?? 'none'}`, adopt: false });
/** The routing fields of a request (a bare string is a panel id). */
export function scopeFields(requestScope?: string | NucScope | null): { requestScope?: string; adopt?: false } {
  if (!requestScope) return {};
  const s = typeof requestScope === 'string' ? panelScope(requestScope) : requestScope;
  return { requestScope: s.scope, ...(s.adopt ? {} : { adopt: false as const }) };
}

/** The server's detail on a request dropped for a newer one (browser/routers/nuc.py SUPERSEDED). */
export const SUPERSEDED_DETAIL = 'Replaced by a newer analysis';

/**
 * A nucleosome read-side request (regularity, geometries) the server dropped because a newer request of the
 * same panel, or an Analyse of its datasets, replaced it: an expected outcome, never an error to show. The caller
 * keeps what it shows and asks again once the newer state settles (`nucJob.resyncAfterSuperseded`).
 */
export function isSupersededNuc(e: unknown): boolean {
  const err = e as { status?: unknown; detail?: unknown; message?: unknown } | null | undefined;
  if (!err) return false;
  if (err.status === 409) return err.detail === undefined || err.detail === SUPERSEDED_DETAIL;
  return String(err.message ?? '') === `API error 409: ${SUPERSEDED_DETAIL}`;
}

/** The Regularity view per observation (one per cluster and dataset), computed with `parameters` (nucreg tiles are
 * computed, never a recalibration). They become the datasets' lane parameters when this panel (`requestScope`, the
 * panel id) changed them since its last request; the same panel's next request replaces this one on the server. */
export const nucRegularity = (observations: Array<NucObservation & { cluster?: number }>,
  parameters: import('./types').NucRegularityParams | undefined, cohort: import('./types').NucCohort, includeDuplicates = false,
  signal?: AbortSignal, perMolecule = false, requestScope?: string | NucScope) =>
  fetchJson<import('./types').NucRegularityResult>('/api/nuc/regularity', json({
    observations: observations.map(o => ({ ...descriptor(o), ...(o.cluster !== undefined ? { cluster: o.cluster } : {}) })),
    ...(parameters ? { parameters } : {}), cohort, spanning: cohort === 'spanning', include_duplicates: includeDuplicates,
    ...(perMolecule ? { per_molecule: true } : {}), ...scopeFields(requestScope),
  }, signal));

export interface NucGeometryBody {
  patches?: import('./types').NucPatchParams; regularity?: import('./types').NucRegularityParams;
  reference?: Record<string, number | string | null>; cohort: import('./types').NucCohort; site?: number | null;
  siteState?: 'nfr' | 'tf';
  show?: 'patch' | 'low' | 'score'; includeDuplicates?: boolean;
  /** The panel's nucleosome analysis parameters (its Analyse): a replay after a server restart analyses the view with
   * them first. Never read by /api/nuc/geometries itself. */
  analysis?: Record<string, unknown>;
}

/** The request body of /api/nuc/geometries: what the panel sends, and what the hub's geometry states replay. */
export const geometryRequestBody = (observations: Array<NucObservation & { cluster?: number }>, body: NucGeometryBody) => ({
  observations: observations.map(o => ({ ...descriptor(o), ...(o.cluster !== undefined ? { cluster: o.cluster } : {}) })),
  patches: body.patches ?? {}, ...(body.regularity ? { regularity: body.regularity } : {}),
  ...(body.reference ? { reference: body.reference } : {}), cohort: body.cohort, spanning: body.cohort === 'spanning',
  ...(body.site != null ? { site: body.site } : {}), site_state: body.siteState ?? 'nfr', show: body.show ?? 'patch',
  include_duplicates: !!body.includeDuplicates, include_qcfail: includeQcFail(),
  ...(body.analysis ? { analysis: body.analysis } : {}),
});
export type NucGeometryRequest = ReturnType<typeof geometryRequestBody>;

/** The Regularity view's patch section: patches, shared geometries (fold mode), carrier shares per observation,
 * nested pairs, read groups and the association of carriage with a site's NFR or TF state. */
export const nucGeometries = (observations: Array<NucObservation & { cluster?: number }>, body: NucGeometryBody, signal?: AbortSignal,
  requestScope?: string | NucScope) =>
  postGeometries(geometryRequestBody(observations, body), signal, requestScope);

/** The routing (`scopeFields`: the panel in this tab, `adopt`) is not part of the replayable request: it names the
 * panel whose next request replaces this one, and whether its parameter changes move the lanes. */
export const postGeometries = (request: NucGeometryRequest, signal?: AbortSignal, requestScope?: string | NucScope) =>
  fetchJson<import('./types').NucGeometryResult>('/api/nuc/geometries', json({ ...request, ...scopeFields(requestScope) }, signal));
