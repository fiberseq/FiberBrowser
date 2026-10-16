import {useMemo,useState} from 'react';
import {useShallow} from 'zustand/react/shallow';
import {useConsensusViewStore} from '../../../stores/consensusViewStore';
import {useBrowserStore} from '../../../stores/browserStore';
import type {NativeComparisonRow,NativeCountSummary} from '../../../api/consensusWorkflow';
import {ConsensusCurationToolbar} from './ConsensusViewControls';
import {StagedStrandComparison} from './StagedStrandComparison';
import {RecallerClassTable} from './RecallerClassTable';

const percent=(v:number|null)=>v==null?'—':`${(v*100).toFixed(1)}%`;
const names:Record<string,string>={lattice_comparable:'Lattice comparable',not_comparable:'Not comparable',
  similar_observed_fractions:'Similar fractions',discordant_observed_fractions:'Discordant fractions',
  low_detection_counts:'Low detection counts',unavailable:'Unavailable'};
const control='border rounded px-1 py-1 bg-white dark:bg-gray-900 min-w-0';

function Counts({label,value}:{label:string;value:NativeCountSummary}){
  return <div className="space-y-0.5"><div className="font-medium break-all">{label}</div>
    <div>{value.assigned_units.toLocaleString()} / {value.covered_units.toLocaleString()} · {percent(value.fraction)}</div>
    <div className="text-gray-500">Lattice capable: {percent(value.lattice_capable_fraction)} · {value.mean_opportunities?.toFixed(1)??'—'} sites</div>
    <div className="text-gray-500">Single-MSP / unmasked: {value.physically_accessible_units.toLocaleString()} ({percent(value.covered_units?value.physically_accessible_units/value.covered_units:null)}) · multiple members: {value.multiple_member_units}</div>
  </div>;
}

export function ConsensusComparison(){
  const {catalog,jobId,curation,loading,error}=useConsensusViewStore(useShallow(s=>({catalog:s.catalog,jobId:s.jobId,
    curation:s.curation,loading:s.loading,error:s.error})));
  const datasets=useBrowserStore(s=>s.datasets);
  const [resolution,setResolution]=useState('native_class');const [kind,setKind]=useState('assay');
  const [status,setStatus]=useState('all');const [agreement,setAgreement]=useState('all');
  const [search,setSearch]=useState('');const [sort,setSort]=useState('position');
  const [establishedOnly,setEstablishedOnly]=useState(true);
  const rows=useMemo(()=>{
    const values=(catalog?.comparison?.rows??[]).filter(r=>r.resolution===resolution&&r.comparison_kind===kind
      &&(!establishedOnly||r.established!==false)
      &&(status==='all'||r.comparability===status)&&(agreement==='all'||r.agreement===agreement)
      &&(!search||`${r.family} ${r.interval.join(' ')} ${r.left_label} ${r.right_label} ${r.child_families.join(' ')}`.toLowerCase().includes(search.toLowerCase())));
    return values.sort((a,b)=>sort==='difference'?(b.absolute_difference??-1)-(a.absolute_difference??-1):a.interval[0]-b.interval[0]||a.family.localeCompare(b.family));
  },[catalog,resolution,kind,status,agreement,search,sort,establishedOnly]);
  function select(row:NativeComparisonRow,label:string){
    if(!jobId||!catalog)return;
    const datasetId=row.comparison_kind==='strand'?label.slice(0,label.lastIndexOf(':')):label;
    const ids=row.child_families.filter(f=>catalog.datasets[datasetId]?.catalog.some(c=>c.family===f));
    const state=useConsensusViewStore.getState();state.select(null);
    ids.forEach(family=>state.select({jobId,datasetId,family},true));
    const browser=useBrowserStore.getState();browser.setViewport(catalog.region?.chrom??browser.chrom,
      Math.max(0,Math.floor(row.interval[0]-30)),Math.ceil(row.interval[1]+30));
  }
  // Recaller runs: per-channel EM prevalence of every class, with strand and assay differences.
  if(!catalog?.comparison&&catalog?.cr_mode==='lattice_recaller'&&jobId)
    return <RecallerClassTable jobId={jobId} catalog={catalog} variant="compare" datasetLabels={Object.fromEntries(datasets.map(d=>[d.id,d.label||d.id]))}/>;
  // Staged runs (Find footprint classes) have per-strand counts for every class, not the harmonization ledger.
  if(!catalog?.comparison&&catalog?.cr_mode==='staged_native_families'&&jobId)
    return <StagedStrandComparison catalog={catalog} jobId={jobId} datasetLabels={Object.fromEntries(datasets.map(d=>[d.id,d.label||d.id]))}/>;
  if(!catalog?.comparison)return <section data-testid="consensus-comparison" className="p-2 space-y-2 text-xs">
    <h3 className="font-semibold">Class comparisons</h3>
    <p>{loading?'Loading comparisons…':'Find footprint classes above first; the comparison appears when a run has finished.'}</p>
    {error&&<p role="alert">{error}</p>}</section>;
  return <section data-testid="consensus-comparison" className="space-y-2 text-xs">
    <h3 className="font-semibold">Class comparisons · native calls only</h3>
    <p>Lattice comparability and observed agreement are separate. Counts use the same fully aligned span in both groups; no rescue, pooled presence call or occupancy correction.</p>
    <p className="text-[11px] text-gray-500">“Lattice capable” means the recorded sites could exceed the native LLR threshold with the required opportunity count. It is not measured sensitivity. Similar fractions alone do not prove equal detection.</p>
    {jobId&&<ConsensusCurationToolbar jobId={jobId}/>}
    {!!(curation?.manual_groups.length||Object.values(curation?.ignored_families??{}).some(ids=>ids.length))&&<p className="text-amber-700 text-[11px]">Manual display overrides are active. The comparison ledger below remains the frozen automatic analysis; manual groups do not inherit automatic comparability flags.</p>}
    <div className="grid grid-cols-2 gap-1">
      <select className={control} aria-label="Comparison resolution" value={resolution} onChange={e=>setResolution(e.target.value)}>
        <option value="native_class">Native classes</option><option value="coarse_any_child">Coarser ANY-child events</option></select>
      <select className={control} aria-label="Comparison kind" value={kind} onChange={e=>setKind(e.target.value)}>
        <option value="assay">Between datasets / assays</option><option value="strand">Between strands / orientations</option></select>
      <select className={control} aria-label="Lattice comparability filter" value={status} onChange={e=>setStatus(e.target.value)}>
        <option value="all">All comparability states</option><option value="lattice_comparable">Lattice comparable</option><option value="not_comparable">Not comparable</option></select>
      <select className={control} aria-label="Observed agreement filter" value={agreement} onChange={e=>setAgreement(e.target.value)}>
        <option value="all">All observed outcomes</option><option value="similar_observed_fractions">Similar fractions</option>
        <option value="discordant_observed_fractions">Discordant fractions</option><option value="low_detection_counts">Low detection counts</option><option value="unavailable">Unavailable</option></select>
      <input className={control} aria-label="Search class comparisons" placeholder="Class, coordinate or dataset…" value={search} onChange={e=>setSearch(e.target.value)}/>
      <select className={control} aria-label="Comparison sort" value={sort} onChange={e=>setSort(e.target.value)}><option value="position">Genomic order</option><option value="difference">Largest absolute difference</option></select>
    </div>
    <p className="text-[11px]">{rows.length} comparisons shown. Agreement tolerance: {(100*(catalog.comparison.options.agreement_difference??.1)).toFixed(0)} percentage points; fewer than three detections on either side is flagged separately. Hia5 FWD/REV are alignment orientations, not paired physical strands.</p>
    {resolution==='coarse_any_child'&&<p className="text-[11px] text-violet-700">A coarser event counts ANY listed native child once per unit. Its scale follows wider recurrent assay-native geometry, not the depth-dominated pooled median; the common evaluation span and denominator can therefore change. Multiple child detections remain recorded. This does not assert that disjoint footprints are one biological footprint.</p>}
    <label className="flex gap-2"><input type="checkbox" checked={establishedOnly} onChange={e=>setEstablishedOnly(e.target.checked)}/>Established classes only (at least three independent source units)</label>
    <div className="max-h-[36rem] overflow-auto space-y-2">
      {!rows.length&&<p>No comparisons match these filters.</p>}
      {rows.map(r=><article key={`${r.family}:${r.left_label}:${r.right_label}`} className="border rounded p-2 space-y-1 dark:border-gray-700">
        <div className="font-semibold break-all">{r.family} · {r.interval[0].toLocaleString()}–{r.interval[1].toLocaleString()}</div>
        <div className={r.comparability==='lattice_comparable'?'text-cyan-700':'text-amber-700'}>{names[r.comparability]} · {names[r.agreement]??r.agreement}</div>
        <div className="grid grid-cols-2 gap-2 text-[11px]"><Counts label={r.left_label} value={r.left}/><Counts label={r.right_label} value={r.right}/></div>
        <p>Right − left: {r.difference==null?'unavailable':`${(100*r.difference).toFixed(1)} percentage points`}</p>
        {!!r.reasons.length&&<p className="text-amber-700 text-[11px]">{r.reasons.map(s=>s.replace(/_/g,' ')).join('; ')}</p>}
        {r.left.covered_units>0&&r.right.covered_units>0&&Math.abs(r.left.physically_accessible_units/r.left.covered_units-r.right.physically_accessible_units/r.right.covered_units)>.25&&
          <p className="text-amber-700 text-[11px]">The single-MSP/unmasked fractions differ by more than 25 percentage points. Upstream MSP/nucleosome masks can drive this count gap even when both lattices are capable.</p>}
        {catalog.region&&Math.min(r.interval[0]-catalog.region.start,catalog.region.end-r.interval[1])<150&&
          <p className="text-amber-700 text-[11px]">Within 150 bp of the analysis boundary. Scope clipping or terminal effects may affect this comparison; the lattice flag is not a boundary-quality guarantee.</p>}
        <div className="flex gap-1"><button className={control} onClick={()=>select(r,r.left_label)}>Inspect / select left classes</button>
          <button className={control} onClick={()=>select(r,r.right_label)}>Inspect / select right classes</button></div>
        <details className="text-[11px]"><summary>Membership and count details</summary><p className="break-all">Native children: {r.child_families.join(', ')}</p>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify({left:r.left,right:r.right,geometry_basis:r.geometry_basis,anchor_assay:r.anchor_assay,child_intervals:r.child_intervals,semantics:r.semantics},null,2)}</pre></details>
      </article>)}
    </div>
  </section>;
}
