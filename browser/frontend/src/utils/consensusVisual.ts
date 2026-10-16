/** Native geometry is immutable. These helpers only choose visual provenance. */
import type {FamilyEvidence} from '../api/consensusWorkflow';
export interface ConsensusRecord {
  interval: [number,number]; kind: string; family?: string | null;
  model_membership?: number; native_log_lr?: number; opportunities?: number; hits?: number;
  provenance?: string; information_status?: string; numerical_provisional?: boolean;
  population_assisted_probability?: number; prior_only_family_inclusion?: number;
  native_equal_activity_log_bf?: number; recipient_integrated_log_bf?: number;
  source_expected_units?: number; source_activity_sd?: number; recipient_parameter_ESS?: number;
  cross_comparable?: boolean;
  shared_hypothesis?: boolean;
  comparability?: {comparative_Q_model: number | null; status: string;
    population_quantification_mask?: Record<string,boolean>} | null;
  links?: {status?:string;comparability_mask?:boolean;comparable?:boolean;link_id?:string;
    source_call_id?:string;receiving_family?:string;other_families?:string[];
    recipient_evidence?:FamilyEvidence}[];
  source_call_id?:string;source_ordinal?:number;original_interval?:[number,number];
  compatible_alternatives?:(string|FamilyEvidence)[];primary_evidence?:FamilyEvidence|null;
  candidate_evidence?:FamilyEvidence[];
  native_cross_tests?:unknown[]|Record<string,unknown>;
  manual?:boolean;manual_group_id?:string;manual_label?:string;automatic_family?:string;source_family_ids?:string[];
  manual_ignored?:boolean;automatic_primary_evidence?:FamilyEvidence|null;
  cr_mode?:'lattice_recaller'|'staged_native_families'|'call_harmonization'|'native_family_distribution'|'legacy_lattice';
  family_evidence?:Record<string,unknown>;
  classification_status?:string;
}

const COLORS=['#d88724','#497fc5','#9566bb','#28a88f','#c35b93','#6b9b2c','#b26345','#5da6bd',
  '#cbb12a','#7362b9','#dc7168','#428d73','#a767a0','#707da6','#b48c55','#729e9e'];
let catalogColors=new Map<string,string>();
/** Allocate once across the completed catalog, never by the current viewport. */
export function setConsensusPalette(ids:string[]):void {
  catalogColors=new Map([...new Set(ids)].sort().map((id,i)=>[id,
    COLORS[i]??`hsl(${((i-COLORS.length)*137.508)%360} 62% ${42+((i-COLORS.length)%3)*8}%)`]));
}
export function consensusFamilyColor(id:string):string {
  const assigned=catalogColors.get(id);if(assigned)return assigned;
  let h=2166136261;for(let i=0;i<id.length;i++)h=Math.imul(h^id.charCodeAt(i),16777619);
  return COLORS[(h>>>0)%COLORS.length];
}
/** Every compatible family is a label possibility, not a fractional occupancy. */
export function consensusRecordFamilies(r:ConsensusRecord):string[]{
  if(r.classification_status==='provisional_unresolved'||r.manual_ignored)return [];
  return [...new Set([r.manual_group_id??r.family,...(r.compatible_alternatives??[]).map(v=>typeof v==='string'?v:v.family)]
    .filter((v):v is string=>typeof v==='string'&&v.length>0))];
}
/** The single best-fit display assignment. Compatible alternatives remain in
 * the evidence inspector, but never replace or stripe the molecular call. */
export function consensusPrimaryFamily(r:ConsensusRecord):string|null{
  if(r.classification_status==='provisional_unresolved'||r.manual_ignored||r.classification_status==='manual_ignored')return null;
  return r.manual_group_id??r.family??null;
}
export function consensusRecordColor(r:ConsensusRecord):string {
  if(r.manual_ignored||r.classification_status==='manual_ignored')return '#94a3b8';
  if(r.manual_group_id)return consensusFamilyColor(r.manual_group_id);
  if(r.classification_status==='provisional_unresolved')return '#9ba6ae';
  // Once a call has a best-fit state, that assignment is its display color.
  // Provenance/kind remains available through outlines and the inspector.
  if(r.family)return consensusFamilyColor(r.family);
  if(r.kind==='recaller_broader')return '#b4bec8';
  if(r.kind==='new_recall')return '#db2777';
  if(r.kind==='internal_accessible_separator')return '#e9a123';
  if(['projection_equivalent_normalization','likelihood_compatible_edge_change'].includes(r.kind))return '#8b5cf6';
  return r.kind==='alternative_protected_piece'?'#328b7b':'#9ba6ae';
}
export function consensusOutline(r:ConsensusRecord):{color:string;dashed:boolean}|null {
  if(r.manual||r.manual_group_id)return {color:'#7c3aed',dashed:true};
  if(r.provenance==='population_assisted_new_call') {
    if(r.numerical_provisional)return {color:'#8d6b95',dashed:true};
    if(r.information_status==='weak_population_assisted')return {color:'#b47a23',dashed:true};
    return {color:'#692d4c',dashed:false};
  }
  if(r.kind==='xcr') {
    if(r.cr_mode==='staged_native_families'&&r.shared_hypothesis)return {color:'#5269a8',dashed:false};
    if(r.cross_comparable)return {color:'#00a8bb',dashed:false};
    if(r.links?.some(e=>e.status==='shape_disagreement'||e.recipient_evidence?.status==='core_contradicted'))return {color:'#d04b43',dashed:false};
    return {color:'#d49a24',dashed:true};
  }
  if(!r.comparability)return null;
  const q=r.comparability.comparative_Q_model;
  if(q==null)return {color:'#89939d',dashed:true};
  return {color:q>=20?'#175c43':q>=10?'#00a8bb':q>=3?'#d49a24':'#d04b43',dashed:false};
}

export function consensusRecordSummary(r:ConsensusRecord):string{
  if(r.cr_mode==='call_harmonization'&&!r.manual){
    return `${r.family??'Unclassified native call'} · native-call harmonization; no new detection`
      +`${r.kind==='xcr'?r.cross_comparable?' · lattice comparable':' · comparison limited':''}`;
  }
  if(r.primary_evidence||r.cr_mode==='native_family_distribution'||r.cr_mode==='staged_native_families'||r.cr_mode==='lattice_recaller'||r.manual){
    const e=r.primary_evidence;
    const alternatives=(r.compatible_alternatives??[]).map(a=>typeof a==='string'?a:a.family??'unidentified');
    return `${r.manual_label??r.family??r.kind}${r.manual||r.manual_group_id?' · MANUAL (automatic evidence unchanged)':''}`
      +`${r.manual_ignored?' · ignored in manual view (not evidence of accessibility)':''}`
      +`${r.shared_hypothesis?' · shared fitted family; quantitative comparability not assessed':''}`
      +`${r.automatic_family?` · automatic family ${r.automatic_family}`:''}`
      +`${r.source_call_id?` · source ${r.source_call_id}`:''}${r.source_ordinal!=null?` · call #${r.source_ordinal}`:''}`
      +`${e?.native_loss!=null?` · native loss=${e.native_loss.toFixed(2)}`:''}${e?.floor_adjusted_loss!=null?` · floor-adjusted loss=${e.floor_adjusted_loss.toFixed(2)}`:''}`
      +`${e?.predictive_tail!=null?` · predictive tail=${e.predictive_tail.toPrecision(3)}`:''}`
      +`${e?.predictive_tail_interval?` [MC ${e.predictive_tail_interval[0].toPrecision(3)}, ${e.predictive_tail_interval[1].toPrecision(3)}]`:''}`
      +`${e?.core_protected_vs_accessible_log_lr!=null?` · core protected/access. logLR=${e.core_protected_vs_accessible_log_lr.toFixed(2)}`:''}`
      +`${e?.source_units!=null?` · ${e.source_units} source units`:''}${e?.scoring_fold!=null?` · fold ${e.scoring_fold}`:''}`
      +`${r.classification_status==='provisional_unresolved'?' · unresolved (not a supported family)':''}`
      +`${e?.veto||e?.core_contradiction?' · core veto':''}${e?.fit_converged===false?' · fit NOT converged':''}`
      +`${alternatives.length?` · compatible alternatives: ${alternatives.join(', ')}`:''}`;
  }
  return `${r.family??r.kind}${r.model_membership!=null?` P=${r.model_membership.toFixed(3)}`:''}${r.provenance==='population_assisted_new_call'?` · source prior=${r.prior_only_family_inclusion?.toFixed(3)??'NA'} · ${r.opportunities??0} opportunities/${r.hits??0} hits · native logBF=${r.native_equal_activity_log_bf?.toFixed(2)??'NA'}${r.numerical_provisional?' · numerical caution':''}`:''}${r.comparability?` CQ=${r.comparability.comparative_Q_model?.toFixed(1)??'NA'}`:''}`;
}
