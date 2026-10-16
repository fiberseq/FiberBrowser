import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsensusCountGroups } from './ConsensusCountGroups';
import type { CorrespondenceCountGroup, CorrespondenceCounts, NativeCorrespondenceCountGroup,
  NativeCorrespondenceCountSummary, NativeCorrespondenceCounts } from '../../../api/consensusWorkflow';

const counts: CorrespondenceCounts={families:['d:A','d:B'],eligible_units:91,assigned_units:33,
  fraction:33/91,native_assigned_units:31,native_fraction:31/91,multiple_member_units:2,
  member_counts:[{family:'d:A',assigned_units:4},{family:'d:B',assigned_units:31}],
  denominator:'common eligibility',endpoint:'any selected member',status:'descriptive'};
const group: CorrespondenceCountGroup={group_id:'XG_a',left_dataset:'DddA',right_dataset:'Hia5',
  left_families:['d:A','d:B'],right_families:['h:A'],edge_ids:['e1','e2'],
  native_intervals:{'d:A':[100,125],'d:B':[110,140],'h:A':[102,138]},
  kind:'coarse_union',status:'descriptive_counts',reasons:[],membership_threshold:.5,
  left_counts:counts,right_counts:{...counts,families:['h:A']},
  quantification_equivalence_established:false,molecule_detection_power_established:false};

describe('XCR descriptive count endpoints',()=>{
  it('shows the union endpoint, denominator and limitations without adding member counts',()=>{
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[group]}/>);
    expect(html).toContain('Coarse ANY-member union');
    expect(html).toContain('33 / 91 assigned (36.3%)');
    expect(html).not.toContain('35 / 91');
    expect(html).toContain('counted once');
    expect(html).toContain('excluding new rescue calls');
    expect(html).toContain('does not establish equal detection power');
  });
  it('does not display counts on an unresolved correspondence chain',()=>{
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...group,kind:'unresolved_mapping',
      reasons:['nonrectangular_correspondence']}]}/>);
    expect(html).toContain('Unresolved mapping');
    expect(html).toContain('No grouped rate is reported');
    expect(html).not.toContain('33 / 91');
  });
  it('distinguishes no common eligibility from an observed zero',()=>{
    const empty={...counts,eligible_units:0,assigned_units:null,fraction:null,native_assigned_units:null};
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...group,left_counts:empty}]}/>);
    expect(html).toContain('unavailable — no common eligible units');
    expect(html).not.toContain('0 / 0');
  });
  it('filters by a member or native coordinate and permits older catalogs with no groups',()=>{
    expect(renderToStaticMarkup(<ConsensusCountGroups groups={[group]} search="d:B"/>)).toContain('XCR count endpoints');
    expect(renderToStaticMarkup(<ConsensusCountGroups groups={[group]} search="140"/>)).toContain('XCR count endpoints');
    expect(renderToStaticMarkup(<ConsensusCountGroups groups={[group]} search="absent"/>)).toBe('');
    expect(renderToStaticMarkup(<ConsensusCountGroups groups={[]}/>)).toBe('');
  });
  it('exposes flank-only eligibility and exact group versus per-member counting',()=>{
    const repaired={...counts,group_event_mass_computed:true,per_member_threshold_assigned_units:0,
      canonical_core_eligible_units:0,canonical_core_assigned_units:null,canonical_core_fraction:null,
      assigned_without_testable_canonical_core:33};
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...group,left_counts:repaired,unrepresented_recurrent_overlap:true}]}/>);
    expect(html).toContain('Canonical-core eligible: 0');
    expect(html).toContain('33 assignments rely on an edge variant');
    expect(html).toContain('Exact ANY-member inclusion');
    expect(html).toContain('separately thresholding each member would count 0');
    expect(html).toContain('not an unambiguous quantitative identity');
    expect(html).not.toContain('0 / 0');
  });
  it('shows chemical strata without calling an untestable stratum an observed zero',()=>{
    const split={...counts,by_strand:{
      CT:{eligible_units:91,assigned_units:33,fraction:33/91,native_assigned_units:31,native_fraction:31/91},
      GA:{eligible_units:0,assigned_units:null,fraction:null,native_assigned_units:null,native_fraction:null},
    }};
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...group,left_counts:split}]}/>);
    expect(html).toContain('pooling can conceal unequal resolution');
    expect(html).toContain('CT: 33 / 91 assigned (36.3%)');
    expect(html).toContain('before SR 31 / 91');
    expect(html).toContain('GA: not testable — no eligible units');
    expect(html).not.toContain('GA: 0 / 0');
    expect(html).toContain('Strand rates alone do not establish detection power');
  });
  it('warns when an older baseline lacks the exact group event endpoint',()=>{
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...group,left_counts:{...counts,native_current_endpoints_match:false}}]}/>);
    expect(html).toContain('before/after counts are not directly comparable');
  });
});

const nativeSummary:NativeCorrespondenceCountSummary={eligible_units:91,assigned_units:33,fraction:33/91,
  all_member_units:2,all_member_fraction:2/91,multiple_member_units:2,original_member_calls:38,
  opportunity_bearing_units:89,opportunity_bearing_assigned_units:33,assigned_without_span_coverage:3,
  member_counts:{'d:A':4,'d:B':31}};
const nativeCounts:NativeCorrespondenceCounts={...nativeSummary,families:['d:A','d:B'],
  comparison_span:[100,140],endpoint:'ANY listed native primary class on an evidence group',
  alternate_endpoint:'ALL listed native primary classes on the same evidence group',
  denominator:'complete aligned-block coverage of the same cross-dataset comparison span',
  classification_reference_percent:99.9,by_strand:{CT:nativeSummary},repeated_groups_collapsed:3,
  unresolved_mixed_groups:0,calibrated_occupancy:false,equal_detection_power_established:false};
const nativeGroup:NativeCorrespondenceCountGroup={group_id:'NXG_a',left_dataset:'DddA',right_dataset:'Hia5',
  left_families:['d:A','d:B'],right_families:['h:A'],edge_ids:['e1','e2'],
  native_intervals:{'d:A':[100,125],'d:B':[110,140],'h:A':[102,138]},comparison_span:[100,140],
  kind:'cooccurring_fragments_or_states',status:'descriptive_native_call_events',
  left_counts:nativeCounts,right_counts:{...nativeCounts,families:['h:A'],member_counts:{'h:A':33},
    by_strand:{pooled:{...nativeSummary,member_counts:{'h:A':33},all_member_units:33,all_member_fraction:33/91}}},
  merged_interval:null,span_is_only_counting_denominator:true,complete_bipartite:true,
  native_models_changed:false,transitive_union:false,overlaps_other_count_groups:true,
  groups_form_a_partition:false,counts_must_not_be_summed_across_groups:true,
  event_equivalence_established:false,fragmentation_resolved:false,
  rate_agreement_used_for_selection:false,rescued_calls_used:false,caution:'ANY is not ALL'};

describe('native XCR descriptive count events',()=>{
  it('shows distinct ANY and ALL events with the same aligned-block denominator',()=>{
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[nativeGroup]}/>);
    expect(html).toContain('Co-occurring fragments or states');
    expect(html).toContain('<strong>ANY</strong>: 33 / 91 evidence groups (36.3%)');
    expect(html).toContain('<strong>ALL</strong>: 2 / 91 evidence groups (2.2%)');
    expect(html).toContain('complete aligned-block coverage');
    expect(html).toContain('same comparison span');
    expect(html).toContain('100–140');
    expect(html).toContain('not a merged footprint');
    expect(html).toContain('do not sum counts across groups');
    expect(html).toContain('Neither occupancy, event equivalence, nor resolved fragmentation');
    expect(html).not.toContain('before SR');
    expect(html).not.toContain('After SR');
    expect(html).not.toContain('fixed membership');
    expect(html).not.toContain('undefined');
  });
  it('uses native reference, dictionary member counts, and separate CT/GA or pooled strata',()=>{
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...nativeGroup,
      left_counts:{...nativeCounts,by_strand:{CT:nativeSummary,GA:{...nativeSummary,eligible_units:20,
        assigned_units:0,fraction:0,all_member_units:0,all_member_fraction:0,multiple_member_units:0}}}}]}/>);
    expect(html).toContain('Recorded classification reference: 99.9%');
    expect(html).toContain('excluding new rescue calls');
    expect(html).toContain('d:A: 4 / 91 covering groups');
    expect(html).toContain('d:B: 31 / 91 covering groups');
    expect(html).toContain('CT');expect(html).toContain('GA');expect(html).toContain('pooled Hia5');
    expect(html).toContain('<strong>ANY</strong>: 0 / 20 evidence groups (0.0%)');
    expect(html).not.toContain('35 / 91');
    expect(html).toContain('not certified independent duplexes');
  });
  it('labels alternative unions and one-to-one events without changing event semantics',()=>{
    for(const [kind,label] of [['alternative_class_union','Alternative-class union'],['one_to_one','One-to-one native-class event']] as const){
      const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...nativeGroup,kind}]}/>);
      expect(html).toContain(label);expect(html).toContain('ANY = at least one');expect(html).toContain('ALL = every');
      expect(html).not.toContain('Unresolved mapping');
    }
  });
  it('does not turn zero coverage into an observed zero or emit NaN',()=>{
    const absent={...nativeCounts,eligible_units:0,assigned_units:0,fraction:null,
      all_member_units:0,all_member_fraction:null,by_strand:{},member_counts:{'d:A':0}};
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...nativeGroup,left_counts:absent,right_counts:absent}]}/>);
    expect(html).toContain('Unavailable — no evidence groups cover');
    expect(html).toContain('3 groups with a member call lack complete span coverage');
    expect(html).not.toContain('0 / 0');expect(html).not.toContain('NaN');
  });
  it('withholds a comparison if the two recorded denominators use different spans',()=>{
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[{...nativeGroup,
      right_counts:{...nativeGroup.right_counts,comparison_span:[102,138]}}]}/>);
    expect(html).toContain('Comparison-span mismatch');expect(html).not.toContain('33 / 91');
  });
  it('renders native and legacy groups independently and filters native coordinates',()=>{
    const html=renderToStaticMarkup(<ConsensusCountGroups groups={[group,nativeGroup]}/>);
    expect(html).toContain('before SR 31 / 91');expect(html).toContain('Recorded classification reference: 99.9%');
    expect(renderToStaticMarkup(<ConsensusCountGroups groups={[nativeGroup]} search="NXG_a"/>)).toContain('Co-occurring fragments or states');
    expect(renderToStaticMarkup(<ConsensusCountGroups groups={[nativeGroup]} search="140"/>)).toContain('same comparison span');
  });
});
