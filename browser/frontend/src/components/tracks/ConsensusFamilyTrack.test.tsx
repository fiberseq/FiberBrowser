import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it} from 'vitest';
import {useBrowserStore} from '../../stores/browserStore';
import {useConsensusViewStore} from '../../stores/consensusViewStore';
import {ConsensusFamilyTrack,consensusJobId} from './ConsensusFamilyTrack';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('paints all cores above overlapping edges and raises selected cores without changing lanes',()=>{
  const container=document.createElement('div');const root=createRoot(container);
  useBrowserStore.setState({chrom:'chr1',start:0,end:100,isReversed:false});
  useConsensusViewStore.setState({jobId:'j',loading:false,error:'',selections:[],curation:null,
    trackMinimumCount:0,trackComparableOnly:false,catalog:{region:{chrom:'chr1',start:0,end:100},edges:[],
      datasets:{d:{catalog:[
        {family:'A',consensus_start:10,consensus_end:20,edge_uncertainty:{left:[5,12],right:[18,23]}},
        {family:'B',consensus_start:30,consensus_end:40,edge_uncertainty:{left:[5,35],right:[38,45]}},
      ]}}}} as any);
  try{
    act(()=>root.render(<ConsensusFamilyTrack width={1000} height={80} datasetId="d" jobId="j"/>));
    const svg=container.querySelector('svg')!;
    expect(svg.children[0].getAttribute('data-testid')).toBe('family-boundary-layer');
    const cores=svg.children[1];
    expect(cores.getAttribute('data-testid')).toBe('family-core-layer');
    expect(cores.querySelector('[data-testid="family-edge-uncertainty"]')).toBeNull();
    const a=cores.querySelector('[data-family-id="A"]')!;
    const y=a.querySelector('rect')!.getAttribute('y');
    act(()=>a.dispatchEvent(new MouseEvent('click',{bubbles:true})));
    expect(useConsensusViewStore.getState().selections.map(s=>s.family)).toEqual(['A']);
    expect(cores.lastElementChild?.getAttribute('data-family-id')).toBe('A');
    expect(a.querySelector('rect')!.getAttribute('y')).toBe(y);
    act(()=>container.querySelector('[data-boundary-family-id="B"] rect')!.dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true})));
    expect(useConsensusViewStore.getState().selections.map(s=>s.family)).toEqual(['A','B']);
    expect(cores.lastElementChild?.getAttribute('data-family-id')).toBe('B');
  }finally{act(()=>root.unmount());}
});

it('finds the run from the recaller class layer when the labelled native layer is absent',()=>{
  expect(consensusJobId({derived_layers:{tf_rc:{consensus_job_id:'r'}}})).toBe('r');
  expect(consensusJobId({derived_layers:{tf_cr:{consensus_job_id:'c'}}})).toBe('c');
  expect(consensusJobId({derived_layers:{}})).toBeNull();
});
