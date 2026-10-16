import type {ConsensusFamily,FamilyEvidence} from '../../../api/consensusWorkflow';
import {nativeCrossStatus,nativeTailAssessment,nativeCrossPrecision} from '../../../utils/nativeCrossEvidence';
import {NativeModelVersion} from './NativeCatalogUpdate';
const mass=(v:number|undefined)=>v==null?'not recorded':`${(100*v).toFixed(2)}%`;

export function NativeCrossPrecision({referencePercent,draws}:{referencePercent:number;draws:number}) {
  const p=nativeCrossPrecision(referencePercent,draws);
  return <div data-testid="native-xcr-precision" className="text-[11px] space-y-1">
    <p>XCR inference settings, not display filters. Full normalized geometry is tested, not a majority core. Original calls and evidence remain unchanged. Run selected stages to apply; the current workflow also refits CR.</p>
    {p.valid?<p role={p.resolved?'status':'alert'} className={p.resolved?'text-gray-500':'text-red-700'}>
      {draws.toLocaleString()} XCR draws: zero-exceedance MC upper bound {p.zeroUpper.toPrecision(4)}; tail threshold {p.threshold.toPrecision(4)}.
      {p.resolved?' The numerical rejection gate is resolvable; individual comparisons can still be MC-borderline.'
        :` Not resolvable: use at least ${p.minimumDraws.toLocaleString()} XCR draws within the server budget, or lower the XCR reference percent. CR draws do not change this gate.`}
    </p>:<p role="alert">Select a valid XCR reference and integer draw count.</p>}
    <p>MC intervals describe simulation error only, not model validity, detection power or FDR. A larger reference percent is more permissive and needs more draws to resolve rejection.</p>
  </div>;
}

export function NativeModelProvenance({family,label}:{family:ConsensusFamily;label?:string}) {
  const full=family.fit_diagnostics?.full??family.fit_diagnostics;
  const failed=full!=null&&typeof full==='object'&&'converged' in full&&full.converged===false;
  return <div className="text-[11px]">
    <p>{label??family.family}: {family.source_units??'unrecorded'} source units{family.model_status?` · ${family.model_status.replace(/_/g,' ')}`:''}.</p>
    <NativeModelVersion provenance={family.model_provenance}/>
    {family.source_units===1&&<p className="text-amber-700">Singleton source hypothesis — not recurrent population support. Retained for inspection.</p>}
    {failed&&<p className="text-amber-700">Full native shape fit NOT converged; compatibility inherits this fit uncertainty.</p>}
    {full!=null&&<details><summary>Frozen full-fit diagnostics · {label??family.family}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(full,null,2)}</pre></details>}
  </div>;
}

export function NativeCrossCallEvidence({evidence,referencePercent}:{evidence:FamilyEvidence;referencePercent?:number}) {
  return <div className="space-y-0.5">
    <p>{nativeCrossStatus(evidence.status??'status_unavailable')}</p>
    <p>Original geometry mass overlapping this call: {mass(evidence.geometry_mass_overlapping_observed_call)}.</p>
    <p>Original geometry allowed by frozen neighbors: {mass(evidence.geometry_mass_allowed_by_frozen_neighbors)} · physically retained (all constraints): {mass(evidence.physical_geometry_retention)}.</p>
    <p>Retained geometry with actual recipient observations: {mass(evidence.geometry_observed_mass_fraction)} · {evidence.observed_opportunities??'unrecorded'} observed opportunities.</p>
    <p className="text-gray-500">The first two masses use original donor geometry; observability is conditional on physically retained geometry. None is a majority-core overlap or detection-power estimate.</p>
    <p>Predictive tail {evidence.predictive_tail?.toPrecision(4)??'not scored'}{evidence.predictive_tail_interval?` · MC interval [${evidence.predictive_tail_interval.map(v=>v.toPrecision(4)).join(', ')}]`:''}.</p>
    <p>{nativeTailAssessment(evidence.status,evidence.predictive_tail_interval,referencePercent)}{referencePercent!=null?` (${referencePercent}% XCR reference, frozen run).`:'.'}</p>
    {evidence.simulations!=null&&<p>{evidence.simulations.toLocaleString()} native reference draws · {evidence.tail_exceedances??'unrecorded'} exceedances.</p>}
  </div>;
}
