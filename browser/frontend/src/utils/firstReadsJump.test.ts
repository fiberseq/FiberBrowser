/** M4 (UI audit): the first load of the user's data didn't show it (the view stayed at the genome's default locus). */
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { cancelFirstReadsJump, pendingFirstReadsJump, takeFirstReadsJump, viewportKey } from './firstReadsJump';

const dataset = (id: string) => ({ id, label: id, data_type: 'bam', paths: [`/${id}.bam`] }) as any;

describe('first view of new data', () => {
  beforeEach(() => {
    cancelFirstReadsJump();
    useBrowserStore.setState({ datasets: [], panels: [], activeReadIds: {}, chrom: 'chr7', start: 152_000_000, end: 152_020_000 } as any);
  });

  it('a dataset opened while nothing shows reads is taken to its reads, once', () => {
    useBrowserStore.getState().addDataset(dataset('napa'));
    const here = viewportKey('chr7', 152_000_000, 152_020_000);
    expect(pendingFirstReadsJump()).toEqual({ datasetId: 'napa', viewport: here });
    expect(takeFirstReadsJump('other', here)).toBe(false);
    expect(takeFirstReadsJump('napa', here)).toBe(true);
    expect(takeFirstReadsJump('napa', here)).toBe(false);
  });

  it('a view moved before its reads arrive (a session, the tour, the user) cancels it', () => {
    useBrowserStore.getState().addDataset(dataset('napa'));
    expect(takeFirstReadsJump('napa', viewportKey('chr19', 47_514_000, 47_518_000))).toBe(false);
    expect(pendingFirstReadsJump()).toBeNull();
  });

  it('never when another panel already shows reads (the user is looking at something)', () => {
    useBrowserStore.setState({ activeReadIds: { first: ['r1', 'r2'] } } as any);
    useBrowserStore.getState().addDataset(dataset('second'));
    expect(pendingFirstReadsJump()).toBeNull();
  });

  it('closing the dataset before its reads arrive forgets it', () => {
    useBrowserStore.getState().addDataset(dataset('napa'));
    useBrowserStore.getState().removeDataset('napa');
    expect(pendingFirstReadsJump()).toBeNull();
  });
});
