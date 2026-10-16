/** Inspect an already completed, real all-unit workflow without rerunning inference.
 * Set FIBERBROWSER_CONSENSUS_INSPECT=http://127.0.0.1:8766.
 * Verifies API records AND the pixels rendered by the actual browser.
 */
import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('frozen NAPA layers render and stringency only removes assignments',async({page},info)=>{
  const base=process.env.FIBERBROWSER_CONSENSUS_INSPECT;
  test.skip(!base,'Requires a live current Browser with a completed NAPA workflow');
  test.setTimeout(300_000);page.setDefaultTimeout(30_000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/shutdown',r=>r.abort());
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;
    localStorage.clear();sessionStorage.clear();});
  const history=await(await page.request.get(`${base}/api/footprint/consensus/jobs`)).json();
  const job=history.jobs.find((j:any)=>j.job_id===history.active_job);
  expect(job?.status).toBe('complete');
  const runtimeSchema=await(await page.request.get(`${base}/api/footprint/consensus/schema`)).json();
  expect(runtimeSchema.runtime.workflow_path).toContain('/fiberhmm/inference/consensus/workflow.py');
  expect(runtimeSchema.groups.cr.find((v:any)=>v.name==='global_iterations').default).toBe(800);
  expect(Object.values(job.summary).every((s:any)=>s.numerical_fit?.selected_converged===true)).toBeTruthy();
  const jobUrl=`${base}/api/footprint/consensus/jobs/${job.job_id}`;
  const defaults={minimum_model_q:0,minimum_comparability_q:0,require_population_comparable:false,
    require_molecule_comparable:false,require_cross_comparable:false,show_quality_outlines:true};
  expect((await page.request.post(`${jobUrl}/filters`,{data:defaults})).ok()).toBeTruthy();
  await page.setViewportSize({width:2000,height:1300});
  await page.goto(base!,{waitUntil:'domcontentloaded'});
  await expect(page.getByRole('combobox',{name:'Chromosome',exact:true}).locator('option[value="chr19"]')).toHaveCount(1);
  async function navigate(region:string){
    await page.getByTestId('location-search-input').fill(region);
    await page.getByTestId('location-search-submit').click();
  }
  await navigate('chr19:47514988-47515670');
  await page.getByTestId('analysis-strip-button-footprint-analysis').click();
  const panel=page.getByTestId('consensus-tools');await expect(panel).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('complete');
  await expect(panel.getByLabel('Consensus start (0-based)',{exact:true})).toHaveValue('47514487');
  await expect(panel.getByLabel('Consensus end (exclusive)',{exact:true})).toHaveValue('47518985');
  await expect(panel.getByText(/Inference settings edited/)).toHaveCount(0);
  // The panel must show the settings actually used by the restored job.
  await expect(panel.locator('summary').filter({hasText:'Cross-dataset relationships'})).toContainText('on');
  await expect(panel.getByRole('checkbox',{name:/XCR · native-family relationships/})).toBeVisible();
  for(let i=0;i<5;i++)await page.getByRole('button',{name:'Increase read row height',exact:true}).first().click();
  const ids=job.request.dataset_ids as string[];
  const tracks=ids.map(id=>page.locator(`[data-read-track-dataset-id="${id}"]`).first());
  async function settled(){for(const track of tracks){
    await expect(track).toHaveAttribute('data-read-track-loading','false');
    await expect.poll(async()=>Number(await track.getAttribute('data-read-track-render-count'))).toBeGreaterThan(0);
  }}
  async function reads(){
    const out:Record<string,any>={};for(const id of ids){
      const res=await page.request.get(`${base}/api/reads/compact?dataset_id=${id}&chrom=chr19&start=47514988&end=47515670&max_reads=100&include_layers=true`);
      expect(res.ok()).toBeTruthy();out[id]=await res.json();
    }return out;
  }
  const keys=(d:any,layer:string)=>d.reads.flatMap((r:any)=>(r.layers?.[layer]?.consensus_records??[])
    .map((c:any)=>`${r.id}|${c.family??c.kind}|${c.interval.join(':')}`)).sort();
  const native=(d:any)=>d.reads.map((r:any)=>[r.id,r.layers?.tf,r.layers?.nuc]);
  const catalog=await(await page.request.get(`${jobUrl}/catalog`)).json();
  expect(catalog.count_groups.length).toBeGreaterThan(0);
  for(const group of catalog.count_groups){
    expect(group.quantification_equivalence_established).toBe(false);
    expect(group.molecule_detection_power_established).toBe(false);
    expect(group.rescue_counts_used).toBe(false);
  }
  const before=await reads();
  for(const id of ids){
    expect(keys(before[id],'tf_cr').length).toBeGreaterThan(50);
    expect(keys(before[id],'tf_xcr').length).toBeGreaterThan(10);
  }
  const ddda=ids.find(id=>job.request.chemistry_overrides[id]==='ddda')!;
  const left=before[ddda].reads.flatMap((r:any)=>r.layers?.tf_cr?.consensus_records??[])
    .filter((c:any)=>c.interval[0]<47515135&&c.interval[1]>47515070);
  expect(left.length).toBeGreaterThan(10);
  expect(new Set(left.map((c:any)=>c.family)).size).toBeGreaterThan(1);
  await settled();
  // Inspect canvas pixels, not just JSON: distinctive CR class hues must exist
  // on BOTH datasets. Raw TF/nucleosome colors cannot satisfy these ranges.
  async function classPixels(){return Promise.all(tracks.map(t=>t.locator('canvas').first().evaluate((canvas:HTMLCanvasElement)=>{
    const ctx=canvas.getContext('2d')!;const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;let n=0;
    for(let i=0;i<rgba.length;i+=4){const[r,g,b]=[rgba[i],rgba[i+1],rgba[i+2]];
      if((r>145&&r<240&&g>80&&g<185&&b<110)||(r>100&&r<200&&g>55&&g<140&&b>130&&b<220))n++;
    }return n;
  })));}
  await expect.poll(async()=>Math.min(...await classPixels())).toBeGreaterThan(100);
  const pixelCounts=await classPixels();
  await page.screenshot({path:info.outputPath('napa-footprint-panel-Q0.png'),fullPage:true});
  await panel.getByLabel('minimum_model_q exact',{exact:true}).fill('10');
  // A full read refresh can occupy the backend for >10 seconds; wait for
  // the acknowledged filter value, not an arbitrary sleep or local checkbox.
  await expect.poll(async()=>(await(await page.request.get(jobUrl)).json()).filters.minimum_model_q,{timeout:30000}).toBe(10);
  const strict=await reads();
  for(const id of ids){
    const looseSet=new Set(keys(before[id],'tf_cr'));const strictKeys=keys(strict[id],'tf_cr');
    expect(strictKeys.length).toBeLessThan(looseSet.size);
    expect(strictKeys.every((k:string)=>looseSet.has(k))).toBeTruthy();
    expect(native(strict[id])).toEqual(native(before[id]));
  }
  expect(await(await page.request.get(`${jobUrl}/catalog`)).json()).toEqual(catalog);
  await settled();await page.screenshot({path:info.outputPath('napa-footprint-panel-Q10.png'),fullPage:true});
  await panel.getByLabel('minimum_model_q exact',{exact:true}).fill('0');
  await expect.poll(async()=>(await(await page.request.get(jobUrl)).json()).filters.minimum_model_q,{timeout:30000}).toBe(0);
  for(const id of ids)expect(keys((await reads())[id],'tf_cr')).toEqual(keys(before[id],'tf_cr'));
  await panel.getByLabel('Only shape-compatible XCR links',{exact:true}).check();
  await expect.poll(async()=>(await(await page.request.get(jobUrl)).json()).filters.require_cross_comparable,{timeout:30000}).toBe(true);
  const comparable=await reads();
  for(const id of ids){const records=comparable[id].reads.flatMap((r:any)=>r.layers?.tf_xcr?.consensus_records??[]);
    expect(records.length).toBeGreaterThan(0);expect(records.every((r:any)=>r.cross_comparable)).toBeTruthy();
    expect(keys(comparable[id],'tf_cr')).toEqual(keys(before[id],'tf_cr'));
  }
  await settled();await page.screenshot({path:info.outputPath('napa-footprint-panel-XCR-comparable.png'),fullPage:true});
  await panel.getByLabel('Only shape-compatible XCR links',{exact:true}).uncheck();
  await expect.poll(async()=>(await(await page.request.get(jobUrl)).json()).filters.require_cross_comparable,{timeout:30000}).toBe(false);
  await navigate('chr19:47515059-47515187');await settled();
  await page.screenshot({path:info.outputPath('napa-difficult-left.png'),fullPage:true});
  await navigate('chr19:47515538-47515640');await settled();
  await page.screenshot({path:info.outputPath('napa-ctcf-split.png'),fullPage:true});
  await navigate('chr19:47514988-47515670');await settled();
  // Isolate the class layer: a red outline or purple SR paint must not count
  // as proof that CR's categorical fills rendered.
  const schema=await(await page.request.get(`${base}/api/footprint/consensus/schema`)).json();
  for(const name of job.layers){const label=schema.layers[name][0] as string;
    await panel.getByRole('checkbox',{name:new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).setChecked(name==='tf_cr');
  }
  await panel.getByLabel('Show comparability outlines',{exact:true}).uncheck();
  await expect.poll(async()=>(await(await page.request.get(jobUrl)).json()).filters.show_quality_outlines,{timeout:30000}).toBe(false);
  await expect(panel.getByTestId('consensus-filters-pending')).toHaveCount(0);
  await settled();
  const palette=['#d88724','#497fc5','#9566bb','#28a88f','#c35b93','#6b9b2c','#b26345','#5da6bd',
    '#cbb12a','#7362b9','#dc7168','#428d73','#a767a0','#707da6','#b48c55','#729e9e'];
  const colorCounts=await Promise.all(tracks.map(t=>t.locator('canvas').first().evaluate((canvas:HTMLCanvasElement,colors)=>{
    const rgba=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    return colors.map(hex=>{const rgb=[1,3,5].map(p=>parseInt(hex.slice(p,p+2),16));let n=0;
      for(let i=0;i<rgba.length;i+=4)if(rgb.every((v,c)=>Math.abs(v-rgba[i+c])<=14))n++;
      return n;});
  },palette)));
  for(const counts of colorCounts)expect(counts.filter(n=>n>100).length).toBeGreaterThanOrEqual(3);
  await page.screenshot({path:info.outputPath('napa-CR-only.png'),fullPage:true});
  await navigate('chr19:47515059-47515187');await settled();
  await page.screenshot({path:info.outputPath('napa-difficult-left-CR-only.png'),fullPage:true});
  await navigate('chr19:47514988-47515670');await settled();
  await writeFile(info.outputPath('inspection.json'),JSON.stringify({job_id:job.job_id,pixelCounts,
    counts:Object.fromEntries(ids.map(id=>[id,{Q0:keys(before[id],'tf_cr').length,Q10:keys(strict[id],'tf_cr').length,
      XCR:keys(before[id],'tf_xcr').length,comparableXCR:keys(comparable[id],'tf_xcr').length}])),
    leftAssignments:left.length,palette,colorCounts},null,2));
  expect(errors).toEqual([]);
});
