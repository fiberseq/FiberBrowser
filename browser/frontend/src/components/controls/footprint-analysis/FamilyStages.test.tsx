import {describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {FamilyStages,stagedControlVisible,stagedPreset} from './FamilyStages';
import type {ConsensusJob,ConsensusSchema} from '../../../api/consensusWorkflow';

describe('staged family controls',()=>{
  it('preserves the assignment slider in the submitted staged parameters',()=>{
    const schema={groups:{families:[{name:'assignment_reference_percent',default:99.9}]}} as ConsensusSchema;
    expect(stagedPreset({families:{assignment_reference_percent:75}},schema).families.assignment_reference_percent).toBe(75);
    expect(stagedPreset({},schema).families.assignment_reference_percent).toBe(99.9);
  });
  it('resets stale hidden legacy settings when switching engines',()=>{
    const schema={groups:{cr:[{name:'engine',default:'call_harmonization'},{name:'minimum_edge_tolerance_bp',default:-1}],
      compute:[{name:'cores',default:4},{name:'predictive_backend',default:'cpu'}],
      families:[{name:'physical_radius_bp',default:10}],sr:[{name:'enabled',default:true}]}} as ConsensusSchema;
    const result=stagedPreset({cr:{minimum_edge_tolerance_bp:5},compute:{cores:2,predictive_backend:'vectorized'},families:{physical_radius_bp:5}},schema);
    expect(result.cr.minimum_edge_tolerance_bp).toBe(-1);expect(result.compute.predictive_backend).toBe('cpu');
    expect(result.compute.cores).toBe(2);expect(result.families.physical_radius_bp).toBe(5);
    expect(result.sr.enabled).toBe(true);expect(result.input.correct_native).toBe(true);
  });
  it('exposes only settings used by this engine',()=>{
    expect(stagedControlVisible('families','physical_radius_bp')).toBe(true);
    expect(stagedControlVisible('compute','require_native_cache')).toBe(true);
    expect(stagedControlVisible('families','nomination_radius_bp')).toBe(true);
    expect(stagedControlVisible('cr','membership_loss_odds')).toBe(false);
    expect(stagedControlVisible('cr','predictive_replicates')).toBe(false);
    expect(stagedControlVisible('sr','loss_odds')).toBe(false);
    expect(stagedControlVisible('cross','native_minimum_geometry_retention')).toBe(false);
    expect(stagedControlVisible('rescue','enabled')).toBe(false);
  });
  it('shows stage-specific counts and frozen inspection semantics',()=>{
    const job={status:'complete',job_id:'j',view_stage:'native',final_stage:'resolved',stages:[
      {id:'native',label:'Native family fits',seconds:2,families:8,original_calls:100,assignments:90},
      {id:'resolved',label:'Final families',seconds:.1,families:3,original_calls:100,assignments:95}]} as ConsensusJob;
    const html=renderToStaticMarkup(<FamilyStages job={job} onChange={vi.fn()}/>);
    expect(html).toContain('8 states');expect(html).toContain('3 states');
    expect(html).toContain('90 / 100 calls assigned');expect(html).toContain('Earlier-stage inspection is read-only');
  });
});
