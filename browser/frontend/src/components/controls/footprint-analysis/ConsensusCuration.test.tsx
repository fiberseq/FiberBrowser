import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRoot,type Root} from 'react-dom/client';
import {act,type ReactElement} from 'react';
import {ConsensusCurationToolbar,ConsensusFamilyList,ConsensusFamilyInspector,ConsensusCallInspector} from './ConsensusViewControls';
import {ClassificationReferenceControl,ConsensusCrossSummary} from './ConsensusTools';
import {useConsensusViewStore} from '../../../stores/consensusViewStore';
import type {ConsensusCatalog} from '../../../api/consensusWorkflow';
import * as workflow from '../../../api/consensusWorkflow';

const catalog:ConsensusCatalog={cr_mode:'native_family_distribution',datasets:{d:{comparability:[],catalog:[
  {family:'A',consensus_start:10,consensus_end:30,classification_counts:{CT:{original_calls:20,primary_calls:4,compatible_calls:10,eligible_units:18,primary_units:3}},fit_flags:['singleton']},
  {family:'B',consensus_start:12,consensus_end:32}],curated_display_families:[{family:'M',display_start:10,display_end:32,display_summary_only:true,manual:true,label:'Exploratory merge',source_family_ids:['A','B']}]},h:{catalog:[{family:'A',consensus_start:10,consensus_end:30}],comparability:[]}},edges:[]};
let container:HTMLDivElement,root:Root;
const originalCurate=useConsensusViewStore.getState().curate;
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
  useConsensusViewStore.setState({curate:originalCurate,jobId:'j',catalog,selection:null,selections:[],callSelection:null,curationBusy:false,curationLoading:false,curationError:'',curation:{revision:2,catalog_digest:'frozen',can_undo:true,can_redo:false,operations:[],manual_groups:[],ignored_families:{d:['B']}}});
});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.restoreAllMocks();});
function render(element:ReactElement){act(()=>root.render(element));return container.innerHTML;}

describe('shared manual curation and native reference controls',()=>{
  it('offers no curation toolbar for a lattice recaller run, with the reason (audit: its edits did nothing)',()=>{
    const load=vi.fn(),original=useConsensusViewStore.getState().loadCuration;
    useConsensusViewStore.setState({catalog:{...catalog,cr_mode:'lattice_recaller'},curation:null,loadCuration:load} as any);
    const html=render(<ConsensusCurationToolbar jobId="j"/>);
    expect(container.querySelector('[data-testid="consensus-curation-panel"]')).toBeNull();
    expect([...container.querySelectorAll('button')].map(b=>b.textContent)).not.toContain('Ignore');
    const note=container.querySelector('[data-testid="consensus-curation-unavailable"]')!;
    expect(note.getAttribute('title')).toContain('lattice recaller');
    expect(html).toContain('not available for lattice recaller runs');
    expect(load).not.toHaveBeenCalled();
    useConsensusViewStore.setState({loadCuration:original});
  });
  it('edits staged XCR families in one shared scope with duplicate selections removed',async()=>{
    const edit=vi.fn().mockResolvedValue(true);
    useConsensusViewStore.setState({curate:edit,catalog:{...catalog,cr_mode:'staged_native_families',curation_scope:'__shared_families__'},
      selections:[{jobId:'j',datasetId:'d',family:'A'},{jobId:'j',datasetId:'h',family:'A'},{jobId:'j',datasetId:'d',family:'B'}]});
    render(<ConsensusCurationToolbar jobId="j"/>);
    const merge=[...container.querySelectorAll('button')].find(b=>b.textContent==='Group selected')!;
    expect(merge.disabled).toBe(false);await act(async()=>merge.click());
    expect(edit).toHaveBeenCalledWith('j',{operation:'merge',dataset_id:'__shared_families__',family_ids:['A','B'],label:undefined});
  });
  it('shows dataset update policy and selected-model origin without attaching evidence to a manual group',()=>{
    const updated={...catalog,datasets:{...catalog.datasets,d:{...catalog.datasets.d,
      native_catalog_update:{policy:'append_frozen',original_family_count:1,added_family_count:1},
      catalog:catalog.datasets.d.catalog.map(f=>({...f,model_provenance:{origin:f.family==='A'?'initial_frozen':'augmented_new',
        model_version_sha256:'abcdef1234567890',producer_snapshot_digest:'source'}}))}}};
    useConsensusViewStore.setState({catalog:updated});
    const list=render(<ConsensusFamilyList jobId="j"/>);
    expect(list).toContain('1 original / 1 added classes');expect(list).toContain('provenance unavailable');
    act(()=>useConsensusViewStore.getState().select({jobId:'j',datasetId:'d',family:'A'}));
    const inspector=render(<ConsensusFamilyInspector/>);
    expect(inspector).toContain('initial model · frozen');expect(inspector).toContain('abcdef1234567890');
    expect(inspector).toContain('added alternatives may change the primary label');
    act(()=>useConsensusViewStore.getState().select({jobId:'j',datasetId:'d',family:'M'}));
    expect(container.innerHTML).toContain('manual exploratory group');
    expect(container.innerHTML).not.toContain('native-model-version');
  });
  it('inspects full transferred-call evidence against the frozen XCR reference with donor provenance',()=>{
    useConsensusViewStore.setState({catalog:{...catalog,datasets:{...catalog.datasets,h:{comparability:[],catalog:[{family:'H',consensus_start:10,consensus_end:40,source_units:1,fit_diagnostics:{full:{converged:false}}}]}}},
      callSelection:{jobId:'j',datasetId:'d',readId:'read',record:{interval:[10,32],kind:'cr',candidate_evidence:[],native_cross_tests:[{
        link_id:'X1',families:{d:'A',h:'H'},recipient_evidence:{status:'scored',predictive_tail_interval:[.0002,.002],
          geometry_mass_overlapping_observed_call:.2,geometry_mass_allowed_by_frozen_neighbors:.8,physical_geometry_retention:.1,geometry_observed_mass_fraction:.5}}]}}});
    const html=render(<ConsensusCallInspector nativeReferencePercent={99.9}/>);
    expect(html).toContain('MC-borderline');expect(html).toContain('99.9% XCR reference, frozen run');
    expect(html).toContain('20.00%');expect(html).toContain('Singleton source hypothesis');expect(html).toContain('NOT converged');
  });
  it('uses the native catalog for XCR totals instead of absent legacy count fields',()=>{
    const edges=[{comparability_mask:true},{comparability_mask:false},{comparability_mask:true}] as ConsensusCatalog['edges'];
    const html=renderToStaticMarkup(<ConsensusCrossSummary summary={{status:'complete'}} nativeMode edges={edges}/>);
    expect(html).toContain('3 catalog atomic links');expect(html).toContain('2 native shape-compatible (provisional)');
    expect(html).not.toContain('XCR: 0');expect(html).not.toContain('undefined');
    const pending=renderToStaticMarkup(<ConsensusCrossSummary summary={{status:'complete'}} nativeMode/>);
    expect(pending).toContain('loading catalog link counts');expect(pending).not.toContain('0 atomic links');
  });
  it('retains the legacy XCR summary count contract',()=>{
    const html=renderToStaticMarkup(<ConsensusCrossSummary summary={{status:'complete',counts:{supported:2,unresolved:1},comparable_edges:2}} nativeMode={false}/>);
    expect(html).toContain('3 atomic links');expect(html).toContain('2 shape-compatible after full-model tests');
  });
  it('reports the shared catalog before opening the inspector without using another job',()=>{
    const edges=[{comparability_mask:true},{comparability_mask:false}] as ConsensusCatalog['edges'];
    useConsensusViewStore.setState({catalog:{...catalog,edges}});
    expect(render(<ConsensusCrossSummary jobId="j" summary={{status:'complete'}} nativeMode/>)).toContain('2 catalog atomic links');
    expect(render(<ConsensusCrossSummary jobId="other" summary={{status:'complete'}} nativeMode/>)).toContain('loading catalog link counts');
    act(()=>useConsensusViewStore.setState({jobId:'other',catalog:{...catalog,edges:[]}}));
    expect(container.textContent).toContain('0 catalog atomic links');
  });
  it('loads only selected-call detail and refuses an obsolete response after selection changes',async()=>{
    let resolveOld!:(value:any)=>void;
    const old=new Promise<any>(resolve=>{resolveOld=resolve;});
    const fetched=vi.spyOn(workflow,'getConsensusCall').mockReturnValueOnce(old).mockResolvedValueOnce({job_id:'j',dataset_id:'d',source_call_id:'source-B',call:{interval:[12,32],kind:'cr',candidate_evidence:[{family:'B-detail',status:'scored',predictive_tail:.3}]}});
    const selection=(id:string)=>({jobId:'j',datasetId:'d',readId:id,record:{interval:[10,32] as [number,number],kind:'cr',source_call_id:`source-${id}`}});
    useConsensusViewStore.setState({callSelection:selection('A')});render(<ConsensusCallInspector/>);
    expect(fetched).toHaveBeenCalledTimes(1);
    await act(async()=>{useConsensusViewStore.setState({callSelection:selection('B')});});
    expect(container.textContent).toContain('B-detail');expect(fetched.mock.calls[0][3]?.aborted).toBe(true);
    await act(async()=>resolveOld({call:{interval:[10,30],kind:'cr',candidate_evidence:[{family:'OLD-DETAIL',status:'scored'}]}}));
    expect(container.textContent).not.toContain('OLD-DETAIL');expect(container.textContent).toContain('B-detail');
  });
  it('lets users type an exact reference before committing the display change',()=>{
    const change=vi.fn();render(<ClassificationReferenceControl value={99.9} onChange={change}/>);
    const input=container.querySelector<HTMLInputElement>('input[aria-label="Classification reference percent exact"]')!;
    act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'99.99');input.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(change).not.toHaveBeenCalled();
    act(()=>input.dispatchEvent(new FocusEvent('focusout',{bubbles:true})));
    expect(change).toHaveBeenCalledWith(99.99);
  });
  it('exposes rejected and unavailable original-call comparisons, not just accepted labels',()=>{
    useConsensusViewStore.setState({callSelection:{jobId:'j',datasetId:'d',readId:'read',record:{interval:[10,32],kind:'cr',cr_mode:'native_family_distribution',classification_status:'provisional_unresolved',source_call_id:'source-id',candidate_evidence:[
      {family:'A',status:'core_contradicted',native_loss:20,core_protected_vs_accessible_log_lr:-8},
      {family:'B',status:'fit_unavailable',fit_converged:false}]}}});
    const html=render(<ConsensusCallInspector/>);
    expect(html).toContain('core_contradicted');expect(html).toContain('fit_unavailable');expect(html).toContain('source-id');
    expect(html).toContain('not posterior probabilities');expect(html).toContain('original span retained');
  });
  it('shares checkbox selection between the overhead and panel action toolbars',async()=>{
    const edit=vi.fn().mockResolvedValue(true);useConsensusViewStore.setState({curate:edit});
    render(<><ConsensusCurationToolbar jobId="j" compact/><ConsensusCurationToolbar jobId="j"/><ConsensusFamilyList jobId="j"/></>);
    for(const family of ['A','B'])act(()=>container.querySelector<HTMLInputElement>(`input[aria-label="Select d state ${family}"]`)!.click());
    const toolbars=container.querySelectorAll('[data-testid^="consensus-curation-"]');
    expect(toolbars).toHaveLength(2);
    for(const toolbar of toolbars)expect(toolbar.textContent).toContain('2 selected');
    const merge=[...toolbars[0].querySelectorAll('button')].find(b=>b.textContent==='Group selected')!;
    expect(merge.disabled).toBe(false);await act(async()=>merge.click());
    expect(edit).toHaveBeenCalledWith('j',{operation:'merge',dataset_id:'d',family_ids:['A','B'],label:undefined});
    const undo=[...toolbars[1].querySelectorAll('button')].find(b=>b.textContent==='Undo edit')!;
    await act(async()=>undo.click());expect(edit).toHaveBeenLastCalledWith('j',{operation:'undo'});
    expect(catalog.datasets.d.catalog.map(f=>[f.consensus_start,f.consensus_end])).toEqual([[10,30],[12,32]]);
  });
  it('exposes the permissive reference direction and avoids accuracy claims',()=>{
    const html=renderToStaticMarkup(<ClassificationReferenceControl value={99.9} onChange={()=>{}}/>);
    expect(html).toContain('Higher reference = more permissive grouping');expect(html).toContain('not an accuracy, posterior probability or FDR');
    expect(html).toContain('99.999%');expect(html).toContain('Original call spans never change');
  });
  it('enables same-dataset merge, never cross-dataset merge, in both toolbars',()=>{
    const view=useConsensusViewStore.getState();view.select({jobId:'j',datasetId:'d',family:'A'});view.select({jobId:'j',datasetId:'d',family:'B'},true);
    for(const compact of [false,true]){
      const html=render(<ConsensusCurationToolbar jobId="j" compact={compact}/>);
      expect(html).toContain('2 selected');expect(html).toMatch(/<button[^>]*(?<!disabled="")>Group selected<\/button>/);
      expect(html).toContain('Undo edit');expect(html).toContain('Redo edit');
    }
    act(()=>view.select({jobId:'j',datasetId:'h',family:'A'},true));
    const html=render(<ConsensusCurationToolbar jobId="j"/>);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Group selected<\/button>/);expect(html).toContain('within one dataset');
  });
  it('offers frozen parent-stage models as subclasses instead of an arbitrary coordinate split',async()=>{
    const edit=vi.fn().mockResolvedValue(true);
    const candidates=[
      {family:'parent:left',consensus_start:8,consensus_end:20,primary_calls:4,compatible_calls:8,member_calls:7,direct_parent:false},
      {family:'parent:right',consensus_start:18,consensus_end:31,primary_calls:5,compatible_calls:9,member_calls:8,direct_parent:true},
    ];
    const staged={...catalog,cr_mode:'staged_native_families' as const,datasets:{...catalog.datasets,d:{...catalog.datasets.d,
      catalog:catalog.datasets.d.catalog.map(f=>f.family==='A'?{...f,subclass_candidates:candidates}:f),
      curated_display_families:[]}}};
    useConsensusViewStore.setState({catalog:staged,curate:edit,selection:{jobId:'j',datasetId:'d',family:'A'},selections:[{jobId:'j',datasetId:'d',family:'A'}]});
    render(<ConsensusCurationToolbar jobId="j"/>);
    const find=[...container.querySelectorAll('button')].find(b=>b.textContent==='Find subclasses')!;
    expect(find.disabled).toBe(false);act(()=>find.click());
    expect(container.textContent).toContain('8–20');expect(container.textContent).toContain('7 matching calls');
    const show=[...container.querySelectorAll('button')].find(b=>b.textContent==='Show selected subclasses')!;
    await act(async()=>show.click());
    expect(edit).toHaveBeenCalledWith('j',{operation:'restore_subclasses',dataset_id:'d',family_ids:['A'],label:undefined,subclass_ids:['parent:left','parent:right']});
  });
  it('lets every automatic class report when no supported subclasses were retained',()=>{
    useConsensusViewStore.getState().select({jobId:'j',datasetId:'d',family:'B'});
    render(<ConsensusCurationToolbar jobId="j"/>);
    const find=[...container.querySelectorAll('button')].find(b=>b.textContent==='Find subclasses')!;
    expect(find.disabled).toBe(false);act(()=>find.click());
    expect(container.textContent).toContain('No distinct supported subclasses were retained');
    expect(container.textContent).not.toContain('Show selected subclasses');
  });
  it('lists manual groups separately and keeps automatic IDs / original counts visible',()=>{
    const html=render(<ConsensusFamilyList jobId="j"/>);
    expect(html).toContain('Select d state A');expect(html).toContain('Select h state A');
    expect(html).toContain('Select d state M');expect(html).toContain('Exploratory merge');expect(html).toContain('ignored');
    expect(html).toContain('4 primary / 10 compatible calls');
    expect(catalog.datasets.d.catalog.map(f=>f.family)).toEqual(['A','B']);
  });
  it('inspects native counts and caution without substituting membership or canonical edges',()=>{
    useConsensusViewStore.getState().select({jobId:'j',datasetId:'d',family:'A'});
    const html=render(<ConsensusFamilyInspector/>);
    expect(html).toContain('4 primary / 10 compatible / 20 original calls');expect(html).toContain('singleton');
    expect(html).toContain('not replacement call edges');expect(html).not.toContain('membership ≥ 0.5');
  });
});
