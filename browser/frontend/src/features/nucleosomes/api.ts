/** The nucleosome panel's routes (browser/routers/nuc.py). */
import { fetchJson } from '../../api/sharedFetch';
import type { NucDatasetStatus, NucJob, NucObservation, NucObservationSummary } from './types';

const json = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
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
  workers?: number;
}

export const submitNucJob = (request: NucJobRequest) => fetchJson<NucJob>('/api/nuc/jobs', json(request));
export const getNucJob = (jobId: string) => fetchJson<NucJob>(`/api/nuc/jobs/${encodeURIComponent(jobId)}`);
export const cancelNucJob = (jobId: string) => fetchJson<NucJob>(`/api/nuc/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });

/** The server's per-observation summaries (only the descriptor fields it reads are sent). */
export const nucSummary = (observations: NucObservation[], signal?: AbortSignal, includeDuplicates = false) =>
  fetchJson<{ observations: NucObservationSummary[] }>('/api/nuc/summary', json({
    include_duplicates: includeDuplicates,
    observations: observations.map(o => ({
      obsId: o.obsId, label: o.label, datasetId: o.datasetId, kind: o.kind, chrom: o.chrom, start: o.start, end: o.end,
      ...(o.liftHap ? { liftHap: o.liftHap } : {}), ...(o.strand ? { strand: o.strand } : {}),
      ...(o.readIds ? { readIds: o.readIds } : {}), ...(o.graph ? { graph: o.graph } : {}),
    })),
  }, signal));
