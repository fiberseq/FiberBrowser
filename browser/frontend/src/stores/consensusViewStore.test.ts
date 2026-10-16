import { beforeEach,expect,it,vi } from 'vitest';
import type { ConsensusCatalog,ConsensusCuration } from '../api/consensusWorkflow';
const {getCatalog,getCuration,updateCuration}=vi.hoisted(()=>({getCatalog:vi.fn(),getCuration:vi.fn(),updateCuration:vi.fn()}));
vi.mock('../api/consensusWorkflow',()=>({getConsensusCatalog:getCatalog,getConsensusCuration:getCuration,updateConsensusCuration:updateCuration}));
import { useConsensusViewStore } from './consensusViewStore';

const catalog=(threshold:number)=>({datasets:{},edges:[],threshold} as unknown as ConsensusCatalog);
beforeEach(()=>{vi.resetAllMocks();useConsensusViewStore.setState({jobId:null,catalog:null,selection:null,selections:[],callSelection:null,curation:null,curationBusy:false,curationLoading:false,curationError:'',loading:false,error:''});});
const curation=(revision=0):ConsensusCuration=>({revision,catalog_digest:'frozen',can_undo:revision>0,can_redo:false,operations:[],manual_groups:[],ignored_families:{}});

it('multiselects by job AND dataset, toggling only the requested family',()=>{
  const a={jobId:'j',datasetId:'d',family:'same'},b={...a,datasetId:'h'};
  useConsensusViewStore.getState().select(a);
  useConsensusViewStore.getState().select(b,true);
  expect(useConsensusViewStore.getState().selections).toEqual([a,b]);
  useConsensusViewStore.getState().select(a,true);
  expect(useConsensusViewStore.getState().selections).toEqual([b]);
  useConsensusViewStore.getState().select({...a,jobId:'new'},true);
  expect(useConsensusViewStore.getState().selections).toEqual([{...a,jobId:'new'}]);
  useConsensusViewStore.getState().select(null);expect(useConsensusViewStore.getState().selections).toEqual([]);
});
it('sends the current revision and refreshes catalog after an undoable edit',async()=>{
  useConsensusViewStore.setState({jobId:'j',curation:curation(4),catalog:catalog(.5)});
  updateCuration.mockResolvedValue(curation(5));getCatalog.mockResolvedValue(catalog(.5));
  const operation={operation:'merge' as const,dataset_id:'d',family_ids:['A','B']};
  expect(await useConsensusViewStore.getState().curate('j',operation)).toBe(true);
  expect(updateCuration).toHaveBeenCalledWith('j',4,operation);
  expect(useConsensusViewStore.getState().curation?.revision).toBe(5);
  expect(getCatalog).toHaveBeenCalledWith('j');
});
it('does not fabricate an edit on revision conflict and retrieves the latest history',async()=>{
  const original=catalog(.5);useConsensusViewStore.setState({jobId:'j',curation:curation(1),catalog:original});
  updateCuration.mockRejectedValue(new Error('409 revision conflict'));getCuration.mockResolvedValue(curation(2));
  expect(await useConsensusViewStore.getState().curate('j',{operation:'undo'})).toBe(false);
  expect(useConsensusViewStore.getState().catalog).toBe(original);
  expect(useConsensusViewStore.getState().curation?.revision).toBe(2);
  expect(useConsensusViewStore.getState().curationError).toContain('409');
  expect(useConsensusViewStore.getState().curationBusy).toBe(false);
});
it('changing jobs clears selections and manual history without editing either catalog',async()=>{
  useConsensusViewStore.setState({jobId:'old',curation:curation(3),selections:[{jobId:'old',datasetId:'d',family:'A'}]});
  getCatalog.mockResolvedValue(catalog(.5));await useConsensusViewStore.getState().load('new');
  expect(useConsensusViewStore.getState().curation).toBeNull();expect(useConsensusViewStore.getState().selections).toEqual([]);
});

it('refreshes displayed rates without dropping the clicked family',async()=>{
  const first=catalog(.5),next=catalog(.9);getCatalog.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
  await useConsensusViewStore.getState().load('job');
  const selection={jobId:'job',datasetId:'d',family:'F1'};
  useConsensusViewStore.getState().select(selection);
  await useConsensusViewStore.getState().load('job');
  expect(getCatalog).toHaveBeenCalledTimes(1);
  await useConsensusViewStore.getState().load('job',true);
  expect(useConsensusViewStore.getState().catalog).toBe(next);
  expect(useConsensusViewStore.getState().selection).toEqual(selection);
});

it('does not install stale rates after a more recent filter refresh',async()=>{
  let oldResolve!:(value:ConsensusCatalog)=>void;
  const old=new Promise<ConsensusCatalog>(resolve=>{oldResolve=resolve;});
  const newest=catalog(.99);getCatalog.mockReturnValueOnce(old).mockResolvedValueOnce(newest);
  const pending=useConsensusViewStore.getState().load('job');
  await useConsensusViewStore.getState().load('job',true);
  oldResolve(catalog(.5));await pending;
  expect(useConsensusViewStore.getState().catalog).toBe(newest);
  expect(useConsensusViewStore.getState().loading).toBe(false);
});
it('bumps the catalog revision on every catalog load, so memberships derived from it are recomputed',async()=>{
  useConsensusViewStore.setState({jobId:'j',catalog:catalog(.5),catalogRevision:3});
  getCatalog.mockResolvedValue(catalog(.9));
  // A stringency change force-reloads the same job's catalog.
  await useConsensusViewStore.getState().load('j',true);
  expect(useConsensusViewStore.getState().catalogRevision).toBe(4);
  await useConsensusViewStore.getState().load('j',true);
  expect(useConsensusViewStore.getState().catalogRevision).toBe(5);
});
