import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

/** Actual v5 import; only a fresh, explicitly test-owned manual history is edited. */
test('v5 native graph, full geometry inspection and reversible display-only merge',async({page},info)=>{
  const base=process.env.FIBERBROWSER_NATIVE_CONSENSUS_INSPECT;
  test.skip(!base,'Requires an isolated v5 imported result');test.setTimeout(300000);page.setDefaultTimeout(20000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/shutdown',r=>r.abort());
  const json=async(path:string)=>{const r=await page.request.get(`${base}${path}`);expect(r.ok()).toBe(true);return r.json();};
  const history=await json('/api/footprint/consensus/jobs'),jid=history.active_job;
  const jpath=`/api/footprint/consensus/jobs/${jid}`;
  const job=await json(jpath),catalog=await json(jpath+'/catalog'),initialCuration=await json(jpath+'/curation');
  expect(job.status).toBe('complete');expect(job.cr_mode).toBe('native_family_distribution');
  expect(initialCuration.manual_groups).toEqual([]);expect(initialCuration.can_undo).toBe(false);expect(initialCuration.can_redo).toBe(false);
  expect(Object.values(initialCuration.ignored_families).flat()).toEqual([]);
  const edges=catalog.edges as any[];expect(edges.length).toBe(5390);expect(edges.filter(e=>e.comparable).length).toBe(84);
  for(const edge of edges){expect(edge.merged_interval??null).toBeNull();expect(edge.native_intervals).toBeTruthy();}
  const directions=edges.flatMap(e=>Object.values(e.native_family_evidence)) as any[];
  expect(directions.every(d=>typeof d.n_compatible_mc_clear==='number'&&typeof d.n_compatible_mc_borderline==='number')).toBe(true);
  expect(edges.some(e=>e.compatibility_depends_on_monte_carlo_uncertainty===true)).toBe(true);
  const reasons:Record<string,number>={};for(const d of directions)for(const [key,n]of Object.entries(d.reason_counts??{}))reasons[key]=(reasons[key]??0)+Number(n);
  expect(reasons.hypothesis_not_attributable_to_this_call).toBeGreaterThan(0);
  const ids=job.request.dataset_ids as string[],ddda=ids.find(id=>job.request.chemistry_overrides[id]==='ddda')!;
  const region={chrom:'chr19',start:47514988,end:47515670};
  const readData=async()=>Object.fromEntries(await Promise.all(ids.map(async id=>[id,await json(`/api/reads/compact?${new URLSearchParams({dataset_id:id,chrom:region.chrom,start:String(region.start),end:String(region.end),max_reads:'100',include_layers:'true'})}`)])));
  const rows=(data:any,layer='tf_cr')=>data.reads.flatMap((r:any)=>(r.layers?.[layer]?.consensus_records??[]).map((c:any)=>({read:r.id,...c})));
  const sourceKeys=(data:any,layer='tf_cr')=>rows(data,layer).map((c:any)=>JSON.stringify([c.read,c.source_call_id,c.source_ordinal,c.interval])).sort();
  const nativeGeometry=(c:any)=>Object.fromEntries(Object.entries(c.datasets).map(([ds,d]:[string,any])=>[ds,d.catalog.map((f:any)=>[f.family,f.consensus_start,f.consensus_end])]));
  const before=await readData();console.log('v5 ledger checked',jid,edges.length,reasons);
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;localStorage.clear();sessionStorage.clear();});
  await page.setViewportSize({width:2200,height:1500});
  await page.goto(`${base}/?chr=${region.chrom}&start=${region.start}&end=${region.end}&shared=1`,{waitUntil:'domcontentloaded'});
  const strip=page.getByTestId(`consensus-family-track-${ddda}`);await expect(strip).toBeVisible({timeout:90000});
  const sampled=new Set(rows(before[ddda]).map((r:any)=>r.family));
  const visible=catalog.datasets[ddda].catalog.filter((f:any)=>f.consensus_start<region.end&&f.consensus_end>region.start&&sampled.has(f.family)).sort((a:any,b:any)=>a.consensus_start-b.consensus_start||a.family.localeCompare(b.family));
  expect(visible.length).toBeGreaterThan(1);const [first,second]=visible;
  await strip.locator(`[data-family-id="${first.family}"]`).click();
  const panel=page.getByTestId('consensus-tools');await expect(panel).toBeVisible();
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Increase read row height',exact:true}).click();
  for(const ds of ids){const track=page.locator(`[data-read-track-dataset-id="${ds}"]`).first();await expect.poll(async()=>Number(await track.getAttribute('data-read-track-render-count')),{timeout:90000}).toBeGreaterThan(0);await expect(track).toHaveAttribute('data-read-track-loading','false',{timeout:90000});}
  await expect(panel.getByTestId('native-xcr-summary')).toContainText('5390');
  await expect(panel.getByTestId('native-xcr-summary')).toContainText('84');
  const layers=['tf_native_replay','tf_sr_lattice','tf_cr','tf_recall','tf_cr_recalled','tf_xcr','nuc_cr_split','cr_split_gap'];
  for(const layer of layers){const control=panel.getByTestId(`consensus-layer-${layer}`);await expect(control).toBeVisible();await control.uncheck();await expect(control).not.toBeChecked();await control.check();await expect(control).toBeChecked();}
  console.log('all native and archived auxiliary layers toggled');
  // Real UI hit-testing of an actual derived footprint; no injected store or records.
  const canvas=page.locator(`[data-read-track-dataset-id="${ddda}"] canvas[data-copilot-track="reads"]`).first();
  await canvas.scrollIntoViewIfNeeded();
  const meta=await canvas.evaluate((c:HTMLCanvasElement)=>({width:c.width,height:c.height,sidebar:Number(c.dataset.trackSidebar),start:Number(c.dataset.trackStart),end:Number(c.dataset.trackEnd),span:Number(c.dataset.trackRegionWidth)}));
  const callInspector=page.getByTestId('consensus-call-inspector');
  let selected=false,targetScoped=false;
  for(const coordinate of [47515100,47515203,47515607]){
    if(selected)break;
    const x=meta.sidebar+(coordinate-meta.start)/meta.span*(meta.width-meta.sidebar);
    for(let k=0;k<14;k++){
      await canvas.click({position:{x,y:48+k*4.5},modifiers:['Control']});
      if(await callInspector.count()){selected=true;break;}
      // Empty Footprint panel omits the click-target chips. A real native
      // footprint click reveals them; then scope subsequent hits to CR.
      const target=page.getByText('Click target',{exact:true});
      if(!targetScoped&&await target.count()){
        // Selecting the first raw call remounts the full Footprint panel.
        // Let its real job hydration finish before selecting a derived call.
        await expect(panel.getByTestId('native-xcr-summary')).toContainText('5390',{timeout:90000});
        await expect(panel.getByTestId('consensus-curation-panel')).toContainText('revision 0',{timeout:90000});
        await target.locator('..').getByRole('button',{name:'CR · classes',exact:true}).click();targetScoped=true;
      }
    }
  }
  expect(selected).toBe(true);await expect(callInspector.getByLabel('Selected source call ID')).toBeVisible();
  const sid=await callInspector.getByLabel('Selected source call ID').inputValue();
  const detail=await json(`${jpath}/call?${new URLSearchParams({dataset_id:ddda,source_call_id:sid})}`);
  await expect(callInspector.getByText("Loading the selected call's full candidate ledger…",{exact:true})).toHaveCount(0);
  const tests=(detail.call.native_cross_tests??[]) as any[];expect(tests.length).toBeGreaterThan(0);
  const selectedTest=tests.find(t=>t.recipient_evidence.geometry_mass_overlapping_observed_call!=null&&t.recipient_evidence.geometry_mass_allowed_by_frozen_neighbors!=null)!;
  expect(selectedTest).toBeTruthy();
  const summary=callInspector.locator('summary').filter({hasText:selectedTest.link_id}).first();await expect(summary).toBeVisible();await summary.click();
  const box=summary.locator('..'),ev=selectedTest.recipient_evidence;
  await expect(box).toContainText(`Original geometry mass overlapping this call: ${(100*ev.geometry_mass_overlapping_observed_call).toFixed(2)}%`);
  await expect(box).toContainText(`Original geometry allowed by frozen neighbors: ${(100*ev.geometry_mass_allowed_by_frozen_neighbors).toFixed(2)}%`);
  await expect(box).toContainText('None is a majority-core overlap or detection-power estimate');
  await box.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('native-v5-call-inspector.png'),fullPage:true});
  console.log('full actual call geometry inspected',sid,selectedTest.link_id,ev.status);
  await callInspector.getByRole('button',{name:'Clear call inspection',exact:true}).click();
  await strip.locator(`[data-family-id="${first.family}"]`).click();await strip.locator(`[data-family-id="${second.family}"]`).click({modifiers:['Control']});
  const actions=panel.getByTestId('consensus-curation-panel');await expect(actions).toContainText('2 selected');
  await actions.getByRole('button',{name:'Group selected',exact:true}).click();
  await expect.poll(async()=>(await json(jpath+'/curation')).manual_groups.length).toBe(1);
  const merged=await json(jpath+'/curation');expect(merged.revision).toBeGreaterThan(initialCuration.revision);
  await expect(panel.getByTestId('consensus-layer-tf_cr_manual')).toBeChecked();
  const manual=await readData();for(const ds of ids){expect(sourceKeys(manual[ds],'tf_cr_manual')).toEqual(sourceKeys(before[ds]));expect(sourceKeys(manual[ds])).toEqual(sourceKeys(before[ds]));}
  expect(rows(manual[ddda],'tf_cr_manual').some((r:any)=>r.manual_group_id===merged.manual_groups[0].group_id)).toBe(true);
  await actions.getByRole('button',{name:'Undo edit',exact:true}).click();await expect.poll(async()=>(await json(jpath+'/curation')).manual_groups.length).toBe(0);
  await panel.getByTestId('consensus-layer-tf_cr').check();await panel.getByTestId('consensus-layer-tf_cr_manual').uncheck();
  const afterCatalog=await json(jpath+'/catalog'),after=await readData(),afterJob=await json(jpath),finalCuration=await json(jpath+'/curation');
  expect(nativeGeometry(afterCatalog)).toEqual(nativeGeometry(catalog));expect(afterCatalog.edges).toEqual(catalog.edges);
  for(const ds of ids)expect(sourceKeys(after[ds])).toEqual(sourceKeys(before[ds]));
  expect(afterJob.filters).toEqual(job.filters);expect(afterJob.request).toEqual(job.request);expect(finalCuration.manual_groups).toEqual([]);
  // Overlapping additive layers were exercised above; overview uses CR/XCR plus SR.
  for(const layer of ['tf_native_replay','tf_recall','tf_cr_recalled','nuc_cr_split','cr_split_gap'])await panel.getByTestId(`consensus-layer-${layer}`).uncheck();
  await actions.getByRole('button',{name:'Clear',exact:true}).click();
  for(const ds of ids)await expect(page.locator(`[data-read-track-dataset-id="${ds}"]`).first()).toHaveAttribute('data-read-track-loading','false',{timeout:90000});
  await panel.getByTestId('native-xcr-summary').scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('native-v5-full-nfr.png'),fullPage:true});
  expect(errors).toEqual([]);
  await writeFile(info.outputPath('native-v5-inspection.json'),JSON.stringify({url:base,job_id:jid,region,counts:{edges:edges.length,compatible:84},count_groups:catalog.count_groups?.length,reason_counts:reasons,
    layers_toggled:layers,selected_call_id:sid,selected_call_interval:detail.call.interval,selected_cross_test:selectedTest,
    source_counts:Object.fromEntries(ids.map(ds=>[ds,sourceKeys(before[ds]).length])),source_spans_unchanged:true,automatic_geometry_unchanged:true,automatic_graph_unchanged:true,
    manual_edit:'merge followed by undo on this fresh test-owned job',curation_at_end:finalCuration,new_inference_submitted:false,evidence_mocked:false,errors},null,2));
});
