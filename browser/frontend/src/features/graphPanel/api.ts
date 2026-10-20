/** Graph panel endpoints (routers/graph_panel.py). Queries name a registration and its revisions, never a path. */
import type { GraphApiError, GraphRegistration, GraphStatus, GraphSubgraphResponse, GraphRevisions, Span } from './types';

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
}

export function querySubgraph(q: SubgraphQuery, signal?: AbortSignal): Promise<GraphSubgraphResponse> {
  return call('/api/graph/subgraph', {
    method: 'POST', signal,
    body: JSON.stringify({
      registration_id: q.registrationId, revisions: q.revisions, request_id: q.requestId, panel_id: q.panelId,
      generation: q.generation, target: q.target, interval: q.interval, selected: q.selected, context_bp: q.contextBp,
      snarls: 'none',
    }),
  });
}

/** Tell the server this subscriber left (its last subscriber leaving kills the running helper job). */
export function cancelSubgraph(requestId: string): void {
  void fetch(`/api/graph/requests/${encodeURIComponent(requestId)}`, { method: 'DELETE', credentials: 'include', keepalive: true })
    .catch(() => { /* the server may be gone */ });
}
