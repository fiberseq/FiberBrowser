import { useEffect,useMemo,useState } from 'react';
import { useConsensusViewStore } from '../stores/consensusViewStore';
import { getNativeLattice,type NativeLatticeResponse } from '../api/consensusWorkflow';
/** A displayed read: its name and, from BAM loads, which primary alignment it is. */
export interface LatticeRead {
  id:string;library_id?:string;reference_start?:number;reference_end?:number;alignment_orientation?:string;
}
type AlignmentIdentity=Omit<LatticeRead,'id'>;
/** Each read's alignment identity, so the server can tell apart primaries sharing a name (merged BAMs). */
export function latticeIdentities(reads:LatticeRead[]):Record<string,AlignmentIdentity>{
  // Only merged datasets' reads carry these fields. A name shown on two rows
  // can't pin one alignment (the lattice is keyed by name): left unpinned, the
  // server reports it ambiguous instead of drawing one row's lattice on both.
  const out:Record<string,AlignmentIdentity>={};const shared=new Set<string>();
  for(const r of reads){
    if(r.library_id==null&&r.reference_start==null)continue;
    if(r.id in out)shared.add(r.id);
    out[r.id]={library_id:r.library_id,reference_start:r.reference_start,reference_end:r.reference_end,
      alignment_orientation:r.alignment_orientation};
  }
  for(const id of shared)delete out[id];
  return out;
}
export function useNativeLattice(datasetId:string,chrom:string,start:number,end:number,reads:LatticeRead[],datatype?:string){
  const enabled=useConsensusViewStore(s=>s.latticeEnabled);
  const override=useConsensusViewStore(s=>s.chemistries[datasetId]);
  const chemistry=override||datatype;
  const idsKey=JSON.stringify([...new Set(reads.map(r=>r.id))].sort());
  const ids=useMemo(()=>JSON.parse(idsKey) as string[],[idsKey]);
  const identitiesKey=JSON.stringify(latticeIdentities(reads));
  const identities=useMemo(()=>JSON.parse(identitiesKey) as Record<string,AlignmentIdentity>,[identitiesKey]);
  const [data,setData]=useState<NativeLatticeResponse|null>(null);
  const [message,setMessage]=useState('');
  const key=JSON.stringify([datasetId,chrom,start,end,chemistry,idsKey,identitiesKey]);
  const [readyKey,setReadyKey]=useState('');
  useEffect(()=>{
    setReadyKey('');setData(null);setMessage('');
    if(!enabled||!ids.length)return;
    const controller=new AbortController();setMessage('Loading native opportunity lattice…');
    const timer=setTimeout(()=>{getNativeLattice({dataset_id:datasetId,chrom,start,end,read_ids:ids,read_identities:identities,chemistry},controller.signal)
      .then(value=>{if(!controller.signal.aborted){setData(value);setReadyKey(key);
        setMessage(`Native lattice · ${chemistry} · ${Object.keys(value.reads).length}/${ids.length} displayed reads have observations`);}})
      .catch(error=>{if(!controller.signal.aborted)setMessage(`Lattice unavailable: ${String(error)}`);});},120);
    return()=>{clearTimeout(timer);controller.abort();};
  },[enabled,key]);
  return {lattice:enabled&&readyKey===key?data:null,latticeMessage:enabled?message:'',latticeEnabled:enabled};
}
