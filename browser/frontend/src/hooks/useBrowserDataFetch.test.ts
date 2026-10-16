import { describe, expect, it } from 'vitest';
import { cachedBinsFineEnough, defaultRenderModeForPath, findExistingUnfilteredTrack, signalBinCount } from './useBrowserDataFetch';
import type { TrackListEntry } from '../api/tracks';

// The fetch covers the viewport plus 1.5 viewports of padding on each side.
function fetchedBpPerBin(viewportBp: number, pixels: number): number {
  const queryWidth = viewportBp * 4;
  return queryWidth / signalBinCount(queryWidth, viewportBp, pixels);
}

describe('auxiliary signal cache resolution', () => {
  it('reuses cached bins for a pan at the same zoom', () => {
    expect(cachedBinsFineEnough(fetchedBpPerBin(100_000, 800), 100_000, 800)).toBe(true);
  });

  it('refetches when zooming in needs finer bins than the cache holds', () => {
    // 100 kb over 800 px is 125 bp/bin; a 10 kb view needs 12.5 bp/bin.
    expect(cachedBinsFineEnough(fetchedBpPerBin(100_000, 800), 10_000, 800)).toBe(false);
  });

  it('reuses one-bp bins at base-level zoom', () => {
    expect(cachedBinsFineEnough(fetchedBpPerBin(400, 800), 200, 800)).toBe(true);
  });

  it('reuses a cache that fetched no signal', () => {
    expect(cachedBinsFineEnough(0, 1_000, 800)).toBe(true);
  });
});

describe('reusing a loaded track for a catalog entry', () => {
  const bb = '/data/jaspar.bb';
  const track = (over: Partial<TrackListEntry>): TrackListEntry => ({
    index: 0, label: 'JASPAR', path: bb, render_mode: 'annotation', filter_names: [], ...over,
  });

  it('reuses an unfiltered track at the same path', () => {
    expect(findExistingUnfilteredTrack({ path: bb, kind: 'bigbed' }, [track({ index: 3 })])?.index).toBe(3);
  });

  it('never hands an unfiltered entry a track filtered to some names', () => {
    const filtered = track({ index: 1, filter_names: ['CTCF'] });
    expect(findExistingUnfilteredTrack({ path: bb, kind: 'bigbed' }, [filtered])).toBeNull();
    expect(findExistingUnfilteredTrack({ path: bb, kind: 'bigbed' }, [filtered, track({ index: 2 })])?.index).toBe(2);
  });

  it('matches the category and render mode registering the entry would give', () => {
    expect(findExistingUnfilteredTrack({ path: bb, kind: 'motif' }, [track({})])).toBeNull();
    expect(findExistingUnfilteredTrack({ path: bb, kind: 'motif' }, [track({ index: 4, category: 'motif' })])?.index).toBe(4);
    expect(findExistingUnfilteredTrack({ path: bb, kind: 'bigbed' }, [track({ render_mode: 'signal' })])).toBeNull();
  });

  it('knows the server defaults', () => {
    expect(defaultRenderModeForPath('/a/peaks.bed.gz')).toBe('annotation');
    expect(defaultRenderModeForPath('/a/sites.BigBed')).toBe('annotation');
    expect(defaultRenderModeForPath('ucsc://hg38/knownGene')).toBe('annotation');
    expect(defaultRenderModeForPath('/a/signal.bw')).toBe('signal');
    expect(defaultRenderModeForPath('motif://sequence/TATAAA')).toBe('annotation');
  });

  it('reconnects a motif entry to its loaded motif track instead of registering a duplicate', () => {
    const motif = track({ index: 6, path: 'motif://sequence/TATAAA', category: 'motif' });
    expect(findExistingUnfilteredTrack({ path: 'motif://sequence/TATAAA', kind: 'motif' }, [motif])?.index).toBe(6);
  });
});
