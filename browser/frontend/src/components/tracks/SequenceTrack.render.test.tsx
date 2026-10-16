import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSequence } = vi.hoisted(() => ({
  getSequence: vi.fn(async (chrom: string, start: number, end: number) => ({ sequence: 'A'.repeat(end - start), chrom, start, end })),
}));
vi.mock('../../api/reference', async (orig) => ({ ...(await orig<typeof import('../../api/reference')>()), getSequence }));

import { useBrowserStore } from '../../stores/browserStore';
import { SequenceTrack } from './SequenceTrack';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// 2026-09-30 UI audit L22: switching genome asked the new genome for the old chromosome (a 404).
describe('sequence track across a switch of reference', () => {
  const initial = useBrowserStore.getState();
  beforeEach(() => getSequence.mockClear());
  afterEach(() => {
    vi.useRealTimers();
    useBrowserStore.setState(initial, true);
  });

  it('uses an independent panel reference even when the main chromosome is absent there', async () => {
    useBrowserStore.setState({ chrom: 'stale', start: 9000, end: 10000 } as never);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<SequenceTrack width={400} height={20} overrideChrom="insert_contig" overrideStart={100} overrideEnd={200} genome="own-reference" />));
    expect(getSequence).toHaveBeenCalledWith('insert_contig', expect.any(Number), expect.any(Number), 'own-reference');
    act(() => root.unmount());
  });

  it('waits for the new chromosome list and a chromosome on it', async () => {
    useBrowserStore.setState({
      currentGenome: 'hg38', fastaPath: null,
      chroms: [{ name: 'chr19', size: 58_617_616 }],
      chrom: 'chr19', start: 47_514_000, end: 47_514_400,
    } as never);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<SequenceTrack width={400} height={20} />));
    expect(getSequence).toHaveBeenCalledTimes(1);
    expect(getSequence.mock.calls[0][0]).toBe('chr19');

    // The genome switches first; its chromosome list and view follow.
    await act(async () => useBrowserStore.setState({ currentGenome: 'dm6' } as never));
    await act(async () => useBrowserStore.setState({ chroms: [{ name: 'chr2L', size: 23_513_712 }] } as never));
    expect(getSequence).toHaveBeenCalledTimes(1);
    await act(async () => useBrowserStore.setState({ chrom: 'chr2L', start: 1000, end: 1400 } as never));
    expect(getSequence).toHaveBeenCalledTimes(2);
    expect(getSequence.mock.calls[1][0]).toBe('chr2L');
    act(() => root.unmount());
  });

  it('a reference loaded with its chromosome list at once is fetched right away', async () => {
    useBrowserStore.setState({ currentGenome: 'hg38', chroms: [{ name: 'chr19', size: 58_617_616 }], chrom: 'chr19', start: 100, end: 500 } as never);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<SequenceTrack width={400} height={20} />));
    await act(async () => useBrowserStore.setState({ currentGenome: 'mm10', chroms: [{ name: 'chr19', size: 61_431_566 }] } as never));
    expect(getSequence).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('a FASTA path reported later for the same genome does not hold the track back', async () => {
    useBrowserStore.setState({ currentGenome: 'dm6', fastaPath: null, chroms: [{ name: 'chr2L', size: 23_513_712 }], chrom: 'chr2L', start: 1000, end: 1400 } as never);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<SequenceTrack width={400} height={20} />));
    await act(async () => useBrowserStore.setState({ fastaPath: '/genomes/dm6.fa' } as never));
    expect(getSequence).toHaveBeenCalledTimes(2);
    expect(getSequence.mock.calls[1][0]).toBe('chr2L');
    act(() => root.unmount());
  });

  it('if the new chromosome list never comes, it fetches after a short wait (never blank for good)', async () => {
    vi.useFakeTimers();
    useBrowserStore.setState({ currentGenome: 'hg38', fastaPath: null, chroms: [{ name: 'chr19', size: 58_617_616 }], chrom: 'chr19', start: 100, end: 500 } as never);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<SequenceTrack width={400} height={20} />));
    await act(async () => useBrowserStore.setState({ currentGenome: 'hg19' } as never));
    expect(getSequence).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(3100); });
    expect(getSequence).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('a view on a chromosome the list lacks is still fetched once the switch wait is over', async () => {
    vi.useFakeTimers();
    useBrowserStore.setState({ currentGenome: 'hg38', fastaPath: null, chroms: [{ name: 'chr19', size: 58_617_616 }], chrom: 'chr19', start: 100, end: 500 } as never);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<SequenceTrack width={400} height={20} />));
    await act(async () => useBrowserStore.setState({ currentGenome: 'custom', chroms: [{ name: 'ctg1', size: 5000 }] } as never));
    expect(getSequence).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(3100); });
    expect(getSequence).toHaveBeenCalledTimes(2);
    // Panning later fetches as usual.
    await act(async () => useBrowserStore.setState({ start: 5000, end: 5400 } as never));
    expect(getSequence).toHaveBeenCalledTimes(3);
    act(() => root.unmount());
  });
});
