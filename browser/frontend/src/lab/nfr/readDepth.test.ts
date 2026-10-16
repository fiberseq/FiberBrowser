import { expect, it } from 'vitest';
import { DEFAULT_NFR_SETTINGS, runParameters } from './AccessibilityPanel';
it('passes both caps and seed only to a supporting NFR engine',()=>{
  const settings={...DEFAULT_NFR_SETTINGS,max_discovery_molecules:2000,max_quantification_molecules:1500,sample_seed:7};
  const original=runParameters(DEFAULT_NFR_SETTINGS,null);
  expect(runParameters(settings,null)).toEqual(original);
  expect(runParameters(settings,null,null,false,false,undefined,true)).toEqual({...original,
    max_discovery_molecules:2000,max_quantification_molecules:1500,sample_seed:7});
  expect(runParameters({...DEFAULT_NFR_SETTINGS,sample_seed:7},null,null,false,false,undefined,true)).toEqual(original);
});

import { nfrReadDepthNotes } from './readDepth';
it('keeps detection purposes and region identifiers in the lab formatter', () => {
  const row = {max_discovery_molecules:2000,nfr:'N1',strata:[{stratum:'d::CT',available:3000,discovery:2000,quantification:null}]};
  expect(nfrReadDepthNotes([{...row,purpose:'region_detection'}])[0]).toContain('for finding regions · N1.');
  expect(nfrReadDepthNotes([{...row,purpose:'opportunity_diagnostic'}])[0]).toContain('for measuring coverage · N1.');
});
