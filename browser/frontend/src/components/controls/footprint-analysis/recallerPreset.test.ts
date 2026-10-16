import {describe,expect,it} from 'vitest';
import type {ConsensusJob,ConsensusSchema} from '../../../api/consensusWorkflow';
import {recallerControlVisible,recallerPreset,stagedPreset,workflowPreset} from './FamilyStages';
import {stagePlan,STAGE_PLANS} from './consensusStagePlan';

const schema={schema:'fiberhmm.consensus.v1',cr_mode:'lattice_recaller',layers:{},display_defaults:{} as ConsensusSchema['display_defaults'],
  groups:{
    cr:[{name:'engine',default:'lattice_recaller',type:'str',label:'Engine',help:'',choices:['lattice_recaller','staged_native_families']},{name:'enabled',default:true,type:'bool',label:'',help:''}],
    input:[{name:'correct_native',default:true,type:'bool',label:'',help:''},{name:'minimum_nfr_length',default:40,type:'int',label:'',help:''}],
    recaller:[{name:'stringency',default:0.9,type:'float',label:'',help:''},{name:'linker',default:'both',type:'str',label:'',help:'',choices:['both','either']}],
    families:[{name:'recall_hia5_nucleosomes',default:true,type:'bool',label:'',help:''},{name:'physical_radius_bp',default:10,type:'int',label:'',help:''}],
    compute:[{name:'cores',default:4,type:'int',label:'',help:''},{name:'fit_cache_dir',default:'',type:'str',label:'',help:''}],
    rescue:[{name:'enabled',default:false,type:'bool',label:'',help:''}],split:[{name:'enabled',default:false,type:'bool',label:'',help:''}],
    comparability:[{name:'enabled',default:false,type:'bool',label:'',help:''}],
  }} as unknown as ConsensusSchema;

describe('lattice recaller presets',()=>{
  it('is the default engine and keeps its own settings',()=>{
    const p=workflowPreset({recaller:{stringency:0.7}},schema);
    expect(p.cr.engine).toBe('lattice_recaller');
    expect(p.recaller.stringency).toBe(0.7);
    expect(p.input.minimum_nfr_length).toBe(0);
    expect(p.rescue.enabled).toBe(false);
  });
  it('keeps the staged engine when it is chosen, and resets recaller-only settings there',()=>{
    const p=workflowPreset({cr:{engine:'staged_native_families'},recaller:{stringency:0.6}},schema);
    expect(p.cr.engine).toBe('staged_native_families');
    expect(p.recaller.stringency).toBe(0.9);
    expect(stagedPreset({},schema).cr.engine).toBe('staged_native_families');
  });
  it('resets controls the recaller does not use',()=>{
    const p=recallerPreset({families:{physical_radius_bp:5,recall_hia5_nucleosomes:false},compute:{fit_cache_dir:'/x',cores:8}},schema);
    expect(p.families.physical_radius_bp).toBe(10);
    expect(p.families.recall_hia5_nucleosomes).toBe(false);
    expect(p.compute.cores).toBe(8);
    expect(p.compute.fit_cache_dir).toBe('');
  });
  it('shows the recaller group, input and the relevant compute controls',()=>{
    expect(recallerControlVisible('recaller','linker')).toBe(true);
    expect(recallerControlVisible('input','correct_native')).toBe(true);
    expect(recallerControlVisible('families','physical_radius_bp')).toBe(false);
    expect(recallerControlVisible('compute','fit_cache_dir')).toBe(false);
    expect(recallerControlVisible('cross','enabled')).toBe(false);
  });
  it('has its own progress plan',()=>{
    const job={cr_mode:'lattice_recaller',stage:'recaller_quantify',request:{parameters:{}}} as unknown as ConsensusJob;
    expect(stagePlan(job)).toBe(STAGE_PLANS.lattice_recaller);
    expect(STAGE_PLANS.lattice_recaller.map(s=>s.key)).toEqual(['load','discover','score','install']);
  });
});
