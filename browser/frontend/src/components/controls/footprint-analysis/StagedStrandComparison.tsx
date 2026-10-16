import {useMemo,useState} from 'react';
import type {ConsensusCatalog,ClassificationCounts} from '../../../api/consensusWorkflow';
import {useConsensusViewStore} from '../../../stores/consensusViewStore';
import {useBrowserStore} from '../../../stores/browserStore';
import {displayFamilies,stateDisplayName} from '../../../utils/consensusTrack';
import {consensusFamilyColor} from '../../../utils/consensusVisual';

/** Same conventions as the harmonization ledger: agreement within 10
 * percentage points; fewer than three detections on a side is flagged. */
const AGREEMENT=.1,MIN_DETECTIONS=3;

export interface StrandSide {channel:string;units:number;eligible:number;calls:number;fraction:number|null}
export interface StrandRow {datasetId:string;family:string;name:string;start:number;end:number;
  left:StrandSide;right:StrandSide;difference:number|null;agreement:'similar'|'discordant'|'low'|'unavailable'}

const channelName=(key:string)=>key.includes('::')?key.slice(key.lastIndexOf('::')+2):key;
function side(key:string,c:ClassificationCounts,staged:boolean):StrandSide{
  const units=staged?(c.compatible_units??c.primary_units):c.primary_units;
  return {channel:channelName(key),units,eligible:c.eligible_units,calls:staged?c.compatible_calls:c.primary_calls,
    fraction:c.eligible_units>0?units/c.eligible_units:null};
}

/** Per-class strand comparison from a staged run's per-channel counts. */
export function strandRows(catalog:ConsensusCatalog,jobId:string):StrandRow[]{
  const rows:StrandRow[]=[];
  for(const [datasetId,dataset] of Object.entries(catalog.datasets)){
    const families=displayFamilies(dataset).filter(f=>!f.manual);
    // The dataset's two strands/orientations, from every class's counts, so a
    // class seen on one strand only is still listed (with nothing on the other).
    const channels=[...new Set(families.flatMap(f=>Object.keys(f.classification_counts??{})))]
      .sort((a,b)=>channelName(a).localeCompare(channelName(b)));
    if(channels.length<2)continue;
    const [lk,rk]=channels;
    const none={original_calls:0,primary_calls:0,compatible_calls:0,primary_units:0,compatible_units:0,eligible_units:0};
    for(const f of families){
      const counts=f.classification_counts??{};
      if(!counts[lk]&&!counts[rk])continue;
      const left=side(lk,counts[lk]??none,!!f.stage),right=side(rk,counts[rk]??none,!!f.stage);
      const difference=left.fraction!=null&&right.fraction!=null?right.fraction-left.fraction:null;
      const agreement=difference==null?'unavailable':left.units<MIN_DETECTIONS||right.units<MIN_DETECTIONS?'low'
        :Math.abs(difference)<=AGREEMENT?'similar':'discordant';
      rows.push({datasetId,family:f.family,name:stateDisplayName(dataset,f.family,{jobId,datasetId}),
        start:f.consensus_start,end:f.consensus_end,left,right,difference,agreement});
    }
  }
  return rows;
}

const pct=(v:number|null)=>v==null?'—':`${(100*v).toFixed(1)}%`;
const LABEL={similar:'Similar on both strands',discordant:'Strand-biased',low:'Too few detections',unavailable:'No reads on one strand'};

export function StagedStrandComparison({catalog,jobId,datasetLabels}:{catalog:ConsensusCatalog;jobId:string;datasetLabels?:Record<string,string>}){
  const [sort,setSort]=useState<'position'|'difference'>('position');
  const [onlyBiased,setOnlyBiased]=useState(false);
  const rows=useMemo(()=>strandRows(catalog,jobId)
    .filter(r=>!onlyBiased||r.agreement==='discordant')
    .sort((a,b)=>sort==='difference'?Math.abs(b.difference??0)-Math.abs(a.difference??0):a.start-b.start||a.end-b.end),
  [catalog,jobId,sort,onlyBiased]);
  const multi=Object.keys(catalog.datasets).length>1;
  /** Show a strand's reads for this dataset: the matching strand panel, splitting a both-strands panel if needed. */
  const showStrand=(r:StrandRow,strand:'CT'|'GA')=>{
    const b=useBrowserStore.getState();
    const panels=b.panels.filter(p=>p.contentType==='dataset'&&p.datasetId===r.datasetId&&!p.viewportOverride);
    if(!panels.some(p=>p.strand===strand)){
      const both=panels.find(p=>!p.strand);
      if(both)b.splitPanelByStrand(both.id);
      // Only the other strand is shown: add this one next to it.
      else if(panels[0])b.addStrandPanel(panels[0].id,strand);
    }
    select(r);
  };
  const select=(r:StrandRow)=>{
    const view=useConsensusViewStore.getState();view.select({jobId,datasetId:r.datasetId,family:r.family});
    const b=useBrowserStore.getState();b.setViewport(catalog.region?.chrom??b.chrom,Math.max(0,Math.floor(r.start-30)),Math.ceil(r.end+30));
  };
  return <section data-testid="strand-comparison" className="space-y-2 text-xs">
    <p className="text-[11px] text-gray-600 dark:text-gray-300">Share of reads covering each class that carry it, on each strand (within {100*AGREEMENT} percentage points counts as similar). A bound footprint protects both strands, so a large difference is worth a look; it can also come from where each strand can be deaminated (sequence context), not only from an artifact.</p>
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <select aria-label="Strand comparison sort" className="rounded border bg-white px-1 py-0.5 dark:bg-gray-900" value={sort} onChange={e=>setSort(e.target.value as 'position'|'difference')}>
        <option value="position">Genomic order</option><option value="difference">Largest difference</option></select>
      <label className="flex items-center gap-1"><input type="checkbox" checked={onlyBiased} onChange={e=>setOnlyBiased(e.target.checked)}/>Strand-biased only</label>
      <span className="text-gray-500">{rows.length} class{rows.length===1?'':'es'}</span>
    </div>
    {rows.length===0?<p className="text-gray-500">{onlyBiased?'No strand-biased classes.':'This run has no per-strand counts to compare.'}</p>:
    <div className="max-h-80 overflow-auto rounded border border-gray-200 dark:border-gray-700">
      <table className="w-full text-[11px] tabular-nums">
        <thead className="sticky top-0 bg-gray-50 text-left dark:bg-gray-800"><tr>
          <th className="px-1.5 py-1">Class</th><th className="px-1.5">Strand 1</th><th className="px-1.5">Strand 2</th><th className="px-1.5">Difference</th><th className="px-1.5"></th><th className="px-1.5" title="Show this strand's reads (splits the panel into CT | GA if needed)">Show</th></tr></thead>
        <tbody>{rows.map(r=><tr key={`${r.datasetId}:${r.family}`} data-testid="strand-row" className="cursor-pointer border-t border-gray-100 hover:bg-cyan-50 dark:border-gray-800 dark:hover:bg-cyan-950/30"
          onClick={()=>select(r)} title={`${r.left.calls} / ${r.right.calls} calls; ${r.left.units} of ${r.left.eligible} and ${r.right.units} of ${r.right.eligible} reads`}>
          <td className="px-1.5 py-0.5"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{backgroundColor:consensusFamilyColor(r.family)}}/>{r.name}{multi&&<span className="text-gray-500"> · {datasetLabels?.[r.datasetId]??r.datasetId}</span>}<span className="text-gray-500"> · {Math.round(r.end-r.start)} bp</span></td>
          <td className="px-1.5"><span className="text-gray-500">{r.left.channel}</span> {pct(r.left.fraction)} <span className="text-gray-400">({r.left.units})</span></td>
          <td className="px-1.5"><span className="text-gray-500">{r.right.channel}</span> {pct(r.right.fraction)} <span className="text-gray-400">({r.right.units})</span></td>
          <td className="px-1.5">{r.difference==null?'—':`${r.difference>0?'+':''}${(100*r.difference).toFixed(1)} pp`}</td>
          <td className={`px-1.5 ${r.agreement==='discordant'?'text-amber-700 dark:text-amber-300':r.agreement==='similar'?'text-emerald-700 dark:text-emerald-400':'text-gray-500'}`}>{LABEL[r.agreement]}</td>
          <td className="whitespace-nowrap px-1.5" onClick={e=>e.stopPropagation()}>
            {(['CT','GA'] as const).filter(s=>s===r.left.channel||s===r.right.channel).map(s=>(
              <button key={s} type="button" data-testid={`strand-show-${s}`} onClick={()=>showStrand(r,s)}
                className="mr-0.5 rounded border border-gray-300 px-1 text-[11px] hover:bg-white dark:border-gray-600 dark:hover:bg-gray-700"
                title={`Show only ${s}-strand reads for this dataset, side by side with the other strand`}>{s}</button>))}
          </td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
