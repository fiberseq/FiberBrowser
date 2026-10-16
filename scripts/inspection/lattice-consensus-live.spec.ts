/** Opt-in acceptance against an already running, current Browser with NAPA open.
 * FIBERBROWSER_CONSENSUS_LIVE=http://127.0.0.1:8766 npx playwright test lattice-consensus-live
 * No mock responses, no sampled inference, no modification of source BAMs.
 */
import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('full NAPA consensus workflow from the Footprint panel', async ({page},info)=>{
  const base=process.env.FIBERBROWSER_CONSENSUS_LIVE;
  test.skip(!base,'Set FIBERBROWSER_CONSENSUS_LIVE to a current Browser with the two NAPA datasets open');
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(60_000);page.setDefaultNavigationTimeout(30_000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/shutdown',route=>route.abort());
  await page.addInitScript(()=>{
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;
    localStorage.clear();sessionStorage.clear();
  });
  await page.setViewportSize({width:1920,height:1200});
  await page.goto(base!,{waitUntil:'domcontentloaded'});
  await expect(page.getByRole('combobox',{name:'Chromosome',exact:true}).locator('option[value="chr19"]')).toHaveCount(1);
  await page.getByTestId('location-search-input').fill('chr19:47514988-47515670');
  await page.getByTestId('location-search-submit').click();
  await page.getByTestId('analysis-strip-button-footprint-analysis').click();
  const panel=page.getByTestId('consensus-tools');await expect(panel).toBeVisible();
  await expect(panel.getByTestId('run-lattice-consensus')).toBeEnabled();
  await panel.getByLabel('Consensus chromosome',{exact:true}).fill('chr19');
  await panel.getByLabel('Consensus start (0-based)',{exact:true}).fill('47514487');
  await panel.getByLabel('Consensus end (exclusive)',{exact:true}).fill('47518985');
  for(const group of ['Cross-dataset relationships','Strict new-footprint rescue','CT/GA comparability','CR-supported nucleosome splitting']) {
    const section=panel.locator('details').filter({has:page.locator('summary').filter({hasText:group})});
    await section.locator('summary').click();
    await section.locator('input[type=checkbox]').first().check();
    await section.locator('summary').click();
  }
  await page.screenshot({path:info.outputPath('footprint-panel-parameters.png'),fullPage:true});
  await expect(panel.getByLabel('Consensus chromosome',{exact:true})).toHaveValue('chr19');
  const submitted=page.waitForResponse(r=>r.url().endsWith('/api/footprint/consensus/jobs')&&r.request().method()==='POST');
  await panel.getByTestId('run-lattice-consensus').click();
  const response=await submitted;expect(response.ok(),await response.text()).toBeTruthy();
  let job=await response.json();
  await writeFile(info.outputPath('job.json'),JSON.stringify(job,null,2));
  console.log('CONSENSUS_JOB',job.job_id,job.artifact_dir);
  let last='';
  for(let i=0;i<3300;i++) {
    const res=await page.request.get(`${base}/api/footprint/consensus/jobs/${job.job_id}`);
    job=await res.json();
    if(job.stage!==last){console.log('STAGE',job.stage,job.message);last=job.stage;}
    if(['complete','error','cancelled'].includes(job.status))break;
    await page.waitForTimeout(1000);
  }
  await writeFile(info.outputPath('completed-job.json'),JSON.stringify(job,null,2));
  expect(job.status,job.message).toBe('complete');
  await expect(panel.getByRole('status')).toContainText('Frozen consensus layers installed',{timeout:10000});
  expect(Object.values(job.summary).map((s:any)=>s.units).sort((a:number,b:number)=>a-b)).toEqual([131,2873]);
  expect(job.layers).toContain('tf_xcr');expect(job.layers).toContain('nuc_cr_split');
  expect(job.cross_summary.comparable_edges).toBeGreaterThan(2);
  const catalog=await(await page.request.get(`${base}/api/footprint/consensus/jobs/${job.job_id}/catalog`)).json();
  await writeFile(info.outputPath('catalog.json'),JSON.stringify(catalog));
  const ids=Object.keys(job.summary);
  const getReads=async()=>{
    const out:Record<string,any>={};
    for(const id of ids)out[id]=await(await page.request.get(`${base}/api/reads/compact?chrom=chr19&start=47514988&end=47515670&dataset_id=${id}&max_reads=100`)).json();
    return out;
  };
  const before=await getReads();
  await writeFile(info.outputPath('visible-q0.json'),JSON.stringify(before));
  await page.screenshot({path:info.outputPath('napa-consensus-q0.png'),fullPage:true});
  await panel.getByLabel('minimum_model_q exact',{exact:true}).fill('10');
  await expect.poll(async()=> (await(await page.request.get(`${base}/api/footprint/consensus/jobs/${job.job_id}`)).json()).filters.minimum_model_q).toBe(10);
  const strict=await getReads();await writeFile(info.outputPath('visible-q10.json'),JSON.stringify(strict));
  await page.screenshot({path:info.outputPath('napa-consensus-q10.png'),fullPage:true});
  const after=await(await page.request.get(`${base}/api/footprint/consensus/jobs/${job.job_id}/catalog`)).json();
  expect(after).toEqual(catalog);expect(errors).toEqual([]);
  await panel.getByLabel('minimum_model_q exact',{exact:true}).fill('0');
});
