import type { ConsensusCrossEdge, CrossDirectionEvidence, CrossJointEvidence,ConsensusCatalog } from '../../../api/consensusWorkflow';
import {nativeCrossStatus} from '../../../utils/nativeCrossEvidence';
import {NativeModelProvenance} from './NativeCrossDiagnostics';

const percent=(x:number|null|undefined)=>x==null?'unavailable':`${(100*x).toFixed(1)}%`;
function Direction({label,evidence}:{label:string;evidence:CrossDirectionEvidence}) {
  return <div className="space-y-0.5"><div className="font-medium">{label}</div>
    <p>Native effective support: {evidence.native_effective_support.toFixed(1)} · testable mass: {percent(evidence.testable_native_mass_fraction)}</p>
    <p>Compatible: {percent(evidence.acceptable_native_mass_fraction)} · native preferred: {percent(evidence.native_shape_preferred_mass_fraction)} · transferred preferred: {percent(evidence.foreign_shape_preferred_mass_fraction)}</p>
    <p>Untestable: {percent(evidence.untestable_mass_fraction)} — not evidence of absence.</p></div>;
}
function Joint({label,evidence}:{label:string;evidence:CrossJointEvidence}) {
  return <div><span className="font-medium">{label}</span>: {evidence.status.replace(/_/g,' ')}
    {evidence.reason&&<p>{evidence.reason}</p>}
    {evidence.status==='tested'&&<p>Full-model fit retained: {percent(evidence.retained_native_mass_fraction)} · target role retained: {percent(evidence.retained_target_inclusion_fraction)} · both on the same units: {percent(evidence.jointly_retained_target_mass_fraction)}</p>}
    {evidence.status==='tested'&&evidence.retained_target_inclusion_fraction===undefined&&<p className="text-amber-700 dark:text-amber-300">Legacy result: target-role retention was not tested.</p>}
  </div>;
}
export function ConsensusCrossEvidence({edge,catalog}:{edge:ConsensusCrossEdge;catalog?:ConsensusCatalog}) {
  if(edge.comparison){
    const c=edge.comparison;
    return <details className="text-[11px] py-1 border-b dark:border-gray-700"><summary>{edge.left_family} · {c.comparability.replace(/_/g,' ')} · {c.agreement.replace(/_/g,' ')}</summary>
      <p>{c.left_label}: {c.left.assigned_units}/{c.left.covered_units} ({percent(c.left.fraction)}) ↔ {c.right_label}: {c.right.assigned_units}/{c.right.covered_units} ({percent(c.right.fraction)})</p>
      <p>Lattice capable: {percent(c.left.lattice_capable_fraction)} ↔ {percent(c.right.lattice_capable_fraction)}. {c.reasons.map(s=>s.replace(/_/g,' ')).join('; ')}</p>
      <p>{c.semantics}</p></details>;
  }
  if(edge.native_family_evidence){
    const e=edge.native_family_evidence;
    const directions=Object.entries(e).flatMap(([dataset,d])=>[{...d,recipient_dataset:d.recipient_dataset??dataset},
      ...Object.entries(d.by_strand??{}).map(([strand,s])=>({...s,recipient_dataset:s.recipient_dataset??dataset,recipient_strand:strand}))]);
    return <details className="text-[11px] py-1 border-b dark:border-gray-700"><summary className="cursor-pointer break-words">{edge.left_family} ↔ {edge.right_family}: {nativeCrossStatus(edge.status)} · provisional native-family comparison</summary>
      <div className="pl-2 pt-1 space-y-2"><p>Native summaries: {edge.left_interval.join('–')} ↔ {edge.right_interval.join('–')}. No merged interval.</p>
        {edge.compatibility_depends_on_monte_carlo_uncertainty===true&&<p className="text-amber-700">Link compatibility depends on Monte Carlo-borderline calls. The MC-clear compatible fraction alone does not meet the reciprocal threshold.</p>}
        {edge.compatibility_depends_on_monte_carlo_uncertainty===false&&edge.comparability_mask&&<p>The MC-clear fractions alone meet the reciprocal compatibility threshold; this does not validate the biological model.</p>}
        {edge.compatibility_depends_on_monte_carlo_uncertainty===undefined&&<p>Link-level MC dependency was not recorded in this result.</p>}
        {([[edge.left_dataset,edge.left_family],[edge.right_dataset,edge.right_family]] as const).map(([ds,id])=>{
          const family=ds?catalog?.datasets[ds]?.catalog.find(f=>f.family===id):undefined;
          return family?<NativeModelProvenance key={`${ds}:${id}`} family={family} label={`Source ${ds} · ${id}`}/>:null;
        })}
        {directions.map((d,i)=><div key={i}><p className="font-medium">Recipient: {d.recipient_dataset}{d.recipient_strand?` · ${d.recipient_strand}`:''}</p>
          <p>{d.n_compatible} compatible / {d.n_scored} scored / {d.n_source_calls} source calls ({percent(d.compatible_fraction)} compatible).</p>
          {d.n_testable!=null&&<p>Assessable: {d.n_testable} / {d.n_source_calls} source calls ({percent(d.source_coverage_fraction)}); includes scored and core-contradicted calls.</p>}
          {d.n_compatible_mc_clear!=null&&d.n_compatible_mc_borderline!=null
            ?<p>{d.n_compatible_mc_clear} MC-clear / {d.n_compatible_mc_borderline} MC-borderline compatible · {percent(d.compatible_mc_clear_fraction)} MC-clear / assessable calls.</p>
            :<p>MC-clear / borderline breakdown not recorded.</p>}
          <p>Median predictive tail: {d.median_predictive_tail?.toPrecision(3)??'unavailable'} · untestable {d.untestable_calls} · contradicted {d.contradicted_calls}.</p>
          {Object.entries(d.reason_counts??{}).map(([reason,count])=><p key={reason}>{nativeCrossStatus(reason)}: {count}</p>)}</div>)}
        {!directions.length&&<p>Directional diagnostics unavailable in this result.</p>}
        <p className="text-gray-500">Classification compatibility is provisional, not detection power, equal occupancy, accuracy or FDR. Untestable calls are not evidence of absence. Manual groups do not contribute support.</p>
      </div></details>;
  }
  return <details className="text-[11px] py-1 border-b dark:border-gray-700">
    <summary className="cursor-pointer break-words">{edge.left_family} ↔ {edge.right_family}: {edge.status.replace(/_/g,' ')} · {edge.comparability_mask?'shape-compatible':'not established'}</summary>
    <div className="pl-2 pt-1 space-y-2">
      <p>Unchanged native intervals: {edge.left_interval.join('–')} ↔ {edge.right_interval.join('–')}.</p>
      {edge.target_role_comparability_mask!==undefined&&<p className={edge.target_role_comparability_mask?'':'text-amber-700 dark:text-amber-300'}>Individual-family target role: {edge.target_role_comparability_mask?'retained':'unresolved; shape compatibility does not identify a unique class'}.</p>}
      {edge.forward&&<Direction label="Left shape tested in right dataset" evidence={edge.forward}/>}
      {edge.reverse&&<Direction label="Right shape tested in left dataset" evidence={edge.reverse}/>}
      {edge.joint_left&&<Joint label="Left full-model replacement" evidence={edge.joint_left}/>}
      {edge.joint_right&&<Joint label="Right full-model replacement" evidence={edge.joint_right}/>}
      {!edge.joint_left&&!edge.joint_right&&<p>Full-model replacement not tested; this edge remains provisional.</p>}
      <p className="text-gray-500">Fractions of frozen model support, not accuracy or FDR. Comparable shape does not establish equal detection power or equal occupancy.</p>
    </div>
  </details>;
}
