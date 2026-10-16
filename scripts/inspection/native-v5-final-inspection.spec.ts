import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

test('finish only the recorded test merge, inspect the installed v5 UI and preserve automatic evidence',async({page},info)=>{
  const base=process.env.FIBERBROWSER_NATIVE_CONSENSUS_INSPECT,expectedJob=process.env.FIBERBROWSER_V5_TEST_OWNED_JOB;
  test.skip(!base||!expectedJob,'Requires explicitly identified test-owned v5 job');test.setTimeout(300000);page.setDefaultTimeout(30000);
  await page.route('**/api/shutdown',r=>r.abort());const errors:string[]=[],requestFailures:any[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('requestfailed',r=>{if(r.url().includes('/api/reads'))requestFailures.push({url:r.url(),failure:r.failure()});});
  const json=async(p:string)=>{const r=await page.request.get(`${base}${p}`);expect(r.ok()).toBe(true);return r.json();};
  const history=await json('/api/footprint/consensus/jobs');expect(history.active_job).toBe(expectedJob);
  const jpath=`/api/footprint/consensus/jobs/${expectedJob}`,job=await json(jpath),beforeCat=await json(jpath+'/catalog'),beforeCur=await json(jpath+'/curation');
  expect([1,2]).toContain(beforeCur.revision);expect(beforeCur.manual_groups.length).toBe(beforeCur.revision===1?1:0);
  if(beforeCur.revision===1){expect(beforeCur.operations).toHaveLength(1);expect(beforeCur.operations[0]).toMatchObject({operation:'merge',dataset_id:'napa_ddda_full',family_ids:['napa_ddda_full:F0044','napa_ddda_full:F0046'],applied_at_revision:1});}
  else{expect(beforeCur.operations).toEqual([]);expect(beforeCur.can_redo).toBe(true);}
  const ids=job.request.dataset_ids as string[],ddda='napa_ddda_full';
  const getReads=async()=>Object.fromEntries(await Promise.all(ids.map(async ds=>[ds,await json(`/api/reads/compact?${new URLSearchParams({dataset_id:ds,chrom:'chr19',start:'47514988',end:'47515670',max_reads:'100',include_layers:'true'})}`)])));
  const rows=(data:any,layer:string)=>data.reads.flatMap((r:any)=>(r.layers?.[layer]?.consensus_records??[]).map((c:any)=>({read:r.id,...c})));
  const keys=(data:any,layer:string)=>rows(data,layer).map((c:any)=>JSON.stringify([c.read,c.source_call_id,c.source_ordinal,c.interval])).sort();
  const before=await getReads();for(const ds of ids)expect(keys(before[ds],'tf_cr_manual')).toEqual(keys(before[ds],'tf_cr'));
  const sourceCall='napa_ddda_full:unit_fc12c5dca6d056479e8bdd5d:4';
  const detail=await json(`${jpath}/call?${new URLSearchParams({dataset_id:ddda,source_call_id:sourceCall})}`);
  const attribution=detail.call.native_cross_tests.find((t:any)=>t.link_id==='X000888');
  expect(attribution.recipient_evidence.status).toBe('hypothesis_not_attributable_to_this_call');
  expect(attribution.recipient_evidence.geometry_mass_overlapping_observed_call).toBe(0);
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;localStorage.clear();sessionStorage.clear();});
  await page.setViewportSize({width:2200,height:1500});await page.goto(`${base}/?chr=chr19&start=47514988&end=47515670&shared=1`,{waitUntil:'domcontentloaded'});
  const strip=page.getByTestId(`consensus-family-track-${ddda}`);await expect(strip).toBeVisible({timeout:90000});
  await strip.locator('[data-family-id="napa_ddda_full:F0065"]').click();const panel=page.getByTestId('consensus-tools');await expect(panel).toBeVisible();
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Increase read row height',exact:true}).click();
  const actions=panel.getByTestId('consensus-curation-panel');
  if(beforeCur.revision===1){
    await panel.getByTestId('consensus-layer-tf_cr_manual').check();
    await actions.getByRole('button',{name:'Undo edit',exact:true}).click();
    await expect.poll(async()=>(await json(jpath+'/curation')).revision,{timeout:90000}).toBe(2);
    await expect.poll(async()=>(await json(jpath+'/curation')).manual_groups.length,{timeout:90000}).toBe(0);
  }
  console.log('test-owned merge undone; original calls preserved');
  const ready=async()=>{for(const ds of ids){const track=page.locator(`[data-read-track-dataset-id="${ds}"]`).first();await expect(track).toHaveAttribute('data-read-track-loading','false',{timeout:90000});await expect.poll(async()=>Number(await track.getAttribute('data-read-track-render-count'))).toBeGreaterThan(0);}};
  await ready();console.log('initial rows hydrated');
  const layers=['tf_native_replay','tf_sr_lattice','tf_cr','tf_cr_manual','tf_recall','tf_cr_recalled','tf_xcr','nuc_cr_split','cr_split_gap'];
  for(const layer of layers){const toggle=panel.getByTestId(`consensus-layer-${layer}`);await expect(toggle).toBeVisible();await toggle.uncheck();await expect(toggle).not.toBeChecked();await ready();await toggle.check();await expect(toggle).toBeChecked();await ready();}
  await expect(panel.getByTestId('native-xcr-summary')).toContainText('5390');await expect(panel.getByTestId('native-xcr-summary')).toContainText('84');
  for(const layer of ['tf_native_replay','tf_cr_manual','tf_recall','tf_cr_recalled','nuc_cr_split','cr_split_gap'])await panel.getByTestId(`consensus-layer-${layer}`).uncheck();
  await actions.getByRole('button',{name:'Clear',exact:true}).click();
  await expect(panel.getByTestId('native-xcr-summary')).toContainText('5390',{timeout:90000});
  for(const ds of ids){const track=page.locator(`[data-read-track-dataset-id="${ds}"]`).first();await expect(track).toHaveAttribute('data-read-track-loading','false',{timeout:90000});await expect.poll(async()=>Number(await track.getAttribute('data-read-track-render-count'))).toBeGreaterThan(0);}
  await panel.getByTestId('native-xcr-summary').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('native-v5-full-nfr.png'),fullPage:true});
  const afterCat=await json(jpath+'/catalog'),afterJob=await json(jpath),afterCur=await json(jpath+'/curation'),after=await getReads();
  for(const ds of ids){expect(keys(after[ds],'tf_cr')).toEqual(keys(before[ds],'tf_cr'));expect(keys(after[ds],'tf_cr_manual')).toEqual(keys(before[ds],'tf_cr'));}
  expect(afterCat.edges).toEqual(beforeCat.edges);
  const geometry=(cat:any)=>Object.fromEntries(Object.entries(cat.datasets).map(([ds,d]:[string,any])=>[ds,d.catalog.map((f:any)=>[f.family,f.consensus_start,f.consensus_end])]));
  expect(geometry(afterCat)).toEqual(geometry(beforeCat));expect(afterJob.request).toEqual(job.request);expect(afterJob.filters).toEqual(job.filters);
  expect(afterCur.manual_groups).toEqual([]);expect(afterCur.can_redo).toBe(true);expect(afterCur.revision).toBe(2);expect(errors).toEqual([]);
  await writeFile(info.outputPath('native-v5-final-inspection.json'),JSON.stringify({url:base,job_id:expectedJob,edges:afterCat.edges.length,compatible:afterCat.edges.filter((e:any)=>e.comparable).length,count_groups:afterCat.count_groups?.length,
    layers_tested:layers,generic_layer_keys_unique_unit_test:true,selected_call:detail,source_counts:Object.fromEntries(ids.map(ds=>[ds,keys(before[ds],'tf_cr').length])),
    automatic_graph_unchanged:true,automatic_geometry_unchanged:true,source_spans_unchanged:true,filters_unchanged:true,request_unchanged:true,
    test_owned_merge_undone:true,curation_at_end:afterCur,new_inference_submitted:false,evidence_mocked:false,requestFailures,errors},null,2));
});
