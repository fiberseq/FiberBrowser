/** Graph panel endpoints (routers/graph_panel.py). Queries name a registration and its revisions, never a path. */
import type { GraphApiError, GraphReadBinding, GraphReadsResponse, GraphRegistration, GraphStatus, GraphSubgraphResponse, GraphRevisions, Span } from './types';

export class GraphRequestError extends Error {
  constructor(public status: number, public error: GraphApiError) {
    super(error.message);
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error: GraphApiError = body?.error ?? { code: `http_${response.status}`, message: text.slice(0, 200) || response.statusText, retryable: response.status >= 500 };
    throw new GraphRequestError(response.status, error);
  }
  return body as T;
}

export function getGraphStatus(signal?: AbortSignal): Promise<GraphStatus> {
  return call('/api/graph/status', { signal });
}

export async function registerGraphPackage(packageDir: string): Promise<GraphRegistration> {
  const out = await call<{ registration: GraphRegistration }>('/api/graph/registrations', {
    method: 'POST', body: JSON.stringify({ package: packageDir }) });
  return out.registration;
}

/** Forget a registered package (host-only, like registering one). */
export function unregisterGraphPackage(registrationId: string): Promise<{ registration_id: string; removed: boolean }> {
  return call(`/api/graph/registrations/${encodeURIComponent(registrationId)}`, { method: 'DELETE' });
}

export interface SubgraphQuery {
  registrationId: string;
  revisions: GraphRevisions;
  requestId: string;
  panelId: string;
  generation: number;
  target: string;
  interval: Span;
  selected: string[];
  contextBp: number;
  /** Named visits walked beyond each window edge (anchors for events exactly at an edge). */
  flankBp?: number;
}

export function querySubgraph(q: SubgraphQuery, signal?: AbortSignal): Promise<GraphSubgraphResponse> {
  return call('/api/graph/subgraph', {
    method: 'POST', signal,
    body: JSON.stringify({
      registration_id: q.registrationId, revisions: q.revisions, request_id: q.requestId, panel_id: q.panelId,
      generation: q.generation, target: q.target, interval: q.interval, selected: q.selected, context_bp: q.contextBp,
      snarls: 'none', ...(q.flankBp ? { flank_bp: q.flankBp } : {}),
    }),
  });
}

/** Tell the server this subscriber left (its last subscriber leaving kills the running helper job). */
export function cancelSubgraph(requestId: string): void {
  void fetch(`/api/graph/requests/${encodeURIComponent(requestId)}`, { method: 'DELETE', credentials: 'include', keepalive: true })
    .catch(() => { /* the server may be gone */ });
}

/** Loaded datasets and the package paths each binds to through explicit identities. */
export async function getReadBindings(registrationId: string, signal?: AbortSignal): Promise<GraphReadBinding[]> {
  const out = await call<{ bindings: GraphReadBinding[] }>(`/api/graph/read_bindings?registration_id=${encodeURIComponent(registrationId)}`, { signal });
  return out.bindings;
}

export interface ReadsQuery {
  registrationId: string;
  revisions: GraphRevisions;
  requestId: string;
  panelId: string;
  generation: number;
  datasets: { dataset_id: string; revision: string }[];
  /** Each selected path's source windows (the topology response's `paths[].windows`). */
  paths: { binding: string; windows: Span[] }[];
  limits?: { molecules?: number; marks?: number; level?: number };
  /** QNAMEs kept in the sample whatever its level and cap (a host's members' filters, selections, highlights). */
  pins?: string[];
}

export function queryReads(q: ReadsQuery, signal?: AbortSignal): Promise<GraphReadsResponse> {
  return call('/api/graph/reads', {
    method: 'POST', signal,
    body: JSON.stringify({ registration_id: q.registrationId, revisions: q.revisions, request_id: q.requestId,
      panel_id: q.panelId, generation: q.generation, datasets: q.datasets, paths: q.paths, ...(q.limits ? { limits: q.limits } : {}), ...(q.pins?.length ? { pins: q.pins } : {}) }),
  });
}

export interface GraphSequenceResult {
  binding: string;
  coverage: { span: Span; kind: string }[];
  pieces: { span: Span; sequence: string }[];
  complete: boolean;
}

/** A path interval's bases from the package (at most 60,000 bp). */
export async function getGraphSequence(registrationId: string, revisions: GraphRevisions, binding: string, interval: Span,
  signal?: AbortSignal): Promise<GraphSequenceResult> {
  const out = await call<{ result: GraphSequenceResult }>('/api/graph/sequence', { method: 'POST', signal,
    body: JSON.stringify({ registration_id: registrationId, revisions, binding, interval }) });
  return out.result;
}

export interface GraphCanonicalMatch { dataset_id: string; label: string; id: string; revision: string; kind: string;
  hap_label?: string; ref_bp: number; alt_bp: number; t_start: number; t_end: number }
export interface GraphCanonicalResponse {
  matches: GraphCanonicalMatch[];
  rejected: { dataset_id: string; label: string; reason: string; message: string; id?: string }[];
  map: { target: string; source: string; manifest_sha256: string | null } | null;
  reason?: string;
}

/** A graph allele's canonical live-lift difference (exact map, boundary and placement only). */
export function getGraphCanonical(q: { registrationId: string; revisions: GraphRevisions; target: string; path: string;
  targetSpan: Span; sourceSpan: Span }, signal?: AbortSignal): Promise<GraphCanonicalResponse> {
  return call('/api/graph/differences', { method: 'POST', signal, body: JSON.stringify({
    registration_id: q.registrationId, revisions: q.revisions, target: q.target, path: q.path,
    target_span: q.targetSpan, source_span: q.sourceSpan }) });
}
