import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsensusCrossEvidence } from './ConsensusCrossEvidence';
import type { ConsensusCrossEdge } from '../../../api/consensusWorkflow';
const base:ConsensusCrossEdge={edge_id:'x',left_family:'d:A',right_family:'h:B',left_interval:[100,140],
  right_interval:[102,138],status:'shape_disagreement',comparability_mask:false};
describe('Inspectable reciprocal XCR evidence',()=>{
  it('shows native direction failures without invoking legacy model-support formatting',()=>{
    const html=renderToStaticMarkup(<ConsensusCrossEvidence edge={{...base,forward:null,reverse:null,native_family_evidence:{DddA:{
      recipient_dataset:'DddA',recipient_strand:'GA',n_source_calls:20,n_scored:15,n_compatible:9,compatible_fraction:.6,
      median_predictive_tail:.02,untestable_calls:5,contradicted_calls:6,reason_counts:{core_contradiction:6}}}}}/>);
    expect(html).toContain('provisional native-family comparison');expect(html).toContain('9 compatible / 15 scored / 20 source calls');
    expect(html).toContain('GA');expect(html).toContain('core contradiction: 6');expect(html).toContain('Manual groups do not contribute support');
    expect(html).not.toContain('effective support');
  });
  it('shows asymmetrical disagreement without implying absence or q values',()=>{
    const html=renderToStaticMarkup(<ConsensusCrossEvidence edge={{...base,forward:{native_effective_support:16,
      testable_native_mass_fraction:.99,acceptable_native_mass_fraction:.77,native_shape_preferred_mass_fraction:.22,
      foreign_shape_preferred_mass_fraction:0,untestable_mass_fraction:.01}}}/>);
    expect(html).toContain('Left shape tested in right dataset');expect(html).toContain('77.0%');
    expect(html).toContain('22.0%');expect(html).toContain('not evidence of absence');
    expect(html).toContain('remains provisional');expect(html).toContain('not accuracy or FDR');
  });
  it('distinguishes global fit preservation from competitor absorption',()=>{
    const html=renderToStaticMarkup(<ConsensusCrossEvidence edge={{...base,joint_left:{status:'tested',
      retained_native_mass_fraction:1,retained_target_inclusion_fraction:.02,jointly_retained_target_mass_fraction:.02}}}/>);
    expect(html).toContain('Full-model fit retained: 100.0%');expect(html).toContain('target role retained: 2.0%');
    expect(html).toContain('both on the same units: 2.0%');
  });
  it('marks old artifacts as untested instead of inventing target retention',()=>{
    const html=renderToStaticMarkup(<ConsensusCrossEvidence edge={{...base,joint_left:{status:'tested',retained_native_mass_fraction:.9}}}/>);
    expect(html).toContain('target-role retention was not tested');expect(html).toContain('unavailable');
  });
});
