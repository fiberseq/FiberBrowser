/**
 * A page opened before any dataset was loaded (it shows the Welcome card) takes the datasets loaded on the server
 * since (by a script, the command line of another launcher, another tab), as it would have had it opened later:
 * the same `setDatasets` the startup uses. Only an empty page, never one with datasets of its own.
 */
import { getDatasets } from '../api/datasets';
import { useBrowserStore } from '../stores/browserStore';
import { useOpeningStore } from '../stores/openingStore';
import { shouldAdoptServerDatasets, useServerDatasetsStore } from '../stores/serverDatasetsStore';
import { useLaunchUiStore } from './launchSession';
import { sessionRestoresInFlight } from './sessionRestore';

let inflight = false;

function busy(): boolean {
  const launch = useLaunchUiStore.getState();
  return Boolean(launch.deciding || launch.restoring || sessionRestoresInFlight() > 0 || useOpeningStore.getState().opening.length);
}

export async function adoptServerDatasetsIfEmpty(): Promise<boolean> {
  const ctx = () => ({ pageDatasets: useBrowserStore.getState().datasets.length, busy: busy(),
    steady: useServerDatasetsStore.getState().steady });
  if (inflight || !shouldAdoptServerDatasets(ctx())) return false;
  inflight = true;
  try {
    const { datasets } = await getDatasets();
    if (!datasets.length || !shouldAdoptServerDatasets(ctx())) return false;
    useBrowserStore.getState().setDatasets(datasets);
    return true;
  } catch {
    return false;
  } finally {
    inflight = false;
  }
}
