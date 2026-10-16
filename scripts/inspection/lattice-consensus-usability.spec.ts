import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

test('overhead families are clickable and both native lattices render independently',async({page},info)=>{
  const base=process.env.FIBERBROWSER_CONSENSUS_INSPECT;test.skip(!base,'Requires a real completed NAPA run');
  test.setTimeout(240000);page.setDefaultTimeout(30000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/shutdown',r=>r.abort());
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;localStorage.clear();sessionStorage.clear();});
  await page.setViewportSize({width:2100,height:1400});
  await page.goto(`${base}/?chr=chr19&start=47515059&end=47515187&shared=1`,{waitUntil:'domcontentloaded'});
  const ddda='napa_ddda_full',hia5='napa_hia5_full';
  const history=await(await page.request.get(`${base}/api/footprint/consensus/jobs`)).json();
  const catalog=await(await page.request.get(`${base}/api/footprint/consensus/jobs/${history.active_job}/catalog`)).json();
  // Family indices can change after a genuine native replay/refit. Inspect the
  // broad left class by its prespecified region, never an old run's ordinal ID.
  const broad=catalog.datasets[ddda].catalog.filter((f:any)=>f.consensus_start>=47515065&&f.consensus_start<=47515090
    &&f.consensus_end>=47515115&&f.consensus_end<=47515145&&f.consensus_end-f.consensus_start>=35)
    .sort((a:any,b:any)=>(Math.abs(a.consensus_start-47515075)+Math.abs(a.consensus_end-47515120))
      -(Math.abs(b.consensus_start-47515075)+Math.abs(b.consensus_end-47515120)))[0];
  expect(broad).toBeTruthy();
  const strip=page.getByTestId(`consensus-family-track-${ddda}`);
  await expect(strip).toBeVisible();await expect.poll(async()=>strip.locator('[data-family-id]').count()).toBeGreaterThan(2);
  const glyph=strip.locator(`[data-family-id="${broad.family}"]`);
  await expect(glyph).toHaveAttribute('data-family-start',String(broad.consensus_start));
  await glyph.click();
  const inspector=page.getByTestId('consensus-family-inspector');await expect(inspector).toContainText(broad.family);
  await expect(glyph).toHaveAttribute('aria-pressed','true');
  const tracks=[ddda,hia5].map(id=>page.locator(`[data-read-track-dataset-id="${id}"]`).first());
  await expect.poll(async()=>await tracks[0].getAttribute('data-consensus-highlight-families')).toContain(broad.family);
  // A broad native class can remain cross-assay unresolved after a refit.
  // Test count transport on an actual linked class, never require a link to
  // manufacture the expected browser state.
  const linkedFamily=catalog.count_groups.flatMap((g:any)=>g.left_families.concat(g.right_families))
    .find((id:string)=>catalog.datasets[ddda].catalog.some((f:any)=>f.family===id
      &&f.consensus_start>=47515059&&f.consensus_end<=47515187));
  expect(linkedFamily).toBeTruthy();
  await strip.locator(`[data-family-id="${linkedFamily}"]`).click();
  await expect(inspector.getByTestId('consensus-count-groups')).toContainText('descriptive, not calibrated occupancy');
  const linkedGroup=catalog.count_groups.find((g:any)=>g.left_families.includes(linkedFamily)||g.right_families.includes(linkedFamily));
  const side=linkedGroup.left_dataset===ddda?'left':'right';
  const breakdown=linkedGroup[`${side}_counts`].by_strand;
  expect(breakdown.CT).toBeTruthy();expect(breakdown.GA).toBeTruthy();
  const strandCounts=inspector.getByTestId('consensus-stratum-counts').first();
  await expect(strandCounts).toBeVisible();
  for(const strand of ['CT','GA'])await expect(strandCounts).toContainText(`${strand}: ${breakdown[strand].assigned_units} / ${breakdown[strand].eligible_units}`);
  await glyph.click();await expect(inspector).toContainText(broad.family);
  for(let i=0;i<6;i++)await page.getByRole('button',{name:'Increase read row height',exact:true}).first().click();
  const panel=page.getByTestId('consensus-tools');
  // Isolate CR fills for inspection; raw TF and modification toggles stay independent.
  for(const name of [/SR · boundary normalization/,/Recall · strict new footprints/,/XCR · native-family relationships/,/CR · alternative protected pieces/])
    await panel.getByRole('checkbox',{name}).uncheck();
  await panel.getByLabel('Show comparability outlines',{exact:true}).uncheck();
  await expect(page.getByRole('button',{name:'▾ Layers',exact:true})).toBeVisible(); // starts open
  await page.getByTestId('layer-checkbox-deam').check();await page.getByTestId('layer-checkbox-m6a').check();
  await page.getByRole('button',{name:'▾ Layers',exact:true}).click();
  await page.getByLabel('Native opportunity lattice layer',{exact:true}).check();
  for(const track of tracks)await expect.poll(async()=>Number(await track.getAttribute('data-native-lattice-read-count')),{timeout:30000}).toBeGreaterThan(10);
  await expect(page.getByTestId(`native-lattice-status-${ddda}`)).toContainText('ddda');
  await expect(page.getByTestId(`native-lattice-status-${hia5}`)).toContainText('hia5-pacbio');
  await page.getByLabel('Opportunity mark style',{exact:true}).selectOption('dots');
  await page.screenshot({path:info.outputPath('napa-clickable-families-native-lattice.png'),fullPage:true});
  await strip.locator(`[data-family-id="${linkedFamily}"]`).click();
  await expect(inspector.getByTestId('consensus-stratum-counts').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Loading...', {exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath('napa-strand-resolved-count-inspector.png'),fullPage:true});
  const pixelDigests=await Promise.all(tracks.map(t=>t.locator('canvas').first().evaluate((c:HTMLCanvasElement)=>c.toDataURL())));
  await page.getByLabel('Native opportunity lattice layer',{exact:true}).uncheck();
  for(const track of tracks)await expect(track).toHaveAttribute('data-native-lattice-read-count','0');
  await expect.poll(async()=>Promise.all(tracks.map(t=>t.locator('canvas').first().evaluate((c:HTMLCanvasElement)=>c.toDataURL())))).not.toEqual(pixelDigests);
  // Keyboard selection is supported; a click does not silently pan or filter.
  await panel.getByRole('button',{name:'Clear family selection',exact:true}).click();
  await glyph.focus();await page.keyboard.press('Enter');await expect(inspector).toContainText(broad.family);
  await panel.getByRole('button',{name:'Zoom to family',exact:true}).click();
  const pad=Math.max(20,broad.consensus_end-broad.consensus_start);
  await expect.poll(async()=>String(await page.getByTestId('location-search-input').inputValue()).replace(/,/g,''))
    .toContain(`${broad.consensus_start-pad}-${broad.consensus_end+pad}`);
  await page.getByLabel('Native opportunity lattice layer',{exact:true}).check();
  for(const track of tracks)await expect.poll(async()=>Number(await track.getAttribute('data-native-lattice-read-count'))).toBeGreaterThan(10);
  await page.screenshot({path:info.outputPath('napa-family-selected-zoom.png'),fullPage:true});
  await writeFile(info.outputPath('usability.json'),JSON.stringify({job_id:history.active_job,click:true,keyboard:true,
    canonical_geometry_unchanged:true,native_lattice_both_assays:true,toggle_changes_canvas:true,
    exact_chemical_strand_counts_visible:true},null,2));
  expect(errors).toEqual([]);
});
