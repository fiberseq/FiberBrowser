import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

test('independent UBA1 locus exposes real CR and XCR without changing native intervals',async({page},info)=>{
  const base=process.env.FIBERBROWSER_UBA1_INSPECT;test.skip(!base,'Requires completed real UBA1 run');
  test.setTimeout(240000);page.setDefaultTimeout(30000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/shutdown',r=>r.abort());
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;localStorage.clear();sessionStorage.clear();});
  const jobs=await(await page.request.get(`${base}/api/footprint/consensus/jobs`)).json();
  const url=`${base}/api/footprint/consensus/jobs/${jobs.active_job}`;
  const job=await(await page.request.get(url)).json();expect(job.status).toBe('complete');
  const runtimeSchema=await(await page.request.get(`${base}/api/footprint/consensus/schema`)).json();
  expect(runtimeSchema.runtime.workflow_path).toContain('/fiberhmm/inference/consensus/workflow.py');
  expect(runtimeSchema.groups.cr.find((v:any)=>v.name==='global_iterations').default).toBe(800);
  expect(Object.values(job.summary).every((s:any)=>s.numerical_fit?.selected_converged===true)).toBeTruthy();
  expect(job.request.start).toBe(47190560);expect(job.request.end).toBe(47194939);
  await page.request.post(`${url}/filters`,{data:{minimum_model_q:0,minimum_comparability_q:0,
    require_population_comparable:false,require_molecule_comparable:false,require_cross_comparable:false,show_quality_outlines:false}});
  await page.setViewportSize({width:2100,height:1400});
  await page.goto(`${base}/?chr=chrX&start=47193480&end=47193880&shared=1`,{waitUntil:'domcontentloaded'});
  const ids=['uba1_ddda_full','uba1_hia5_full'];
  const catalog=await(await page.request.get(`${url}/catalog`)).json();
  expect(catalog.datasets[ids[0]].catalog.length).toBe(419);expect(catalog.datasets[ids[1]].catalog.length).toBe(146);
  const broad=catalog.datasets[ids[0]].catalog.find((f:any)=>f.consensus_start===47193667&&f.consensus_end===47193698);
  expect(broad).toBeTruthy();
  const strip=page.getByTestId(`consensus-family-track-${ids[0]}`);await expect(strip).toBeVisible();
  const glyph=strip.locator(`[data-family-id="${broad.family}"]`);await glyph.click();
  const inspector=page.getByTestId('consensus-family-inspector');await expect(inspector).toContainText(broad.family);
  await expect(inspector.getByTestId('consensus-count-groups')).toContainText('descriptive, not calibrated occupancy');
  const panel=page.getByTestId('consensus-tools');
  await expect(panel.getByRole('checkbox',{name:/XCR · native-family relationships/})).toBeVisible();
  await page.getByLabel('Native opportunity lattice layer',{exact:true}).check();
  for(let i=0;i<5;i++)await page.getByRole('button',{name:'Increase read row height',exact:true}).first().click();
  const tracks=ids.map(id=>page.locator(`[data-read-track-dataset-id="${id}"]`).first());
  for(const track of tracks)await expect.poll(async()=>Number(await track.getAttribute('data-native-lattice-read-count'))).toBeGreaterThan(10);
  async function data(id:string){return (await page.request.get(`${base}/api/reads/compact?dataset_id=${id}&chrom=chrX&start=47193480&end=47193880&max_reads=100&include_layers=true`)).json();}
  const keys=(d:any)=>d.reads.flatMap((r:any)=>(r.layers?.tf_cr?.consensus_records??[]).map((c:any)=>`${r.id}|${c.family}|${c.interval.join(':')}`)).sort();
  const before=await Promise.all(ids.map(data));for(const d of before)expect(keys(d).length).toBeGreaterThan(20);
  await page.screenshot({path:info.outputPath('UBA1_real_CR_XCR_lattice_inspector.png'),fullPage:true});
  await panel.getByLabel('minimum_model_q exact',{exact:true}).fill('10');
  await expect.poll(async()=>(await(await page.request.get(url)).json()).filters.minimum_model_q).toBe(10);
  const after=await Promise.all(ids.map(data));
  for(let i=0;i<ids.length;i++){
    const old=new Set(keys(before[i]));expect(keys(after[i]).every((k:string)=>old.has(k))).toBeTruthy();
    expect(keys(after[i]).length).toBeLessThan(old.size);
    expect(after[i].reads.map((r:any)=>[r.id,r.layers?.tf,r.layers?.nuc])).toEqual(before[i].reads.map((r:any)=>[r.id,r.layers?.tf,r.layers?.nuc]));
  }
  expect(await(await page.request.get(`${url}/catalog`)).json()).toEqual(catalog);
  await panel.getByLabel('minimum_model_q exact',{exact:true}).fill('0');
  await expect.poll(async()=>(await(await page.request.get(url)).json()).filters.minimum_model_q).toBe(0);
  await writeFile(info.outputPath('UBA1_inspection.json'),JSON.stringify({job_id:jobs.active_job,
    families:[419,146],all_locus_bounds:[47190560,47194939],Q0:before.map(d=>keys(d).length),Q10:after.map(d=>keys(d).length),
    catalog_unchanged:true,native_intervals_unchanged:true,clickable_family_and_XCR_counts:true,independent_lattices:true},null,2));
  expect(errors).toEqual([]);
});
