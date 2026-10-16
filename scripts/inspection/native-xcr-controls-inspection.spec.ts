import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

/** Real frozen-result inspection. Never submits inference or changes curation. */
test('native XCR controls and archived provenance are explicit without changing evidence',async({page},info)=>{
  const base=process.env.FIBERBROWSER_NATIVE_CONSENSUS_INSPECT;
  test.skip(!base,'Requires an isolated imported native result');test.setTimeout(180000);page.setDefaultTimeout(20000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/shutdown',r=>r.abort());
  const schema=await(await page.request.get(`${base}/api/footprint/consensus/schema`)).json();
  const controls=Object.fromEntries(schema.groups.cross.map((c:any)=>[c.name,c]));
  for(const name of ['native_predictive_replicates','native_minimum_call_attribution_mass','native_minimum_geometry_retention','native_minimum_visible_geometry_mass','native_minimum_testable_fraction'])expect(controls[name]).toBeTruthy();
  const history=await(await page.request.get(`${base}/api/footprint/consensus/jobs`)).json();
  const jobUrl=`${base}/api/footprint/consensus/jobs/${history.active_job}`;
  const beforeJob=await(await page.request.get(jobUrl)).json();
  const beforeCuration=await(await page.request.get(`${jobUrl}/curation`)).json();
  const catalog=await(await page.request.get(`${jobUrl}/catalog`)).json();
  expect(beforeJob.cr_mode).toBe('native_family_distribution');
  const ds=beforeJob.request.dataset_ids.find((id:string)=>beforeJob.request.chemistry_overrides[id]==='ddda');
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;localStorage.clear();sessionStorage.clear();});
  await page.setViewportSize({width:2200,height:1500});
  await page.goto(`${base}/?chr=chr19&start=47514988&end=47515670&shared=1`,{waitUntil:'domcontentloaded'});
  const track=page.getByTestId(`consensus-family-track-${ds}`);await expect(track).toBeVisible({timeout:90000});
  const glyph=track.locator('[data-family-id]').first(),fid=await glyph.getAttribute('data-family-id');
  await glyph.click();const panel=page.getByTestId('consensus-tools');await expect(panel).toBeVisible();
  const family=catalog.datasets[ds].catalog.find((f:any)=>f.family===fid);
  const inspector=page.getByTestId('consensus-family-inspector');
  if(family.source_units!=null)await expect(inspector).toContainText(`${family.source_units} source units`);
  if(family.fit_diagnostics)await expect(inspector.getByText(`Frozen full-fit diagnostics · ${fid}`,{exact:true})).toBeVisible();
  await panel.locator('summary').filter({hasText:'3 · Cross-dataset relationships'}).click();
  // Existing generic controls include their help text in the accessible label.
  const draws=panel.getByRole('spinbutton',{name:/^Native XCR predictive reference draws /});
  const reference=panel.getByRole('spinbutton',{name:/^Native XCR predictive reference \(%\)/});
  const originalDraws=await draws.inputValue(),originalReference=await reference.inputValue();
  for(const label of ['Minimum full geometry mass overlapping this call','Minimum physically retained geometry mass','Minimum observable retained geometry mass','Minimum assessable source-call fraction'])await expect(panel.getByRole('spinbutton',{name:new RegExp('^'+label)})).toBeVisible();
  await expect(panel.getByRole('spinbutton',{name:/^Reciprocal shape likelihood tolerance/})).toHaveCount(0);
  await draws.fill('65535');await reference.fill('99.999');
  await expect(panel.getByTestId('native-xcr-precision')).toContainText('Not resolvable');
  await expect(panel.getByTestId('run-lattice-consensus')).toBeDisabled();
  await reference.fill('99.99');await expect(panel.getByTestId('native-xcr-precision')).toContainText('gate is resolvable');
  await draws.fill(originalDraws);await reference.fill(originalReference);
  await expect(panel.getByTestId('native-xcr-precision')).toContainText('not display filters');
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Increase read row height',exact:true}).click();
  for(const id of beforeJob.request.dataset_ids){
    const rows=page.locator(`[data-read-track-dataset-id="${id}"]`).first();
    await expect.poll(async()=>Number(await rows.getAttribute('data-read-track-render-count')),{timeout:90000}).toBeGreaterThan(0);
    await expect(rows).toHaveAttribute('data-read-track-loading','false',{timeout:90000});
  }
  await draws.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('native-xcr-controls.png'),fullPage:true});
  const afterJob=await(await page.request.get(jobUrl)).json();
  expect(afterJob.filters).toEqual(beforeJob.filters);expect(afterJob.request).toEqual(beforeJob.request);
  expect(await(await page.request.get(`${jobUrl}/curation`)).json()).toEqual(beforeCuration);
  expect((await(await page.request.get(`${base}/api/footprint/consensus/jobs`)).json()).jobs.map((j:any)=>j.job_id)).toEqual(history.jobs.map((j:any)=>j.job_id));
  expect(errors).toEqual([]);
  await writeFile(info.outputPath('native-xcr-controls-inspection.json'),JSON.stringify({url:base,job_id:history.active_job,
    inspected_family:fid,source_units:family.source_units,fit_diagnostics:family.fit_diagnostics,
    native_controls:Object.keys(controls).filter(k=>k.startsWith('native_')),new_inference_submitted:false,
    requests_unchanged:true,filters_unchanged:true,curation_unchanged:true,evidence_mocked:false,errors},null,2));
});
