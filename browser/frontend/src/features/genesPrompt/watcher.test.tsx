/** The genome check runs for a reference alone (no datasets): the genes prompt needs its annotation status. */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getGenomeCheck: vi.fn() }));
vi.mock('../../api/genomeCheck', async importOriginal => ({ ...(await importOriginal<object>()), getGenomeCheck: api.getGenomeCheck }));
import { useBrowserStore } from '../../stores/browserStore';
import { useGenomeCheckStore } from '../../stores/genomeCheckStore';
import { useGenomeCheckWatcher } from '../../components/controls/GenomeMismatchBanner';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() { useGenomeCheckWatcher(); return null; }

describe('genome check watcher', () => {
  it('refreshes for a reference without datasets, and clears with neither', () => {
    const real = useGenomeCheckStore.getState().refresh;
    const refresh = vi.fn(async () => {});
    useGenomeCheckStore.setState({ refresh, check: { stale: true } as never });
    useBrowserStore.setState({ datasets: [], hasFasta: true, currentGenome: 'dm6' } as never);
    const box = document.createElement('div');
    const root = createRoot(box);
    act(() => root.render(<Probe />));
    expect(refresh).toHaveBeenCalled();
    // The annotation status stays while the same reference refreshes (dataset fields go at once).
    expect(useGenomeCheckStore.getState().check).toMatchObject({ stale: true, problems: [], datasets: [] });
    // Another reference: the last one's status goes (its prompt would load the wrong genes).
    act(() => { useBrowserStore.setState({ currentGenome: 'mm10' } as never); });
    expect(useGenomeCheckStore.getState().check).toBeNull();
    act(() => root.unmount());
    refresh.mockClear();
    useBrowserStore.setState({ datasets: [], hasFasta: false, currentGenome: null } as never);
    const root2 = createRoot(document.createElement('div'));
    act(() => root2.render(<Probe />));
    expect(refresh).not.toHaveBeenCalled();
    expect(useGenomeCheckStore.getState().check).toBeNull();
    act(() => root2.unmount());
    useGenomeCheckStore.setState({ refresh: real });
  });
});

describe('genome check answers', () => {
  it('an answer asked for before the reference changed is dropped', async () => {
    const { invalidateGenomeCheck } = await import('../../stores/genomeCheckStore');
    let release: (v: unknown) => void = () => {};
    const spy = api.getGenomeCheck
      .mockImplementationOnce(() => new Promise(r => { release = r; }) as never)
      .mockImplementationOnce(() => Promise.reject(new Error('down')));
    useGenomeCheckStore.setState({ check: null });
    const done = useGenomeCheckStore.getState().refresh();
    invalidateGenomeCheck();                      // dm6 -> mm10 while dm6's answer is in flight
    release({ annotation: { target: { genome_id: 'dm6' } } });
    await done;
    expect(useGenomeCheckStore.getState().check).toBeNull();   // dm6's answer never lands on mm10
    expect(spy).toHaveBeenCalledTimes(2);                       // asked again for the new reference
    spy.mockReset();
  });
});
