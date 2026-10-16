import {describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {ConsensusProgress} from './ConsensusProgress';
import type {ConsensusJob} from '../../../api/consensusWorkflow';

const job={job_id:'test',status:'running',stage:'cr_classification',
  message:'DddA F0004: fitting held-out model 2/10',created_at:100,started_at:102,
  progress:{stage:'cr_classification',task:'initial',completed:4,total:20,fraction:.2,
    unit:'families',stage_started_at:105,semantics:'completed items'}} as ConsensusJob;

describe('consensus work progress',()=>{
  it('fills from actual stage counts and explains that this is not time remaining',()=>{
    const html=renderToStaticMarkup(<ConsensusProgress job={job}/>);
    expect(html).toContain('aria-valuenow="20"');expect(html).toContain('width:20%');
    expect(html).toContain('4 / 20 classes completed');expect(html).toContain('fitting held-out model 2/10');
    expect(html).toContain('not estimated time');
    // The stage bar isn't full (finished steps of the step row are).
    expect(html).not.toMatch(/consensus-progress-fill"[^>]*width:100%/);expect(html).not.toContain('Results installed');
  });
  it('uses indeterminate accessible semantics when the total is unknown',()=>{
    const html=renderToStaticMarkup(<ConsensusProgress job={{...job,stage:'loading',progress:undefined}}/>);
    expect(html).not.toContain('aria-valuenow');expect(html).toContain('total not yet known');
    // clearly indeterminate: moving stripes over the whole bar, no stationary part-fill (N6)
    expect(html).toMatch(/consensus-progress-fill"[^>]*data-indeterminate="true"/);expect(html).not.toContain('width:32%');
  });
  it('draws the recaller\'s tiles as a determinate bar (N6)',()=>{
    const tiles={...job,stage:'recaller_discovery',cr_mode:'lattice_recaller',message:'tile 44/59 15040000-15042000: 2387 molecules',
      progress:{...job.progress!,stage:'recaller_discovery',completed:null,total:null,fraction:null}} as ConsensusJob;
    const html=renderToStaticMarkup(<ConsensusProgress job={tiles}/>);
    expect(html).toContain('tile 44 of 59');expect(html).not.toContain('Find classes: tile');expect(html).not.toContain('total not yet known');
    expect(html).toContain('aria-valuenow="75"');expect(html).not.toContain('data-indeterminate');
  });
  it('counts the Count step\'s class groups as a determinate bar (B2), with "1 class" said right',()=>{
    const count={...job,stage:'recaller_quantify',cr_mode:'lattice_recaller',message:'group 113/124 (1 classes), amp_DddB_full::CT: 1402 molecules',
      progress:{...job.progress!,stage:'recaller_quantify',completed:null,total:null,fraction:null}} as ConsensusJob;
    const html=renderToStaticMarkup(<ConsensusProgress job={count}/>);
    expect(html).toContain('group 113 of 124');expect(html).not.toContain('total not yet known');
    expect(html).toContain('aria-valuenow="91"');expect(html).not.toContain('data-indeterminate');
    expect(html).toContain('group 113/124 (1 class), amp_DddB_full::CT');expect(html).not.toContain('1 classes');
    expect(renderToStaticMarkup(<ConsensusProgress job={{...count,message:'group 13/124 (4 classes), x'}}/>)).toContain('(4 classes)');
  });
  it('saving the evidence snapshot after the native replay keeps Load reads filled, and says so (R5)',()=>{
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
    const div=document.createElement('div');const root=createRoot(div);
    const load={...job,stage:'native',cr_mode:'lattice_recaller',message:'amp_DddB_full: replaying the native caller 2048/3421 alignments',
      progress:{...job.progress!,stage:'native',completed:2048,total:3421,fraction:2048/3421,unit:'alignments'}} as ConsensusJob;
    try{
      act(()=>root.render(<ConsensusProgress job={load}/>));
      act(()=>root.render(<ConsensusProgress job={{...load,stage:'saving_input',message:'Saving the complete native evidence snapshot',progress:undefined}}/>));
      expect(div.querySelector<HTMLElement>('[data-testid="consensus-progress-fill"]')!.dataset.held).toBe('60');
      expect(div.textContent).toContain('Reads loaded · saving the evidence snapshot');
      expect(div.textContent).not.toContain('total not yet known');
    }finally{act(()=>root.unmount());}
  });
  it('preserves partial work at error/cancellation and fills only on success',()=>{
    for(const status of ['error','cancelled','cancelling'] as const){
      const html=renderToStaticMarkup(<ConsensusProgress job={{...job,status,finished_at:122}}/>);
      expect(html).toContain('width:20%');expect(html).not.toContain('Results installed');
    }
    const html=renderToStaticMarkup(<ConsensusProgress job={{...job,status:'complete',finished_at:122}}/>);
    expect(html).toContain('width:100%');expect(html).toContain('Results installed');
  });
  it('ticks elapsed time during long numerical operations without inventing progress',()=>{
    vi.useFakeTimers();vi.setSystemTime(112000);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
    const div=document.createElement('div'),root=createRoot(div);
    try{
      act(()=>root.render(<ConsensusProgress job={job}/>));
      expect(div.textContent).toContain('10s elapsed');
      act(()=>vi.advanceTimersByTime(5000));
      expect(div.textContent).toContain('15s elapsed');
      expect(div.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('20');
      act(()=>root.render(<ConsensusProgress job={{...job,status:'cancelled',finished_at:117}}/>));
      act(()=>vi.advanceTimersByTime(5000));
      expect(div.textContent).toContain('15s elapsed');
    }finally{act(()=>root.unmount());vi.useRealTimers();}
  });
  it('shows every step of the run: done, current (with its stage progress), still to come',()=>{
    const staged={...job,cr_mode:'staged_native_families',stage:'foreign_scoring',
      progress:{...job.progress!,stage:'foreign_scoring',completed:3,total:4,fraction:.75}} as ConsensusJob;
    const html=renderToStaticMarkup(<ConsensusProgress job={staged}/>);
    for(const label of ['Load reads','Fit classes per dataset','Score across datasets','Shared parent classes','Choose classes','Install layers'])
      expect(html).toContain(label);
    expect(html).toContain('Step 3 of 6');
    expect(html.match(/data-state="done"/g)).toHaveLength(2);
    expect(html).toMatch(/data-state="active"[^]*?width:75%/);
    expect(html.match(/data-state="pending"/g)).toHaveLength(3);
    const done=renderToStaticMarkup(<ConsensusProgress job={{...staged,status:'complete',stage:'complete',finished_at:130}}/>);
    expect(done).toContain('All 6 steps done');expect(done.match(/data-state="done"/g)).toHaveLength(6);
  });
});

describe('read-order check step', () => {
  it('appears only for a lattice-recaller run that asked for it, before Install layers', async () => {
    const {stagePlan,stageLabel}={...await import('./consensusStagePlan'),...await import('./ConsensusProgress')};
    const job=(orders:number,stage='recaller_robustness')=>({job_id:'j',status:'running',stage,cr_mode:'lattice_recaller',
      request:{parameters:{cr:{engine:'lattice_recaller'},recaller:{order_replicates:orders}}}}) as unknown as ConsensusJob;
    expect(stagePlan(job(0)).map(s=>s.key)).toEqual(['load','discover','score','install']);
    expect(stagePlan(job(2)).map(s=>s.key)).toEqual(['load','discover','score','robust','install']);
    expect(stageLabel(job(2))).toBe('Checking the classes with the reads in other orders');
  });
});
