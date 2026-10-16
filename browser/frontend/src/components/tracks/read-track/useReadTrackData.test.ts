import { describe, expect, it } from 'vitest';
import {
  normalizeRequestReadIds,
  requestFilterParamFromSets,
  readFilterFitsRequest,
  clusterCohortNeedsFullPool,
  canBatchReadDatasets,
  coverageRequestKey,
  displayCapacity,
} from './useReadTrackData';
import {computeReadTrackLayout} from './layout';

describe('Fit capacity at reduced UI viewport sizes',()=>{
  it.each([30,60,100,150,199,400])('fits sampled rows inside %i logical pixels',height=>{
    for(const rowHeight of [1,3,5,10]){
      const count=displayCapacity(height,rowHeight,'auto',3,1);
      const layout=computeReadTrackLayout(count,height,0,0,true,rowHeight,0);
      expect(layout.needsScroll).toBe(false);
      expect(layout.totalContentHeight).toBeLessThanOrEqual(height);
    }
  });
  it('reduces sample capacity proportionally as UI zoom increases',()=>{
    expect(displayCapacity(100,1,'off',3,1)).toBe(100);
    expect(displayCapacity(50,1,'off',3,1)).toBe(50);
  });
});

describe('read payload membership scope', () => {
  it('sends the exact focused-cluster IDs on payload-changing refetches', () => {
    expect(requestFilterParamFromSets(
      new Set(['read-c', 'read-a']),
    )).toBe('read-a,read-c');
  });

  it('intersects focus and filter scopes in base-read ID space', () => {
    expect(requestFilterParamFromSets(
      new Set(['read-a_0', 'read-b']),
      new Set(['read-a_1', 'read-c']),
    )).toBe('read-a');
    expect(normalizeRequestReadIds(new Set(['read-a_0', 'read-a_1']))).toEqual(new Set(['read-a']));
  });

  it('falls back to a full current-dataset pool above the safe query-ID cap', () => {
    const largeFocus = new Set(Array.from({ length: 5_001 }, (_, index) => `read-${index}`));

    const filterParam = requestFilterParamFromSets(largeFocus);

    expect(filterParam).toBe('');
    expect(clusterCohortNeedsFullPool(largeFocus, filterParam)).toBe(true);
    expect(clusterCohortNeedsFullPool(largeFocus, 'read-1')).toBe(false);
  });

  it('uses the full-pool fallback when encoded long-read IDs exceed the URL budget', () => {
    const longReadFocus = new Set(Array.from(
      { length: 750 },
      (_, index) => `m84046_250513_034312_s1/${String(index).padStart(10, '0')}/ccs`,
    ));

    const filterParam = requestFilterParamFromSets(longReadFocus);

    expect(filterParam).toBe('');
    expect(clusterCohortNeedsFullPool(longReadFocus, filterParam)).toBe(true);
  });

  it('never batches a clustered track, even when no cluster is focused', () => {
    expect(canBatchReadDatasets(2, false, '', new Set(['read-a']))).toBe(false);
    expect(canBatchReadDatasets(2, false, '', null)).toBe(true);
  });

  it('keeps dense independent loads eligible for streaming and cohort reuse', () => {
    expect(canBatchReadDatasets(2, false, '', null, true)).toBe(false);
    expect(canBatchReadDatasets(2, false, '', null, false)).toBe(true);
  });
});


describe('coverageRequestKey', () => {
  it('differs by dataset, region and bins, so another request\'s coverage is never shown', () => {
    const key = coverageRequestKey('ds', 'chr1', 0, 1_000_000, 500);
    expect(coverageRequestKey('ds', 'chr1', 0, 1_000_000, 500)).toBe(key);
    expect(coverageRequestKey('ds', 'chr1', 1, 1_000_000, 500)).not.toBe(key);
    expect(coverageRequestKey('ds', 'chr2', 0, 1_000_000, 500)).not.toBe(key);
    expect(coverageRequestKey('other', 'chr1', 0, 1_000_000, 500)).not.toBe(key);
    // Coverage counts duplicate-flagged molecules only while the panel shows them.
    expect(coverageRequestKey('ds', 'chr1', 0, 1_000_000, 500, false)).toBe(key);
    expect(coverageRequestKey('ds', 'chr1', 0, 1_000_000, 500, true)).not.toBe(key);
    expect(coverageRequestKey('ds', 'chr1', 0, 1_000_000, 400)).not.toBe(key);
  });
});

describe('read-ID request filters', () => {
  it('strips a segment suffix once, so a_1_2 reaches the server as a_1', () => {
    // The server matches a read by its ID or its ID minus one numeric suffix.
    expect(requestFilterParamFromSets(new Set(['a_1_2']))).toBe('a_1');
    expect(requestFilterParamFromSets(new Set(['a_1_2']), new Set(['a_1_2', 'b']))).toBe('a_1');
  });

  it('reports when a filter is too large to send (the server would see every read)', () => {
    const long = new Set(Array.from({ length: 750 }, (_, i) => `m64011_190830_220126/${100000 + i}/ccs/fwd_segment`));
    expect(readFilterFitsRequest(long)).toBe(false);
    expect(readFilterFitsRequest(new Set(['read-a']))).toBe(true);
  });
});
