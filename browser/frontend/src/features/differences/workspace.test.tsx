import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useLiveLiftStore } from '../liveLift/store';
import { PanelDisplayContext } from '../../hooks/usePanelDisplayStore';
import { useDifferenceAxis } from './useDifferenceAxis';
import { expandDifference, useDifferenceSelection } from '../liveLift/inspectionStore';
import { selectNativeDifference } from './selection';
import { MoleculeCalls } from './MoleculeCalls';
import { inspectDifference, type WorkspaceCalls } from './api';
import { workspaceAssignments } from './callModel';
import { applyFrozenDifferenceSplit } from './splits';
import { refreshSvSplit } from '../../utils/svAlleleSplit';
import { serializeState, deserializeSavedState } from '../../stores/historySlice';
vi.mock('./api',async original=>({...await original<any>(),inspectDifference:vi.fn(),getAlternateBlocks:vi.fn()}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const cluster={id:'geometry',t:'I' as const,ref:500,end:504,len:792,ref_len:4,alt_len:792};
const panel:any={id:'native-panel',datasetId:'native',stateKey:'rows',contentType:'dataset',subTracks:[],linkGroup:null};
const call:any={call:{assignment:'unknown',level:'confirmed',method:'geometry_only',reasons:['sequence_not_assessed'],witness_ids:[]},geometry_group:0,representations:[],complete:true};
const response:WorkspaceCalls={schema_version:'differences:v1',analysis_scope:'native_only',evidence_policy:{include_duplicates:false,include_putative:true,include_conflicting:false,include_ambiguous:false},scope:{cohort:'loaded'},
  membership:{rows:{native:{row1:'m',row2:'m'}},molecules:{m:{provenance_group:'public',library_id:'library',raw_name:'molecule'}},legacy_aliases:{native:{molecule:'m'}}},
  targets:[{target:{target_id:'geometry',revision:1,target_type:'geometry',chrom:'chr1',ref_start:500,ref_end:504,alt_bp:792},calls_by_molecule:{m:call},counts:[1,0,0],geometry_counts:[1,0,0],sequence_unresolved_count:1}]};
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{useBrowserStore.setState({chrom:'chr1',start:0,end:1000,panels:[panel],datasets:[{id:'native',data_type:'bam',label:'Native',path:'fixture.bam',color:'#000'}],liveLiftExpansions:{},svSplits:{},clusterAssignments:{},clusterGroupLabels:{}});
  useLiveLiftStore.setState({enabled:false});vi.mocked(inspectDifference).mockResolvedValue(response);
  host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();useDifferenceSelection.getState().select(null);vi.clearAllMocks();});
it('expands a replacement at ref_end without lift or a source panel, preserving reference scope and reversal',()=>{
  selectNativeDifference(cluster,'native','chr1',panel.id);
  expect(expandDifference(useDifferenceSelection.getState().selection!)).toBe(true);
  expect(useBrowserStore.getState().liveLiftExpansions.main[0]).toMatchObject({source:'reads',pos:504,ref_start:500,t_end:504,ref_bp:4,length:792,estimated:true});
  let axis:ReturnType<typeof useDifferenceAxis>['axis'];
  function Axis({reversed=false}:{reversed?:boolean}){axis=useDifferenceAxis('chr1',0,1000,1792,reversed).axis;return null;}
  act(()=>root.render(<PanelDisplayContext.Provider value={panel.id}><Axis/></PanelDisplayContext.Provider>));
  expect(axis!.blocks.map(b=>[b.x0,b.x1])).toEqual([[504,1296]]);
  expect(axis!.spans(500,510)).toEqual([{x:500,w:4},{x:1296,w:6}]);
  expect(axis!.fromX(514)).toMatchObject({pos:504,within:10,ins_id:'geometry'});
  act(()=>useBrowserStore.setState({panels:[]}));expect(axis!.blocks).toHaveLength(1);
  act(()=>root.render(<Axis reversed/>));expect(axis!.blocks.map(b=>[b.x0,b.x1])).toEqual([[496,1288]]);
  act(()=>useBrowserStore.setState({panels:[{...panel,genome:'other-reference'}]}));
  act(()=>root.render(<PanelDisplayContext.Provider value={panel.id}><Axis/></PanelDisplayContext.Provider>));expect(axis!.blocks).toEqual([]);
  act(()=>useBrowserStore.getState().collapseLiveLift('main','geometry'));expect(useBrowserStore.getState().liveLiftExpansions.main).toEqual([]);
});
it('counts once, fans out two rows and round-trips a frozen split that cannot auto-refresh',async()=>{
  selectNativeDifference(cluster,'native','chr1',panel.id);
  await act(async()=>root.render(<MoleculeCalls selection={useDifferenceSelection.getState().selection!} native/>));
  expect(host.textContent).toContain('1 carriers');
  await act(async()=>{[...host.querySelectorAll('button')].find(b=>b.textContent==='Split by carrier')!.click();});
  const state=useBrowserStore.getState(),def=state.svSplits.rows;
  expect(state.clusterAssignments.rows).toEqual({row1:0,row2:0});expect(def.counts).toEqual([1,0,0]);
  expect(def.differenceSnapshot?.target).toEqual(response.targets[0].target);expect(def.frozenImport).toBe(true);
  const restored=deserializeSavedState(JSON.parse(JSON.stringify(serializeState(state))));
  expect(restored.svSplits?.rows.differenceSnapshot).toEqual(def.differenceSnapshot);
  const fetch=vi.spyOn(globalThis,'fetch');await refreshSvSplit({stateKey:'rows',datasetId:'native',chrom:'chr1',viewStart:1,viewEnd:999},def);expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
  expect(workspaceAssignments(response,'native',response.evidence_policy).counts).toEqual([1,0,0]);
});
it('retains an explicit exact target in saved intent as well as the active split',()=>{
  const result=structuredClone(response);
  const target={...result.targets[0].target,target_type:'exact' as const,candidates:{reference:'CCCC',alternate:'A'.repeat(792)}};
  result.targets[0].target=target;
  result.targets[0].calls_by_molecule.m.call.assignment='target';
  applyFrozenDifferenceSplit('rows',{dataset_id:'native',chrom:'chr1',start:0,end:1000,target},result);
  const saved=Object.values(useBrowserStore.getState().differencesSession.targets).find(t=>t.snapshot.target?.target_type==='exact');
  expect(saved).toMatchObject({target_type:'exact',identity_state:'exact',frozen:true,snapshot:{target}});
  const roundtrip=deserializeSavedState(JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState()))));
  expect(Object.values(roundtrip.differencesSession!.targets).find(t=>t.snapshot.target?.target_type==='exact')).toEqual(saved);
});
