import { useEffect, useState } from 'react';
import { getRemoteSources, type RemoteConnection } from '../../../../api/remote';
import { useConnectClusterStore, openConnectCluster } from '../../../../utils/connectCluster';
import { SidebarSubSection } from '../../SidebarSubSection';
import { isLabServerPage } from '../../../../utils/labServer';

interface ConnectClusterSettingsProps {
  publicMode: boolean;
}

/** Sidebar > Load data: "Connect to cluster…" and the live connections. */
export function ConnectClusterSettings({ publicMode }: ConnectClusterSettingsProps) {
  const [connections, setConnections] = useState<RemoteConnection[]>([]);
  const dialogOpen = useConnectClusterStore(s => s.open);

  useEffect(() => {
    if (publicMode || dialogOpen || isLabServerPage()) return;
    let cancelled = false;
    getRemoteSources(false)
      .then(result => {
        if (!cancelled) setConnections(result.sources.find(s => s.scheme === 'ssh')?.connections ?? []);
      })
      .catch(() => { /* older server or not allowed: nothing to show */ });
    return () => { cancelled = true; };
  }, [publicMode, dialogOpen]);

  if (publicMode || isLabServerPage()) return null;  // a lab server never signs in to clusters
  const live = connections.filter(c => c.state === 'connected');

  return (
    <SidebarSubSection
      id="file.cluster"
      label="Connect to cluster"
      helpText="Open files that live on a cluster (e.g. a university HPC cluster) over your own SSH: nothing is installed there and only the byte ranges FiberBrowser needs are read."
      persist
    >
      <button
        onClick={() => openConnectCluster()}
        data-testid="connect-cluster-button"
        className="w-full text-left px-2 py-1 text-[12px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded"
      >
        Connect to cluster…
        {live.length > 0 && (
          <span className="ml-1 text-[11px] text-teal-600 dark:text-teal-400">({live.map(c => c.target).join(', ')} connected)</span>
        )}
      </button>
    </SidebarSubSection>
  );
}
