import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { applyImportedState } from '../api/session';
import type { Dataset } from '../types';
import { startupDatasetsGuard } from './startupDatasets';

const dataset = (id: string) => ({ id, label: id, paths: [`/${id}.bam`], data_type: 'bam' }) as unknown as Dataset;

/** What Browser.tsx does once the startup requests settle: the startup list replaces the datasets if it still applies. */
function startupArrives(guard: { stillApplies(): boolean }, list: Dataset[]) {
  if (guard.stillApplies()) useBrowserStore.getState().setDatasets(list);
}

const ids = () => useBrowserStore.getState().datasets.map(d => d.id);

describe('startup dataset list', () => {
  beforeEach(() => {
    useBrowserStore.setState({ datasets: [], panels: [], slotOrder: [] } as never);
  });

  it('applies when nothing replaced the datasets since startup', () => {
    const guard = startupDatasetsGuard();
    startupArrives(guard, [dataset('a')]);
    expect(ids()).toEqual(['a']);
  });

  it('applies when only a metadata refresh re-mapped the empty list', () => {
    const guard = startupDatasetsGuard();
    useBrowserStore.getState().setDatasets(useBrowserStore.getState().datasets.map(d => d));
    startupArrives(guard, [dataset('a')]);
    expect(ids()).toEqual(['a']);
  });

  it('does not overwrite datasets a session restore set during startup', () => {
    const guard = startupDatasetsGuard();
    applyImportedState({ datasets: [dataset('restored')], overlays: [], has_fasta: false, frontend: {}, viewport: { chrom: 'chr1', start: 1, end: 2 } });
    startupArrives(guard, [dataset('a')]);
    expect(ids()).toEqual(['restored']);
  });

  it('does not put back the datasets an empty session cleared during startup', () => {
    // RELEASE_READINESS_310 deferred MED: the startup list (fetched with dataset A open on the server) arrives after an
    // empty session import cleared the server and the page; it must not resurrect A.
    const guard = startupDatasetsGuard();
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: {}, viewport: { chrom: 'chr1', start: 1, end: 2 } });
    startupArrives(guard, [dataset('a')]);
    expect(ids()).toEqual([]);
  });

  it('does not put back a dataset added and closed during startup', () => {
    const guard = startupDatasetsGuard();
    useBrowserStore.getState().addDataset(dataset('b'));
    useBrowserStore.getState().removeDataset('b');
    startupArrives(guard, [dataset('a'), dataset('b')]);
    expect(ids()).toEqual([]);
  });

  it('does not overwrite a dataset added during startup', () => {
    const guard = startupDatasetsGuard();
    useBrowserStore.getState().addDataset(dataset('b'));
    startupArrives(guard, [dataset('a')]);
    expect(ids()).toEqual(['b']);
  });
});
