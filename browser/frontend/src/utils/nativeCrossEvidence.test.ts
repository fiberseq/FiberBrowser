import {describe,it,expect} from 'vitest';
import {crossControlVisible,nativeCrossPrecision,nativeCrossStatus,nativeTailAssessment} from './nativeCrossEvidence';

describe('native XCR presentation semantics',()=>{
  it('distinguishes lack of primary cohort and attribution failures from sequence resolution',()=>{
    expect(nativeCrossStatus('provisional_no_native_primary_cohort')).toContain('No native primary-call cohort');
    expect(nativeCrossStatus('provisional_incomplete_reciprocal_assessment')).toContain('Incomplete reciprocal assessment');
    expect(nativeCrossStatus('hypothesis_not_attributable_to_this_call')).toContain('Model located elsewhere');
    expect(nativeCrossStatus('no_recipient_information')).toContain('No actual recipient information');
    expect(nativeCrossStatus('custom_new_status')).toBe('custom new status');
  });
  it('uses frozen XCR reference, never a CR display slider, and reports missing metadata',()=>{
    expect(nativeTailAssessment('scored',[.0002,.002],99.9)).toContain('MC-borderline');
    expect(nativeTailAssessment('scored',[.002,.1],99.9)).toContain('MC-clear');
    expect(nativeTailAssessment('scored',[.00001,.0002],99.9)).toContain('Predictive rejection');
    expect(nativeTailAssessment('scored',[.00001,.0002],99.99)).toContain('MC-borderline');
    expect(nativeTailAssessment('core_contradicted',[.1,.2],99.9)).toContain('not assessed');
    expect(nativeTailAssessment('scored',[.1,.2])).toContain('not recorded');
  });
  it('matches the server zero-exceedance gate and declares finite budget limits',()=>{
    expect(nativeCrossPrecision(99.9,4095).resolved).toBe(true);
    expect(nativeCrossPrecision(99.9,511).resolved).toBe(false);
    expect(nativeCrossPrecision(99.99,65535).resolved).toBe(true);
    expect(nativeCrossPrecision(99.999,65535).minimumDraws).toBeGreaterThan(65535);
    expect(nativeCrossPrecision(100,4095).valid).toBe(false);
  });
  it('hides ineffective legacy controls in native mode and native controls in legacy mode',()=>{
    for(const key of ['enabled','minimum_support','minimum_fraction'])expect(crossControlVisible(key,true)&&crossControlVisible(key,false)).toBe(true);
    for(const key of ['tolerance_odds','joint_validation','minimum_target_retention'])expect(crossControlVisible(key,true)).toBe(false);
    expect(crossControlVisible('native_predictive_replicates',false)).toBe(false);
    expect(crossControlVisible('native_minimum_call_attribution_mass',true)).toBe(true);
  });
});
