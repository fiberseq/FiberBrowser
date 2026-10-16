import { create } from 'zustand';
import { getConsensusCatalog,getConsensusCuration,updateConsensusCuration,
  type ConsensusCatalog,type ConsensusCuration,type CurationOperation } from '../api/consensusWorkflow';
import type {ConsensusRecord} from '../utils/consensusVisual';
import {setConsensusPalette} from '../utils/consensusVisual';

export type FamilySelection={jobId:string;datasetId:string;family:string};
interface ConsensusView {
  jobId:string|null;catalog:ConsensusCatalog|null;loading:boolean;error:string;
  /** Bumped on every catalog load: a reload (e.g. after the assignment stringency changed) can change memberships. */
  catalogRevision:number;
  selection:FamilySelection|null;showTrack:boolean;trackMinimumCount:number;trackLabels:boolean;trackComparableOnly:boolean;
  selections:FamilySelection[];curation:ConsensusCuration|null;curationLoading:boolean;curationBusy:boolean;curationError:string;
  callSelection:{jobId:string;datasetId:string;readId:string;record:ConsensusRecord}|null;
  latticeEnabled:boolean;latticeHits:boolean;latticeStyle:'ticks'|'dots';chemistries:Record<string,string>;
  load:(jobId:string,force?:boolean)=>Promise<void>;select:(value:FamilySelection|null,additive?:boolean)=>void;
  loadCuration:(jobId:string)=>Promise<void>;curate:(jobId:string,operation:CurationOperation)=>Promise<boolean>;
  configure:(value:Partial<Pick<ConsensusView,'showTrack'|'trackMinimumCount'|'trackLabels'|'trackComparableOnly'|'latticeEnabled'|'latticeHits'|'latticeStyle'|'chemistries'>>)=>void;
}
let pending:Promise<void>|null=null;let pendingId='';let generation=0;
export const useConsensusViewStore=create<ConsensusView>((set,get)=>({
  jobId:null,catalog:null,catalogRevision:0,loading:false,error:'',selection:null,showTrack:true,trackMinimumCount:0,trackLabels:false,
  selections:[],callSelection:null,curation:null,curationLoading:false,curationBusy:false,curationError:'',
  trackComparableOnly:false,latticeEnabled:false,latticeHits:true,latticeStyle:'ticks',chemistries:{},
  select:(selection,additive=false)=>set(state=>{
    if(!selection)return {selection:null,selections:[],callSelection:null};
    const same=(other:FamilySelection)=>other.jobId===selection.jobId&&other.datasetId===selection.datasetId&&other.family===selection.family;
    const current=state.selections.filter(other=>other.jobId===selection.jobId);
    const selections=additive?(current.some(same)?current.filter(other=>!same(other)):[...current,selection]):[selection];
    return {selection:selections[selections.length-1]??null,selections,callSelection:null};
  }),configure:value=>set(value),
  loadCuration:async(jobId)=>{
    if(get().curationLoading)return;
    set({curationLoading:true,curationError:''});
    try{const curation=await getConsensusCuration(jobId);if(get().jobId===jobId)set({curation});}
    catch(error){if(get().jobId===jobId)set({curationError:String(error)});}
    finally{if(get().jobId===jobId)set({curationLoading:false});}
  },
  curate:async(jobId,operation)=>{
    const state=get();if(state.curationBusy||state.jobId!==jobId)return false;
    if(!state.curation){set({curationError:'Load the current manual revision before editing.'});return false;}
    set({curationBusy:true,curationError:''});
    try{
      const curation=await updateConsensusCuration(jobId,state.curation.revision,operation);
      if(get().jobId!==jobId)return false;
      set({curation});await get().load(jobId,true);return true;
    }catch(error){
      if(get().jobId===jobId){set({curationError:String(error)});try{const curation=await getConsensusCuration(jobId);if(get().jobId===jobId)set({curation});}catch{/* original edit error is retained */}}
      return false;
    }finally{if(get().jobId===jobId)set({curationBusy:false});}
  },
  load:async(jobId,force=false)=>{
    if(!force&&get().jobId===jobId&&get().catalog)return;
    if(!force&&pendingId===jobId&&pending)return pending;
    const sameJob=get().jobId===jobId;
    const seq=++generation;pendingId=jobId;set({jobId,catalog:sameJob?get().catalog:null,
      selection:sameJob?get().selection:null,selections:sameJob?get().selections:[],
      callSelection:sameJob&&!force?get().callSelection:null,
      curation:sameJob?get().curation:null,curationLoading:sameJob?get().curationLoading:false,
      curationBusy:sameJob?get().curationBusy:false,curationError:sameJob?get().curationError:'',loading:true,error:''});
    pending=getConsensusCatalog(jobId).then(catalog=>{if(seq===generation){
      setConsensusPalette(Object.values(catalog.datasets).flatMap(ds=>[
        ...ds.catalog,...(ds.curated_display_families??[])].filter(f=>!f.superseded_by_manual).map(f=>f.family)));
      set({catalog,catalogRevision:get().catalogRevision+1,loading:false});}})
      .catch(error=>{if(seq===generation)set({loading:false,error:String(error)});})
      .finally(()=>{if(seq===generation){pending=null;pendingId='';}});
    return pending;
  },
}));
