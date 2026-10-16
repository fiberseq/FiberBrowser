import { describe, expect, it } from 'vitest';
import { readDepthNotes, readDepthParameters } from './readDepth';

describe('read depth', () => {
  it('omits unsupported and uncapped controls, including a changed seed', () => {
    expect(readDepthParameters({max_discovery_molecules:2000},false)).toEqual({});
    expect(readDepthParameters({max_discovery_molecules:0,max_quantification_molecules:0,sample_seed:9},true)).toEqual({});
    expect(readDepthParameters({max_discovery_molecules:2000,sample_seed:9},true)).toEqual({max_discovery_molecules:2000,max_quantification_molecules:0,sample_seed:9});
  });
  it('only reports applied caps and preserves window and channel denominators', () => {
    const records = [{max_discovery_molecules:2000,window:[10,20],strata:[{stratum:'d::CT',available:2734,discovery:2000,quantification:null},
      {stratum:'d::GA',available:1000,discovery:1000,quantification:null}]}];
    expect(readDepthNotes(records,{d:'Deep data'})).toEqual(['Used 2,000 of 2,734 reads in Deep data (CT) for finding classes · window [10,20].']);
    expect(readDepthNotes()).toEqual([]);
    expect(readDepthNotes([{max_quantification_molecules:0,strata:[{stratum:'d::CT',available:2734,discovery:null,quantification:2000}]}])).toEqual([]);
  });
});

it('identifies decoded denominators and exposes loader counts even without an applied molecule cap', () => {
  const loader = [{dataset_id:'d', reads_seen:25000, eligible_reads:20000, reads_decoded:3000}];
  const records = [{max_discovery_molecules:2000,max_quantification_molecules:2000,
    strata:[{stratum:'d::CT',available:3000,discovery:2000,quantification:2000}]}];
  const notes = readDepthNotes(records, {d:'Deep data'}, loader);
  expect(notes[0]).toContain('Used 2,000 of 3,000 eligible reads in the decoded subset in Deep data (CT) for finding classes');
  expect(notes[1]).toContain('decoded subset in Deep data (CT) for scoring');
  expect(notes[2]).toContain('decoded 3,000 of 20,000 eligible reads (25,000 reads seen)');
  expect(readDepthNotes([], {d:'Deep data'}, loader)).toEqual([notes[2]]);
});
