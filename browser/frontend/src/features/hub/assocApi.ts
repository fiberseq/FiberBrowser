/**
 * Association runs (DESIGN §7, hub A2): the request the hub sends to POST /api/hub/assoc/jobs, and the result the
 * backend returns (FiberHMM's `fiberhmm.assoc` dict plus display tables and plain-language limits).
 */
import { fetchJson } from '../../api/sharedFetch';

export type AssocMode = 'M1' | 'M2' | 'M3' | 'M4';

export const MODE_LABELS: Record<AssocMode, string> = {
  M1: 'Same molecules: is B\'s state linked to A\'s state?',
  M2: 'Does a measure of the molecules differ when A is open (or bound)?',
  M3: 'Is B denser inside A than outside, on the same molecules?',
  M4: 'Are B hits nearer A hits than chance?',
};
export const MODE_SHORT: Record<AssocMode, string> = { M1: 'Co-occurrence', M2: 'Conditional response', M3: 'Within-molecule rate', M4: 'Overlap and distance' };
export const MODE_UNITS: Record<AssocMode, string> = {
  M1: 'pair of hits (A, B) × molecule spanning both', M2: 'anchor × molecule', M3: 'molecule × inside / outside A', M4: 'hit',
};

export interface AssocInlineHit {
  hitId: string; chrom: string; start: number; end: number; anchor: number; strand?: '+' | '-'; label?: string;
  frame?: { kind: string }; target?: { chrom: string; start: number; end: number; anchor: number; insertion?: boolean };
  values?: Record<string, Record<string, { v: number | null }>>; legacyRefs?: Array<Record<string, unknown>>;
}

export interface AssocSetRef {
  kind: 'scan' | 'inline' | 'anchors' | 'marks' | 'tf';
  setId?: string;
  typeId?: string;
  label?: string;
  hits?: AssocInlineHit[];
  anchors?: Array<{ chrom: string; pos: number; start?: number; end?: number; strand?: '+' | '-'; label?: string; hitId?: string; insertion?: boolean }>;
  /** A browser set's coverage: where it was computed (its absence means absence only there). */
  coverage?: Array<[string, number, number]>;
}

export type AssocResponse = { kind: 'phasing' } | { kind: 'scalar'; module: 'nuc' | 'nfr'; column: string };

export interface AssocGroup {
  kind: 'none' | 'dataset' | 'haplotype' | 'cluster';
  labels?: Record<string, Record<string, string>>;
  clusterRegions?: Array<[string, number, number]>;
  flank?: number;
  acceptPostSelection?: boolean;
}

export interface AssocScope {
  kind: 'view' | 'bed' | 'anchors' | 'scan';
  chrom?: string; start?: number; end?: number;
  bed?: string;
  anchors?: Array<[string, number]>;
  anchorSetId?: string;
  flank?: number;
}

export interface AssocOptions {
  maxDistance?: number; test?: 'adjusted' | 'strata'; density?: 'rho_read' | 'lambda_acc';
  nPerm?: number; nBoot?: number; seed?: number; frames?: Array<'anchor' | 'molecule'>; metric?: 'R_minus_null' | 'R';
  strataBed?: string; anchorBed?: string; heldOut?: boolean;
}

export interface AssocRequest {
  mode: AssocMode;
  a: AssocSetRef;
  b?: AssocSetRef;
  response?: AssocResponse;
  group?: AssocGroup;
  scope: AssocScope;
  datasets?: string[];
  options?: AssocOptions;
  label?: string;
  /** The §7.9 question this run answers (a preset), if any. */
  question?: string;
  /** Inline hits were cut when the run was kept (sessions stay small): it can't be run again as it was. */
  truncated?: boolean;
}

export interface AssocEffect {
  key: string; label: string; group?: string;
  estimate?: number | null; lo?: number | null; hi?: number | null; p?: number | null; n?: number | null;
  scale?: string; test?: string; descriptive?: boolean; status?: string;
  detail?: Record<string, unknown>;
  interaction?: AssocInteraction;
}

export interface AssocInteraction {
  groups?: string[]; reference?: string; p?: number | null; chi2?: number | null; df?: number; variance?: string;
  scale?: string; test?: string; statistic?: string; status?: string; note?: string;
  differences?: Array<{ group: string; reference: string; difference: number | null; se?: number | null; lo?: number | null;
    hi?: number | null; p_wald?: number | null; p_boot?: number | null }>;
}

export interface AssocRow {
  id: string; chrom?: string; pos?: number; pos2?: number; a?: string; b?: string; hitId?: string | null;
  estimate?: number | null; lo?: number | null; hi?: number | null; p?: number | null; q?: number | null; n?: number | null;
  table?: number[]; distance?: number; bin?: string; frame?: string; metric?: string; se?: number | null; shrunk?: number | null;
  /** A's span and strand on this genome (Use as anchors keeps them). */
  aStart?: number | null; aEnd?: number | null; aStrand?: '+' | '-' | null;
  /** A is a hit lifted from an assembly scan, or inside an insertion: its placement and carriage aren't in the row. */
  aLifted?: boolean | null;
  /** One state only at this pair (A or B): no odds ratio or p. */
  noContrast?: boolean;
  n1?: number; n0?: number; p_b1_given_a1?: number | null; p_b1_given_a0?: number | null;
}

export interface AssocCurveRow { d: number; observed: number | null; null_mean: number | null; null_sd?: number | null; o_over_e: number | null; z: number | null; p_descriptive: number | null; n_used: number; n_censored?: number }
export interface AssocCurve { rows: AssocCurveRow[]; status?: string;
  histogram?: { edges: number[]; observed: number[]; null_mean: number[]; observed_overflow?: number; null_mean_overflow?: number; note?: string } | null }

export interface AssocResult {
  status: 'ok' | 'refused' | 'empty';
  mode: AssocMode; modeLabel?: string; unit?: string;
  scope?: { kind: string; regions: Array<[string, number, number]>; nRegions: number };
  limits?: string[];
  inputs?: Record<string, unknown>;
  effects?: AssocEffect[];
  anchors?: AssocRow[];
  curve?: Record<string, AssocCurve>;
  distances?: Array<Record<string, number | null>>;
  postSelection?: { status: 'ok' | 'refused' | 'post-selection'; overlaps?: unknown[]; note?: string; clusterRegions?: number } | null;
  cli?: string | null;
  /** Group key (a dataset id) -> its display name. */
  groupNames?: Record<string, string>;
  /** FiberHMM's own result (rows moved to `anchors`). */
  result?: Record<string, unknown>;
}

export interface AssocJob {
  job_id: string; status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'complete' | 'error';
  stage?: string; message?: string; created_at: number; finished_at?: number; error?: string;
  mode: AssocMode; definition?: AssocRequest; result?: AssocResult;
  progress?: { completed?: number; total?: number; fraction?: number | null; stage?: string } | null;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const submitAssoc = (request: AssocRequest) => fetchJson<AssocJob>('/api/hub/assoc/jobs', json(request));
export const getAssocJob = (jobId: string) => fetchJson<AssocJob>(`/api/hub/assoc/jobs/${encodeURIComponent(jobId)}`);
export const cancelAssocJob = (jobId: string) => fetchJson<AssocJob>(`/api/hub/assoc/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
