import { ReadDepthControls } from '../shared/ReadDepthControls';
import { READ_DEPTH_NAMES, readDepthParameters, readDepthNotes, type ReadDepth } from '../../../utils/readDepth';
import { AnalysisButton } from '../shared';
import { holdAnalysisRegions, useAnalysisRegionStore } from '../../../stores/analysisRegionStore';
import { ClassRegionChoice } from '../shared/ClassRegionChoice';
export { ClassRegionChoice } from '../shared/ClassRegionChoice';
import { regionAnalysisExtension, selectedAnalysisWindows, type AnalysisWindow } from '../../../utils/regionAnalysis';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { ConsensusViewControls,ConsensusFamilyInspector,ConsensusFamilyList,ConsensusCurationToolbar,ConsensusCallInspector } from './ConsensusViewControls';
import { ConsensusCountGroups } from './ConsensusCountGroups';
import { ConsensusCrossEvidence } from './ConsensusCrossEvidence';
import { ConsensusFitStatus } from './ConsensusFitStatus';
import {ConsensusBamExport} from './ConsensusBamExport';
import {ConsensusProgress} from './ConsensusProgress';
import {FamilyStages,stagedControlVisible,stagedPreset,recallerControlVisible,recallerPreset,workflowPreset} from './FamilyStages';
import {NativeCrossPrecision} from './NativeCrossDiagnostics';
import {crossControlVisible,nativeCrossPrecision} from '../../../utils/nativeCrossEvidence';
import {familyWorkflowMode} from '../../../utils/familyWorkflowMode';
import {consensusFamilyColor} from '../../../utils/consensusVisual';
import {StateList} from './StateList';
import {savedRunTiers} from '../../../utils/savedClasses';
import {refreshRunNames} from '../../../utils/runNames';
import { getDatasets } from '../../../api/datasets';
import { useFocusedReadIds } from '../../../hooks/useFocusedReadIds';
import { useAnalysisLoci } from '../../../hooks/useAnalysisLoci';
import { analysisLocusLabel, sameLocus, type AnalysisLocus } from '../../../utils/analysisLocus';
import { panelGenomeLabel, usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { categoryShown, useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import { holdOutlineWhileRunning, useClassRegionOutlineStore } from '../../../stores/classRegionOutlineStore';
import { genomeKeyFor } from '../../../utils/regionNavigation';
import { classRegionLine, regionSourceWords, resolveClassRegion, savedRegionAt, shortClassRegionBp,
  type ClassRange, type ClassRegionMode, type ClassRegionSource } from '../../../utils/classRegion';
import { consensusChemistry } from '../../../utils/datasetChemistry';
import { HowItWorks } from '../../ui/HowItWorks';
import { CLASS_REGION_RESET_EVENT } from '../../../utils/analysisCommands';
import { ChevronRight, FootprintClasses, Sparkles } from '../../ui/Icons';
import { OpenBamHint } from '../shared/OpenBamHint';
import { PreviewBadge } from '../../ui/PreviewBadge';
import { FOOTPRINT_CLASSES_PREVIEW } from './preview';
import { activateConsensus, importConsensus, cancelConsensus, consensusExportUrl, filterConsensus, getConsensusCatalog,
  getConsensusJob, getConsensusJobs, getConsensusSchema, startConsensus,
  type ConsensusCatalog, type ConsensusJob, type ConsensusSchema, type DisplayFilters,
  type ParameterControl, type Parameters } from '../../../api/consensusWorkflow';

const STORAGE = 'fiberhmm-consensus-parameters-v2';
/** Extra read orders for "Check robustness to read order": three orders in all, about 3x the time. */
const ROBUST_ORDERS = 2;
/** Stringency the "Missing a class you can see?" hint under the slider offers (Finer than the 0.90 default). */
const FINER_HINT_STRINGENCY = 0.8;
const GROUP_NAMES: Record<string,string> = {input:'Native input',sr:'1 · Strand boundary normalization',
  cr:'2 · Population CR classes',rescue:'Optional · New-footprint rescue',cross:'3 · Cross-dataset relationships',
  comparability:'Optional · CT/GA comparability',split:'Optional · population-supported nucleosome splitting',compute:'Compute budgets',families:'Population-class formation and consolidation',
  recaller:'Lattice recaller: discovery, class geometry and molecule scoring'};
const inputStyle='border rounded px-1.5 py-1 bg-white dark:bg-gray-900 dark:border-gray-600 min-w-0';
const buttonStyle='border rounded px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40';

export function ConsensusCrossSummary({summary,nativeMode,harmonization=false,staged=false,edges,jobId}:{summary:ConsensusJob['cross_summary'];nativeMode:boolean;harmonization?:boolean;staged?:boolean;edges?:ConsensusCatalog['edges'];jobId?:string}){
  // The inspector's private catalog is lazy; the overhead track already loads
  // this same-job catalog independently of whether the inspector is expanded.
  const sharedEdges=useConsensusViewStore(s=>jobId&&s.jobId===jobId?s.catalog?.edges:undefined);
  const currentEdges=edges??sharedEdges;
  if(summary?.status!=='complete')return null;
  if(staged)return <p className="text-[11px]">{currentEdges?.length??summary.comparable_edges??0} cross-dataset shared-class links. Each original call retains its direct native-lattice memberships.</p>;
  if(harmonization)return <p data-testid="harmonization-xcr-summary" className="text-[11px]">XCR: {currentEdges?.length??0} shared native-class links · {summary.comparable_edges??0} lattice comparable. See Compare strands and datasets for agreement, limitations and coarser ANY-child counts. No rescue or simulations.</p>;
  if(nativeMode)return <p data-testid="native-xcr-summary" className="text-[11px]">{currentEdges
    ? `XCR: ${currentEdges.length} catalog atomic links · ${currentEdges.filter(edge=>edge.comparability_mask).length} native shape-compatible (provisional). This is not occupancy or event equivalence.`
    : 'XCR complete · loading catalog link counts…'}{currentEdges?.some(e=>e.compatibility_depends_on_monte_carlo_uncertainty!==undefined)
      ?` ${currentEdges.filter(e=>e.compatibility_depends_on_monte_carlo_uncertainty===true).length} links depend on MC-borderline compatibility.`:''}
      {summary.parameters?.reference_percent!=null?` Frozen XCR reference: ${summary.parameters.reference_percent}%; ${summary.parameters.predictive_replicates?.toLocaleString()??'unrecorded'} draws (not the current CR display reference).`:''}</p>;
  return <p className="text-[11px]">XCR: {Object.values(summary.counts??{}).reduce((a,b)=>a+b,0)} atomic links · {summary.comparable_edges} shape-compatible after full-model tests. This is not a quantification-equivalence test.</p>;
}

export function ClassificationReferenceControl({value,onChange}:{value:number;onChange:(value:number)=>void}){
  const [draft,setDraft]=useState(String(value));
  useEffect(()=>setDraft(String(value)),[value]);
  const update=(v:number)=>{if(Number.isFinite(v))onChange(Math.max(50,Math.min(99.999,v)));};
  const commit=()=>{if(draft.trim()!==''&&Number.isFinite(Number(draft)))update(Number(draft));else setDraft(String(value));};
  return <div data-testid="classification-reference-control" className="space-y-1">
    <label className="block">Native-class classification reference · {value}%
      <div className="flex gap-2"><input aria-label="Classification reference percent" className="flex-1" type="range" min="50" max="99.999" step="0.001" value={value} onChange={e=>update(Number(e.target.value))}/>
        <input aria-label="Classification reference percent exact" className={`${inputStyle} w-24`} type="number" min="50" max="99.999" step="0.001" value={draft}
          onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')commit();}}/></div>
    </label>
    <div className="flex gap-1">{[95,99,99.9,99.99,99.999].map(v=><button key={v} className={buttonStyle} onClick={()=>onChange(v)}>{v}%</button>)}</div>
    <p className="text-[11px] text-gray-500">Higher reference = more permissive grouping. The distinction threshold is {((100-value)/100).toPrecision(3)}; a compatible alternative is retained when its predictive-tail uncertainty reaches this threshold. This is not an accuracy, posterior probability or FDR score. Original call spans never change.</p>
  </div>;
}

function savedParameters(): Parameters {
  try { return JSON.parse(localStorage.getItem(STORAGE) ?? '{}'); } catch { return {}; }
}
export function harmonizationControlVisible(group:string,name:string){
  return group==='input'||group==='sr'&&name==='enabled'
    ||group==='cr'&&(['engine','enabled'].includes(name)||name.startsWith('harmonization_'))
    ||group==='cross'&&(['enabled','coarse_native_events'].includes(name)||name.startsWith('lattice_'))
    ||group==='compute'&&name==='maximum_region_bp';
}
function Control({spec,value,onChange}: {spec: ParameterControl; value: boolean | number | string;
  onChange: (v: boolean | number | string) => void}) {
  const id=`consensus-${spec.label.replace(/[^a-z0-9]/gi,'-')}`;
  return <label htmlFor={id} className="grid grid-cols-[1fr_95px] gap-x-2 gap-y-0.5 items-center py-1.5 border-b border-gray-100 dark:border-gray-800">
    <span>{spec.label}</span>
    {spec.type==='bool' ? <input id={id} type="checkbox" checked={Boolean(value)} onChange={e=>onChange(e.target.checked)} className="justify-self-end"/>
      : spec.choices ? <select id={id} value={String(value)} onChange={e=>onChange(e.target.value)} className={inputStyle}>
        {spec.choices.map(c=><option key={c} value={c}>{c.replace(/_/g,' ')}</option>)}
      </select> : spec.type==='str'?<input id={id} type="text" className={inputStyle} value={String(value)} onChange={e=>onChange(e.target.value)}/>:<input id={id} type="number" className={inputStyle} value={Number(value)} min={spec.minimum??undefined}
          max={spec.maximum??undefined} step={spec.step??'any'} onChange={e=>{if(e.target.value!=='')onChange(Number(e.target.value));}}/>}
    <span className="col-span-2 text-[11px] text-gray-500 dark:text-gray-400 leading-snug">{spec.help}</span>
  </label>;
}

/** A region of one reference: the next run's (genome null = the main genome). */
type RunRange=ClassRange;
const rangeOf=(l:AnalysisLocus):RunRange=>({chrom:l.chrom,start:l.start,end:l.end,genome:l.genome});
/** A region set in place of the region choice: typed coordinates, one of several panels' views, a restored run. */
type PinnedRange={range:RunRange;source:ClassRegionSource;what:string};

/**
 * Which region Find classes analyses, before it runs (fb-n5-classregion):
 * "Analyses: chr19:47,518,060–47,518,500 · 440 bp · the selected peak", the
 * choice of selected peaks / this view / a saved region (when Regions has one
 * here), and a gentle note when the region is short for discovery.
 */

/** "Analysed: chr19:47,518,060–47,518,500 · 440 bp · the selected peak" for a run (its request records the source). */
export function analysedLine(request:{chrom:string;start:number;end:number;region_source?:string;region_label?:string;region_windows?:import('../../../utils/regionAnalysis').AnalysisWindow[]}|undefined|null):string{
  if(!request)return '';
  if(request.region_windows?.length)return request.region_label||`Selected matched regions · ${request.region_windows.length} regions / datasets · ${request.region_windows[0].end-request.region_windows[0].start} bp each`;
  return classRegionLine(request,request.region_label||regionSourceWords(request.region_source));
}

export function ConsensusTools({datasetIds,peaks,onOpenSetup,activeFilterKey=null,onFilterState}: {datasetIds: string[]; peaks: {absStart:number;absEnd:number;chrom?:string|null;genome?:string|null}[]; onOpenSetup?:()=>void;
  activeFilterKey?:string|null;onFilterState?:(datasetId:string,family:string,name:string)=>void}) {
  const {datasets,chrom,start,end,enabledModTypes,footprintGroups,setFootprintGroups} = useBrowserStore(useShallow(s=>({datasets:s.datasets,chrom:s.chrom,
    start:s.start,end:s.end,enabledModTypes:s.enabledModTypes,footprintGroups:s.footprintGroups,setFootprintGroups:s.setFootprintGroups})));
  const [schema,setSchema]=useState<ConsensusSchema|null>(null);
  const [parameters,setParameters]=useState<Parameters>(savedParameters);
  const hadSavedParameters=useRef(Object.keys(parameters).length>0);
  // Which region Find classes analyses: the choice (selected peaks, the view, a saved
  // region) is a session setting with undo; a region set in its place is held here.
  const {classRegionMode,setClassRegionMode}=useBrowserStore(useShallow(s=>({classRegionMode:s.classRegionMode,setClassRegionMode:s.setClassRegionMode})));
  const [pinned,setPinned]=useState<PinnedRange|null>(null);
  const [restoredWindows,setRestoredWindows]=useState<AnalysisWindow[]|null>(null);
  const [chosenLocus,setChosenLocus]=useState<{range:RunRange;what:string}|null>(null);
  const rangePinned=pinned!==null;
  const [selected,setSelected]=useState<string[]>(datasetIds);
  // Ticked by hand: then the dataset choice stops following the browser's selection.
  const [selectedPinned,setSelectedPinned]=useState(false);
  // The region comes from the panels of the chosen datasets (their own locus or
  // reference when they have one), not from the main view: one region is used
  // as it is; panels at different regions ask which one (fb-r2-integ).
  const {stateKeyMap}=useFocusedReadIds();
  const regionStateKeys=useMemo(()=>selected.flatMap(id=>stateKeyMap[id]??[]),[selected,stateKeyMap]);
  const regionExtraDatasets=useMemo(()=>selected.filter(id=>!stateKeyMap[id]?.length),[selected,stateKeyMap]);
  const loci=useAnalysisLoci(regionStateKeys,regionExtraDatasets);
  const genomeAssignments=usePanelGenomeStore(s=>s.assignments);
  const panelGenomes=usePanelGenomeStore(s=>s.genomes);
  const referenceName=(key:string|null)=>key?panelGenomeLabel(panelGenomes[key],key):'the main genome';
  const [chemistry,setChemistry]=useState<Record<string,string>>({});
  const [job,setJob]=useState<ConsensusJob|null>(null);
  const [history,setHistory]=useState<ConsensusJob[]>([]);
  const [filters,setFilters]=useState<DisplayFilters|null>(null);
  const [error,setError]=useState('');const [submitting,setSubmitting]=useState(false);
  const [catalog,setCatalog]=useState<ConsensusCatalog|null>(null);
  const [catalogOpen,setCatalogOpen]=useState(false);const [search,setSearch]=useState('');
  // After a run the settings fold into one summary line (Edit settings; Find again in the header reruns); a new run's result folds them again.
  const [configOpen,setConfigOpen]=useState(true);
  const collapsedFor=useRef<string|null>(null);
  const nativeMode=(job?(job.cr_mode??'legacy_lattice'):schema?.cr_mode)==='native_family_distribution';
  const harmonization=(job?(job.cr_mode??'legacy_lattice'):schema?.cr_mode)==='call_harmonization';
  // Completed lattice-recaller runs share the staged display path (same result shape); only their text differs.
  const recaller=job?.cr_mode==='lattice_recaller';
  const staged=job?.cr_mode==='staged_native_families'||recaller;
  const curationRevision=useConsensusViewStore(s=>s.curation?.revision);
  const viewCatalog=useConsensusViewStore(s=>s.catalog);
  const viewCatalogJobId=useConsensusViewStore(s=>s.jobId);
  const applied=useRef('');const filterSequence=useRef(0);
  const filterQueue=useRef<Promise<unknown>>(Promise.resolve());
  // The filters last sent for a run: while a change is in flight the cached
  // job still shows the old ones, so reverting to them must still be sent.
  const lastSentFilters=useRef<{jobId:string;filters:string}|null>(null);
  const running=!!job && ['queued','running','cancelling'].includes(job.status);
  const filtersPending = job?.status === 'complete' && !!filters
    && JSON.stringify(filters) !== JSON.stringify(job.filters);
  const selectedChemistries=selected.map(id=>consensusChemistry(datasets.find(d=>d.id===id))||'');
  const automaticMode=familyWorkflowMode(selectedChemistries);
  const missingChemistry=automaticMode===null;
  // No BAM open at all: the panels' one empty-state sentence (R12), not the assay-setup prompt.
  const noData=!datasets.length;
  const workflowAction=automaticMode||noData?'Find footprint classes':'Set up datasets to continue';
  const strandResolvedAvailable=selectedChemistries.some(value=>['ddda','dddb'].includes(value));
  const multipleDatasets=selected.length>1;
  const effective=useMemo(()=>{
    const values=workflowPreset(parameters,schema);
    if(values.cr?.engine==='staged_native_families'){
      values.sr={...values.sr,enabled:!missingChemistry&&strandResolvedAvailable};
      values.cross={...values.cross,enabled:!missingChemistry&&multipleDatasets};
    }
    return values;
  },[schema,parameters,missingChemistry,strandResolvedAvailable,multipleDatasets]);
  const depthSupported=READ_DEPTH_NAMES.every(n=>schema?.groups.recaller?.some(c=>c.name===n));
  const configurationNative=effective.cr?.engine==='native_family_distribution';
  const configurationHarmonization=effective.cr?.engine==='call_harmonization';
  const configurationStaged=effective.cr?.engine==='staged_native_families';
  const configurationRecaller=effective.cr?.engine==='lattice_recaller';
  const configurationFamilies=configurationStaged||configurationRecaller;
  // Optional read-order check (recaller.order_replicates): extra read orders the class search is repeated in.
  const robustOrders=Number(effective.recaller?.order_replicates??0);
  const robustShare=Number(effective.recaller?.order_robust_fraction??1);
  const crossPrecision=configurationNative&&effective.cross?.enabled&&effective.cross.native_predictive_replicates!==undefined
    ?nativeCrossPrecision(Number(effective.cross.native_reference_percent),Number(effective.cross.native_predictive_replicates)):null;
  const frozenParameters=useMemo(()=>Object.fromEntries(Object.entries(schema?.groups??{}).map(([group,controls])=>[group,
    Object.fromEntries(controls.map(s=>[s.name,job?.request.parameters[group]?.[s.name]??s.default]))])),[schema,job?.request.parameters]);
  const errorMessage=(e:unknown)=>e instanceof Error?e.message:String(e);
  const pinRange=(next:RunRange,source:ClassRegionSource='custom',what='coordinates set by hand')=>setPinned({range:next,source,what});
  // Choosing peaks / the view / a saved region drops a region set in its place.
  const chooseMode=(mode:ClassRegionMode)=>{setPinned(null);setRestoredWindows(null);if(mode!==classRegionMode)setClassRegionMode(mode);};
  // A region set in place of the choice is dropped when the choice changes (also by undo), on undo/redo
  // and on a session import (CLASS_REGION_RESET_EVENT), and by "Find classes in this view".
  useEffect(()=>{const reset=()=>{setPinned(null);setRestoredWindows(null);};window.addEventListener(CLASS_REGION_RESET_EVENT,reset);
    return()=>window.removeEventListener(CLASS_REGION_RESET_EVENT,reset);},[]);
  const modeSeen=useRef(classRegionMode);
  useEffect(()=>{if(modeSeen.current!==classRegionMode){modeSeen.current=classRegionMode;setPinned(null);if(classRegionMode!=='matched')setRestoredWindows(null);}},[classRegionMode]);
  const lastRestore=useBrowserStore(s=>s._lastRestoreTime);
  const restoreSeen=useRef(lastRestore);
  useEffect(()=>{if(restoreSeen.current!==lastRestore){restoreSeen.current=lastRestore;setPinned(null);setRestoredWindows(null);}},[lastRestore]);
  // Choosing one of the panels' regions also chooses its reference: the
  // selected datasets on another assembly are unticked (a run covers one
  // reference), so neither the reference check nor their assay setup blocks it.
  const chooseRegion=(locus:AnalysisLocus)=>{
    setPinned(null);
    setChosenLocus({range:rangeOf(locus),what:`the view of ${locus.datasetIds.map(datasetName).join(', ')||'the panel'}`});
    const sameReference=(id:string)=>(genomeAssignments[id]??null)===(locus.genome??null);
    const next=[...new Set([...selected.filter(sameReference),...locus.datasetIds])];
    if(next.length!==selected.length||next.some(id=>!selected.includes(id))){setSelectedPinned(true);setSelected(next);}
  };
  // The next run uses the region the chosen panels show unless one was set by
  // hand; a finished run keeps its own region in job.request, so the view can move on.
  const panelLocus=loci.length===1?loci[0]:null;
  // Panels at different regions: the one chosen among them is "the view" (while the panels still show it).
  const chosen=!panelLocus&&chosenLocus&&loci.some(l=>sameLocus(l,chosenLocus.range))?chosenLocus:null;
  const viewSource=panelLocus?rangeOf(panelLocus):chosen?.range??null;
  const viewRange=useMemo(()=>viewSource,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewSource?.chrom,viewSource?.start,viewSource?.end,viewSource?.genome]);
  // Selected peaks: their panel's chromosome and reference (one of each), else the main view's.
  const peakChroms=[...new Set(peaks.map(p=>`${p.genome??''}|${p.chrom??chrom}`))];
  const peakRange:RunRange|null=peaks.length&&peakChroms.length===1?{chrom:peaks[0].chrom??chrom,genome:peaks[0].genome??null,
    start:Math.min(...peaks.map(p=>p.absStart)),end:Math.max(...peaks.map(p=>p.absEnd))}:null;
  // The saved region (Regions) at the view's locus, on the view's reference.
  const regionGenome=useBrowserStore(s=>genomeKeyFor(viewRange?.genome??null,s));
  const mainGenome=useBrowserStore(s=>genomeKeyFor(null,s));
  const regionCatalog=useRegionCatalogStore(s=>s.catalogs[regionGenome]);
  const regionFingerprints=useRegionCatalogStore(s=>s.fingerprints);
  useEffect(()=>{void useRegionCatalogStore.getState().ensureLoaded(regionGenome);},[regionGenome]);
  const savedRegion=useMemo(()=>{
    if(!viewRange||!regionCatalog)return null;
    const shown=new Set(regionCatalog.categories.filter(c=>categoryShown(c,regionFingerprints)).map(c=>c.id));
    const entry=savedRegionAt(regionCatalog.entries.filter(e=>shown.has(e.category)),viewRange);
    return entry?{range:{chrom:entry.chrom,start:entry.start,end:entry.end,genome:viewRange.genome},label:entry.label||`${entry.chrom}:${entry.start.toLocaleString()}`}:null;
  },[viewRange,regionCatalog,regionFingerprints]);
  const regionSelection=useBrowserStore(useShallow(s=>({peakRules:s.peakRules,peaksByRule:s.peaksByRule,selectedPeaks:s.selectedPeaks,panels:s.panels})));
  const selectedMatched=useMemo(()=>selectedAnalysisWindows(useBrowserStore.getState(),selected),[regionSelection,selected,chrom,start,end]);
  const restoredSelection=restoredWindows?.filter(w=>selected.includes(w.dataset_id));
  const matched=restoredSelection?{windows:restoredSelection,label:'selected matched regions of the restored run',error:selected.some(id=>!restoredSelection.some(w=>w.dataset_id===id))||!restoredSelection.length?'Choose the datasets of the restored run.':null}:selectedMatched;
  const useMatched=classRegionMode==='matched'&&!pinned;
  const resolved=resolveClassRegion({mode:classRegionMode,view:viewRange,viewWhat:chosen?.what,peaks:peakRange,peakCount:peaks.length,
    peaksSplit:peaks.length>0&&!peakRange,saved:savedRegion,pinned});
  const matchedWindows=running&&job?.request.region_windows?job.request.region_windows:useMatched?matched.windows:[];
  const matchedOutlineKey=JSON.stringify(matchedWindows);
  const lastMatchedOutline=useRef<{jobId:string|null;outlines:import('../../../stores/analysisRegionStore').AnalysisOutline[]}>({jobId:null,outlines:[]});
  useEffect(()=>{
    const outlines=matchedWindows.map(w=>({ ...w, genomeKey:w.genome||mainGenome, datasetIds:[w.dataset_id], label:running?'Finding classes':'Find classes', color:'#059669' }));
    lastMatchedOutline.current={jobId:running&&job?job.job_id:null,outlines};
    useAnalysisRegionStore.getState().set('class-matched',outlines);
    return ()=>useAnalysisRegionStore.getState().set('class-matched',[]);
  },[matchedOutlineKey,mainGenome,running,job?.job_id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>()=>{
    const {jobId,outlines}=lastMatchedOutline.current;
    if(jobId&&outlines.length)holdAnalysisRegions('class-matched',jobId,outlines);
  },[]);
  const range:RunRange=resolved?.range??{chrom,start,end,genome:null};
  const dirty=!!job && (
    JSON.stringify(useMatched?matched.windows:undefined)!==JSON.stringify(job.request.region_windows) ||JSON.stringify(effective)!==JSON.stringify(frozenParameters)
    || (!useMatched&&(range.chrom!==job.request.chrom || range.start!==job.request.start || range.end!==job.request.end))
    || JSON.stringify([...selected].sort())!==JSON.stringify([...job.request.dataset_ids].sort())
    || selected.some(id=>(consensusChemistry(datasets.find(d=>d.id===id))||'')!==job.request.chemistry_overrides[id]));
  // Panels at different regions (another locus, another assembly): no silent default.
  const regionUnresolved=!useMatched&&!rangePinned&&loci.length>1&&!chosen&&resolved?.source!=='peaks';
  // One run covers one region of one reference: its datasets must all be on that one.
  const selectedReferences=[...new Set(selected.map(id=>genomeAssignments[id]??null))];
  const referenceProblem=useMatched?matched.error:selectedReferences.length>1
    ?`The selected datasets are on different references (${selectedReferences.map(referenceName).join(', ')}). A footprint-class run covers one region of one reference: untick the datasets on the others.`
    :selectedReferences.length===1&&!regionUnresolved&&(range.genome??null)!==selectedReferences[0]
      ?`The region is on ${referenceName(range.genome)}, but the selected datasets are on ${referenceName(selectedReferences[0])}. Choose a region their panels show (Use view).`
      :null;

  useEffect(()=>{let alive=true;
    Promise.all([getConsensusSchema(),getConsensusJobs()]).then(([s,history])=>{
      if(!alive)return;setSchema(s);setHistory(history.jobs);
      // Keep the running job visible when reopening the panel; active_job
      // intentionally still names the last successfully installed layer set.
      const latest=[...history.jobs].reverse().find(j=>['queued','running','cancelling'].includes(j.status))
        ??history.jobs.find(j=>j.job_id===history.active_job)??history.jobs[history.jobs.length-1];
      // Its settings come back; its region and datasets stay with the run
      // (the next run uses the current view and selection unless restored).
      if(latest){setJob(latest);setFilters(latest.filters);setParameters(latest.request.parameters);
        setChemistry(latest.request.chemistry_overrides);}
      else {
        setFilters(s.display_defaults);
        if(!hadSavedParameters.current){
          const chemistries=datasetIds.map(id=>consensusChemistry(datasets.find(d=>d.id===id))||'');
          const next=workflowPreset({},s);
          setParameters({...next,
            sr:{...next.sr,enabled:chemistries.some(value=>['ddda','dddb'].includes(value))},
            cross:{...next.cross,enabled:datasetIds.length>1},
            families:{...next.families,physical_radius_bp:10,stop_after:'resolved'},
          });
        }
      }
    }).catch(e=>{if(alive)setError(errorMessage(e));});return()=>{alive=false;};
  },[]);
  useEffect(()=>{try{localStorage.setItem(STORAGE,JSON.stringify(parameters));}catch{/* optional persistence */}},[parameters]);
  useEffect(()=>{useConsensusViewStore.getState().configure({chemistries:chemistry});},[chemistry]);
  useEffect(()=>{setSelected(old=>{
    const loaded=(ids:string[])=>ids.filter(id=>datasets.some(d=>d.id===id));
    // The browser's selected datasets, unless the user ticked datasets here.
    const present=selectedPinned?loaded(old):loaded(datasetIds);
    const next=present.length?present:datasetIds;
    return JSON.stringify(next)===JSON.stringify(old)?old:next;
  });},[datasets,datasetIds,selectedPinned]);
  useEffect(()=>{if(!running||!job)return;let alive=true;const id=job.job_id;
    let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{const v=await getConsensusJob(id);if(alive)setJob(current=>{
        // A late pre-cancellation poll must not undo the Cancel response.
        if(current?.job_id===id&&((current.updated_at??0)>(v.updated_at??0)
          ||current.status==='cancelling'&&v.status==='running'))return current;
        return v;
      });}catch(e){if(alive)setError(errorMessage(e));}
      finally{if(alive)timer=setTimeout(poll,1000);}
    };
    timer=setTimeout(poll,500);
    return()=>{alive=false;clearTimeout(timer);};
  },[running,job?.job_id]);
  useEffect(()=>{if(job?.status!=='complete'||applied.current===job.job_id)return;
    applied.current=job.job_id;setFilters(job.filters);setCatalog(null);
    void useConsensusViewStore.getState().load(job.job_id);
    getConsensusJobs().then(v=>setHistory(v.jobs)).catch(e=>setError(errorMessage(e)));
    getDatasets().then(response=>{
      const store=useBrowserStore.getState();
      store.setDatasets(store.datasets.map(d=>{const server=response.datasets.find(v=>v.id===d.id);
        return server?{...d,available_layers:server.available_layers,derived_layers:server.derived_layers}:d;}));
      // A completed run opens as one clear, consolidated result.  Intermediate,
      // XCR, and manual layers remain available in Display filters.
      // Recaller runs show the recaller's own calls (what it counted); other engines their labelled native calls.
      const primary=(job.layers??[]).includes('tf_rc')?'tf_rc':'tf_cr';
      for(const name of job.layers??[])store.toggleModType(name,name===primary);
      store.triggerRefresh();
    }).catch(e=>setError(errorMessage(e)));
  },[job]);
  useEffect(()=>{
    // Any change of run or filters supersedes a pending request, even when no new one is needed.
    const seq=++filterSequence.current;
    if(!job||job.status!=='complete'||!filters)return;
    const serverFilters=lastSentFilters.current?.jobId===job.job_id?lastSentFilters.current.filters:JSON.stringify(job.filters);
    if(JSON.stringify(filters)===serverFilters)return;
    const id=job.job_id;
    const timer=setTimeout(()=>{lastSentFilters.current={jobId:id,filters:JSON.stringify(filters)};
      filterQueue.current=filterQueue.current.catch(()=>undefined).then(()=>filterConsensus(id,filters)).then(v=>{if(seq!==filterSequence.current)return;
        setJob(current=>current&&current.job_id!==id?current:v);useBrowserStore.getState().triggerRefresh();})
      .catch(e=>{
        // The server's filters are unknown now: compare with the job's again.
        if(lastSentFilters.current?.jobId===id)lastSentFilters.current=null;
        if(seq===filterSequence.current)setError(errorMessage(e));
      });},200);
    return()=>clearTimeout(timer);
  },[filters,job?.job_id,job?.status,job?.filters]);
  useEffect(()=>{if(!catalogOpen||!job||job.status!=='complete'||catalog)return;
    let current=true;
    getConsensusCatalog(job.job_id).then(value=>{if(current)setCatalog(value);})
      .catch(e=>{if(current)setError(errorMessage(e));});
    return()=>{current=false;};
  },[catalogOpen,job?.job_id,job?.status,job?.filters.minimum_rescue_model_q,catalog]);
  useEffect(()=>{setCatalog(null);if(job?.status==='complete')void useConsensusViewStore.getState().load(job.job_id,true);},
    [job?.job_id,job?.view_stage,job?.filters.minimum_rescue_model_q,job?.filters.classification_reference_percent,curationRevision]);
  useEffect(()=>{
    // Only this run's catalog, and only classes saved from this run (or saved
    // before classes recorded their run): a class from another run keeps its
    // own run, since the same family name there is a different class.
    if(!job||job.status!=='complete'||!viewCatalog||viewCatalogJobId!==job.job_id)return;
    let changed=false;
    const next=footprintGroups.map(group=>{
      if(!group.consensusStateId||!group.sourceDatasetId)return group;
      if(group.consensusJobId&&group.consensusJobId!==job.job_id)return group;
      const dataset=viewCatalog.datasets[group.consensusDatasetId ?? group.sourceDatasetId];
      const states=[...(dataset?.catalog??[]),...(dataset?.curated_display_families??[])];
      if(!states.some(state=>state.family===group.consensusStateId))return group;
      const color=consensusFamilyColor(group.consensusStateId);
      if(group.consensusJobId===job.job_id&&group.color===color)return group;
      changed=true;
      return {...group,consensusJobId:job.job_id,color};
    });
    if(changed)setFootprintGroups(next);
  },[job?.job_id,job?.status,viewCatalog,viewCatalogJobId,footprintGroups,setFootprintGroups]);

  // Parameters the user set in this panel (the backend treats the rest as defaults it may adapt, e.g. DddA mCG
  // conditioning is skipped with a warning on BigBed input unless it was turned on here).
  const explicitParameters=useRef(new Set<string>());
  const setParameter=(group:string,name:string,value:boolean|number|string)=>(explicitParameters.current.add(`${group}.${name}`),setParameters(p=>group==='cr'&&name==='engine'&&value==='staged_native_families'?stagedPreset(p,schema)
    :group==='cr'&&name==='engine'&&value==='lattice_recaller'?recallerPreset(p,schema):({
    ...p,...(group==='cr'&&name==='engine'&&['call_harmonization','staged_native_families'].includes(String(value))
      ?{rescue:{...p.rescue,enabled:false},split:{...p.split,enabled:false},comparability:{...p.comparability,enabled:false},
        input:{...p.input,minimum_nfr_length:0,...(value==='staged_native_families'?{correct_native:true}:{})},
        ...(value==='staged_native_families'?{compute:{...p.compute,fit_backend:'cpu',predictive_backend:'cpu'}}:{})}:{}),
    [group]:{...p[group],...(group==='cr'&&name==='engine'&&['call_harmonization','staged_native_families'].includes(String(value))?{enabled:true,residual_update_policy:'refit_catalog'}:{}),[name]:value}})));
  async function run(lastStage?:string,frozenJobId?:string) {
    setSubmitting(true);setError('');
    try{const overrides=Object.fromEntries(selected.map(id=>[id,consensusChemistry(datasets.find(d=>d.id===id))||'']));
      if(Object.values(overrides).some(v=>!v))throw new Error('Choose the datatype for each selected dataset.');
      if(regionUnresolved)throw new Error('The selected panels show different regions: choose the one to analyse.');
      if(referenceProblem)throw new Error(referenceProblem);
      const requestedStage=configurationStaged?(lastStage??'resolved'):lastStage;
      const settings:Parameters=requestedStage?{...effective,families:{...effective.families,stop_after:requestedStage}}:{...effective};
      if(settings.recaller){
        settings.recaller={...settings.recaller};
        for(const name of READ_DEPTH_NAMES)delete settings.recaller[name];
        Object.assign(settings.recaller,readDepthParameters(effective.recaller as ReadDepth,depthSupported&&configurationRecaller));
      }
      if(requestedStage)setParameter('families','stop_after',requestedStage);
      const starter=useMatched?regionAnalysisExtension()?.run:startConsensus;
      if(!starter)throw new Error('Selected region analysis is unavailable in this build.');
      const next=await starter({
        ...(useMatched?{region_windows:matched.windows,frozen_job_id:frozenJobId,region_source:'matched',region_label:matched.label}:{}),dataset_ids:selected,chemistry_overrides:overrides,chrom:range.chrom,start:range.start,end:range.end,parameters:settings,
        ...(resolved?{region_source:resolved.source,region_label:resolved.what}:{}),
        explicit_parameters:[...explicitParameters.current]});
      setJob(next);setCatalog(null);
    }catch(e){setError(errorMessage(e));}finally{setSubmitting(false);}
  }
  const updateFilter=<K extends keyof DisplayFilters>(key:K,value:DisplayFilters[K])=>setFilters(f=>f?{...f,[key]:value}:f);
  // Runs in the order started; saved classes carry this label.
  const runLabel=useMemo(()=>{
    if(!job)return '';
    const order=[...history].sort((a,b)=>a.created_at-b.created_at).findIndex(j=>j.job_id===job.job_id);
    const stringency=(job.request?.parameters as {recaller?:{stringency?:number}}|undefined)?.recaller?.stringency;
    return `run ${order>=0?order+1:history.length+1}${typeof stringency==='number'?` · stringency ${stringency.toFixed(2)}`:''}`;
  },[history,job?.job_id,job?.request]);
  // A recaller run's reads show each class as its saved definitions count it (strict when not saved).
  const savedTiers=useMemo(()=>job?savedRunTiers(footprintGroups,job.job_id):{},[footprintGroups,job?.job_id]);
  useEffect(()=>{
    if(!recaller||!filters||job?.status!=='complete')return;
    const current=filters.recaller_class_tiers??{};
    const same=Object.keys({...current,...savedTiers}).every(k=>(current[k]??'core')===(savedTiers[k]??'core'));
    if(!same)updateFilter('recaller_class_tiers',savedTiers);
  },[savedTiers,recaller,filters?.recaller_class_tiers,job?.status]);
  function restore(next:ConsensusJob) {
    // Restoring a run on purpose: its region and datasets become the next run's, until changed.
    setJob(next);setCatalog(null);setParameters(next.request.parameters);setSelectedPinned(true);setSelected(next.request.dataset_ids);
    setChemistry(next.request.chemistry_overrides);
    if(next.request.region_windows?.length){setPinned(null);setClassRegionMode('matched');setRestoredWindows(next.request.region_windows);}
    else {setRestoredWindows(null);pinRange({chrom:next.request.chrom,start:next.request.start,end:next.request.end,
      genome:genomeAssignments[next.request.dataset_ids[0]]??null},'custom',`the region of run ${next.job_id.slice(0,8)}`);}
  }
  // Short for discovery: under two discovery tiles (recaller.tile_bp), so classes near its edges may be missed.
  const tileBp=effective.recaller?.tile_bp??schema?.groups.recaller?.find(c=>c.name==='tile_bp')?.default;
  // While a run is in progress the card names the run's own region (the view may move on meanwhile).
  const runningRegion=running&&job?job.request:null;
  const shortRegion=configurationRecaller&&(runningRegion
    ?runningRegion.end-runningRegion.start<shortClassRegionBp(Number(job?.request.parameters?.recaller?.tile_bp??tileBp))
    :!!resolved&&!regionUnresolved&&range.end-range.start<shortClassRegionBp(Number(tileBp)));
  // The region outlined on the targeted panels: the next run's while the card is open, a run's own while it runs.
  const outlineTarget=useMemo(()=>{
    if(running&&job&&!job.request.region_windows){const genome=genomeAssignments[job.request.dataset_ids[0]]??null;
      return {chrom:job.request.chrom,start:job.request.start,end:job.request.end,genome,genomeKey:genome||mainGenome,
        datasetIds:job.request.dataset_ids,label:'Finding classes'};}
    if(regionUnresolved||!resolved||!selected.length)return null;
    return {...resolved.range,genomeKey:resolved.range.genome||mainGenome,datasetIds:selected,label:'Find classes'};
  },[running,job?.job_id,job?.request,genomeAssignments,mainGenome,regionUnresolved,resolved?.range.chrom,resolved?.range.start,resolved?.range.end,resolved?.range.genome,selected]);// eslint-disable-line react-hooks/exhaustive-deps
  // Each run's short name ("Footprint run 2 · 6 Oct 14:02") for every panel that names it: read from the server's whole
  // run list (the panel's history can lag behind) whenever a run starts or the history is read again.
  useEffect(()=>{void refreshRunNames('footprint',true);},[history,job?.job_id]);
  // Each run's region in words, for the class tables shown elsewhere (Compare strands and datasets).
  useEffect(()=>{const runs=[...history,...(job?[job]:[])];
    useClassRegionOutlineStore.getState().noteRunRegions(Object.fromEntries(runs.filter(j=>j.request).map(j=>[j.job_id,analysedLine(j.request)])));
  },[history,job?.job_id,job?.request]);// eslint-disable-line react-hooks/exhaustive-deps
  const outlineKey=JSON.stringify(outlineTarget);
  const unmountState=useRef<{jobId:string|null;outline:typeof outlineTarget}>({jobId:null,outline:null});
  unmountState.current={jobId:running&&job?job.job_id:null,outline:outlineTarget};
  useEffect(()=>{useClassRegionOutlineStore.getState().setOutline(outlineTarget);},[outlineKey]);// eslint-disable-line react-hooks/exhaustive-deps
  // Closing the card clears the outline, unless a run is in progress: then it stays until the run ends.
  useEffect(()=>()=>{const {jobId,outline}=unmountState.current;
    if(jobId&&outline)holdOutlineWhileRunning(jobId,outline);else useClassRegionOutlineStore.getState().setOutline(null);},[]);
  const runDisabled=!schema||running||submitting||!selected.length||missingChemistry||regionUnresolved||!!referenceProblem||!!crossPrecision&&!crossPrecision.resolved;
  useEffect(()=>{if(job?.status==='complete'&&collapsedFor.current!==job.job_id){collapsedFor.current=job.job_id;setConfigOpen(false);}},[job?.status,job?.job_id]);
  const configCollapsed=!!configurationFamilies&&job?.status==='complete'&&!configOpen;
  const engineName=configurationStaged?'Staged Monte Carlo (deprecated)':configurationRecaller?'Lattice recaller':String(effective.cr?.engine??'lattice_recaller');
  const configSummary=[engineName,configurationRecaller?`stringency ${Number(effective.recaller?.stringency??0.9).toFixed(2)}`:null,
    configurationRecaller&&robustOrders>0?'robustness check':null,resolved?.what?`region: ${resolved.what}`:null].filter(Boolean).join(' · ');
  const datasetName=(id:string)=>datasets.find(d=>d.id===id)?.label||id;
  return <section data-testid="consensus-tools" className="fb-panel-card text-xs">
    {/* The title keeps one line; the buttons move under it when the panel is narrow (L9). */}
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <FootprintClasses size={16} className="flex-shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true"/>
      <h3 className="flex flex-1 items-center whitespace-nowrap text-[13px] font-semibold text-gray-900 dark:text-gray-100">Footprint classes<PreviewBadge feature={FOOTPRINT_CLASSES_PREVIEW} className="ml-1.5" /></h3>
      {configurationFamilies&&<div className="ml-auto flex flex-wrap items-center justify-end gap-1" aria-label="Population footprint-class analysis">
        {running&&job&&<button className="fb-btn-secondary" onClick={()=>cancelConsensus(job.job_id).then(setJob).catch(e=>setError(errorMessage(e)))}>Cancel</button>}
        <button type="button" data-testid="run-lattice-consensus" disabled={runDisabled} className="fb-btn-primary"
          onClick={()=>void run('resolved')}><Sparkles size={14} aria-hidden="true"/><span data-testid="automatic-family-mode">{submitting?'Starting…':job?.status==='complete'?'Find again':workflowAction}</span></button>
      </div>}
    </div>
    {regionUnresolved&&<div data-testid="consensus-region-choice" className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
      <p>The selected panels show different regions. Choose the one to analyse (or select a single panel):</p>
      <div className="mt-1 flex flex-wrap gap-1">{loci.map(l=><button key={`${l.genome??''}|${l.chrom}:${l.start}-${l.end}`} type="button" data-testid="consensus-region-option"
        className={`${buttonStyle} bg-white dark:bg-gray-900`} onClick={()=>chooseRegion(l)}>
        {analysisLocusLabel(l,key=>referenceName(key),datasetName)}</button>)}</div>
    </div>}
    {noData&&<OpenBamHint testId="consensus-no-data"/>}
    {referenceProblem&&<p role="status" data-testid="consensus-reference-problem" className="text-[11px] text-amber-700 dark:text-amber-400">{referenceProblem}{useMatched && matched.recovery && <AnalysisButton data-testid="consensus-shared-block" onClick={matched.recovery.run}>{matched.recovery.label}</AnalysisButton>}</p>}
    {missingChemistry&&!noData&&onOpenSetup&&<div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
      Dataset assay metadata is required to choose the correct opportunity lattice. {onOpenSetup&&<button className="underline font-medium" onClick={onOpenSetup}>Open dataset setup</button>}
    </div>}
    {configCollapsed&&<div data-testid="class-config-summary" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-gray-200 bg-gray-50/60 px-2 py-1 text-[12px] dark:border-gray-700 dark:bg-white/[0.03]">
      <span className="min-w-0 flex-1 text-gray-700 dark:text-gray-200"><span className="text-ink-muted">Settings:</span> {configSummary}</span>
      <button type="button" data-testid="class-config-edit" className="fb-btn-secondary" onClick={()=>setConfigOpen(true)}
        title="Show the engine, stringency and region settings for the next run (Find again, above, runs with these settings)">Edit settings</button>
    </div>}
    {configurationFamilies&&<div data-testid="family-workflow" className="space-y-2" hidden={configCollapsed}>
      {job?.status==='complete'&&configOpen&&<button type="button" data-testid="class-config-collapse" className="text-[11px] text-ink-muted underline-offset-2 hover:underline"
        onClick={()=>setConfigOpen(false)}>Fold the settings</button>}
      <ClassRegionChoice matchedAvailable={!!regionAnalysisExtension()} line={runningRegion?analysedLine(runningRegion):useMatched?matched.label:regionUnresolved||!resolved?null:classRegionLine(range,resolved.fallback?`${resolved.what} (${resolved.fallback})`:resolved.what,range.genome?referenceName(range.genome):null)}
        source={runningRegion?runningRegion.region_source??null:useMatched?'matched':resolved?.source??null}
        mode={pinned?null:classRegionMode} onChoose={chooseMode} disabled={running||submitting}
        peaksTitle={peaks.length?(peakRange?undefined:'The selected peaks are on different chromosomes or references'):'Select a peak first (click it in the Peaks track)'}
        peaksAvailable={!!peakRange} savedRegion={savedRegion?.label??null}
        short={!!shortRegion} viewChosen={resolved?.source==='view'}/>
      {useMatched&&<p className="text-[11px] text-ink-muted" data-testid="class-region-pooling">Classes are found once in the shared orientation. Counts use one retained window per physical molecule; calls are drawn in each region’s genomic coordinates. Frozen transfer excludes training molecules.</p>}
      {useMatched&&job?.status==='complete'&&<AnalysisButton data-testid="class-region-transfer" disabled={runDisabled} onClick={()=>void run(undefined,job.job_id)}>Apply frozen classes</AnalysisButton>}
      {(pinned||classRegionMode!=='view')&&<div className="flex flex-wrap gap-2 text-[11px]">
        <button type="button" data-testid="class-region-clear" className="text-ink-muted underline" onClick={()=>chooseMode('view')}>Clear</button>
        {pinned&&regionAnalysisExtension()&&<button type="button" data-testid="class-region-link" disabled={!range.chrom||!Number.isInteger(range.start)||!Number.isInteger(range.end)||range.start<0||range.end<=range.start} className="text-ink-muted underline" onClick={()=>regionAnalysisExtension()!.link(range)}>Link as matched</button>}
      </div>}
      <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[12px]">
        <span className="text-gray-700 dark:text-gray-300">Engine</span>
        <span className="text-gray-800 dark:text-gray-100" data-testid="family-engine-name" title="The deprecated staged Monte Carlo engine is under Advanced">{engineName}{configurationStaged?'':' (default)'}</span>
        {configurationRecaller&&<><span className="text-gray-700 dark:text-gray-300" title="Class discovery stringency">Stringency</span>
        {/* In a narrow panel the slider keeps a usable width and "Coarser 0.90" wraps under it (it squeezed to nothing at 320 px). */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ink-muted"><span>Finer</span>
          <input aria-label="Class discovery stringency" data-testid="recaller-stringency" type="range" min="0.5" max="0.95" step="0.05" className="min-w-[72px] flex-1"
            disabled={running||submitting||!schema?.groups.recaller?.some(s=>s.name==='stringency')}
            value={Number(effective.recaller?.stringency??0.9)} onChange={e=>setParameter('recaller','stringency',Number(e.target.value))}/>
          <span>Coarser</span><span className="w-8 text-right font-medium tabular-nums text-gray-900 dark:text-gray-100">{Number(effective.recaller?.stringency??0.9).toFixed(2)}</span></div>
        {/* Classes the eye picks out in a partly closed region can be lumped with neighbours at the default; Finer finds them. */}
        {Number(effective.recaller?.stringency??0.9)>FINER_HINT_STRINGENCY+1e-9&&<p data-testid="recaller-finer-hint" className="col-start-2 -mt-1 text-[11px] text-ink-muted">
          Missing a class you can see? <button type="button" data-testid="recaller-finer-hint-apply" className="underline hover:text-gray-900 dark:hover:text-gray-100"
            disabled={running||submitting||!schema?.groups.recaller?.some(s=>s.name==='stringency')}
            onClick={()=>setParameter('recaller','stringency',FINER_HINT_STRINGENCY)}>Try Finer ({FINER_HINT_STRINGENCY.toFixed(2)})</button>: more, smaller classes, at the cost of near-duplicates.</p>}
        {schema?.groups.recaller?.some(s=>s.name==='order_replicates')&&<label className="col-start-2 flex items-center gap-2 text-gray-700 dark:text-gray-300"
          title={'Runs the class search again with the reads in other orders and marks as robust the classes found '
            +(robustShare>=1?'every time':`in at least ${Math.round(100*robustShare)}% of the orders`)+'. '
            +'Classes close to the detection threshold can depend on the order the reads are processed in; robust ones are found regardless. '
            +'The classes and numbers shown stay those of the normal order. Takes about '+((robustOrders||ROBUST_ORDERS)+1)+' times as long.'}>
          <input type="checkbox" data-testid="recaller-robust" disabled={running||submitting} checked={robustOrders>0}
            onChange={e=>setParameter('recaller','order_replicates',e.target.checked?ROBUST_ORDERS:0)}/>
          <span>Check robustness to read order <span className="text-ink-muted">(slower, ~{robustOrders>0?robustOrders+1:ROBUST_ORDERS+1}×)</span></span>
        </label>}</>}
      </div>
      {configurationRecaller&&<><HowItWorks>
        <p>Stringency is the k-means prediction strength. Lower finds more, finer classes (dense data, composite footprints) at the cost of near-duplicates. Every molecule's lattice is then scored against the classes; fractions are EM prevalences.</p>
        <p>Confident likelihood-ratio calls → k-means class geometries (split-half prediction strength) → exact identity merging → every molecule's lattice scored against the classes → EM prevalence per strand and dataset. No Monte Carlo.</p>
      </HowItWorks></>}
      {configurationStaged&&<><label className="mt-2 block">Assignment stringency
        <div className="flex items-center gap-2"><span>Strict</span>
          <input aria-label="Assignment stringency" type="range" min="50" max="99.9" step="0.1"
            className="min-w-0 flex-1" disabled={running||submitting||!schema?.groups.families?.some(s=>s.name==='assignment_reference_percent')}
            value={Number(job?.status==='complete'?filters?.classification_reference_percent??99.9:effective.families?.assignment_reference_percent??99.9)}
            onChange={e=>{const value=Number(e.target.value);setParameter('families','assignment_reference_percent',value);
              if(job?.status==='complete')updateFilter('classification_reference_percent',value);}}/>
          <span>Loose</span></div>
      </label>
      <p className="text-[11px] text-gray-600 dark:text-gray-300" title="Updates completed automatic assignments live from saved fit scores (no refitting). For a manually edited run, start a new run before changing stringency to preserve your edits.">{job?.status==='complete'
        ?'Loose accepts any compatible class. Changes re-assign calls instantly; class numbers stay the same.'
        :'Used by the next run; after a run it re-assigns calls instantly.'}</p></>}
    </div>}
    {job&&running&&<ConsensusProgress job={job}/>}
    {job?.warnings?.map(w=><p key={w} role="status" data-testid="consensus-run-warning" className="text-[11px] text-amber-700 dark:text-amber-400">{w}</p>)}
    {job?.status==='complete'&&recaller&&(job.layers??[]).includes('tf_rc')&&filters&&<label className="flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300" data-testid="recaller-edges"
      title="Footprint-class calls at their own edges (the native caller's where it called the footprint; members it did not call are outlined, at the recaller's edges, and the Edges control chooses strict, soft or loose for those), or at their class's consensus edges">
      Class calls at
      <span className="inline-flex overflow-hidden rounded-fb border border-line dark:border-white/15">
        {(['native','class'] as const).map(v=>{const on=(filters.recaller_edges==='class'?'class':'native')===v;return <button key={v} type="button" aria-pressed={on}
          onClick={()=>updateFilter('recaller_edges',v)}
          className={`px-2 py-px ${on?'bg-gray-900 text-white dark:bg-gray-200 dark:text-gray-900':'text-ink-muted hover:bg-surface-sunken'}`}>{v==='native'?'call edges':'class edges'}</button>;})}
      </span></label>}
    {job?.status==='complete'&&job.request.region_windows&&<div data-testid="class-region-windows" className="flex flex-wrap gap-2 text-[11px] text-ink-muted">{job.request.region_windows.map(w=><span key={w.name}>{w.dataset_id}@{w.name}: {classRegionLine(w,w.strand==='-'?'reversed':null)}</span>)}</div>}
    {job?.status==='complete'&&<p data-testid="class-region-analysed" className="text-[11px] text-ink-muted">Analysed: <span className="tabular-nums text-gray-800 dark:text-gray-200">{analysedLine(job.request)}</span></p>}
    {job?.status==='complete'&&viewCatalog&&<StateList jobId={job.job_id} activeFilterKey={activeFilterKey} analysedRegion={analysedLine(job.request)}
      datasetLabels={Object.fromEntries(datasets.map(d=>[d.id,d.label||d.id]))}
      onFilter={(datasetId,family,name)=>onFilterState?.(datasetId,family,name)} runLabel={runLabel}/>}
    {job?.status==='complete'&&<div data-testid="consensus-read-depth-notes" className="text-[11px] text-ink-muted">{readDepthNotes(job.molecule_sampling,Object.fromEntries(datasets.map(d=>[d.id,d.label])),job.loader_sampling).map(note=><p key={note}>{note}</p>)}</div>}
    <details data-testid="states-advanced" className="fb-disc"><summary><ChevronRight size={12} className="fb-disc-chevron" aria-hidden="true"/>Advanced: edit classes, export, algorithm settings</summary><div className="fb-disc-body">
    {configurationFamilies&&<label className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-gray-700 dark:text-gray-300">Engine</span>
      <select id="family-engine-select" aria-label="Footprint-class engine" data-testid="family-engine" className="input-tool min-h-0 py-1 text-[12px]" disabled={running||submitting}
        value={String(effective.cr?.engine??'lattice_recaller')} onChange={e=>{setParameter('cr','engine',e.target.value);setConfigOpen(true);}}>
        <option value="lattice_recaller">Lattice recaller (default)</option>
        <option value="staged_native_families">Staged Monte Carlo (deprecated)</option>
      </select>
      <span className="text-[11px] text-ink-muted">The staged engine is kept for older analyses; the lattice recaller is the default.</span>
    </label>}
    {job?.status==='complete'&&viewCatalog&&<>
      <p className="text-[11px] text-gray-600 dark:text-gray-300">Each read footprint is colored by its best-fit class. Other evidence-compatible classes are listed in the inspector.{recaller?'':' Ctrl/⌘-click states to select several, then merge, split or ignore them.'}</p>
      {(nativeMode||harmonization||staged)&&<ConsensusCurationToolbar jobId={job.job_id}/>}
      <ConsensusBamExport key={job.job_id} jobId={job.job_id}/>
    </>}
    {schema?.runtime&&<details className="text-[11px] text-gray-500"><summary className="cursor-pointer">Caller source / runtime</summary>
      <p className="break-all">{schema.runtime.workflow_path}</p><p>Frozen exports record the inference source hashes. Restart after changing caller code; stale shadow packages cannot run consensus.</p></details>}
    {configurationRecaller&&<ReadDepthControls prefix="consensus" values={(effective.recaller??{}) as ReadDepth} supported={depthSupported} onChange={(name,v)=>setParameter('recaller',name,v)}/>}
    <ConsensusFamilyInspector/>
    <ConsensusCallInspector nativeReferencePercent={job?.cross_summary?.parameters?.reference_percent}/>
    {(nativeMode||harmonization||staged)&&job?.status==='complete'&&<ConsensusFamilyList jobId={job.job_id}/>}
    {job&&<FamilyStages job={job} onChange={setJob}/>}
    {configurationStaged&&<p className="text-[11px]">Existing likelihood-ratio calls → native class fits → shared-class fits → consolidation → recurrent states. Strand-resolved assays pool measurement strands; multiple datasets form shared cross-dataset states. HiA5 directions are pooled. Reference scoring: 4,095 draws, 10 molecule-excluded folds, 99.9% reference, initial 2 bp floor; no extra parent matching floor.</p>}
    {staged&&<p className="text-[11px]">{recaller?'Solid bars: class spans (median call edges). Pale boxes: class edge ranges. Each read footprint uses the class its lattice best supports; per-strand prevalence, support and resolution are in the class inspector.':'Solid bars: fitted mean spans. Pale boxes: conditional 95% edge uncertainty. Each read footprint uses its best-fit class color; other compatible classes remain available in the inspector.'}</p>}
    <details className="fb-disc"><summary><ChevronRight size={12} className="fb-disc-chevron" aria-hidden="true"/>Algorithm, region, and display settings</summary><div className="fb-disc-body">
    <ConsensusViewControls/>
    <div className="grid grid-cols-[55px_1fr_1fr] gap-1">
      <input aria-label="Consensus chromosome" disabled={!schema} className={inputStyle} value={range.chrom} onChange={e=>pinRange({...range,chrom:e.target.value})}/>
      <input aria-label="Consensus start (0-based)" disabled={!schema} className={inputStyle} type="number" value={range.start} onChange={e=>pinRange({...range,start:Number(e.target.value)})}/>
      <input aria-label="Consensus end (exclusive)" disabled={!schema} className={inputStyle} type="number" value={range.end} onChange={e=>pinRange({...range,end:Number(e.target.value)})}/>
    </div>
    <div className="flex gap-1 items-center flex-wrap"><button className={buttonStyle}
        title={loci.length>1?'The selected panels show different regions: choose one':'The region the selected panels show'}
        onClick={()=>chooseMode('view')}>Use view</button>
      <button className={buttonStyle} disabled={!peakRange} title={peaks.length&&!peakRange?'The selected peaks are on different chromosomes or references':undefined}
        onClick={()=>chooseMode('peaks')}>Use selected peaks</button>
      <span className="text-[11px]">{regionUnresolved?'Region not chosen yet':`${range.genome?`${referenceName(range.genome)} · `:''}${Math.max(0,range.end-range.start).toLocaleString()} bp · 0-based, end-exclusive`}</span></div>
    <fieldset className="space-y-1"><legend className="font-medium">Datasets and native models</legend>
      {datasets.map(d=><div key={d.id} className="flex gap-2 items-center"><label className="flex gap-1 flex-1 min-w-0"><input type="checkbox" checked={selected.includes(d.id)}
        onChange={e=>{setSelectedPinned(true);setSelected(v=>e.target.checked?[...v,d.id]:v.filter(id=>id!==d.id));}}/><span className="truncate" title={d.label}>{d.label}</span></label>
        <span className="text-[11px] text-gray-500">{consensusChemistry(d)||'Metadata required'}</span></div>)}
      {onOpenSetup&&<button className="underline" onClick={onOpenSetup}>Edit dataset information</button>}
    </fieldset>
    {schema && Object.entries(schema.groups).filter(([group])=>!configurationFamilies||!['sr','cross'].includes(group)).filter(([group,controls])=>configurationStaged?controls.some(s=>stagedControlVisible(group,s.name)):configurationRecaller?controls.some(s=>recallerControlVisible(group,s.name)):group!=='families'&&group!=='recaller'&&(!configurationHarmonization||controls.some(s=>harmonizationControlVisible(group,s.name)))).map(([group,controls])=><details key={group} className="border rounded p-1.5 dark:border-gray-700">
      <summary className="cursor-pointer font-medium">{configurationStaged&&group==='sr'?'Cross-strand shared classes':configurationStaged&&group==='cross'?'Cross-dataset shared classes':configurationStaged&&group==='cr'?'Algorithm':GROUP_NAMES[group]}{effective[group]?.enabled!==undefined?` · ${effective[group].enabled?'on':'off'}`:''}</summary>
      {group==='rescue'&&<p className="text-[11px] text-gray-500">Population-assisted uses source recurrence and recipient evidence. Legacy strict retains the previous hard gates. Only controls for the selected model are shown.</p>}
      {group==='cross'&&configurationNative&&effective.cross.native_predictive_replicates!==undefined&&<NativeCrossPrecision
        referencePercent={Number(effective.cross.native_reference_percent)} draws={Number(effective.cross.native_predictive_replicates)}/>}
      {controls.filter(spec=>!configurationHarmonization||harmonizationControlVisible(group,spec.name))
        .filter(spec=>!configurationStaged||stagedControlVisible(group,spec.name))
        .filter(spec=>!configurationRecaller||recallerControlVisible(group,spec.name))
        .filter(spec=>group!=='recaller'||!READ_DEPTH_NAMES.some(n=>n===spec.name))
        .filter(spec=>group!=='rescue'||['enabled','model','source_mode','minimum_probability','maximum_diffuse_odds'].includes(spec.name)
        || (effective.rescue?.model==='population_assisted'?spec.name.startsWith('population_'):!spec.name.startsWith('population_')))
        .filter(spec=>configurationStaged||configurationHarmonization||group!=='cross'||crossControlVisible(spec.name,configurationNative))
        .filter(spec=>!(configurationStaged&&group==='families'&&['physical_radius_bp','stop_after'].includes(spec.name)))
        .map(spec=><Control key={spec.name} spec={configurationStaged&&spec.name==='enabled'&&group==='sr'
          ?{...spec,label:'Form shared classes across strands',help:'Joint parent fitting and consolidation across the distinct measurement lattices of this dataset; original footprint boundaries never change.'}
          :configurationStaged&&spec.name==='enabled'&&group==='cross'
          ?{...spec,label:'Form shared classes across datasets',help:'Joint shared hypotheses using each call’s own lattice and chemistry. Multi-compatible calls remain members of every supported hypothesis.'}
          :group==='cross'&&configurationNative&&spec.name==='minimum_support'
          ?{...spec,label:'Minimum native primary / assessable calls',help:'Per-direction interpretation threshold on native primary and assessable call counts, not posterior-effective support or source-family recurrence.'}
          :group==='cross'&&configurationNative&&spec.name==='minimum_fraction'
            ?{...spec,help:'Compatible calls divided by assessable calls (scored plus core-contradicted), required in both directions. MC-borderline compatible calls remain included and are reported separately.'}:spec}
          value={effective[group][spec.name]} onChange={v=>setParameter(group,spec.name,v)}/>)}</details>)}
    </div></details>
    {crossPrecision&&!crossPrecision.resolved&&<p role="alert" className="text-red-700 text-[11px]">Resolve the Native XCR simulation-budget warning before running; lower the XCR reference or increase XCR draws.</p>}
    <div className="flex gap-1 flex-wrap"><button className={buttonStyle} onClick={()=>{explicitParameters.current.clear();setParameters({});}}>Use current defaults</button>
      <label className={`${buttonStyle} cursor-pointer`}>Import frozen result<input aria-label="Import frozen consensus result" type="file" accept=".json,.gz" className="hidden" disabled={running}
        onChange={e=>{const file=e.target.files?.[0];if(file){setError('');void importConsensus(file).then(restore).catch(v=>setError(errorMessage(v)));}e.target.value='';}}/></label></div>
    {history.some(j=>j.status==='complete')&&<label className="block">Completed runs <select aria-label="Activate completed consensus run" className={`${inputStyle} w-full`} disabled={running}
      value={job?.status==='complete'?job.job_id:''} onChange={e=>{if(e.target.value)void activateConsensus(e.target.value).then(restore).catch(v=>setError(errorMessage(v)));}}>
      <option value="" disabled>Select a frozen run…</option>{history.filter(j=>j.status==='complete').map(j=><option key={j.job_id} value={j.job_id}>{j.job_id.slice(0,8)} · {j.request.chrom}:{j.request.start}–{j.request.end}</option>)}</select></label>}
    {dirty&&<p className="text-amber-700 dark:text-amber-300 text-[11px]">Inference settings edited. Existing layers stay frozen until you run again.</p>}
    {job&&<div className="bg-gray-50 dark:bg-gray-800 rounded p-2 space-y-1">
      <p className="text-[11px]" data-testid="class-region-analysed-details">Analysed: {analysedLine(job.request)} · run {job.job_id.slice(0,8)}</p>
      {job.summary&&Object.entries(job.summary).map(([id,s])=><p key={id} className="text-[11px]">{datasets.find(d=>d.id===id)?.label??id}: {s.units.toLocaleString()} units · {!staged&&`${s.sr_changed.toLocaleString()} strand-normalized edge changes · `}{s.classes} {staged?'states':'classes'} · {staged
        ?<>{s.assignments.toLocaleString()} / {s.source_calls?.toLocaleString()} original calls assigned</>:harmonization
        ? <>{s.source_calls_in_region?.toLocaleString()??'unreported'} in-region native calls · {s.assignments.toLocaleString()} class-labeled calls · no rescue
            {!!((s.outside_region_calls??0)+(s.boundary_crossing_calls??0))&&<>. Retained source context: {s.outside_region_calls??0} outside-region and {s.boundary_crossing_calls??0} boundary-crossing calls; not in-region detections.</>}</>
        : <>{s.assignments.toLocaleString()} assignments · {s.rescued} new calls · {s.split_spans} split spans<ConsensusFitStatus fit={s.numerical_fit}/></>}</p>)}
      {job.summary&&Object.entries(job.summary).filter(([,s])=>s.population_rescue).map(([id,s])=><p key={`${id}-rescue-numerics`} className="text-[11px] text-amber-800 dark:text-amber-300">
        Population rescue: {s.population_rescue!.retained_additions} retained additions; {s.population_rescue!.provisional_source_models}/{s.population_rescue!.source_models} source models numerically provisional.
        Minimum chain ESS {s.population_rescue!.minimum_source_ess.toFixed(1)}; maximum split R̂ {s.population_rescue!.maximum_source_rhat.toFixed(2)}.
        {s.population_rescue!.provisional_source_models>0?' Treat the affected confidence scores as exploratory; completion is not convergence.':' Model probabilities remain uncalibrated, even when the numerical checks pass.'}</p>)}
      <ConsensusCrossSummary summary={job.cross_summary} nativeMode={nativeMode} harmonization={harmonization} staged={staged} edges={catalog?.edges} jobId={job.job_id}/>
      {job.status==='complete'&&<a className="underline text-cyan-700" href={consensusExportUrl(job.job_id)}>Download frozen result + provenance</a>}
    </div>}
    {job?.status==='complete'&&filters&&<fieldset aria-busy={filtersPending} className="border-t pt-2 space-y-2 dark:border-gray-700"><legend className="font-semibold">Display filters · no refit</legend>
      {filtersPending && <p data-testid="consensus-filters-pending" aria-live="polite" className="text-[11px] text-cyan-700 dark:text-cyan-300">Applying display filters… Existing reads remain visible until the refresh completes.</p>}
      {nativeMode&&<ClassificationReferenceControl value={filters.classification_reference_percent??99.9} onChange={v=>updateFilter('classification_reference_percent',v)}/>}
      {!nativeMode&&!harmonization&&!staged&&<>{(['minimum_model_q','minimum_rescue_model_q','minimum_comparability_q'] as const).filter(key=>filters[key]!==undefined).map((key)=><label key={key} className="block">
        <span>{key==='minimum_model_q'?'Native class inclusion model Q':key==='minimum_rescue_model_q'?'New-call rescue model Q':'CT/GA comparability model CQ'} ≥ {(filters[key]??0).toFixed(1)}</span>
        <div className="flex gap-2"><input aria-label={key} className="flex-1" type="range" min="0" max="60" step="0.1" value={filters[key]??0} onChange={e=>updateFilter(key,Number(e.target.value))}/>
          <input aria-label={`${key} exact`} className={`${inputStyle} w-16`} type="number" min="0" max="120" step="0.1" value={filters[key]??0} onChange={e=>updateFilter(key,Number(e.target.value))}/></div>
      </label>)}
      <p className="text-[11px] text-gray-500">Q = −10 log₁₀(1 − model mass). These are not calibrated accuracy/FDR scores. Hidden color means an unassigned or filtered hypothesis, not demonstrated accessibility.</p>
      <div className="flex gap-1 flex-wrap" aria-label="New-call confidence presets">{[.5,.75,.9,.95,.99,.999].map(p=><button key={p} className={buttonStyle}
        onClick={()=>updateFilter(filters.minimum_rescue_model_q!==undefined?'minimum_rescue_model_q':'minimum_model_q',-10*Math.log10(1-p))}>{(100*p).toFixed(p===.999?1:0)}%</button>)}</div>
      <p className="text-[11px] text-gray-500">Population-assisted rescue: one/two-opportunity additions may be weak but remain filterable. Native equal-activity evidence and the source-only prior are recorded separately. Dashed amber marks weak recipient evidence; dashed violet marks numerical integration caution. {filters.minimum_rescue_model_q!==undefined?'These presets filter new calls only; existing CR labels retain their separate threshold.':'This older server filters all class layers together.'} No refit or geometry changes.</p>
      </>}
      {([['require_population_comparable','Only CT/GA population-testable classes'],['require_molecule_comparable','Only molecule-power-testable classes'],
        ['require_cross_comparable','Only compatible cross-dataset links'],['show_quality_outlines','Show comparability outlines']] as const).filter(([key])=>!(nativeMode||harmonization||staged)||!['require_population_comparable','require_molecule_comparable'].includes(key)).filter(([key])=>!staged||key!=='require_cross_comparable').map(([key,label])=><label key={key} className="flex gap-2"><input type="checkbox" checked={filters[key]} onChange={e=>updateFilter(key,e.target.checked)}/>{staged&&key==='show_quality_outlines'?'Show state outlines':harmonization&&key==='require_cross_comparable'?'Only lattice-comparable cross-dataset links':label}</label>)}
      <div className="space-y-1">{job.layers?.map(name=><label key={name} className="flex gap-2 items-center"><input data-testid={`consensus-layer-${name}`} type="checkbox" checked={!!enabledModTypes[name]}
        onChange={e=>useBrowserStore.getState().toggleModType(name,e.target.checked)}/><span style={{color:schema?.layers[name]?.[1]}}>━</span>{schema?.layers[name]?.[0]??name}</label>)}</div>
      <p className="text-[11px] text-gray-500">{staged?'Colors label unchanged likelihood-ratio footprints by their single best-fit class; other compatible classes remain inspectable. Gray calls remain in the audit ledger without an accepted recurrent-class assignment. Cross-strand and cross-dataset analysis share class hypotheses without moving original boundaries. Manual groups are separate annotations, not additional fitted evidence.':harmonization?'Population-class colors label unchanged native spans. Strand normalization changes only measurement-equivalent boundaries. Cyan cross-dataset links mean lattice comparable, not matching counts; amber means limited comparison. Compare strands and datasets shows both agreement and disagreement. Manual edits remain separate.':nativeMode?'Population-class colors classify unchanged original footprint spans; unresolved calls are gray. Manual groups have dashed violet markers, not new evidence. Cross-dataset outlines: cyan provisionally compatible, amber unresolved, red core contradiction. All alternatives remain inspectable.':'Class-colored fill = fitted population-class geometry. Violet = moved boundary, gray = unchanged. Pink = genuinely added footprint. Cross-dataset outline: cyan shape-compatible, amber unresolved, red disagreement. Original nucleosomes remain intact underneath alternative split pieces.'}</p>
      <button className={buttonStyle} onClick={()=>setCatalogOpen(v=>!v)}>{catalogOpen?'Hide':'Inspect'} classes, rates and cross-dataset links</button>
      {catalogOpen&&<div className="space-y-1"><input aria-label="Search consensus catalog" className={`${inputStyle} w-full`} placeholder="Class ID or coordinate…" value={search} onChange={e=>setSearch(e.target.value)}/>
        <div className="max-h-72 overflow-auto text-[11px]">
          {catalog&&<ConsensusCountGroups groups={catalog.count_groups??[]} search={search}/>}
          {!catalog?'Loading catalog…':!nativeMode&&!harmonization&&Object.entries(catalog.datasets).map(([id,value])=><div key={id}>
          <div className="font-semibold mt-2">{datasets.find(d=>d.id===id)?.label??id}</div>
          {value.rescue_rates&&<div className="text-gray-500">New calls at model P ≥ {(100*value.rescue_rates.probability_threshold).toFixed(1)}%; baseline CR fixed at P ≥ 50%. {value.rescue_rates.denominator}.</div>}
          {value.catalog.filter(c=>!search||`${c.family} ${c.consensus_start} ${c.consensus_end}`.includes(search)).map(c=><div key={c.family} className="py-1 border-b dark:border-gray-700">
            <div>{c.family} · {c.consensus_start}–{c.consensus_end} ({c.consensus_end-c.consensus_start} bp)</div>
            {Object.entries(c.rates_by_strand??{}).map(([strand,r])=><div key={strand}>{strand}: native {r.native_assignments} → SR {r.after_sr_assignments}{!value.rescue_rates&&r.after_recall_assignments!==undefined?` → recall ${r.after_recall_assignments}`:''} / {r.eligible_units} eligible (membership ≥ 0.5)</div>)}
            {Object.entries(value.rescue_rates?.by_family[c.family]??{}).map(([strand,r])=><div key={`${strand}-new-counts`}>{strand} all-unit counts: CR {r.baseline_units} + {r.added_units} new = {r.combined_units} / {r.all_units}</div>)}
          </div>)}</div>)}
          {catalog?.edges.filter(e=>!search||`${e.left_family} ${e.right_family} ${e.left_interval} ${e.right_interval}`.includes(search)).map(e=><ConsensusCrossEvidence key={e.edge_id} edge={e} catalog={catalog}/>)}
        </div></div>}
    </fieldset>}
    </div></details>
    {error&&<p role="alert" className="text-red-700 dark:text-red-300 break-words">{error}</p>}
  </section>;
}
