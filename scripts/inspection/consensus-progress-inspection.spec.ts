/** Read-only browser inspection: deterministic job events, real application UI.
 * Vite preview serves the tested build; GETs proxy to an inspection server.
 * No analysis is submitted and cancellation is intercepted (no server writes).
 */
import {test,expect} from '@playwright/test';

test.afterEach(async({page})=>{
  // Read rendering may still have a slow BAM GET in flight when this focused
  // progress test finishes; page teardown must not turn that into a test error.
  await page.unrouteAll({behavior:'ignoreErrors'});
});

test('consensus progress fills, survives reopening and reports cancellation',async({page},info)=>{
  const ui=process.env.CONSENSUS_PROGRESS_UI,api=process.env.CONSENSUS_PROGRESS_API;
  test.skip(!ui||!api,'Set current-source Vite URL and existing read-only browser API');
  test.setTimeout(120000);
  const history=await(await page.request.get(`${api}/api/footprint/consensus/jobs`)).json();
  const previous=history.jobs.find((j:any)=>j.job_id===history.active_job)??history.jobs.at(-1);
  expect(previous).toBeTruthy();
  const dataset=previous.request.dataset_ids[0];
  let job={...previous,job_id:'progress-ui-fixture',status:'running',stage:'cr_classification',
    created_at:Date.now()/1000-43,started_at:Date.now()/1000-42,finished_at:undefined,updated_at:Date.now()/1000,
    summary:undefined,cross_summary:undefined,
    message:`${dataset}: F0056 · held-out model 4/10 · optimizer iteration 12`,
    progress:{stage:'cr_classification',task:'initial_catalog',dataset_id:dataset,completed:64,total:322,
      fraction:64/322,unit:'families',stage_started_at:Date.now()/1000-20,semantics:'completed items, not time'}};
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),pathname=url.pathname;
    if(pathname==='/api/footprint/consensus/jobs'){
      await route.fulfill({json:{active_job:previous.job_id,jobs:[previous,job]}});return;
    }
    if(pathname===`/api/footprint/consensus/jobs/${job.job_id}`){
      if(request.method()==='DELETE')job={...job,status:'cancelling',
        message:'Cancelling at the next safe evidence/optimizer checkpoint',updated_at:Date.now()/1000};
      await route.fulfill({json:job});return;
    }
    if(pathname==='/api/jupyter/state'){await route.fulfill({json:{enabled:false,connected:false}});return;}
    // This UI test must never start inference/change the live session.
    if(request.method()!=='GET'){await route.abort();return;}
    const response=await route.fetch({url:`${api}${pathname}${url.search}`});
    await route.fulfill({response});
  });
  await page.addInitScript(()=>{
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;
    localStorage.clear();sessionStorage.clear();
  });
  await page.setViewportSize({width:1700,height:1100});
  await page.goto(`${ui}/?chr=chr19&start=47514988&end=47515670&shared=1`,{waitUntil:'domcontentloaded'});
  await page.getByTestId('analysis-strip-button-footprint-analysis').click();
  const panel=page.getByTestId('consensus-tools'),progress=panel.getByTestId('consensus-progress');
  await expect(progress).toBeVisible({timeout:60000});
  await expect(progress).toContainText('64 / 322 families completed');
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow',String(100*64/322));
  await expect(progress).toContainText('held-out model 4/10');
  job={...job,updated_at:Date.now()/1000,progress:{...job.progress,completed:226,fraction:226/322},
    message:`${dataset}: F0227 · testing native recipients 96/130`};
  await expect(progress).toContainText('226 / 322 families completed');
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow',String(100*226/322));
  await progress.screenshot({path:info.outputPath('consensus-progress-running.png')});
  await panel.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(progress).toContainText('Cancellation requested');
  await expect(progress).toContainText('Previous layers remain available');
  job={...job,status:'cancelled',message:'Cancelled; previous successful layers retained',finished_at:Date.now()/1000};
  await expect(progress).toContainText('Consensus cancelled');
  await expect(progress).toContainText('No new result was installed');
  await progress.screenshot({path:info.outputPath('consensus-progress-cancelled.png')});
  expect(errors).toEqual([]);
});
