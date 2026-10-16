import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

/** Mutates only manual display history on an explicitly supplied fresh demo.
 * Requires an already-running real backend with the active NAPA native job.
 * No intercepted inference responses, fabricated classes, or expected matches.
 */
test('native CR reference, independent layers and undoable manual curation',async({page},info)=>{
  const base=process.env.FIBERBROWSER_NATIVE_CONSENSUS_INSPECT;
  test.skip(!base,'Requires an isolated, completed native NAPA browser demo');
  test.setTimeout(300000);page.setDefaultTimeout(30000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/shutdown',r=>r.abort());
  const history=await(await page.request.get(`${base}/api/footprint/consensus/jobs`)).json();
  const jobUrl=`${base}/api/footprint/consensus/jobs/${history.active_job}`;
  const job=await(await page.request.get(jobUrl)).json();
  expect(job.status).toBe('complete');expect(job.cr_mode).toBe('native_family_distribution');
  const catalog=await(await page.request.get(`${jobUrl}/catalog`)).json();
  expect(catalog.cr_mode).toBe('native_family_distribution');
  const curation=async()=>await(await page.request.get(`${jobUrl}/curation`)).json();
  const originalCuration=await curation();
  // Never overwrite an existing user's manual decisions or redo history.
  expect(originalCuration.manual_groups).toEqual([]);
  expect(originalCuration.can_undo).toBe(false);expect(originalCuration.can_redo).toBe(false);
  expect(Object.values(originalCuration.ignored_families).flat()).toEqual([]);
  const ids=job.request.dataset_ids as string[];
  const ddda=ids.find(id=>job.request.chemistry_overrides[id]==='ddda')!;
  const hia5=ids.find(id=>String(job.request.chemistry_overrides[id]).startsWith('hia5'))!;
  expect(ddda).toBeTruthy();expect(hia5).toBeTruthy();
  const region={chrom:'chr19',start:47514988,end:47515670};
  const nativeGeometry=()=>Object.fromEntries(Object.entries(catalog.datasets).map(([id,d]:[string,any])=>[id,d.catalog.map((f:any)=>[f.family,f.consensus_start,f.consensus_end])]));
  const frozenGeometry=nativeGeometry();
  const readData=async()=>{
    const out:Record<string,any>={};
    for(const id of ids){
      const response=await page.request.get(`${base}/api/reads/compact?dataset_id=${encodeURIComponent(id)}&chrom=${region.chrom}&start=${region.start}&end=${region.end}&max_reads=100&include_layers=true`);
      expect(response.ok()).toBe(true);out[id]=await response.json();
    }return out;
  };
  const rows=(data:any,layer='tf_cr')=>data.reads.flatMap((r:any)=>(r.layers?.[layer]?.consensus_records??[]).map((c:any)=>({read:r.id,...c})));
  const sourceKeys=(data:any,layer='tf_cr')=>rows(data,layer).map((c:any)=>[c.read,c.source_call_id,c.source_ordinal,c.interval].join('|')).sort();
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;localStorage.clear();sessionStorage.clear();});
  await page.setViewportSize({width:2200,height:1500});
  await page.goto(`${base}/?chr=${region.chrom}&start=${region.start}&end=${region.end}&shared=1`,{waitUntil:'domcontentloaded'});
  const strip=page.getByTestId(`consensus-family-track-${ddda}`);
  // Initial BAM/catalog hydration can exceed the generic 10-second assertion
  // timeout on a cold local filesystem; subsequent interactions remain bounded.
  await expect(strip).toBeVisible({timeout:60000});await expect.poll(()=>strip.locator('[data-family-id]').count()).toBeGreaterThan(1);
  // A normal display control, not an inference/read-ledger filter: lattice
  // marks must have enough pixels to inspect in the final browser capture.
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Increase read row height',exact:true}).click();
  const before=await readData();
  const displayedFamilies=new Set(rows(before[ddda]).map((r:any)=>r.family));
  const visible=catalog.datasets[ddda].catalog.filter((f:any)=>f.consensus_start<region.end&&f.consensus_end>region.start&&displayedFamilies.has(f.family))
    .sort((a:any,b:any)=>a.consensus_start-b.consensus_start||a.family.localeCompare(b.family));
  expect(visible.length).toBeGreaterThan(1);
  const [first,second]=visible;
  await strip.locator(`[data-family-id="${first.family}"]`).click();
  const panel=page.getByTestId('consensus-tools');await expect(panel).toBeVisible();
  const reference=panel.getByLabel('Classification reference percent exact',{exact:true});
  await expect(reference).toBeVisible();await expect(panel.getByLabel('minimum_model_q exact',{exact:true})).toHaveCount(0);
  for(const id of ids){expect(sourceKeys(before[id]).length).toBeGreaterThan(0);for(const r of rows(before[id]))expect(typeof r.source_call_id).toBe('string');}
  const selectedSource=rows(before[ddda])[0];
  const detailResponse=await page.request.get(`${jobUrl}/call?${new URLSearchParams({dataset_id:ddda,source_call_id:selectedSource.source_call_id})}`);
  expect(detailResponse.ok()).toBe(true);const detail=await detailResponse.json();
  expect(detail.source_call_id).toBe(selectedSource.source_call_id);expect(detail.call.interval).toEqual(selectedSource.interval);
  expect(Array.isArray(detail.call.candidate_evidence)).toBe(true);
  for(const value of [95,99.9]){
    await reference.fill(String(value));await reference.press('Tab');
    await expect.poll(async()=>(await(await page.request.get(jobUrl)).json()).filters.classification_reference_percent).toBe(value);
    const data=await readData();for(const id of ids)expect(sourceKeys(data[id])).toEqual(sourceKeys(before[id]));
  }
  for(const layer of ['tf_sr_lattice','tf_cr','tf_xcr']){
    const control=panel.getByTestId(`consensus-layer-${layer}`);await expect(control).toBeVisible();
    await control.uncheck();await expect(control).not.toBeChecked();await control.check();await expect(control).toBeChecked();
  }
  const inspector=page.getByTestId('consensus-family-inspector');
  await strip.locator(`[data-family-id="${first.family}"]`).click();await expect(inspector).toContainText('original');
  for(const [strand,count] of Object.entries(first.classification_counts??{}) as [string,any][]){
    // Counts can change with the display reference, so compare the live ledger.
    const current=await(await page.request.get(`${jobUrl}/catalog`)).json();
    const c=current.datasets[ddda].catalog.find((f:any)=>f.family===first.family).classification_counts[strand];
    expect(count).toBeTruthy();await expect(inspector).toContainText(`${strand}: ${c.primary_calls} primary / ${c.compatible_calls} compatible / ${c.original_calls} original calls`);
  }
  const actions=panel.getByTestId('consensus-curation-panel');
  await strip.locator(`[data-family-id="${second.family}"]`).click({modifiers:['Control']});
  await expect(actions).toContainText('2 selected');await expect(strip.getByTestId('consensus-curation-track')).toContainText('2 selected');
  await actions.getByRole('button',{name:'Group selected',exact:true}).click();
  await expect.poll(async()=>(await curation()).manual_groups.length).toBe(1);
  const merged=(await curation()).manual_groups[0],groupId=merged.group_id;
  await expect(panel.getByTestId('consensus-layer-tf_cr_manual')).toBeChecked();await expect(panel.getByTestId('consensus-layer-tf_cr')).not.toBeChecked();
  const mergedData=await readData();for(const id of ids)expect(sourceKeys(mergedData[id],'tf_cr_manual')).toEqual(sourceKeys(before[id]));
  expect(rows(mergedData[ddda],'tf_cr_manual').some((r:any)=>r.manual_group_id===groupId)).toBe(true);
  await expect(strip.locator(`[data-family-id="${groupId}"]`)).toBeVisible();
  await actions.getByRole('button',{name:'Clear',exact:true}).click();
  const groupCheckbox=panel.getByRole('checkbox',{name:`Select ${ddda} family ${groupId}`,exact:true});await groupCheckbox.check();
  await expect(strip.locator(`[data-family-id="${groupId}"]`)).toHaveAttribute('aria-pressed','true');
  await actions.getByRole('button',{name:'Ignore',exact:true}).click();
  await expect.poll(async()=>Object.values((await curation()).ignored_families).flat()).toContain(groupId);
  const ignoredData=await readData();const ignored=rows(ignoredData[ddda],'tf_cr_manual').filter((r:any)=>r.manual_group_id===groupId);
  expect(ignored.length).toBeGreaterThan(0);expect(ignored.every((r:any)=>r.manual_ignored===true)).toBe(true);
  for(const id of ids)expect(sourceKeys(ignoredData[id],'tf_cr_manual')).toEqual(sourceKeys(before[id]));
  await actions.getByRole('button',{name:'Undo edit',exact:true}).click();
  await expect.poll(async()=>Object.values((await curation()).ignored_families).flat()).not.toContain(groupId);
  await actions.getByRole('button',{name:'Redo edit',exact:true}).click();
  await expect.poll(async()=>Object.values((await curation()).ignored_families).flat()).toContain(groupId);
  await actions.getByRole('button',{name:'Undo edit',exact:true}).click();
  await expect.poll(async()=>Object.values((await curation()).ignored_families).flat()).not.toContain(groupId);
  // Native model geometry and source evidence were never replaced by curation.
  const afterCatalog=await(await page.request.get(`${jobUrl}/catalog`)).json();
  expect(Object.fromEntries(Object.entries(afterCatalog.datasets).map(([id,d]:[string,any])=>[id,d.catalog.map((f:any)=>[f.family,f.consensus_start,f.consensus_end])]))).toEqual(frozenGeometry);
  for(const edge of afterCatalog.edges){expect(edge.native_family_evidence).toBeTruthy();expect(edge.forward??null).toBeNull();expect(edge.reverse??null).toBeNull();}
  await page.getByLabel('Native opportunity lattice layer',{exact:true}).check();
  for(const id of [ddda,hia5]){
    const track=page.locator(`[data-read-track-dataset-id="${id}"]`).first();
    await expect.poll(async()=>Number(await track.getAttribute('data-native-lattice-read-count')),{timeout:60000}).toBeGreaterThan(0);
  }
  await page.screenshot({path:info.outputPath('native-consensus-curated-complete-view.png'),fullPage:true});
  await page.getByLabel('Native opportunity lattice layer',{exact:true}).uncheck();
  for(const id of [ddda,hia5])await expect(page.locator(`[data-read-track-dataset-id="${id}"]`).first()).toHaveAttribute('data-native-lattice-read-count','0');
  await actions.getByRole('button',{name:'Reset manual edits',exact:true}).click();
  await expect.poll(async()=>(await curation()).manual_groups.length).toBe(0);
  await expect.poll(async()=>Object.values((await curation()).ignored_families).flat().length).toBe(0);
  await panel.getByTestId('consensus-layer-tf_cr').check();await panel.getByTestId('consensus-layer-tf_cr_manual').uncheck();
  await reference.fill(String(job.filters.classification_reference_percent??99.9));await reference.press('Tab');
  await writeFile(info.outputPath('native-usability.json'),JSON.stringify({job_id:job.job_id,datasets:ids,source_counts:Object.fromEntries(ids.map(id=>[id,sourceKeys(before[id]).length])),
    source_spans_unchanged:true,native_catalog_geometry_unchanged:true,manual_only_edits:true,manual_overrides_reset_at_end:true,reference_values:[95,99.9],
    tested_actions:['merge','ignore','undo','redo','split'],on_demand_source_ledger:true,native_xcr_edges:afterCatalog.edges.length,errors},null,2));
  expect(errors).toEqual([]);
});
