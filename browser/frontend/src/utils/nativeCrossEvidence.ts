/** Presentation only: never modify native losses, records or compatibility. */
export function nativeCrossStatus(status:string):string {
  const labels:Record<string,string>={
    no_native_primary_cohort:'No native primary-call cohort in at least one dataset; reciprocal assessment unavailable',
    incomplete_reciprocal_assessment:'Incomplete reciprocal assessment; inspect attribution, geometry and information failures',
    hypothesis_not_attributable_to_this_call:'Model located elsewhere: insufficient full-geometry overlap with this original call (not a sequence-information failure)',
    geometry_blocked_by_neighbours_or_domain:'Too little donor geometry survives the call, frozen neighbors or domain',
    no_recipient_information:'No actual recipient information in the comparison domain',
    transferred_shape_unobserved:'Too little retained geometry contains an observed recipient opportunity',
  };
  return labels[status.replace(/^provisional_/,'')]??status.replace(/_/g,' ');
}

export function nativeTailAssessment(status:string|undefined,interval:[number,number]|undefined,referencePercent?:number):string {
  if(status!=='scored')return 'Predictive compatibility not assessed for this call';
  if(!interval||referencePercent==null||!Number.isFinite(referencePercent))return 'MC clear/borderline classification not recorded for this result';
  const threshold=1-referencePercent/100;
  if(interval[1]<threshold)return 'Predictive rejection: entire MC interval below the threshold';
  if(interval[0]>=threshold)return 'MC-clear compatible: entire MC interval at or above the threshold';
  return 'MC-borderline compatible: interval crosses the threshold; retained provisionally';
}

export function nativeCrossPrecision(referencePercent:number,draws:number) {
  const z2=3.841458820694124,threshold=1-referencePercent/100;
  const valid=Number.isInteger(draws)&&draws>0&&referencePercent>=50&&referencePercent<100;
  const zeroUpper=valid?z2/(draws+z2):NaN;
  return {valid,resolved:valid&&zeroUpper<threshold,threshold,zeroUpper,
    minimumDraws:valid?Math.floor(z2*(1-threshold)/threshold)+1:NaN};
}

export function crossControlVisible(name:string,native:boolean):boolean {
  return native?['enabled','minimum_support','minimum_fraction'].includes(name)||name.startsWith('native_'):!name.startsWith('native_');
}
