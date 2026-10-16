import type { CorrespondenceCountGroup, CorrespondenceCounts, NativeCorrespondenceCountGroup,
  NativeCorrespondenceCountSummary, NativeCorrespondenceCounts } from '../../../api/consensusWorkflow';

function isNativeGroup(group:CorrespondenceCountGroup):group is NativeCorrespondenceCountGroup {
  return group.status==='descriptive_native_call_events'
    || !!group.left_counts&&'classification_reference_percent' in group.left_counts;
}

function NativeEventCounts({counts}:{counts:NativeCorrespondenceCountSummary}) {
  if(!counts.eligible_units)return <>
    <div>Unavailable — no evidence groups cover the complete comparison span.</div>
    {counts.assigned_without_span_coverage>0&&<div className="text-amber-700 dark:text-amber-300">{counts.assigned_without_span_coverage} groups with a member call lack complete span coverage and are excluded.</div>}
  </>;
  const fraction=(value:number|null)=>value===null?'unavailable':`${(100*value).toFixed(1)}%`;
  return <>
    <div><strong>ANY</strong>: {counts.assigned_units} / {counts.eligible_units} evidence groups ({fraction(counts.fraction)})</div>
    <div><strong>ALL</strong>: {counts.all_member_units} / {counts.eligible_units} evidence groups ({fraction(counts.all_member_fraction)})</div>
    <div className="text-gray-500">{counts.multiple_member_units} groups contain multiple members; each group is counted once in ANY.</div>
    <div className="text-gray-500">{counts.opportunity_bearing_units} / {counts.eligible_units} covering groups have an observed opportunity in the span. Coverage and opportunity presence do not establish equal detection power.</div>
    {counts.assigned_without_span_coverage>0&&<div className="text-amber-700 dark:text-amber-300">{counts.assigned_without_span_coverage} groups with a member call lack complete span coverage and are excluded.</div>}
  </>;
}

function NativeCounts({dataset,counts}:{dataset:string;counts:NativeCorrespondenceCounts}) {
  return <div className="py-1 break-words" data-testid="native-correspondence-counts">
    <div className="font-semibold">{dataset}</div>
    <NativeEventCounts counts={counts}/>
    <div>Recorded classification reference: {counts.classification_reference_percent}% · original primary-class calls, excluding new rescue calls.</div>
    <div className="text-gray-500">{counts.original_member_calls} original member calls; {counts.repeated_groups_collapsed} repeated observations collapsed. Evidence groups are not certified independent duplexes.</div>
    {counts.unresolved_mixed_groups>0&&<div className="text-amber-700 dark:text-amber-300">{counts.unresolved_mixed_groups} groups have unresolved mixed-strand identity.</div>}
    <details><summary>Individual member counts · do not sum into ANY</summary>
      {Object.entries(counts.member_counts).map(([family,count])=><div key={family}>{family}: {counts.eligible_units?`${count} / ${counts.eligible_units} covering groups`:'unavailable — no complete span coverage'}</div>)}
    </details>
    <div className="mt-1 border-l-2 border-cyan-200 pl-1.5 dark:border-cyan-900" data-testid="native-correspondence-strata">
      <div className="font-medium">Native strata · CT/GA separate; Hia5 pooled</div>
      {Object.entries(counts.by_strand).map(([strand,value])=><div key={strand} className="mt-1">
        <div className="font-medium">{strand==='pooled'?'pooled Hia5':strand}</div><NativeEventCounts counts={value}/>
      </div>)}
    </div>
  </div>;
}

function NativeGroup({group:g}:{group:NativeCorrespondenceCountGroup}) {
  const sameSpan=[g.left_counts.comparison_span,g.right_counts.comparison_span]
    .every(span=>span[0]===g.comparison_span[0]&&span[1]===g.comparison_span[1]);
  return <div className="border-t pt-1 dark:border-gray-700" data-testid="native-count-group" data-group-id={g.group_id}>
    <div className="font-medium">{g.kind==='one_to_one'?'One-to-one native-class event':g.kind==='alternative_class_union'?'Alternative-class union':'Co-occurring fragments or states'} · {g.left_families.length} ↔ {g.right_families.length} native classs</div>
    <div className="text-gray-500">{g.group_id}</div>
    <p>ANY = at least one listed primary class. ALL = every listed primary class on the same evidence group. These are different observed events, not interchangeable descriptions of a broad footprint.</p>
    <p>Primary denominator: complete aligned-block coverage of the <strong>same comparison span</strong> in both datasets: {g.comparison_span[0].toLocaleString()}–{g.comparison_span[1].toLocaleString()} (0-based, end-exclusive). The span defines counting coverage only; it is not a merged footprint.</p>
    <p className="text-amber-700 dark:text-amber-300">Nonexclusive groups: do not sum counts across groups. {g.overlaps_other_count_groups?'These native members also occur in other groups. ':''}Neither occupancy, event equivalence, nor resolved fragmentation is established.</p>
    {!sameSpan?<p role="alert" className="text-red-700">Comparison-span mismatch in the recorded counts; cross-dataset rates are withheld.</p>:<>
      <NativeCounts dataset={g.left_dataset} counts={g.left_counts}/>
      <NativeCounts dataset={g.right_dataset} counts={g.right_counts}/>
    </>}
  </div>;
}

function Counts({dataset, counts}: {dataset: string; counts: CorrespondenceCounts}) {
  const available=counts.assigned_units!==null && counts.fraction!==null;
  return <div className="py-0.5 break-words">
    <span className="font-medium">{dataset}</span>: {available
      ? `${counts.assigned_units} / ${counts.eligible_units} assigned (${(100*counts.fraction!).toFixed(1)}%)`
      : 'unavailable — no common eligible units'}
    {available && counts.native_assigned_units!==null && <span> · before SR {counts.native_assigned_units} / {counts.eligible_units}</span>}
    {counts.native_current_endpoints_match===false&&<div className="text-amber-700 dark:text-amber-300">Legacy baseline uses a different event rule; before/after counts are not directly comparable.</div>}
    <div className="text-gray-500">ANY of {counts.families.join(', ')} · {counts.multiple_member_units} multi-member units counted once</div>
    {counts.canonical_core_eligible_units!==undefined&&<div className={counts.assigned_without_testable_canonical_core?'text-amber-700 dark:text-amber-300':'text-gray-500'}>
      Canonical-core eligible: {counts.canonical_core_eligible_units}. {counts.assigned_without_testable_canonical_core||0} assignments rely on an edge variant without a testable canonical core.
    </div>}
    {counts.group_event_mass_computed&&<div className="text-gray-500">Exact ANY-member inclusion; separately thresholding each member would count {counts.per_member_threshold_assigned_units??'NA'}. Member counts need not sum to the event count.</div>}
    {counts.union_eligible_units!==undefined&&counts.union_eligible_units!==counts.eligible_units&&<div className="text-gray-500">
      Eligibility sensitivity: {counts.union_eligible_assigned_units??'NA'} / {counts.union_eligible_units} on the any-member-eligible cohort. Primary denominator requires every member to be eligible.
    </div>}
    {counts.by_strand&&Object.keys(counts.by_strand).length>1&&<div className="mt-1 border-l-2 border-cyan-200 pl-1.5 dark:border-cyan-900" data-testid="consensus-stratum-counts">
      <div className="font-medium">Chemical-strand breakdown · pooling can conceal unequal resolution</div>
      {Object.entries(counts.by_strand).map(([strand,c])=><div key={strand}>
        {strand}: {c.assigned_units===null||c.fraction===null?'not testable — no eligible units':`${c.assigned_units} / ${c.eligible_units} assigned (${(100*c.fraction).toFixed(1)}%)`}
        {c.eligible_units>0&&c.native_assigned_units!==null&&<span> · before SR {c.native_assigned_units} / {c.eligible_units}</span>}
        {c.canonical_core_eligible_units!==undefined&&<span> · core eligible {c.canonical_core_eligible_units}</span>}
      </div>)}
      <div className="text-gray-500">Same exact event, not counts adjusted toward agreement. Strand rates alone do not establish detection power.</div>
    </div>}
  </div>;
}

/** A count endpoint, not a new family. Never select partners using rate agreement. */
export function ConsensusCountGroups({groups, search=''}: {groups: CorrespondenceCountGroup[]; search?: string}) {
  const matching=groups.filter(g=>!search || `${g.group_id} ${g.left_families} ${g.right_families} ${JSON.stringify(g.native_intervals)}`.includes(search));
  if(!matching.length)return null;
  return <section data-testid="consensus-count-groups" className="border rounded p-1.5 space-y-1 dark:border-gray-700 text-[11px]">
    <h4 className="font-semibold">XCR count endpoints · descriptive, not calibrated occupancy</h4>
    <p>Shape compatibility does not establish equal detection power or equal quantities. Multiple atomic links are not independent count matches. Native intervals stay unchanged.</p>
    {matching.map(g=>isNativeGroup(g)?<NativeGroup key={g.group_id} group={g}/>:<div key={g.group_id} className="border-t pt-1 dark:border-gray-700">
      <div className="font-medium">{g.kind==='one_to_one'?'One-to-one':g.kind==='coarse_union'?'Coarse ANY-member union':'Unresolved mapping'} · {g.left_families.length} ↔ {g.right_families.length} native families</div>
      {g.unrepresented_recurrent_overlap&&<p className="text-amber-700 dark:text-amber-300">Recurrent overlapping native alternatives are outside this endpoint (pooled catalog warning). The graph match is not an unambiguous quantitative identity.</p>}
      {g.individual_target_roles_established===false&&<p className="text-amber-700 dark:text-amber-300">Individual-class support can redistribute to competitors during replacement. Shape links and coarse counts remain visible; unique-state correspondence is unresolved.</p>}
      {g.kind==='unresolved_mapping'?<p>{g.reasons.join(', ').replace(/_/g,' ')}. No grouped rate is reported.</p>:<>
        <p>After SR, excluding new rescue calls · fixed membership ≥ {g.membership_threshold}. Caller-conditioned assignments; each assay uses units with an eligible edge variant for every listed member. This is not canonical-core testability; slider changes do not recount.</p>
        {g.left_counts&&<Counts dataset={g.left_dataset} counts={g.left_counts}/>}
        {g.right_counts&&<Counts dataset={g.right_dataset} counts={g.right_counts}/>}
      </>}
    </div>)}
  </section>;
}
