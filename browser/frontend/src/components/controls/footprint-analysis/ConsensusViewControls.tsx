import { useShallow } from 'zustand/react/shallow';
import { useEffect,useState } from 'react';
import {getConsensusCall,type CurationOperation,type FamilyEvidence,type RecallerStrand} from '../../../api/consensusWorkflow';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { useBrowserStore } from '../../../stores/browserStore';
import { consensusFamilyColor,consensusRecordSummary,type ConsensusRecord } from '../../../utils/consensusVisual';
import { displayFamilies,stateDisplayName } from '../../../utils/consensusTrack';
import { ConsensusCountGroups } from './ConsensusCountGroups';
import { ConsensusCrossEvidence } from './ConsensusCrossEvidence';
import {NativeCrossCallEvidence,NativeModelProvenance} from './NativeCrossDiagnostics';
import {NativeCatalogUpdateSummary} from './NativeCatalogUpdate';

export const RECALLER_CURATION_NOTE='Group and ignore edit the staged engine\'s labelled native calls. A lattice recaller run counts '
  +'its classes from its own per-molecule calls, which those edits would not change. To leave a class out, don\'t save it; '
  +'to count a class more loosely, save it with + edge or + overlap; to change what is found, rerun with a different stringency.';

export function ConsensusCurationToolbar({jobId,compact=false}:{jobId:string;compact?:boolean}){
  const readOnly=useConsensusViewStore(s=>s.catalog?.curation_read_only??false);
  const sharedScope=useConsensusViewStore(s=>s.catalog?.curation_scope);
  const catalog=useConsensusViewStore(s=>s.catalog);
  const {selections,curation,curationBusy,curationLoading,curationError}=useConsensusViewStore(useShallow(s=>({
    selections:s.selections,curation:s.curation,curationBusy:s.curationBusy,curationLoading:s.curationLoading,curationError:s.curationError})));
  const [subclassOpen,setSubclassOpen]=useState(false),[subclassIds,setSubclassIds]=useState<string[]>([]),[label,setLabel]=useState('');
  const rawSelected=selections.filter(s=>s.jobId===jobId);
  const selected=sharedScope?rawSelected.filter((s,i)=>rawSelected.findIndex(v=>v.family===s.family)===i):rawSelected;
  const datasets=[...new Set(selected.map(s=>s.datasetId))];
  const sameDataset=!!sharedScope||datasets.length===1,ready=!!curation&&!curationBusy&&!curationLoading&&!readOnly;
  const common={dataset_id:sharedScope??datasets[0],family_ids:selected.map(s=>s.family)};
  const selectedRef=selected.length===1?selected[0]:null;
  const selectedFamily=selectedRef?displayFamilies(catalog?.datasets[selectedRef.datasetId]).find(f=>f.family===selectedRef.family):undefined;
  const subclassCandidates=selectedFamily?.subclass_candidates??[];
  const canFindSubclasses=ready&&sameDataset&&selected.length===1&&!!selectedFamily&&!selectedFamily.manual;
  // Manual ignore/merge edits the staged engine's labelled native calls; a lattice recaller run's classes are its own
  // per-molecule calls (tf_rc), which those edits don't reach. No toolbar that would look as if it worked.
  const recallerRun=catalog?.cr_mode==='lattice_recaller';
  useEffect(()=>{if(!curation&&!recallerRun)void useConsensusViewStore.getState().loadCuration(jobId);},[jobId,curation,recallerRun]);
  const apply=async(operation:CurationOperation)=>{
    if(await useConsensusViewStore.getState().curate(jobId,operation)){
      setSubclassOpen(false);const browser=useBrowserStore.getState();
      if(['merge','split','restore_subclasses','ignore','unignore'].includes(operation.operation)){
        // tf_cr_manual is the COMPLETE curated display, including unchanged
        // automatic calls. This switches display only, never native evidence.
        browser.toggleModType('tf_cr_manual',true);browser.toggleModType('tf_cr',false);
      }
      browser.triggerRefresh();
    }
  };
  const button='border rounded px-1.5 py-0.5 whitespace-nowrap shrink-0 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40';
  if(recallerRun)return <p data-testid="consensus-curation-unavailable" className="text-[11px] text-gray-500"
    title={RECALLER_CURATION_NOTE}>Manual class edits (group, ignore) are not available for lattice recaller runs.</p>;
  return <div data-testid={compact?'consensus-curation-track':'consensus-curation-panel'} className={`relative ${compact?'text-[11px]':'border rounded p-2 space-y-1 text-xs'}`}>
    <div className={`flex items-center gap-1 ${compact?'flex-nowrap overflow-x-auto h-[26px]':'flex-wrap'}`}>
      <span className="font-semibold whitespace-nowrap" title={datasets.length>1?'Select classes within one dataset to edit':'Exploratory edits leave automatic evidence frozen'}>Edit selected states · {selected.length} selected</span>
      <button className={button} disabled={!ready||!sameDataset||selected.length<2} onClick={()=>void apply({operation:'merge',...common,label:label.trim()||undefined})}>Group selected</button>
      <button className={button} title={selectedFamily?.manual?'Subclasses can be recovered from an automatic class, not a manual group.':'Inspect supported subclasses for this class'}
        disabled={!canFindSubclasses} onClick={()=>{setSubclassIds(subclassCandidates.map(v=>v.family));setSubclassOpen(v=>!v);}}>Find subclasses</button>
      <button className={button} disabled={!ready||!sameDataset} onClick={()=>void apply({operation:'ignore',...common})}>Ignore</button>
      <button className={button} disabled={!ready||!sameDataset} onClick={()=>void apply({operation:'unignore',...common})}>Unignore</button>
      <button className={button} disabled={!ready||!curation?.can_undo} onClick={()=>void apply({operation:'undo'})}>Undo edit</button>
      <button className={button} disabled={!ready||!curation?.can_redo} onClick={()=>void apply({operation:'redo'})}>Redo edit</button>
      <button className={button} disabled={!selected.length} onClick={()=>useConsensusViewStore.getState().select(null)}>Clear</button>
      {!compact&&<button className={button} disabled={!ready||!curation?.operations.length} onClick={()=>void apply({operation:'reset'})}>Reset manual edits</button>}
      <span className="whitespace-nowrap">{curationBusy?'Applying…':curationLoading?'Loading edits…':curation?`revision ${curation.revision}`:''}</span>
    </div>
    {!compact&&<><p className="text-[11px] text-gray-500">Click a class in the track; Ctrl/⌘-click to select several. Group, recover fitted subclasses, ignore, or save the selection (Saved tab).</p>
      <input className="border rounded px-1 dark:bg-gray-900 w-full" aria-label="Manual class label" placeholder="Optional group label" value={label} onChange={e=>setLabel(e.target.value)}/></>}
    {!compact&&sharedScope&&<p role="status" className="text-cyan-700">Manual edits apply to shared classes across all datasets. Original calls, automatic hypotheses and source-specific counts remain available.</p>}
    {!compact&&!sharedScope&&datasets.length>1&&<p role="status" className="text-amber-700">Select classes within one dataset to edit; native catalogs are not merged across datasets.</p>}
    {subclassOpen&&<div role="dialog" aria-label="Review fitted subclasses" className={`${compact?'absolute z-50 top-full left-0 w-96 shadow-lg':''} border rounded bg-white dark:bg-gray-900 p-2 space-y-2`}>
      <p className="font-medium">Supported subclasses</p>
      {subclassCandidates.length>=2?<>
      <p className="text-[11px] text-gray-500">These are distinct classes retained by the earlier fit before consolidation. Choose at least two. Residual calls become unassigned instead of recreating the consolidated parent.</p>
      <div className="space-y-1">{subclassCandidates.map(candidate=><label key={candidate.family} className="flex gap-2 items-start border-b py-1 dark:border-gray-700">
        <input type="checkbox" checked={subclassIds.includes(candidate.family)} onChange={e=>setSubclassIds(ids=>e.target.checked?[...ids,candidate.family]:ids.filter(id=>id!==candidate.family))}/>
        <span><span style={{color:consensusFamilyColor(candidate.family)}}>━ </span>{Math.round(candidate.consensus_start).toLocaleString()}–{Math.round(candidate.consensus_end).toLocaleString()} · {candidate.member_calls} matching calls
          <span className="block text-[11px] text-gray-500">{candidate.primary_calls} primary · {candidate.compatible_calls} compatible in the earlier fit</span></span>
      </label>)}</div>
      <div className="flex gap-2"><button className={button} disabled={!ready||subclassIds.length<2}
        onClick={()=>void apply({operation:'restore_subclasses',...common,label:label.trim()||undefined,subclass_ids:subclassIds})}>Show selected subclasses</button>
        <button className={button} onClick={()=>setSubclassOpen(false)}>Cancel</button></div></>:<>
        <p role="status" className="text-[11px] text-gray-500">No distinct supported subclasses were retained for this class by the earlier fit.</p>
        <button className={button} onClick={()=>setSubclassOpen(false)}>Close</button>
      </>}
    </div>}
    {curationError&&<p role="alert" className={`${compact?'absolute z-50 top-full bg-white dark:bg-gray-900 border rounded p-1':''} text-red-700 break-words`}>{curationError}</p>}
  </div>;
}

export function ConsensusFamilyList({jobId}:{jobId:string}){
  const {catalog,selections,curation}=useConsensusViewStore(useShallow(s=>({catalog:s.catalog,selections:s.selections,curation:s.curation})));
  const [search,setSearch]=useState('');
  if(!catalog)return null;
  return <details className="border rounded p-2"><summary className="font-semibold cursor-pointer">Browse all population classes</summary>
    <input aria-label="Search editable population classes" placeholder="Class ID or coordinate…" className="border rounded w-full my-1 px-1 dark:bg-gray-900" value={search} onChange={e=>setSearch(e.target.value)}/>
    <div className="max-h-64 overflow-y-auto space-y-2">{Object.entries(catalog.datasets).map(([datasetId,dataset])=><div key={datasetId}>
      <div className="font-medium text-[11px]">{datasetId}</div>
      {catalog.cr_mode==='native_family_distribution'&&<NativeCatalogUpdateSummary update={dataset.native_catalog_update}/>}
      {displayFamilies(dataset).filter(f=>!search||`${f.family} ${f.label??''} ${f.consensus_start} ${f.consensus_end}`.includes(search)).map(f=>{
        const selected=selections.some(s=>s.jobId===jobId&&s.datasetId===datasetId&&s.family===f.family);
        const ignored=f.ignored||curation?.ignored_families[datasetId]?.includes(f.family);
        const manual=f.manual;
        const overridden=!manual&&curation?.manual_groups.some(g=>g.dataset_id===datasetId&&g.source_family_ids.includes(f.family));
        return <div key={f.family} className="flex gap-1 items-start py-1 border-b dark:border-gray-800 text-[11px]">
          <input aria-label={`Select ${datasetId} state ${f.family}`} type="checkbox" checked={selected} onChange={()=>useConsensusViewStore.getState().select({jobId,datasetId,family:f.family},true)}/>
          <button className="text-left flex-1" onClick={()=>useConsensusViewStore.getState().select({jobId,datasetId,family:f.family})}>
            <span style={{color:consensusFamilyColor(f.family)}}>━ </span>{stateDisplayName(dataset,f.family,{jobId,datasetId})} · {f.consensus_start.toLocaleString()}–{f.consensus_end.toLocaleString()}
            {manual&&<span className="text-violet-700"> · manual</span>}{ignored&&<span className="text-amber-700"> · ignored</span>}
            {manual&&f.effective_call_ids&&<span> · {f.effective_call_ids.length} manually grouped calls</span>}
            {overridden&&<span className="text-violet-700"> · manual override exists (automatic node)</span>}
            {f.classification_counts&&<span className="block text-gray-500">{Object.entries(f.classification_counts).map(([strand,c])=>f.stage?`${strand}: ${c.compatible_calls} compatible calls (${c.primary_calls} display-primary); ${c.compatible_units??0} compatible / ${c.eligible_units} mean-span eligible units`:`${strand}: ${c.primary_calls} primary / ${c.compatible_calls} compatible calls; ${c.primary_units}/${c.eligible_units} units`).join(' · ')}</span>}
            {f.model_status&&<span className="block text-gray-500">Native model: {f.model_status.replace(/_/g,' ')}{f.source_units!=null?` · ${f.source_units} ${f.stage?'call-bearing':'source'} units`:''}</span>}
          </button>
        </div>;
      })}
    </div>)}</div>
  </details>;
}
export function ConsensusCallInspector({nativeReferencePercent}:{nativeReferencePercent?:number}={}){
  const selected=useConsensusViewStore(s=>s.callSelection?.jobId===s.jobId?s.callSelection:null);
  const catalog=useConsensusViewStore(s=>s.catalog);
  const [detail,setDetail]=useState<{selection:typeof selected;record:ConsensusRecord}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    setDetail(null);setError('');setLoading(false);
    if(!selected?.record.source_call_id||selected.record.candidate_evidence)return;
    const controller=new AbortController();setLoading(true);
    void getConsensusCall(selected.jobId,selected.datasetId,selected.record.source_call_id,controller.signal).then(response=>{
      if(!controller.signal.aborted)setDetail({selection:selected,record:{...response.call,...selected.record,candidate_evidence:response.call.candidate_evidence,native_cross_tests:response.call.native_cross_tests}});
    }).catch(e=>{if(!controller.signal.aborted)setError(String(e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[selected]);
  if(!selected)return null;
  const r=detail?.selection===selected?detail.record:selected.record;
  return <div data-testid="consensus-call-inspector" className="border rounded p-2 space-y-1 text-[11px]">
    <div className="font-semibold">Original footprint evidence · {selected.datasetId}</div>
    <div className="break-all">Read {selected.readId} · {r.interval.join('–')} · original span retained</div>
    <p className="break-words">{consensusRecordSummary(r)}</p>
    {r.automatic_primary_evidence&&<details><summary>Original automatic evidence · not evidence for the manual group</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(r.automatic_primary_evidence,null,2)}</pre></details>}
    {r.source_call_id&&<input aria-label="Selected source call ID" className="border rounded w-full dark:bg-gray-900" readOnly value={r.source_call_id}/>}
    {r.family_evidence&&<details><summary>Stage memberships and evidence</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(r.family_evidence,null,2)}</pre></details>}
    {loading&&<p role="status">Loading the selected call's full candidate ledger…</p>}
    {error&&<p role="alert" className="text-red-700">Candidate ledger unavailable: {error}</p>}
    {r.native_cross_tests&&<details><summary>Selected-call cross-dataset tests and failure reasons</summary>
      {Array.isArray(r.native_cross_tests)&&r.native_cross_tests.map((test,i)=>{
        if(!test||typeof test!=='object'||!('recipient_evidence' in test)||!test.recipient_evidence||typeof test.recipient_evidence!=='object')return null;
        return <details key={i} className="border-b py-1"><summary>{'link_id' in test?String(test.link_id):`Comparison ${i+1}`}{'families' in test?` · ${Object.values(test.families as Record<string,string>).join(' ↔ ')}`:''}</summary>
          <NativeCrossCallEvidence evidence={test.recipient_evidence as FamilyEvidence} referencePercent={nativeReferencePercent}/>
          {'families' in test&&Object.entries(test.families as Record<string,string>).filter(([ds])=>ds!==selected.datasetId).map(([ds,id])=>{
            const donor=catalog?.datasets[ds]?.catalog.find(f=>f.family===id);
            return donor?<NativeModelProvenance key={`${ds}:${id}`} family={donor} label={`Frozen donor ${ds} · ${id}`}/>:<p key={`${ds}:${id}`}>Frozen donor {ds} · {id}: source-fit provenance not present in this catalog.</p>;
          })}
        </details>;
      })}
      <details><summary>Complete immutable XCR call ledger</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(r.native_cross_tests,null,2)}</pre></details>
    </details>}
    {r.candidate_evidence&&<details><summary>{r.candidate_evidence.length} candidate state comparisons · not posterior probabilities</summary>
      <div className="max-h-48 overflow-auto">{r.candidate_evidence.map((e,i)=><div key={i} className="border-b py-1 dark:border-gray-800">
        <div>{e.family} · {e.status??'status unavailable'}{e.fit_converged===false?' · fit NOT converged':''}</div>
        <div>Native loss {e.native_loss?.toFixed(3)??'unavailable'} · floor-adjusted loss {e.floor_adjusted_loss?.toFixed(3)??'unavailable'}</div>
        <div>Predictive tail {e.predictive_tail?.toPrecision(3)??'unavailable'}{e.predictive_tail_interval?` · MC interval [${e.predictive_tail_interval.map(v=>v.toPrecision(3)).join(', ')}]`:''}</div>
        <div>Core protected/access. logLR {e.core_protected_vs_accessible_log_lr?.toFixed(3)??'unavailable'} · source units {e.source_units??'unavailable'} · fold {e.scoring_fold??'unavailable'}</div>
      </div>)}</div></details>}
    <button className="border rounded px-1" onClick={()=>useConsensusViewStore.setState({callSelection:null})}>Clear call inspection</button>
  </div>;
}
export function ConsensusViewControls(){
  const harmonization=useConsensusViewStore(s=>s.catalog?.cr_mode==='call_harmonization');
  const staged=useConsensusViewStore(s=>s.catalog?.cr_mode==='staged_native_families'||s.catalog?.cr_mode==='lattice_recaller');
  const v=useConsensusViewStore(useShallow(s=>({showTrack:s.showTrack,trackLabels:s.trackLabels,trackMinimumCount:s.trackMinimumCount,
    trackComparableOnly:s.trackComparableOnly,latticeEnabled:s.latticeEnabled,latticeHits:s.latticeHits,latticeStyle:s.latticeStyle})));
  const configure=useConsensusViewStore.getState().configure;
  return <details className="border rounded p-1.5 dark:border-gray-700" open><summary className="cursor-pointer font-medium">Population-class display</summary>
    <div className="space-y-1 pt-1">
      <label className="flex gap-2"><input type="checkbox" checked={v.showTrack} onChange={e=>{
        configure({showTrack:e.target.checked});if(e.target.checked){const s=useBrowserStore.getState();
          useBrowserStore.setState({panels:s.panels.map(p=>({...p,subTracks:p.subTracks.map(t=>t.type==='consensus'?{...t,visible:true}:t)}))});}
      }}/>Show overhead population-class track</label>
      <label className="flex gap-2"><input type="checkbox" checked={v.trackLabels} onChange={e=>configure({trackLabels:e.target.checked})}/>Label class IDs and counts</label>
      <label className="flex gap-2 items-center">Minimum catalog assignments (display)<input type="number" min="0" step="1" aria-label="Minimum catalog assignments" className="border rounded w-16 dark:bg-gray-900"
        value={v.trackMinimumCount} onChange={e=>configure({trackMinimumCount:Math.max(0,Math.round(Number(e.target.value)||0))})}/></label>
      <label className="flex gap-2"><input type="checkbox" checked={v.trackComparableOnly} onChange={e=>configure({trackComparableOnly:e.target.checked})}/>{staged?'Only classes with assignments in multiple datasets':`Only catalog classes with ${harmonization?'lattice-comparable':'shape-compatible'} cross-dataset partners`}</label>
      {v.latticeEnabled&&<><p className="text-[11px] text-cyan-700">Native opportunity lattice is enabled in the main Layers bar.</p><label className="flex gap-2"><input type="checkbox" checked={v.latticeHits} onChange={e=>configure({latticeHits:e.target.checked})}/>Overlay model-threshold modification hits</label>
        <label className="flex gap-2">Opportunity marks<select aria-label="Opportunity mark style" value={v.latticeStyle} className="border rounded dark:bg-gray-900" onChange={e=>configure({latticeStyle:e.target.value as 'ticks'|'dots'})}>
          <option value="ticks">Edge ticks</option><option value="dots">Hollow dots</option></select></label>
        <p className="text-[11px] text-gray-500">CT teal, GA amber, Hia5 purple: usable native opportunities. Black: model-threshold hit. No mark is not a miss. Deam/m6A remain independent layers. BAM required; increase row height or zoom for detail.</p></>}
    </div>
  </details>;
}
/** Lattice-recaller class numbers per chemical strand: EM prevalence over all spanning molecules, held-out support and resolution. */
export function RecallerClassSummary({strands}:{strands:Record<string,RecallerStrand>}){
  const pct=(v:number)=>`${(100*v).toFixed(1)}%`;
  return <div data-testid="recaller-class-summary" className="text-[11px] space-y-0.5 border-t pt-1">
    {Object.entries(strands).map(([s,r])=><p key={s}><span className="font-medium">{s==='pooled'?'Hia5':s}</span>: prevalence {pct(r.prevalence)} (lower bound {pct(r.prevalence_lower_bound)}) of {r.molecules.toLocaleString()} molecules
      {' · '}{r.supported?'supported':'not supported'} ({r.support_gain_nats==null?'n/a':`${r.support_gain_nats.toFixed(1)} nats`}){' · '}{r.resolved?'resolved':'unresolved'} ({r.resolution_nats.toFixed(1)} nats)
      {r.spots?` · learned spots ${r.spots}`:''}{r.edge_contraction?` · edge ${r.edge_contraction.startsWith('rejected')?'contraction '+r.edge_contraction:'contracted '+r.edge_contraction}`:''}</p>)}
    <p className="text-gray-500">Prevalence is the EM share of all molecules spanning the class window (broader protection, other shapes and accessible are separate shares). Supported: including the class raises held-out likelihood; resolved: the lattice carries enough evidence for this class on that strand.</p>
  </div>;
}
export function ConsensusFamilyInspector(){
  const {catalog,selection}=useConsensusViewStore(useShallow(s=>({catalog:s.catalog,selection:s.selection})));
  if(!selection||!catalog)return null;
  const dataset=catalog.datasets[selection.datasetId];
  const family=displayFamilies(dataset).find(f=>f.family===selection.family);
  if(!family)return null;
  const staged=catalog.cr_mode==='staged_native_families';
  const recaller=catalog.cr_mode==='lattice_recaller';
  const native=catalog.cr_mode==='native_family_distribution'||staged||recaller;
  const harmonization=catalog.cr_mode==='call_harmonization';
  const cq=catalog.datasets[selection.datasetId]?.comparability.find(f=>f.family===selection.family);
  const rescueRates=catalog.datasets[selection.datasetId]?.rescue_rates;
  const edges=catalog.edges.filter(e=>(e.left_family===selection.family&&(!e.left_dataset||e.left_dataset===selection.datasetId))
    ||(e.right_family===selection.family&&(!e.right_dataset||e.right_dataset===selection.datasetId)));
  return <div data-testid="consensus-family-inspector" className="border-2 rounded p-2 space-y-1" style={{borderColor:consensusFamilyColor(family.family)}}>
    <div className="font-semibold">{stateDisplayName(dataset,family.family,{jobId:selection.jobId,datasetId:selection.datasetId})}{family.manual?' · manual exploratory group':''}</div>
    <div>{family.consensus_start.toLocaleString()}–{family.consensus_end.toLocaleString()} · {family.consensus_end-family.consensus_start} bp {native||harmonization?'display summary, not replacement call edges':'canonical span'}</div>
    <p className="text-[11px] text-gray-500">Selection highlights the fitted mean span; it does not choose a core, change footprint bounds, or edit calls. Counts use the complete region, not only visible reads.</p>
    <details className="text-[11px]"><summary className="cursor-pointer">Display and comparison meaning</summary><p>Black outlines: selected classes in this dataset. Cyan: direct {harmonization?'lattice-comparable':'compatible'} cross-dataset partners. {harmonization?'Exact native memberships are counted once per unit on the same aligned span.':native?'Compatible alternatives can overlap and must not be added as independent calls.':'Native catalog counts use all units at membership ≥ 0.5.'}</p></details>
    {family.source_family_ids&&<details className="text-[11px]"><summary>{family.source_family_ids.length} automatic source class{family.source_family_ids.length===1?'':'s'}</summary><p className="break-all">{family.source_family_ids.join(', ')}. Manual grouping does not change their evidence.</p></details>}
    <details className="text-[11px]"><summary>Technical class ID</summary><p className="break-all">{family.family}</p></details>
    {family.effective_call_ids&&<details><summary>{family.effective_call_ids.length} source call memberships</summary><textarea aria-label="Source call memberships" readOnly className="w-full text-[11px] dark:bg-gray-900" value={family.effective_call_ids.join('\n')}/></details>}
    {native?Object.entries(family.classification_counts??{}).map(([s,r])=><p key={s} className="text-[11px]">{s}: {family.stage?`${r.primary_calls} display-primary / ${r.compatible_calls} compatible calls · ${r.compatible_units??0} compatible / ${r.eligible_units} mean-span eligible units`:`${r.primary_calls} primary / ${r.compatible_calls} compatible / ${r.original_calls} original calls · ${r.primary_units} primary / ${r.eligible_units} eligible units`}</p>)
      :Object.entries(family.rates_by_strand??{}).map(([s,r])=><p key={s}>{s}: native {r.native_assignments} → SR {r.after_sr_assignments}{!rescueRates&&r.after_recall_assignments!==undefined?` → recall ${r.after_recall_assignments}`:''} / {r.eligible_units} eligible</p>)}
    {family.fit_flags&&<p className="text-[11px] text-amber-700">Fit flags: {Array.isArray(family.fit_flags)?family.fit_flags.join(', '):JSON.stringify(family.fit_flags)}</p>}
    {recaller&&family.recaller&&<RecallerClassSummary strands={family.recaller}/>}
    {native&&!staged&&!recaller&&!family.manual&&<NativeModelProvenance family={family}/>}
    {staged&&family.hypothesis&&<details><summary>Technical model details, edge-search range and consolidation provenance</summary><pre className="text-[11px] max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(family.hypothesis,null,2)}</pre></details>}
    {native&&!staged&&!recaller&&<NativeCatalogUpdateSummary update={dataset.native_catalog_update}/>}
    {family.fit_diagnostics&&<details><summary>Native fit / convergence diagnostics</summary><pre className="text-[11px] whitespace-pre-wrap break-all">{JSON.stringify(family.fit_diagnostics,null,2)}</pre></details>}
    {family.evidence_summary&&<details><summary>Native evidence diagnostics</summary><pre className="text-[11px] whitespace-pre-wrap break-all">{JSON.stringify(family.evidence_summary,null,2)}</pre></details>}
    {rescueRates&&<div className="border-t pt-1"><p>New calls at current model P ≥ {(100*rescueRates.probability_threshold).toFixed(1)}%:</p>
      {Object.entries(rescueRates.by_family[family.family]??{}).map(([s,r])=><p key={s}>{s}: CR {r.baseline_units} + {r.added_units} new = {r.combined_units} / {r.all_units} all units</p>)}
      <p className="text-[11px] text-gray-500">Baseline CR stays at P ≥ 50%; only the new-call counts follow the rescue slider. Denominators are not testability-normalized.</p></div>}
    {!native&&cq&&<p>{rescueRates?'Frozen native strand comparability':'Strand comparability'}: {cq.status} · CQ {cq.comparative_Q_model?.toFixed(1)??'unavailable'}</p>}
    <div className="flex gap-2"><button className="border rounded px-2 py-1" onClick={()=>{const store=useBrowserStore.getState();const pad=Math.max(20,family.consensus_end-family.consensus_start);
      // Whole bases: a class's edges can fall on a half base.
      store.setViewport(catalog.region?.chrom??store.chrom,Math.max(0,Math.floor(family.consensus_start-pad)),Math.ceil(family.consensus_end+pad));}}>Zoom to class</button>
      <button className="border rounded px-2 py-1" onClick={()=>useConsensusViewStore.getState().select(null)}>Clear state selection</button></div>
    {!native&&<ConsensusCountGroups groups={(catalog.count_groups??[]).filter(g=>g.left_dataset===selection.datasetId&&g.left_families.includes(selection.family)||g.right_dataset===selection.datasetId&&g.right_families.includes(selection.family))}/>}
    <details><summary className="cursor-pointer">{edges.length} cross-dataset links · {edges.filter(e=>e.comparability_mask).length} {harmonization?'lattice comparable':'shape-compatible'}</summary>
      <div className="max-h-40 overflow-auto">{edges.sort((a,b)=>Number(b.comparability_mask)-Number(a.comparability_mask)).map(e=>{
        const left=e.left_family===selection.family&&(!e.left_dataset||e.left_dataset===selection.datasetId);const other=left?e.right_family:e.left_family;
        const candidates=Object.keys(catalog.datasets).filter(id=>catalog.datasets[id].catalog.some(f=>f.family===other));
        const datasetId=(left?e.right_dataset:e.left_dataset)??(candidates.length===1?candidates[0]:undefined);
        return <div key={e.edge_id}><button className="block text-left underline text-[11px] py-1" disabled={!datasetId} onClick={()=>datasetId&&useConsensusViewStore.getState().select({...selection,datasetId,family:other})}>
          Select {other}</button><ConsensusCrossEvidence edge={e} catalog={catalog}/></div>;
      })}</div></details>
  </div>;
}
