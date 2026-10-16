import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeCrossCallEvidence,NativeCrossPrecision,NativeModelProvenance} from './NativeCrossDiagnostics';
import {ConsensusCrossEvidence} from './ConsensusCrossEvidence';
import type {ConsensusCrossEdge} from '../../../api/consensusWorkflow';

describe('native geometry, Monte Carlo and source provenance inspectors',()=>{
  it('reports complete call geometry masses with their actual denominators and MC caution',()=>{
    const html=renderToStaticMarkup(<NativeCrossCallEvidence referencePercent={99.9} evidence={{status:'scored',
      geometry_mass_overlapping_observed_call:.08,geometry_mass_allowed_by_frozen_neighbors:.7,
      physical_geometry_retention:.06,geometry_observed_mass_fraction:.9,observed_opportunities:6,
      predictive_tail:.001,predictive_tail_interval:[.0001,.002],simulations:4095,tail_exceedances:3}}/>);
    for(const expected of ['8.00%','70.00%','6.00%','90.00%','conditional on physically retained','MC-borderline','4,095'])expect(html).toContain(expected);
    expect(html).not.toContain('NaN');
  });
  it('does not fabricate old fields or label failed attribution as lack of observations',()=>{
    const html=renderToStaticMarkup(<NativeCrossCallEvidence evidence={{status:'hypothesis_not_attributable_to_this_call'}}/>);
    expect(html).toContain('Model located elsewhere');expect(html).toContain('not recorded');
    expect(html).not.toContain('0.00%');expect(html).not.toContain('resolution limited');
  });
  it('makes singleton and failed-fit donor provenance visible without deleting the hypothesis',()=>{
    const html=renderToStaticMarkup(<NativeModelProvenance family={{family:'d:F1',consensus_start:10,consensus_end:40,
      source_units:1,fit_diagnostics:{full:{converged:false,message:'iteration limit'}}}}/>);
    expect(html).toContain('Singleton source hypothesis');expect(html).toContain('NOT converged');expect(html).toContain('iteration limit');
  });
  it('shows native direction MC breakdown and incomplete assessment honestly',()=>{
    const edge:ConsensusCrossEdge={edge_id:'x',left_family:'d:F1',right_family:'h:F1',left_interval:[10,40],right_interval:[12,40],
      status:'provisional_incomplete_reciprocal_assessment',comparability_mask:false,compatibility_depends_on_monte_carlo_uncertainty:true,
      native_family_evidence:{d:{n_source_calls:20,n_scored:8,n_testable:10,n_compatible:5,compatible_fraction:.5,
        n_compatible_mc_clear:2,n_compatible_mc_borderline:3,compatible_mc_clear_fraction:.2,source_coverage_fraction:.5,
        median_predictive_tail:.003,untestable_calls:10,contradicted_calls:2,reason_counts:{hypothesis_not_attributable_to_this_call:10}}}};
    const html=renderToStaticMarkup(<ConsensusCrossEvidence edge={edge}/>);
    expect(html).toContain('Incomplete reciprocal assessment');expect(html).toContain('2 MC-clear / 3 MC-borderline');
    expect(html).toContain('20.0%');expect(html).toContain('Link compatibility depends');expect(html).not.toContain('resolution limited');
  });
  it('shows numerical precision and not display-derived inference claims',()=>{
    const html=renderToStaticMarkup(<NativeCrossPrecision referencePercent={99.999} draws={4095}/>);
    expect(html).toContain('Not resolvable');expect(html).toContain('CR draws do not change this gate');expect(html).toContain('not display filters');
  });
});
