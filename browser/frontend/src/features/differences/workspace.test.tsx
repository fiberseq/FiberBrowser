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
import { inspectDifference, getAlternateBlocks, type WorkspaceCalls } from './api';
import { NativeInspector } from './NativeInspector';
import { identifyLens } from '../insertion/IdentifyTab';
import { workspaceAssignments } from './callModel';
import { applyFrozenDifferenceSplit } from './splits';
import { refreshSvSplit } from '../../utils/svAlleleSplit';
import { serializeState, deserializeSavedState } from '../../stores/historySlice';
vi.mock('./api',async original=>({...await original<any>(),inspectDifference:vi.fn(),getAlternateBlocks:vi.fn()}));
vi.mock('../insertion/IdentifyTab',()=>({IdentifyTab:()=>null,identifyLens:vi.fn()}));
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
afterEach(()=>{act(()=>root.unmount());host.remove();useDifferenceSelection.getState().select(null);vi.clearAllMocks();vi.unstubAllGlobals();});
it('automatically identifies a qualified alternate observation rather than a preceding replacement reference',async()=>{
  selectNativeDifference(cluster,'native','chr1',panel.id);
  const selection={...useDifferenceSelection.getState().selection!,action:'identify' as const};
  vi.mocked(getAlternateBlocks).mockResolvedValue({complete:true,blocks:[
    {row_id:'reference',record_id:'ref',coverage:'full',observation_role:'reference',read_bases:'CCCC',read_bases_length:4},
    {row_id:'observed',record_id:'alt',coverage:'full',observation_role:'alternate',read_bases:'A'.repeat(60),read_bases_length:792},
  ] as any});
  const fetch=vi.fn(async()=>new Response(JSON.stringify({sequence:'A'.repeat(792),complete:true})));
  vi.stubGlobal('fetch',fetch);
  await act(async()=>root.render(<NativeInspector selection={selection} panel={panel} dataset={useBrowserStore.getState().datasets[0]} anchor={{current:host}}/>));
  expect(fetch).toHaveBeenCalledTimes(1);
  const request=JSON.parse((fetch.mock.calls[0] as any)[1].body);
  expect(request).toMatchObject({row_ids:['observed'],record_id:'alt',limit:50000});
  expect(identifyLens).toHaveBeenCalledWith(expect.objectContaining({consensus:expect.objectContaining({seq:'A'.repeat(792),n_reads:1})}),'native',expect.anything());
});
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
it('keeps saved columns across chromosomes and reference scopes through a session round-trip',()=>{
  const state=useBrowserStore.getState();
  const base={chrom:'chr1',pos:500,ins_id:'one',length:100,label:'',hap_label:''};
  state.expandLiveLift('main',base);
  state.expandLiveLift('main',{...base,chrom:'chr2',ins_id:'two'});
  state.expandLiveLift('main',{...base,referenceScope:'other-reference'});
  expect(useBrowserStore.getState().liveLiftExpansions.main).toHaveLength(3);
  const saved=deserializeSavedState(JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState()))));
  expect(saved.liveLiftExpansions?.main).toHaveLength(3);
  state.expandLiveLift('main',{...base,length:200});
  expect(useBrowserStore.getState().liveLiftExpansions.main).toHaveLength(3);
});
it('restores an exact selected target and missing-source geometry through eviction, hydration and undo',()=>{
  const originalSession=useBrowserStore.getState().differencesSession;
  selectNativeDifference(cluster,'native','chr1',panel.id);
  const selection={...useDifferenceSelection.getState().selection!,target:{...response.targets[0].target,target_type:'exact' as const,
    revision:7,candidates:{reference:'CCCC',alternate:'A'.repeat(792)}}};
  useDifferenceSelection.getState().select(selection);
  useBrowserStore.getState().pushSnapshot('Selected exact target');
  const serialized=JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())));
  useDifferenceSelection.getState().select(null);
  useBrowserStore.getState().pushSnapshot('Closed selection');
  useBrowserStore.getState().undo();
  expect(useDifferenceSelection.getState().selection).toEqual(selection);
  useBrowserStore.setState({...deserializeSavedState(serialized),datasets:[],panels:[]});
  expect(useDifferenceSelection.getState().selection).toEqual(selection);
  expect(useDifferenceSelection.getState().selection?.target?.revision).toBe(7);
  // The removed source cannot be silently replaced by the next active one.
  useBrowserStore.setState({datasets:[{id:'other',data_type:'bam',label:'Other',path:'other.bam',color:'#000'}]});
  expect(useDifferenceSelection.getState().selection?.datasetId).toBe('native');
  useBrowserStore.setState({differencesSession:originalSession});
});
it.each(['putative','conflicting','ambiguous'] as const)('applies %s policy to geometry counts and rows',level=>{
  const result=structuredClone(response);
  result.targets[0].calls_by_molecule.m={...call,geometry_group:2,
    geometry_evidence:{assignment:'target',level},call:{...call.call,level}} as any;
  const policy={...response.evidence_policy,include_putative:false};
  expect(workspaceAssignments(result,'native',policy).counts).toEqual([0,0,1]);
  expect(workspaceAssignments(result,'native',{...policy,[`include_${level}`]:true})).toMatchObject({counts:[1,0,0],rows:{row1:0,row2:0}});
});
