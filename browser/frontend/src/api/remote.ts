import { fetchJson } from './sharedFetch';

const API_BASE = '/api/remote';

export interface SshHostEntry {
  alias: string;
  hostname?: string;
  user?: string;
}

export type RemoteConnectionState = 'starting' | 'authenticating' | 'connected' | 'error' | 'disconnected';

export interface RemoteConnection {
  source: string;
  target: string;
  host: string;
  user: string | null;
  /** The account ``ssh <host>`` signs in as (``ssh -G``), when known. */
  default_user?: string | null;
  effective_user?: string | null;
  /** How the helper is reached: a private Unix socket, or (fallback) a loopback port on the login node. */
  transport?: 'socket' | 'port' | null;
  state: RemoteConnectionState;
  message: string;
  error: string | null;
  /** The sign-in command to run in a terminal (password / Duo), while authenticating. */
  auth_command: string | null;
  terminal_opened: boolean;
  roots: string[];
  missing_roots: string[];
  home: string | null;
  remote_hostname: string | null;
  python: string | null;
  shared_master: boolean;
  own_master: boolean;
  latency_ms: number | null;
  rate_bps: number | null;
  bytes_served: number;
  ref_prefix: string;
}

export interface RemoteSourceInfo {
  scheme: string;
  label: string;
  available: boolean;
  problem: string | null;
  hosts?: SshHostEntry[];
  connections: RemoteConnection[];
  configured?: boolean;
  profile?: string | null;
}

export interface RemoteEntry {
  name: string;
  type: 'file' | 'dir';
  size: number | null;
  mtime: number | null;
  ref: string;
  kind: 'dir' | 'bam' | 'bigbed' | 'bigwig' | 'fasta' | 'map' | 'index' | 'annotation' | 'session' | 'other';
  openable?: boolean;
  has_index?: boolean;
  index?: string | null;
  link?: boolean;
}

export interface RemoteListing {
  success: boolean;
  error?: string;
  not_connected?: boolean;
  path?: string;
  ref?: string;
  parent_ref?: string | null;
  entries?: RemoteEntry[];
  truncated?: boolean;
  /** Why the listing is partial: too many entries to show, to read, or it took too long. */
  truncated_reason?: 'limit' | 'scan' | 'time' | null;
  scanned?: number;
  limit?: number;
}

export interface RemoteTargetStatus {
  source: string;
  target: string;
  host?: string;
  user?: string | null;
  connected: boolean;
  folders: string[];
  refs: number;
}

export interface RemoteRefsStatus {
  refs: { ref: string; source: string; target: string; connected: boolean }[];
  targets: RemoteTargetStatus[];
  disconnected: number;
}

export async function getRemoteSources(probe = true): Promise<{ sources: RemoteSourceInfo[] }> {
  return fetchJson(`${API_BASE}/sources?probe=${probe ? 'true' : 'false'}`, { cache: 'no-store' });
}

export async function connectRemote(params: {
  source?: string;
  host?: string;
  user?: string;
  roots?: string[];
  remote_python?: string;
  open_terminal?: boolean;
  profile?: string;
  endpoint_url?: string;
}): Promise<{ success: boolean; error?: string; connection?: RemoteConnection }> {
  return fetchJson(`${API_BASE}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'ssh', ...params }),
  });
}

export async function disconnectRemote(target: string, closeMaster = false, source = 'ssh'): Promise<{ success: boolean; error?: string }> {
  return fetchJson(`${API_BASE}/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target, close_master: closeMaster }),
  });
}

export async function listRemote(ref: string): Promise<RemoteListing> {
  return fetchJson(`${API_BASE}/list?ref=${encodeURIComponent(ref)}`, { cache: 'no-store' });
}

export async function remoteRefsStatus(refs: string[]): Promise<RemoteRefsStatus> {
  return fetchJson(`${API_BASE}/refs_status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  });
}

/** True for a reference a remote source opens (ssh://host/abs/path). */
export function isClusterRef(path: unknown): path is string {
  return typeof path === 'string' && /^ssh:\/\//i.test(path);
}
