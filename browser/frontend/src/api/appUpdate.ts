/**
 * The app's own settings and its update check (backend routers/app_info.py, services/app_update.py).
 *
 * Plain fetches, not sharedFetch's: the GitHub token a person pastes must never reach the activity log.
 */

export interface FiberhmmSelection {
  packaged: boolean;
  requested: { source: string; path: string | null };
  source: 'env' | 'app' | 'settings' | 'bundled' | 'installed';
  source_label: string;
  root: string | null;
  package_dir: string | null;
  version: string | null;
  bundled: { path: string | null; version: string | null; kind: string };
  requirements: string[];
  missing: string[];
  notices: string[];
  app_choice: { source: 'bundled' | 'custom'; custom_path: string; restart_needed: boolean } | null;
  running?: { available: boolean; version: string | null; path: string | null };
}

export interface AuthStatus {
  gh: { installed: boolean; signed_in: boolean };
  keychain: { name: string; available: boolean; reason: string | null; has_token: boolean };
  device_flow: { configured: boolean };
}

export interface AppInfo {
  version: string;
  packaged: boolean;
  build: { channel?: string; version?: string; build?: string; platform?: string } | null;
  platform: string;
  fiberhmm: FiberhmmSelection;
  updates: {
    check_at_startup: boolean;
    manifest_url: string;
    repo: string;
    channel: string;
    source: 'manifest' | 'github';
    where: string;
    manifest_from: string | null;
    private: boolean;
    disabled: string | null;
    pip_command: string;
    /** The check at startup when Settings haven't set it: on in a packaged app, off in a source run or pip install. */
    check_at_startup_default?: boolean;
    /** Settings set the check at startup (else it follows the kind of run). */
    check_at_startup_set?: boolean;
  };
  auth: AuthStatus | null;
}

export type UpdateStatus =
  | 'update_available' | 'up_to_date' | 'disabled' | 'auth_required' | 'auth_invalid' | 'not_published' | 'error';

export interface UpdateCheck {
  status: UpdateStatus;
  current: string;
  build: string | null;
  channel: string;
  packaged: boolean;
  platform: string;
  where: string;
  private: boolean;
  message: string | null;
  latest?: string;
  latest_build?: string | null;
  released?: string | null;
  notes?: string | null;
  notes_url?: string | null;
  from?: string | null;
  token_source?: string | null;
  pip_command?: string;
  download?: { name: string; kind: string; size: number | null; sha256: string } | null;
  cached?: boolean;
}

export interface DownloadStatus {
  state: 'idle' | 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
  name?: string;
  version?: string;
  received?: number;
  total?: number | null;
  path?: string | null;
  error?: string | null;
  sha256?: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...(init ?? {}), credentials: 'include', cache: 'no-store' });
  let body: unknown = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  if (!response.ok) {
    const detail = (body as { detail?: unknown; message?: unknown } | null);
    const text = typeof detail?.detail === 'string' ? detail.detail : typeof detail?.message === 'string' ? detail.message : '';
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const getAppInfo = () => call<AppInfo>('/api/app/info');

export const setFiberhmmChoice = (source: 'bundled' | 'custom', customPath = '') =>
  call<AppInfo & { checked: { path: string; version: string | null; missing: string[] } | null }>(
    '/api/app/fiberhmm', json({ source, custom_path: customPath }));

export const checkForUpdates = ({ startup = false, force = false } = {}) =>
  call<UpdateCheck>(`/api/app/update?startup=${startup ? 1 : 0}&force=${force ? 1 : 0}`);

export const setUpdateSettings = (values: Partial<{ check_at_startup: boolean; manifest_url: string; repo: string }>) =>
  call<AppInfo>('/api/app/update/settings', json(values));

export const saveGithubToken = (token: string) => call<{ auth: AuthStatus }>('/api/app/update/token', json({ token }));

export const removeGithubToken = () => call<{ auth: AuthStatus }>('/api/app/update/token', { method: 'DELETE' });

export const startUpdateDownload = () => call<DownloadStatus>('/api/app/update/download', { method: 'POST' });

export const getUpdateDownload = () => call<DownloadStatus>('/api/app/update/download');

export const cancelUpdateDownload = () => call<DownloadStatus>('/api/app/update/download/cancel', { method: 'POST' });

export const openUpdateDownload = () => call<{ opened: string }>('/api/app/update/open', { method: 'POST' });
