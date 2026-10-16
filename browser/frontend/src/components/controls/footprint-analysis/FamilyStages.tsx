import {useState} from 'react';
import {selectConsensusStage,type ConsensusJob,type ConsensusSchema} from '../../../api/consensusWorkflow';
import {useConsensusViewStore} from '../../../stores/consensusViewStore';
import {useBrowserStore} from '../../../stores/browserStore';

export function stagedControlVisible(group:string,name:string){
  return group==='families'||group==='input'
    ||group==='sr'&&name==='enabled'||group==='cross'&&name==='enabled'
    ||group==='compute'&&['cores','maximum_matrix_mb','maximum_region_bp','fit_cache_dir','require_native_cache'].includes(name);
}

export function stagedPreset(parameters:Record<string,Record<string,boolean|number|string>>,schema:ConsensusSchema|null):Record<string,Record<string,boolean|number|string>>{
  const reset=Object.fromEntries(Object.entries(schema?.groups??{}).map(([g,controls])=>[g,
    Object.fromEntries(controls.map(c=>[c.name,stagedControlVisible(g,c.name)?parameters[g]?.[c.name]??c.default:c.default]))]));
  return {...reset,cr:{...reset.cr,engine:'staged_native_families',enabled:true},
    input:{...reset.input,correct_native:reset.input?.correct_native??true,minimum_nfr_length:0},
    rescue:{...reset.rescue,enabled:false},split:{...reset.split,enabled:false},comparability:{...reset.comparability,enabled:false}};
}

/** Controls the lattice recaller uses: its own group, input, Hia5 nucleosome replay and the compute budget. */
export function recallerControlVisible(group:string,name:string){
  return group==='recaller'||group==='input'
    ||group==='families'&&['recall_hia5_nucleosomes','nuc_split_minimum_llr'].includes(name)
    ||group==='compute'&&['cores','maximum_region_bp'].includes(name);
}

export function recallerPreset(parameters:Record<string,Record<string,boolean|number|string>>,schema:ConsensusSchema|null):Record<string,Record<string,boolean|number|string>>{
  const reset=Object.fromEntries(Object.entries(schema?.groups??{}).map(([g,controls])=>[g,
    Object.fromEntries(controls.map(c=>[c.name,recallerControlVisible(g,c.name)?parameters[g]?.[c.name]??c.default:c.default]))]));
  return {...reset,cr:{...reset.cr,engine:'lattice_recaller',enabled:true},
    input:{...reset.input,correct_native:reset.input?.correct_native??true,minimum_nfr_length:0},
    rescue:{...reset.rescue,enabled:false},split:{...reset.split,enabled:false},comparability:{...reset.comparability,enabled:false}};
}

/** The preset for the chosen footprint-class engine: the lattice recaller unless the staged Monte Carlo engine is chosen. */
export function workflowPreset(parameters:Record<string,Record<string,boolean|number|string>>,schema:ConsensusSchema|null){
  return parameters.cr?.engine==='staged_native_families'?stagedPreset(parameters,schema):recallerPreset(parameters,schema);
}

export function FamilyStages({job,onChange}:{job:ConsensusJob;onChange:(job:ConsensusJob)=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  if(!job.stages?.length||job.status!=='complete')return null;
  const select=async(stage:string)=>{
    setBusy(true);setError('');
    try{
      const next=await selectConsensusStage(job.job_id,stage);onChange(next);
      useConsensusViewStore.getState().select(null);
      await useConsensusViewStore.getState().load(job.job_id,true);
      // Earlier stages show their automatic calls, never final manual labels.
      const browser=useBrowserStore.getState();browser.toggleModType('tf_cr',true);
      browser.toggleModType('tf_cr_manual',false);browser.triggerRefresh();
    }catch(e){setError(String(e));}finally{setBusy(false);}
  };
  const active=job.stages.find(stage=>stage.id===job.view_stage)??job.stages[job.stages.length-1];
  return <details data-testid="family-stages" className="border rounded p-2 space-y-1">
    <summary className="font-medium cursor-pointer">Completed stages · showing {active.label} · {active.families} classes</summary>
    <p className="text-[11px]">Inspect frozen hypotheses and original-call memberships at each stage. Changing the view does not refit.</p>
    {job.checkpoints&&<p className="text-[11px]" data-testid="family-checkpoint-summary">Reused checkpoints: {job.checkpoints.hits.native??0} native sources, {job.checkpoints.hits.foreign??0} cross-source scoring blocks, {job.checkpoints.hits.parent??0} shared fits. New work: {Object.values(job.checkpoints.misses).reduce((a,b)=>a+b,0)} blocks.</p>}
    {job.stages.map(s=><button key={s.id} disabled={busy} aria-pressed={job.view_stage===s.id}
      onClick={()=>void select(s.id)} className={`block w-full text-left rounded px-2 py-1 ${job.view_stage===s.id?'bg-cyan-100 dark:bg-cyan-900':'hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
      {s.label} · {s.families} states
      <span className="block text-[11px]">{s.assignments.toLocaleString()} / {s.original_calls.toLocaleString()} calls assigned · {s.seconds.toFixed(1)} s</span>
    </button>)}
    {job.view_stage!==job.final_stage&&<p className="text-[11px]">Earlier-stage inspection is read-only. Return to the final stage for manual merge/split.</p>}
    {error&&<p role="alert" className="text-red-700">{error}</p>}
  </details>;
}
