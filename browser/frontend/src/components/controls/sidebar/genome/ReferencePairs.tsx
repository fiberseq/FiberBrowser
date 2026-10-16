import {useEffect,useState} from 'react';
import {fetchJson} from '../../../../api/sharedFetch';
import {pickFile} from '../../../../api/files';
import {useBrowserStore} from '../../../../stores/browserStore';
import {showLoadedReference} from '../../../../utils/referenceNavigation';
import {defineSettings,inSidebar,settingAnchor} from '../../../../utils/settingsCatalog';
export const REFERENCE_PAIR_SETTINGS=defineSettings({
  pairs:{
    id:'genome.reference-pairs',
    label:'Multiple FASTA / annotation pairs',
    keywords:['haplotypes','diploid','reference pairs','two references','gtf','gff'],
    location:inSidebar('genome.reference'),
  },
});
type Pair={fasta:string;annotation:string|null};
export function ReferencePairs(){
  const [pairs,setPairs]=useState<Pair[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{void fetchJson<{pairs:Pair[]}>('/api/reference_pairs').then(value=>setPairs(value.pairs)).catch(error=>setMessage(String(error)));},[]);
  const choose=async(index:number,kind:'fasta'|'annotation')=>{
    try{const value=await pickFile(kind==='fasta'?'fasta':'gtf');if(value.success&&value.path)setPairs(rows=>rows.map((row,i)=>i===index?{...row,[kind]:value.path!}:row));}catch(error){setMessage(String(error));}
  };
  const load=async()=>{
    setBusy(true);setMessage('Loading reference pairs…');
    try{
      const result=await fetchJson<{success:boolean;error?:string;gene_count:number;sequences:number}>('/api/reference_pairs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pairs)});
      if(!result.success)throw new Error(result.error);
      const store=useBrowserStore.getState();store.setHasFasta(true);store.setFastaPath(pairs[0].fasta);store.setCurrentGenome(null);
      // Kept for crash recovery, which would otherwise reload only the first FASTA.
      useBrowserStore.setState({referencePairs:pairs.map(row=>({fasta:row.fasta,annotation:row.annotation??null}))} as never);
      // Refreshes, and leaves a chromosome the new references don't have.
      await showLoadedReference();
      setMessage(`Loaded ${pairs.length} references, ${result.sequences} chromosomes and ${result.gene_count} transcripts.`);
    }catch(error){setMessage(String(error));}finally{setBusy(false);}
  };
  return <details className="mt-2 text-xs" data-tour="reference-pairs" {...settingAnchor(REFERENCE_PAIR_SETTINGS.pairs)}><summary className="cursor-pointer font-medium">{REFERENCE_PAIR_SETTINGS.pairs.label}</summary>
    <p className="my-1 text-[11px] text-gray-500">Load haplotypes together using distinct chromosome names matching the BAMs. Applying this list replaces the active reference set. Annotations accept GTF, GFF or BED.</p>
    {pairs.map((pair,index)=><div key={index} className="my-1 rounded border p-1 space-y-1">
      <div className="flex gap-1"><input aria-label={`Reference ${index+1} FASTA`} placeholder="FASTA path" value={pair.fasta} onChange={event=>setPairs(rows=>rows.map((row,i)=>i===index?{...row,fasta:event.target.value}:row))} className="w-full min-w-0 bg-transparent"/><button onClick={()=>void choose(index,'fasta')}>Browse</button></div>
      <div className="flex gap-1"><input aria-label={`Reference ${index+1} annotation`} placeholder="Optional GTF/GFF/BED path" value={pair.annotation||''} onChange={event=>setPairs(rows=>rows.map((row,i)=>i===index?{...row,annotation:event.target.value||null}:row))} className="w-full min-w-0 bg-transparent"/><button onClick={()=>void choose(index,'annotation')}>Browse</button></div>
      <button className="text-red-600" onClick={()=>setPairs(rows=>rows.filter((_,i)=>i!==index))}>Remove from list</button>
    </div>)}
    <div className="flex gap-2"><button disabled={busy} onClick={()=>setPairs(rows=>[...rows,{fasta:'',annotation:null}])}>Add reference pair</button><button disabled={busy||!pairs.length||pairs.some(row=>!row.fasta.trim())} onClick={()=>void load()} className="rounded bg-blue-700 px-2 py-1 text-white disabled:opacity-40">Load pairs</button></div>
    {message&&<p role="status" className="mt-1 break-words">{message}</p>}
  </details>;
}
