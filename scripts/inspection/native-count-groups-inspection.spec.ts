import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

/** Real imported native count inspection. Does not change filters or curation. */
test('native XCR count groups expose distinct ANY and ALL on matched coverage',async({page},info)=>{
  const base=process.env.FIBERBROWSER_NATIVE_CONSENSUS_INSPECT;
  test.skip(!base,'Requires an isolated completed native NAPA browser demo');
  test.setTimeout(180000);page.setDefaultTimeout(30000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/shutdown',route=>route.abort());
  const history=await(await page.request.get(`${base}/api/footprint/consensus/jobs`)).json();
  const jobUrl=`${base}/api/footprint/consensus/jobs/${history.active_job}`;
  const job=await(await page.request.get(jobUrl)).json();
  expect(job.cr_mode).toBe('native_family_distribution');expect(job.status).toBe('complete');
  const catalog=await(await page.request.get(`${jobUrl}/catalog`)).json();
  const groups=catalog.count_groups??[];expect(groups.length).toBeGreaterThan(0);
  expect(groups.every((group:any)=>group.status==='descriptive_native_call_events')).toBe(true);
  const before=await(await page.request.get(`${jobUrl}/curation`)).json();
  const ddda=job.request.dataset_ids.find((id:string)=>job.request.chemistry_overrides[id]==='ddda');
  const region={chrom:'chr19',start:47514988,end:47515670};
  const group=groups.find((g:any)=>g.kind==='cooccurring_fragments_or_states'
    &&g.comparison_span[0]<region.end&&g.comparison_span[1]>region.start)
    ??groups.find((g:any)=>g.comparison_span[0]<region.end&&g.comparison_span[1]>region.start)??groups[0];
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;localStorage.clear();sessionStorage.clear();});
  await page.setViewportSize({width:2200,height:1500});
  await page.goto(`${base}/?chr=${region.chrom}&start=${region.start}&end=${region.end}&shared=1`,{waitUntil:'domcontentloaded'});
  const strip=page.getByTestId(`consensus-family-track-${ddda}`);
  await expect(strip).toBeVisible({timeout:60000});
  await strip.locator('[data-family-id]').first().click();
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Increase read row height',exact:true}).click();
  const panel=page.getByTestId('consensus-tools');await expect(panel).toBeVisible();
  await expect(panel.getByTestId('native-xcr-summary')).toContainText(`${catalog.edges.length} catalog atomic links`);
  const linked=catalog.edges.find((edge:any)=>edge.comparable&&edge.native_intervals?.[ddda]?.[0]<region.end&&edge.native_intervals?.[ddda]?.[1]>region.start);
  expect(linked).toBeTruthy();const linkedFamily=linked.families[ddda];
  await strip.locator(`[data-family-id="${linkedFamily}"]`).click();
  const expectedLinks=catalog.edges.filter((edge:any)=>edge.families?.[ddda]===linkedFamily).length;
  await expect(page.getByTestId('consensus-family-inspector')).toContainText(`${expectedLinks} atomic XCR links`);
  await panel.getByRole('button',{name:'Inspect classes, rates and XCR links',exact:true}).click();
  await panel.getByLabel('Search consensus catalog',{exact:true}).fill(group.group_id);
  const displayed=panel.getByTestId('native-count-group');await expect(displayed).toHaveCount(1);
  await expect(displayed).toHaveAttribute('data-group-id',group.group_id);
  await expect(displayed).toContainText('same comparison span');
  await expect(displayed).toContainText('complete aligned-block coverage');
  await expect(displayed).toContainText('do not sum counts across groups');
  await expect(displayed).toContainText('Neither occupancy, event equivalence, nor resolved fragmentation');
  await expect(displayed).not.toContainText('before SR');await expect(displayed).not.toContainText('fixed membership');
  await expect(displayed).not.toContainText('undefined');
  const sides=displayed.getByTestId('native-correspondence-counts');await expect(sides).toHaveCount(2);
  for(const [index,key] of ['left_counts','right_counts'].entries()){
    const counts=group[key],side=sides.nth(index);
    expect(counts.comparison_span).toEqual(group.comparison_span);
    await expect(side).toContainText(`Recorded classification reference: ${counts.classification_reference_percent}%`);
    if(counts.eligible_units){
      await expect(side).toContainText(`ANY: ${counts.assigned_units} / ${counts.eligible_units} evidence groups`);
      await expect(side).toContainText(`ALL: ${counts.all_member_units} / ${counts.eligible_units} evidence groups`);
    }else await expect(side).toContainText('Unavailable — no evidence groups cover');
    for(const strand of Object.keys(counts.by_strand))await expect(side).toContainText(strand==='pooled'?'pooled Hia5':strand);
  }
  for(const id of job.request.dataset_ids){
    const track=page.locator(`[data-read-track-dataset-id="${id}"]`).first();
    await expect.poll(async()=>Number(await track.getAttribute('data-read-track-render-count')),{timeout:90000}).toBeGreaterThan(0);
    await expect(track).toHaveAttribute('data-read-track-loading','false',{timeout:90000});
  }
  await sides.first().getByText(group.left_counts.eligible_units?`ANY: ${group.left_counts.assigned_units} / ${group.left_counts.eligible_units} evidence groups`:'Unavailable — no evidence groups cover',{exact:false}).first().scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('native-xcr-count-group-inspection.png'),fullPage:true});
  await sides.last().getByText(group.right_counts.eligible_units?`ANY: ${group.right_counts.assigned_units} / ${group.right_counts.eligible_units} evidence groups`:'Unavailable — no evidence groups cover',{exact:false}).first().scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('native-xcr-count-group-recipient.png'),fullPage:true});
  expect(await(await page.request.get(`${jobUrl}/curation`)).json()).toEqual(before);
  expect((await(await page.request.get(jobUrl)).json()).filters).toEqual(job.filters);
  await writeFile(info.outputPath('native-count-inspection.json'),JSON.stringify({job_id:job.job_id,
    native_count_groups:groups.length,inspected_group_id:group.group_id,kind:group.kind,
    comparison_span:group.comparison_span,left_counts:group.left_counts,right_counts:group.right_counts,
    curation_unchanged:true,filters_unchanged:true,evidence_mocked:false,errors},null,2));
  expect(errors).toEqual([]);
});
