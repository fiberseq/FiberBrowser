import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createRoot,type Root} from 'react-dom/client';
import {act} from 'react';
import {ConsensusComparison} from './ConsensusComparison';
import {ConsensusCrossEvidence} from './ConsensusCrossEvidence';
import {harmonizationControlVisible} from './ConsensusTools';
import {useConsensusViewStore} from '../../../stores/consensusViewStore';
import {useBrowserStore} from '../../../stores/browserStore';
import type {ConsensusCatalog,NativeComparisonRow,NativeCountSummary} from '../../../api/consensusWorkflow';

const counts:NativeCountSummary={covered_units:100,assigned_units:20,fraction:.2,lattice_capable_units:100,
  lattice_capable_fraction:1,mean_opportunities:5,physically_accessible_units:75,multiple_member_units:0,original_member_calls:20};
const base:NativeComparisonRow={family:'F1',interval:[20,30],resolution:'native_class',established:true,
  child_families:['F1'],comparison_kind:'assay',left_label:'d',right_label:'h',
  comparability:'lattice_comparable',agreement:'discordant_observed_fractions',difference:.3,absolute_difference:.3,
  left:counts,right:{...counts,assigned_units:50,fraction:.5,physically_accessible_units:10},reasons:[],semantics:'Native-only; not occupancy.'};
const rows=[base,{...base,family:'F2',interval:[40,50],child_families:['F2'],comparability:'not_comparable' as const,
  agreement:'similar_observed_fractions',difference:0,absolute_difference:0,reasons:['right_lattice_limited'],right:{...counts,lattice_capable_fraction:.1}},
  {...base,family:'XC',resolution:'coarse_any_child' as const,child_families:['F1','F2'],left:{...counts,multiple_member_units:4}},
  {...base,family:'S1',comparison_kind:'strand' as const,left_label:'d:CT',right_label:'d:GA'}];
const catalog:ConsensusCatalog={cr_mode:'call_harmonization',region:{chrom:'chr1',start:0,end:100},
  datasets:Object.fromEntries(['d','h'].map(d=>[d,{catalog:['F1','F2'].map(family=>({family,consensus_start:20,consensus_end:50})),comparability:[]}])),
  edges:[],comparison:{rows,options:{agreement_difference:.1},semantics:'Native only'}};
let container:HTMLDivElement,root:Root;
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
  useConsensusViewStore.setState({catalog,jobId:'j',selection:null,selections:[],loading:false,error:'',curationBusy:false,
    curation:{revision:0,catalog_digest:'frozen',operations:[],manual_groups:[],ignored_families:{},can_undo:false,can_redo:false}});
});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.restoreAllMocks();});
function render(){act(()=>root.render(<ConsensusComparison/>));}
function change(label:string,value:string){act(()=>{const select=container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}

it('shows comparable disagreement and non-comparable agreement independently',()=>{
  render();expect(container.textContent).toContain('Lattice comparable · Discordant fractions');
  expect(container.textContent).toContain('Not comparable · Similar fractions');
  expect(container.textContent).toContain('right lattice limited');
  expect(container.textContent).toContain('Upstream MSP/nucleosome masks can drive this count gap');
  expect(container.textContent).toContain('Within 150 bp of the analysis boundary');
  change('Lattice comparability filter','lattice_comparable');
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.textContent).toContain('Discordant fractions');
  change('Observed agreement filter','similar_observed_fractions');
  expect(container.querySelectorAll('article')).toHaveLength(0);
});

it('selects coarse children in one dataset through the shared manual-edit selection',()=>{
  const zoom=vi.spyOn(useBrowserStore.getState(),'setViewport').mockImplementation(()=>{});
  render();change('Comparison resolution','coarse_any_child');
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.textContent).toContain('multiple members: 4');
  act(()=>[...container.querySelectorAll('article button')].find(b=>b.textContent==='Inspect / select left classes')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  expect(useConsensusViewStore.getState().selections).toEqual(['F1','F2'].map(family=>({jobId:'j',datasetId:'d',family})));
  expect(zoom).toHaveBeenCalledWith('chr1',0,60);
  expect([...container.querySelectorAll('button')].find(b=>b.textContent==='Group selected')!.disabled).toBe(false);
});

it('switches to strand comparisons and labels manual evidence as frozen',()=>{
  render();change('Comparison kind','strand');expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.textContent).toContain('d:CT');expect(container.textContent).toContain('d:GA');
  act(()=>useConsensusViewStore.setState({curation:{...useConsensusViewStore.getState().curation!,operations:[{operation:'merge'}] as any,manual_groups:[{group_id:'manual'}] as any}}));
  expect(container.textContent).toContain('manual groups do not inherit automatic comparability flags');
  act(()=>useConsensusViewStore.setState({curation:{...useConsensusViewStore.getState().curation!,manual_groups:[]}}));
  expect(container.textContent).not.toContain('Manual display overrides are active');
});

it('does not invent Monte Carlo evidence for new links or expose fitted-engine controls',()=>{
  act(()=>root.render(<ConsensusCrossEvidence edge={{edge_id:'edge',left_family:'F1',right_family:'F1',left_interval:[20,30],right_interval:[20,30],status:'lattice_comparable',comparability_mask:true,comparison:base}}/>));
  expect(container.textContent).toContain('20/100');expect(container.textContent).toContain('50/100');
  expect(container.textContent).not.toContain('Full-model replacement');
  expect(harmonizationControlVisible('cr','harmonization_cut')).toBe(true);
  expect(harmonizationControlVisible('input','minimum_nfr_length')).toBe(true);
  expect(harmonizationControlVisible('cross','lattice_capable_fraction')).toBe(true);
  for(const [group,name] of [['cr','predictive_replicates'],['cross','native_reference_percent'],['rescue','enabled'],['split','enabled'],['compute','fit_backend']]){
    expect(harmonizationControlVisible(group,name)).toBe(false);
  }
});
