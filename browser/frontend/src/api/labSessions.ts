/** The lab session shelf of a lab server (backend routers/lab.py): saved sessions every member can open. */
import { exportSession } from './session';
import { fetchJson } from './sharedFetch';

export interface LabSessionSummary {
  id: string;
  name: string;
  user: string;
  created: number;
  updated: number;
  datasets: number | null;
  viewport: { chrom?: string; start?: number; end?: number } | null;
}

export async function listLabSessions(): Promise<LabSessionSummary[]> {
  const body = await fetchJson<{ sessions: LabSessionSummary[] }>('/api/lab/sessions', { method: 'GET', cache: 'no-store' });
  return body.sessions ?? [];
}

export async function getLabSession(id: string): Promise<Record<string, unknown>> {
  const body = await fetchJson<{ session: Record<string, unknown> }>(`/api/lab/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' });
  return body.session;
}

/** Save the current session on the lab shelf under `name`. */
export async function saveLabSession(name: string): Promise<LabSessionSummary> {
  const blob = await exportSession();
  const session = JSON.parse(await blob.text()) as Record<string, unknown>;
  const body = await fetchJson<LabSessionSummary & { success: boolean; detail?: string; message?: string }>('/api/lab/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, session }),
  });
  if (!body.success) throw new Error(body.detail || body.message || 'Could not save the session');
  return body;
}

export async function deleteLabSession(id: string): Promise<void> {
  await fetchJson(`/api/lab/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
