import type { MoleculeSampling, LoaderSampling } from '../utils/readDepth';
import { fetchJson } from './sharedFetch';
import { withSandboxParam } from '../utils/sandbox';
import type {ConsensusRecord} from '../utils/consensusVisual';

export type ConsensusMode = 'lattice_recaller' | 'staged_native_families' | 'call_harmonization' | 'native_family_distribution' | 'legacy_lattice';
/** Per chemical strand (CT, GA, pooled) numbers of one lattice-recaller class. */
export interface RecallerStrand {prevalence:number;prevalence_edge?:number;prevalence_loose?:number;prevalence_lower_bound:number;broader:number;other_shape:number;accessible:number;
  support_gain_nats:number|null;supported:boolean;resolution_nats:number;resolved:boolean;spots:string;L0:number;L1:number;R0:number;R1:number;
  molecules:number;unknown_accessible_fraction:number;efficiency:number|null;edge_contraction?:string}
export interface FamilyStage {id:string;label:string;seconds:number;families:number;original_calls:number;assignments:number}
export interface ClassificationCounts {
  original_calls:number; primary_calls:number; compatible_calls:number; eligible_units:number; primary_units:number;
  compatible_units?:number;
}
export interface FamilyEvidence {
  family?:string;native_loss?:number;floor_adjusted_loss?:number;
  predictive_tail?:number;predictive_tail_interval?:[number,number];
  core_protected_vs_accessible_log_lr?:number;mean_core_unobserved?:number;
  source_units?:number;scoring_fold?:number;geometry_distance_sq?:number;
  core_contradiction?:boolean; veto?:boolean|string; training_groups?:number;
  fit_converged?:boolean; status?:string; [key:string]:unknown;
  geometry_mass_overlapping_observed_call?:number;
  geometry_mass_allowed_by_frozen_neighbors?:number;
  physical_geometry_retention?:number;geometry_observed_mass_fraction?:number;
  observed_opportunities?:number;expected_core_opportunities?:number;
  simulations?:number;tail_exceedances?:number;
}
export interface ManualFamilyGroup {
  group_id:string;dataset_id:string;label:string;operation?:'merge'|'split'|'restore_subclasses';
  source_family_ids:string[];call_ids?:string[];[key:string]:unknown;
}
export interface ConsensusCuration {
  revision:number;catalog_digest:string;can_undo:boolean;can_redo:boolean;
  operations:Record<string,unknown>[];manual_groups:ManualFamilyGroup[];
  ignored_families:Record<string,string[]>;
}
export interface CurationOperation {
  operation:'merge'|'split'|'restore_subclasses'|'ignore'|'unignore'|'undo'|'redo'|'reset';
  dataset_id?:string;family_ids?:string[];label?:string;
  split?:{by:'length'|'start'|'end';threshold:number}|{by:'call_ids';call_ids:string[]};
  subclass_ids?:string[];
}

export type Parameters = Record<string, Record<string, boolean | number | string>>;
export interface ParameterControl {
  name: string; label: string; help: string; type: 'bool' | 'float' | 'int' | 'str';
  default: boolean | number | string; minimum: number | null; maximum: number | null;
  step: number | null; choices: string[] | null;
}
export interface DisplayFilters {
  classification_reference_percent?:number;
  minimum_model_q: number;
  minimum_rescue_model_q?: number;
  minimum_comparability_q: number;
  require_population_comparable: boolean;
  require_molecule_comparable: boolean;
  require_cross_comparable: boolean;
  show_quality_outlines: boolean;
  /** Footprint-class calls at native call edges (default), the recaller's lattice edges, or class consensus edges. */
  recaller_edges?: 'native' | 'lattice' | 'class';
  /** Per class: strict (core), + one edge ('edge') or any overlapping shape ('loose'). */
  recaller_class_tiers?: Record<string, string>;
}
export interface ConsensusSchema {
  cr_mode?:ConsensusMode;
  schema: string; groups: Record<string, ParameterControl[]>;
  runtime?: {workflow_path:string;source_root:string};
  layers: Record<string, [string, string]>; display_defaults: DisplayFilters;
}
export interface ConsensusRequest {
  frozen_job_id?: string;
  region_windows?: import('../utils/regionAnalysis').AnalysisWindow[];
  dataset_ids: string[]; chemistry_overrides: Record<string, string>;
  chrom: string; start: number; end: number; parameters: Parameters;
  /** 'group.name' of the parameters the user set (the rest are defaults), e.g. 'input.ddda_m5c_correction'. */
  explicit_parameters?: string[];
  /** Where the region came from (utils/classRegion.ts: 'peaks', 'view', 'region', 'custom') and in words
   *  ("the selected peak"): recorded with the run so its results can say what was analysed. */
  region_source?: string;
  region_label?: string;
}
export interface ConsensusJob {
  stages?:FamilyStage[];view_stage?:string;final_stage?:string;
  checkpoints?:{directory:string;hits:Record<string,number>;misses:Record<string,number>;exact_reuse:boolean};
  cr_mode?:ConsensusMode;
  job_id: string; status: 'queued' | 'running' | 'cancelling' | 'complete' | 'cancelled' | 'error';
  stage: string; message: string; created_at: number; updated_at?: number; finished_at?: number;
  started_at?:number;
  progress?:{stage:string;task:string;dataset_id?:string|null;completed:number|null;total:number|null;
    fraction:number|null;unit?:string|null;detail?:string|null;stage_started_at:number;semantics:string};
  request: ConsensusRequest; filters: DisplayFilters; artifact_dir: string;
  /** What the run skipped and why (e.g. DddA mCG conditioning on a BigBed dataset). */
  warnings?: string[];
  molecule_sampling?: MoleculeSampling[];
  loader_sampling?: LoaderSampling[];
  layers?: string[];
  summary?: Record<string, {units: number; sr_changed: number; classes: number; assignments: number;
    source_calls?:number; source_calls_in_region?:number; boundary_crossing_calls?:number; outside_region_calls?:number; unclassified_calls?:number;
    native_catalog_update?:NativeCatalogUpdate|null;
    rescued: number; split_spans: number; statuses: Record<string, string>; numerical_fit?: ConsensusFitSummary;
    population_rescue?: {model: string; source_models: number; provisional_source_models: number;
      minimum_source_ess: number; maximum_source_rhat: number; retained_additions: number} | null}>;
  cross_summary?: {counts?: Record<string, number>; comparable_edges?: number; status: string;
    parameters?:{reference_percent?:number;predictive_replicates?:number;[key:string]:unknown};
    count_group_statuses?: Record<string, number>};
}
export interface ConsensusFitSummary {
  status: 'unreported' | 'converged' | 'numerically_provisional';
  selected_converged: boolean | null; starts: number;
  converged_starts?: number; all_starts_converged?: boolean;
  iterations?: number; max_projected_gradient?: number; optimizer_message?: string;
}
export interface CorrespondenceCounts {
  families: string[]; eligible_units: number; assigned_units: number | null; fraction: number | null;
  native_assigned_units: number | null; native_fraction: number | null; multiple_member_units: number;
  member_counts: {family: string; assigned_units: number}[];
  denominator: string; endpoint: string; status: string;
  group_event_mass_computed?: boolean;
  native_group_event_mass_computed?: boolean;
  native_endpoint?: string;
  native_current_endpoints_match?: boolean;
  per_member_threshold_assigned_units?: number | null;
  canonical_core_eligible_units?: number;
  canonical_core_assigned_units?: number | null;
  canonical_core_fraction?: number | null;
  assigned_without_testable_canonical_core?: number;
  union_eligible_units?: number;
  union_eligible_assigned_units?: number | null;
  union_eligible_fraction?: number | null;
  by_strand?: Record<string, {
    eligible_units: number; assigned_units: number | null; fraction: number | null;
    native_assigned_units: number | null; native_fraction: number | null;
    canonical_core_eligible_units?: number; canonical_core_assigned_units?: number | null;
    canonical_core_fraction?: number | null; assigned_without_testable_canonical_core?: number;
    union_eligible_units?: number; union_eligible_assigned_units?: number | null;
    union_eligible_fraction?: number | null;
  }>;
  stratum_semantics?: string;
}
export interface LegacyCorrespondenceCountGroup {
  group_id: string; left_dataset: string; right_dataset: string;
  left_families: string[]; right_families: string[]; edge_ids: string[];
  native_intervals: Record<string, number[]>;
  kind: 'one_to_one' | 'coarse_union' | 'unresolved_mapping'; status: string; reasons: string[];
  membership_threshold: number; left_counts?: CorrespondenceCounts; right_counts?: CorrespondenceCounts;
  quantification_equivalence_established: boolean; molecule_detection_power_established: boolean;
  unrepresented_recurrent_overlap?: boolean;
  individual_target_roles_established?: boolean;
  omitted_overlapping_native_families?: Record<string, {family:string;interval:number[];per_member_threshold_assignments:number;recurrent:boolean}[]>;
}
export interface NativeCorrespondenceCountSummary {
  eligible_units:number; assigned_units:number; fraction:number|null;
  all_member_units:number; all_member_fraction:number|null;
  multiple_member_units:number; original_member_calls:number;
  opportunity_bearing_units:number; opportunity_bearing_assigned_units:number;
  assigned_without_span_coverage:number; member_counts:Record<string,number>;
  descriptive_unit_wilson_interval?:[number,number]|null;
}
export interface NativeCorrespondenceCounts extends NativeCorrespondenceCountSummary {
  families:string[]; comparison_span:[number,number]; endpoint:string;
  alternate_endpoint:string; denominator:string; classification_reference_percent:number;
  by_strand:Record<string,NativeCorrespondenceCountSummary>;
  repeated_groups_collapsed:number; unresolved_mixed_groups:number;
  calibrated_occupancy:false; equal_detection_power_established:false;
  interval_semantics?:string;
}
export interface NativeCorrespondenceCountGroup {
  group_id:string; left_dataset:string; right_dataset:string;
  left_families:string[]; right_families:string[]; edge_ids:string[];
  native_intervals:Record<string,number[]>; comparison_span:[number,number];
  kind:'one_to_one'|'alternative_class_union'|'cooccurring_fragments_or_states';
  status:'descriptive_native_call_events';
  left_counts:NativeCorrespondenceCounts; right_counts:NativeCorrespondenceCounts;
  merged_interval:null; span_is_only_counting_denominator:true;
  complete_bipartite:true; native_models_changed:false; transitive_union:false;
  overlaps_other_count_groups:boolean; groups_form_a_partition:false;
  counts_must_not_be_summed_across_groups:true; event_equivalence_established:false;
  fragmentation_resolved:false|null; rate_agreement_used_for_selection:false;
  rescued_calls_used:false; caution:string;
}
export type CorrespondenceCountGroup=LegacyCorrespondenceCountGroup|NativeCorrespondenceCountGroup;
export interface CrossDirectionEvidence {
  native_effective_support: number;
  testable_native_mass_fraction: number;
  acceptable_native_mass_fraction: number;
  native_shape_preferred_mass_fraction: number;
  foreign_shape_preferred_mass_fraction: number;
  untestable_mass_fraction: number;
}
export interface CrossJointEvidence {
  status: string; reason?: string;
  retained_native_mass_fraction: number | null;
  retained_target_inclusion_fraction?: number | null;
  jointly_retained_target_mass_fraction?: number | null;
}
export interface ConsensusCrossEdge {
  shared_hypothesis?:boolean;
  comparison?: NativeComparisonRow;
  left_dataset?:string;right_dataset?:string;
  edge_id: string; left_family: string; right_family: string; left_interval: number[];
  right_interval: number[]; status: string; comparability_mask: boolean;
  count_group_id?: string; count_comparison?: string;
  individual_count_comparison_unambiguous?: boolean;
  forward?: CrossDirectionEvidence|null; reverse?: CrossDirectionEvidence|null;
  native_family_evidence?:Record<string,NativeFamilyDirection>;
  compatibility_depends_on_monte_carlo_uncertainty?:boolean;
  joint_left?: CrossJointEvidence; joint_right?: CrossJointEvidence; joint_status?: string;
  target_role_comparability_mask?: boolean;
}
export interface NativeFamilyDirection {
  recipient_dataset?:string;recipient_strand?:string;n_source_calls:number;n_scored:number;n_compatible:number;
  compatible_fraction:number|null;median_predictive_tail:number|null;untestable_calls:number;contradicted_calls:number;
  reason_counts:Record<string,number>;
  n_testable?:number;source_coverage_fraction?:number|null;
  n_compatible_mc_clear?:number;n_compatible_mc_borderline?:number;
  compatible_mc_clear_fraction?:number|null;
  by_strand?:Record<string,NativeFamilyDirection>;
}
export interface ConsensusFamily {
  edge_uncertainty?:{left:[number,number];right:[number,number]}|null;
  physical_edge_support?:[[number,number],[number,number]]|null;
  hypothesis?:Record<string,unknown>;stage?:string;shared_scope?:string;
  recaller?:Record<string,RecallerStrand>;
  /** Lattice recaller with the read-order check (recaller.order_replicates > 0): the fraction of the read orders that
   * found this class supported, and whether that reaches recaller.order_robust_fraction. Absent otherwise. */
  order_robustness?:number;robust?:boolean;
  superseded_by_manual?:boolean;
  family:string;consensus_start:number;consensus_end:number;
  classification_counts?:Record<string,ClassificationCounts>;fit_flags?:string[]|Record<string,unknown>;
  manual?:boolean;manual_group_id?:string;source_family_ids?:string[];effective_call_ids?:string[];label?:string;
  ignored?:boolean;display_summary_only?:boolean;display_start?:number;display_end?:number;
  evidence_summary?:Record<string,unknown>;
  model_status?:string;source_units?:number;fit_diagnostics?:Record<string,unknown>;
  native_fit_center?:number[];native_fit_covariance?:number[][];
  model_provenance?:NativeModelOrigin|null;
  subclass_candidates?:{family:string;consensus_start:number;consensus_end:number;primary_calls:number;
    compatible_calls:number;member_calls:number;direct_parent:boolean}[];
  rates_by_strand?:Record<string,{eligible_units:number;native_assignments:number;after_sr_assignments:number;after_recall_assignments?:number}>;
}
export interface NativeModelOrigin {
  origin:string;
  model_version_sha256?:string;
  producer_snapshot_digest?:string;
}
export interface NativeCatalogUpdate {
  policy:string;
  original_family_count?:number;
  added_family_count?:number;
  initial_snapshot_digest?:string;
  augmented_snapshot_digest?:string;
}
/** The read-order check of a lattice-recaller run (manifest recaller.order_robustness). */
export interface RecallerRobustness {
  orderings:number;replicates:number;robust_fraction?:number;rule?:string;matching?:string;
  supported_per_ordering?:number[];discovered_per_ordering?:number[];robust_classes?:string[];seconds?:number;
}
export interface ConsensusCatalog {
  region_sources?: Record<string, { dataset_id: string; window: { chrom: string; start: number; end: number; strand: '+' | '-' }; coordinate_origin: number }>;
  robustness?:RecallerRobustness|null;
  stages?:FamilyStage[];view_stage?:string;final_stage?:string;curation_read_only?:boolean;
  curation_scope?:string|null;
  comparison?: {rows:NativeComparisonRow[];options:Record<string,number>;semantics:string};
  cr_mode?:ConsensusMode;
  region?: {chrom:string;start:number;end:number};
  datasets: Record<string, {catalog:ConsensusFamily[];curated_display_families?:(Omit<ConsensusFamily,'consensus_start'|'consensus_end'>&{consensus_start?:number;consensus_end?:number})[];
    native_catalog_update?:NativeCatalogUpdate|null;
    comparability: {family: string; comparative_Q_model: number | null; status: string}[];
    rescue_rates?: {probability_threshold: number; baseline_probability_threshold: number; denominator: string;
      by_family: Record<string,Record<string,{baseline_units:number;added_units:number;combined_units:number;all_units:number}>>} | null}>;
  edges: ConsensusCrossEdge[];
  count_groups?: CorrespondenceCountGroup[];
  count_semantics?: string | null;
}
export interface NativeCountSummary {
  covered_units:number;assigned_units:number;fraction:number|null;
  lattice_capable_units:number;lattice_capable_fraction:number|null;
  capable_assigned_units:number;capable_fraction:number|null;
  physically_accessible_units:number;multiple_member_units:number;
  mean_opportunities:number|null;mean_ceiling:number|null;fraction_interval:[number,number]|null;
}
export interface NativeComparisonRow {
  established?:boolean;
  geometry_basis?:string;anchor_assay?:string;child_intervals?:Record<string,number[]>;
  family:string;interval:[number,number];resolution:'native_class'|'coarse_any_child';
  child_families:string[];comparison_kind:'assay'|'strand';left_label:string;right_label:string;
  comparability:'lattice_comparable'|'not_comparable';reasons:string[];
  agreement:string;difference:number|null;absolute_difference:number|null;
  left:NativeCountSummary;right:NativeCountSummary;group_kind?:string;semantics:string;
}
export interface NativeCatalogEdgeTransport {
  link_id:string;datasets:[string,string];families:Record<string,string>;
  native_intervals:Record<string,number[]>;status:string;comparable:boolean;
  merged_interval:null;native_family_evidence:Record<string,NativeFamilyDirection>;
  compatibility_depends_on_monte_carlo_uncertainty?:boolean;
}
export type ConsensusCatalogTransport=Omit<ConsensusCatalog,'edges'>&{
  edges:(ConsensusCrossEdge|NativeCatalogEdgeTransport)[];
};
/** Lossless presentation aliases for native atomic graph rows. Native IDs,
 * endpoints and evidence remain authoritative; no matching or interval merging.
 */
export function normalizeConsensusCatalog(catalog:ConsensusCatalogTransport):ConsensusCatalog {
  return {...catalog,edges:catalog.edges.map(edge=>{
    if(!('link_id' in edge))return edge;
    const [left,right]=edge.datasets??[];
    const validInterval=(value:number[]|undefined)=>!!value&&value.length===2
      &&value.every(Number.isFinite)&&value[1]>value[0];
    if(!left||!right||left===right||edge.datasets.length!==2||!edge.families[left]||!edge.families[right]
      ||!validInterval(edge.native_intervals[left])||!validInterval(edge.native_intervals[right])
      ||typeof edge.comparable!=='boolean'||edge.merged_interval!==null){
      throw new Error(`Invalid native atomic catalog edge ${edge.link_id}; no display geometry inferred`);
    }
    return {...edge,edge_id:edge.link_id,left_dataset:left,right_dataset:right,
      left_family:edge.families[left],right_family:edge.families[right],
      left_interval:edge.native_intervals[left],right_interval:edge.native_intervals[right],
      comparability_mask:edge.comparable,forward:null,reverse:null};
  })};
}
export interface NativeLatticeRead {
  positions:number[];hits:number[];p_accessible:number[];p_protected:number[];strand:string;
  conflicting_observations_omitted:number;
}
export interface NativeLatticeResponse {
  chrom:string;start:number;end:number;dataset_id:string;chemistry:string;
  reads:Record<string,NativeLatticeRead>;unavailable_read_ids:string[];ambiguous_read_ids?:string[];probability_threshold:number|null;
}
export const getNativeLattice=(request:{dataset_id:string;chrom:string;start:number;end:number;read_ids:string[];
  read_identities?:Record<string,{library_id?:string;reference_start?:number;reference_end?:number;alignment_orientation?:string}>;
  chemistry?:string},signal?:AbortSignal)=>
  fetchJson<NativeLatticeResponse>('/api/footprint/consensus/lattice',{...post(request),signal});
const base = '/api/footprint/consensus';
const post = (value: unknown): RequestInit => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
export const getConsensusSchema = () => fetchJson<ConsensusSchema>(`${base}/schema`);
export const getConsensusJobs = () => fetchJson<{active_job: string | null; jobs: ConsensusJob[]}>(`${base}/jobs`);
export const startConsensus = (request: ConsensusRequest) => fetchJson<ConsensusJob>(`${base}/jobs`, post(request));
export const getConsensusJob = (id: string) => fetchJson<ConsensusJob>(`${base}/jobs/${encodeURIComponent(id)}`);
export const cancelConsensus = (id: string) => fetchJson<ConsensusJob>(`${base}/jobs/${encodeURIComponent(id)}`, {method: 'DELETE'});
export const filterConsensus = (id: string, filters: DisplayFilters) => fetchJson<ConsensusJob>(`${base}/jobs/${encodeURIComponent(id)}/filters`, post(filters));
export const selectConsensusStage = (id:string,stage:string) => fetchJson<ConsensusJob>(`${base}/jobs/${encodeURIComponent(id)}/stage`,post({stage}));
export const getConsensusCatalog = async(id:string) => normalizeConsensusCatalog(await fetchJson<ConsensusCatalogTransport>(`${base}/jobs/${encodeURIComponent(id)}/catalog`));
export const getConsensusCall = (id:string,datasetId:string,sourceCallId:string,signal?:AbortSignal)=>
  fetchJson<{job_id:string;dataset_id:string;source_call_id:string;call:ConsensusRecord}>(`${base}/jobs/${encodeURIComponent(id)}/call?${new URLSearchParams({dataset_id:datasetId,source_call_id:sourceCallId})}`,{signal});
export const getConsensusStateReads = (id:string,datasetId:string,familyId:string,signal?:AbortSignal,stage?:string|null,strand?:string|null,tier?:string|null)=>
  fetchJson<{job_id:string;dataset_id:string;family_id:string;read_ids:string[];matching_units:number;semantics:string}>(`${base}/jobs/${encodeURIComponent(id)}/state-reads?${new URLSearchParams({dataset_id:datasetId,family_id:familyId,...(stage?{stage}:{}),...(strand?{strand}:{}),...(tier?{tier}:{})})}`,{signal});
export const getConsensusCuration = (id:string) => fetchJson<ConsensusCuration>(`${base}/jobs/${encodeURIComponent(id)}/curation`);
export const updateConsensusCuration = (id:string,expected_revision:number,operation:CurationOperation) =>
  fetchJson<ConsensusCuration>(`${base}/jobs/${encodeURIComponent(id)}/curation`,post({expected_revision,...operation}));
export const consensusExportUrl = (id: string) => withSandboxParam(`${base}/jobs/${encodeURIComponent(id)}/export`);
export const activateConsensus = (id:string) => fetchJson<ConsensusJob>(`${base}/jobs/${encodeURIComponent(id)}/activate`,post({}));
export function importConsensus(file:File) {
  const body=new FormData();body.append('file',file);
  return fetchJson<ConsensusJob>(`${base}/import`,{method:'POST',body});
}

export interface ConsensusBamExport {
  outputs: {dataset_id:string;inputs:string[];bam:string;index:string;annotations:number;matched_alignments:number}[];
  grouping:'datasets'|'files';
}
export const exportConsensusBams=(id:string,output_dir:string,grouping:'datasets'|'files',scope:'regions'|'full'='regions') =>
  fetchJson<ConsensusBamExport>(`${base}/jobs/${encodeURIComponent(id)}/bam-export`,post({output_dir,grouping,scope}));
