import { create } from 'zustand';
import { remoteRefsStatus, type RemoteConnection, type RemoteTargetStatus } from '../api/remote';
import { isLabServerPage } from './labServer';

/** What the Connect to cluster dialog opens with. */
export interface ConnectClusterPrefill {
  host?: string;
  user?: string | null;
  folders?: string[];
  /** Why the dialog opened (e.g. "This session uses files on hpc."). */
  reason?: string;
}

interface ConnectClusterState {
  open: boolean;
  prefill: ConnectClusterPrefill | null;
  /** Called with true once the prefilled host is connected, false when closed first. */
  waiter: ((connected: boolean) => void) | null;
  show: (prefill?: ConnectClusterPrefill | null, waiter?: ((connected: boolean) => void) | null) => void;
  close: (connected?: boolean) => void;
}

export const useConnectClusterStore = create<ConnectClusterState>((set, get) => ({
  open: false,
  prefill: null,
  waiter: null,
  show: (prefill = null, waiter = null) => {
    get().waiter?.(false);
    set({ open: true, prefill, waiter });
  },
  close: (connected = false) => {
    const waiter = get().waiter;
    set({ open: false, prefill: null, waiter: null });
    waiter?.(connected);
  },
}));

/** Open "Connect to cluster…" from anywhere (sidebar, Library, session restore). */
export function openConnectCluster(prefill?: ConnectClusterPrefill | null): void {
  useConnectClusterStore.getState().show(prefill ?? null);
}

/**
 * Whether ``connection`` signs in to ``host`` as the account ``user`` asks
 * for (``null``: the account ssh uses by default). Mirrors the server's
 * ``connection_for``: another spelling of the target counts only when both
 * sides resolve (via ``ssh -G``) to the same user.
 */
export function connectionServes(
  connection: Pick<RemoteConnection, 'host' | 'user' | 'target'> & { default_user?: string | null },
  host: string | undefined | null,
  user?: string | null,
): boolean {
  if (!host || connection.host !== host) return false;
  const wanted = user || null;
  if ((connection.user || null) === wanted) return true;
  const defaultUser = connection.default_user || null;
  const wantedAccount = wanted ?? defaultUser;
  const connectionAccount = connection.user || defaultUser;
  return !!wantedAccount && wantedAccount === connectionAccount;
}

function prefillFor(target: RemoteTargetStatus, reason: string): ConnectClusterPrefill {
  return {
    host: target.host ?? target.target,
    user: target.user ?? null,
    folders: target.folders,
    reason,
  };
}

/**
 * Before opening files that live on a cluster (a restored session, Library
 * entries), make sure their host is connected: if not, open the dialog
 * prefilled with the host and the files' folders and resolve once connected.
 * Resolves true when every referenced host is connected (or nothing is remote).
 */
export async function ensureClusterRefsConnected(refs: string[], what = 'These files'): Promise<boolean> {
  const clusterRefs = refs.filter(ref => typeof ref === 'string' && /^ssh:\/\//i.test(ref));
  // A lab server never connects to clusters: the loads report that themselves.
  if (clusterRefs.length === 0 || isLabServerPage()) return true;
  let status;
  try {
    status = await remoteRefsStatus(clusterRefs);
  } catch {
    return false;
  }
  for (const target of status.targets) {
    if (target.connected) continue;
    const connected = await new Promise<boolean>(resolve => {
      useConnectClusterStore.getState().show(
        prefillFor(target, `${what}: ${target.refs} file${target.refs === 1 ? '' : 's'} on ${target.target}. Connect to open ${target.refs === 1 ? 'it' : 'them'}.`),
        resolve,
      );
    });
    if (!connected) return false;
  }
  return true;
}
