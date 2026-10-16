import { useEffect,useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { useConsensusViewStore } from '../../stores/consensusViewStore';
import { consensusFamilyColor } from '../../utils/consensusVisual';
import { sameChrom } from '../../utils/chromAliases';
import { HoverHint, HoverLabel, useTrackLabels } from './TrackLabels';
import { FootprintClasses } from '../ui/Icons';
import { TRACK_BACKGROUND } from './TrackContainerConstants';
import { classFeature, hoverFeature, toggleClassFeatures } from '../../utils/classFeatures';
import { featureKey, useFeatureStore } from '../../stores/featureStore';
import { familyCount,packFamilies,relatedFamilyRefs,comparableFamilyRefs,familyRefKey,trackX,displayFamilies,stateDisplayName } from '../../utils/consensusTrack';

export function consensusJobId(dataset:any):string|null {
  // Recaller runs register only their class layer (tf_rc); other engines the labelled native one (tf_cr).
  return dataset?.derived_layers?.tf_cr?.consensus_job_id??dataset?.derived_layers?.tf_rc?.consensus_job_id??null;
}
export function ConsensusFamilyTrack({width,height,datasetId,jobId,sidebarWidth=0,overrideChrom,overrideStart,overrideEnd}: {
  width:number;height:number;datasetId:string;jobId:string;sidebarWidth?:number;overrideChrom?:string;overrideStart?:number;overrideEnd?:number;
}){
  const showDetails=useBrowserStore(s=>s.showAnalysisDetails);
  const overlayLabels=useTrackLabels();
  const {chrom:storeChrom,start:storeStart,end:storeEnd,isReversed}=useBrowserStore(useShallow(s=>({chrom:s.chrom,start:s.start,end:s.end,isReversed:s.isReversed})));
  const chrom=overrideChrom??storeChrom,start=overrideStart??storeStart,end=overrideEnd??storeEnd;
  const {catalog,selections,curation,trackMinimumCount,trackLabels,trackComparableOnly,loading,error}=useConsensusViewStore(useShallow(s=>({
    catalog:s.jobId===jobId?s.catalog:null,selections:s.selections,curation:s.curation,trackMinimumCount:s.trackMinimumCount,
    trackLabels:s.trackLabels,trackComparableOnly:s.trackComparableOnly,loading:s.loading,error:s.error})));
  useEffect(()=>{void useConsensusViewStore.getState().load(jobId);},[jobId]);
  const comparable=useMemo(()=>new Set([...comparableFamilyRefs(catalog)].map(key=>JSON.parse(key) as [string,string])
    .filter(([id])=>id===datasetId).map(([,family])=>family)),[catalog,datasetId]);
  const packed=useMemo(()=>packFamilies(displayFamilies(catalog?.datasets[datasetId]).filter(f=>familyCount(f)>=trackMinimumCount
    &&(!trackComparableOnly||comparable.has(f.family)))),[catalog,datasetId,trackMinimumCount,trackComparableOnly,comparable]);
  const inRegion=(!catalog?.region||sameChrom(catalog.region.chrom,chrom));
  const visible=inRegion?packed.filter(f=>f.consensus_start<end&&f.consensus_end>start):[];
  // Preserve lane packing; only change paint order. Selected cores are last,
  // but ALL cores stay above ALL uncertainty edges (including selected edges).
  const selectionOrder=new Map(selections.filter(s=>s.jobId===jobId&&s.datasetId===datasetId).map((s,i)=>[s.family,i]));
  const paintOrder=[...visible].sort((a,b)=>(selectionOrder.get(a.family)??-1)-(selectionOrder.get(b.family)??-1));
  const related=relatedFamilyRefs(selections,catalog,jobId);
  const native=catalog?.cr_mode==='native_family_distribution'||catalog?.cr_mode==='staged_native_families'||catalog?.cr_mode==='lattice_recaller';
  const headerHeight=20;
  const occupiedLanes=[...new Set(visible.map(f=>f.lane))].sort((a,b)=>a-b);
  const laneIndex=new Map(occupiedLanes.map((v,i)=>[v,i]));
  // Lanes share the row's height (14–28 px each; more lanes than fit scroll). fb-n11-tracks: fixed 20 px lanes
  // left a resized row empty, or spilled out of a short one.
  const lane=Math.round(Math.min(28,Math.max(14,(height-headerHeight)/Math.max(1,occupiedLanes.length))));
  // Features (stores/featureStore.ts): shift-click selects classes for the main toolbar's Cluster / Sort / Filter (and
  // highlights them in the Footprints panel); a click selects one and opens the panel, as before.
  const selectedFeatures=useBrowserStore(s=>s.selectedFeatures);const hoveredFeature=useFeatureStore(s=>s.hovered);
  const featureKeys=useMemo(()=>new Set(selectedFeatures.map(featureKey)),[selectedFeatures]);
  const hoveredKey=hoveredFeature?featureKey(hoveredFeature):null;
  const refOf=(f:{family:string;consensus_start:number;consensus_end:number})=>classFeature(jobId,datasetId,f.family,f.consensus_start,f.consensus_end,
    catalog?.region?.chrom??chrom,stateDisplayName(catalog?.datasets[datasetId],f.family,{jobId,datasetId}));
  const select=(family:string,additive=false,shift=false)=>{
    const f=visible.find(v=>v.family===family);
    // Only shift selects it as a feature; a click and ctrl/cmd-click inspect, as before.
    if(f&&shift)toggleClassFeatures([refOf(f)]);
    useConsensusViewStore.getState().select({jobId,datasetId,family},additive||shift);
    if(!shift)useBrowserStore.getState().openAnalysisPanel('footprint-analysis');};
  const classTitle=`Click a class to inspect it${native ? '; Ctrl/⌘-click to select several' : ''}; shift-click to select classes for Cluster, Sort and Filter (main toolbar)`;
  // The read canvas stays light in dark mode, and so does this row (no dark band between light rows).
  const labelText=`Footprint classes (${visible.length})`;
  const emptyText=`No population classes in this view${trackMinimumCount>0||trackComparableOnly?' passing the track filters':''}.`;
  return <section data-testid={`consensus-family-track-${datasetId}`} data-figure-fill={TRACK_BACKGROUND.signal}
    className="relative overflow-hidden border-y border-slate-200 text-slate-600" style={{height,width,background:TRACK_BACKGROUND.signal}}>
    <div className="h-5 text-[11px] px-1 flex items-center justify-between">{overlayLabels.hover
      ? <HoverLabel title={classTitle}>{labelText}</HoverLabel>
      : !overlayLabels.clean && <span title={classTitle} data-figure-text={labelText}>{labelText}</span>}
      {showDetails && <span title={native?'Original-call classification counts; not detection or occupancy.':'Catalog counts use all eligible units, membership ≥ 0.5; read-Q sliders do not refit these classes'}>all-molecule catalog</span>}</div>
    <div style={{height:Math.max(20,height-headerHeight),overflowY:'auto',overflowX:'hidden'}}>
      {error?<span className="text-xs text-red-700">{error}</span>:loading&&!catalog?<span className="text-xs">Loading frozen catalog…</span>:!visible.length?
        (overlayLabels.hover
          ? <HoverHint><span className="inline-flex items-center gap-1.5"><FootprintClasses size={13} className="text-violet-600" aria-hidden="true" />{emptyText}</span></HoverHint>
          : !overlayLabels.clean && <span className="inline-flex items-center gap-1.5 px-1 text-xs text-gray-500" data-figure-text={emptyText}>{emptyText}</span>):
        <svg width={width} height={Math.max(20,occupiedLanes.length*lane)} aria-label={`Population footprint classes ${datasetId}`} data-figure-svg="">
          <g data-testid="family-boundary-layer">
            {paintOrder.filter(f=>!f.manual).map(f=>{
              const y=(laneIndex.get(f.lane)??0)*lane+3;
              return <g key={f.family} data-boundary-family-id={f.family} className="cursor-pointer"
                onClick={e=>select(f.family,e.ctrlKey||e.metaKey,e.shiftKey)}>
                {(f.edge_uncertainty?[f.edge_uncertainty.left,f.edge_uncertainty.right]:[]).map((range,i)=>{
                  const p=trackX(Math.max(start,range[0]),start,end,width,sidebarWidth,isReversed),q=trackX(Math.min(end,range[1]),start,end,width,sidebarWidth,isReversed);
                  return range[0]<end&&range[1]>start?<rect key={i} data-testid="family-edge-uncertainty" x={Math.min(p,q)} y={y-1} width={Math.max(1,Math.abs(q-p))} height={lane-5} fill={consensusFamilyColor(f.family)} opacity={.2}><title>{stateDisplayName(catalog?.datasets[datasetId],f.family,{jobId,datasetId})} — conditional 95% edge uncertainty: {range.join('–')} bp</title></rect>:null;
                })}
              </g>;
            })}
          </g>
          <g data-testid="family-core-layer">
          {paintOrder.map(f=>{const a=trackX(Math.max(start,f.consensus_start),start,end,width,sidebarWidth,isReversed),b=trackX(Math.min(end,f.consensus_end),start,end,width,sidebarWidth,isReversed);
            const x=Math.min(a,b),w=Math.max(3,Math.abs(b-a)),y=(laneIndex.get(f.lane)??0)*lane+3;
            const selected=selections.some(s=>s.jobId===jobId&&s.datasetId===datasetId&&s.family===f.family);
            const linked=related.has(familyRefKey({datasetId,family:f.family}))&&!selected;const count=familyCount(f);
            const ignored=f.ignored||curation?.ignored_families[datasetId]?.includes(f.family);
            const manual=f.manual;
            const displayName=stateDisplayName(catalog?.datasets[datasetId],f.family,{jobId,datasetId});
            const label=`${displayName}, ${f.consensus_start}–${f.consensus_end}, ${count} assignments`;
            return <g key={f.family} role="button" tabIndex={0} aria-label={label} aria-pressed={selected}
              data-family-id={f.family} data-family-start={f.consensus_start} data-family-end={f.consensus_end}
              className="cursor-pointer focus:outline focus:outline-2 focus:outline-slate-900" onClick={e=>select(f.family,e.ctrlKey||e.metaKey,e.shiftKey)}
              data-feature-key={featureKey(refOf(f))} data-feature-selected={featureKeys.has(featureKey(refOf(f)))||undefined}
              onMouseEnter={()=>hoverFeature(refOf(f))} onMouseLeave={()=>hoverFeature(null)}
              onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(f.family,e.ctrlKey||e.metaKey,e.shiftKey);}}}>
              <title>{label}\n{native?'Display class summary; original molecule spans are unchanged.':'Canonical population-class bounds; molecule geometry can vary.'} {manual?'Manual exploratory override. ':''}{ignored?'Ignored in manual view. ':''}{comparable.has(f.family)?'Has a comparable cross-dataset partner.':'No comparable cross-dataset partner established.'}\nTechnical ID: {f.family}</title>
              <rect x={x} y={y} width={w} height={lane-7} rx={2} fill={consensusFamilyColor(f.family)}
                opacity={ignored ? 0.35 : 1} strokeDasharray={manual?'3 2':undefined}
                stroke={selected||featureKeys.has(featureKey(refOf(f)))||hoveredKey===featureKey(refOf(f))?'#111827':linked?'#00a8bb':manual?'#7c3aed':comparable.has(f.family)?'#0891b2':'#ffffff'}
                strokeWidth={selected||linked||featureKeys.has(featureKey(refOf(f)))?2.5:hoveredKey===featureKey(refOf(f))?1.5:1}/>
              {featureKeys.has(featureKey(refOf(f)))&&<rect x={x} y={y+lane-7} width={w} height={2} fill="#111827" pointerEvents="none" data-testid="family-feature-selected"/>}
              {trackLabels&&w>32&&<text x={x+3} y={y+(lane-7)/2+3.5} fontSize={Math.round(Math.min(12,Math.max(9,(lane-7)*0.7)))} fill="white" pointerEvents="none">{manual?'M · ':''}{w>68?`${displayName} · ${count}`:displayName.replace('Class ','#')}</text>}
            </g>;
          })}
          </g>
        </svg>}
    </div>
  </section>;
}
