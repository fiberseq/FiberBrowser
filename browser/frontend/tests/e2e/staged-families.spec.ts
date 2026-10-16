/**
 * The deprecated engine: staged Monte Carlo families (cr.engine
 * 'staged_native_families'). No longer the default (the lattice recaller is;
 * see release-consensus.spec.ts) but still selectable in the Engine menu, so
 * its stages, family track, manual grouping with undo/redo and frozen
 * export/import stay covered. Runs on a tiny, explicitly synthetic Hia5 BAM
 * made by tests/make_staged_demo_bam.py (16 reads, 2 protected spans on
 * chrTest), generated per test into a temp dir.
 */
import { test, panelButton } from './fixtures/server';
import {expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const REPO_ROOT=process.env.FIBERBROWSER_TEST_DIR?path.resolve(process.env.FIBERBROWSER_TEST_DIR):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');

test.use({fixtureBam:async({},use)=>{
  const bam=path.join(mkdtempSync(path.join(tmpdir(),'fiberbrowser-staged-demo-')),'staged_demo.bam');
  execFileSync(process.env.FIBERBROWSER_TEST_PYTHON?.trim()||'python',[path.join(REPO_ROOT,'tests','make_staged_demo_bam.py'),bam],{stdio:'inherit'});
  await use(bam);
}});

test('staged MC caller, hypothesis tracks, display grouping and history export',async({page,server},info)=>{
  test.setTimeout(180000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/shutdown',r=>r.abort());
  await page.addInitScript(()=>{(window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;localStorage.clear();sessionStorage.clear();});
  await page.setViewportSize({width:1700,height:1100});
  await page.goto(server.baseUrl+'/?chr=chrTest&start=100&end=280&shared=1');
  await panelButton(page, 'footprint-analysis').click();
  const panel=page.getByTestId('consensus-tools');await expect(panel).toBeVisible();
  // Deprecated engine: still selectable, no longer the default (lattice_recaller is; see release-consensus.spec.ts).
  await expect(panel.getByTestId('run-lattice-consensus')).toBeEnabled(); // parameter schema loaded
  // The deprecated engine is chosen under Advanced (usability round 1, FP-5).
  await panel.getByText('Advanced: edit classes, export, algorithm settings',{exact:true}).click();
  await panel.getByTestId('family-engine').selectOption('staged_native_families');
  await expect(panel.getByTestId('family-engine')).toHaveValue('staged_native_families');
  await expect(panel.getByTestId('family-engine-name')).toContainText('Staged Monte Carlo (deprecated)');
  await panel.getByText('Algorithm, region, and display settings',{exact:true}).click();
  await panel.getByLabel('Consensus chromosome',{exact:true}).fill('chrTest');
  await panel.getByLabel('Consensus start (0-based)',{exact:true}).fill('100');
  await panel.getByLabel('Consensus end (exclusive)',{exact:true}).fill('280');
  const continued=page.waitForResponse(r=>r.url().endsWith('/api/footprint/consensus/jobs')&&r.request().method()==='POST');
  await panel.getByTestId('run-lattice-consensus').click();
  const submitted=await continued;expect(submitted.ok(),await submitted.text()).toBe(true);
  const job=await submitted.json();const url=server.baseUrl+'/api/footprint/consensus/jobs/'+job.job_id;
  await expect.poll(async()=>(await(await page.request.get(url)).json()).status,{timeout:120000}).toBe('complete');
  await expect(panel.getByTestId('family-stages')).toBeVisible();
  await expect(panel.getByTestId('family-checkpoint-summary')).toContainText(/Reused checkpoints: \d+ native sources, .*New work: \d+ blocks/); // counts depend on the fit cache
  const initial=await(await page.request.get(url+'/catalog')).json();const ds=Object.keys(initial.datasets)[0];
  expect(initial.cr_mode).toBe('staged_native_families');expect(initial.stages).toHaveLength(4);
  expect(initial.stages.every((s:any)=>s.original_calls===32)).toBe(true);
  await expect(page.getByTestId(`consensus-family-track-${ds}`).locator('[data-family-id]')).toHaveCount(2);
  await expect(page.getByTestId(`consensus-family-track-${ds}`).getByTestId('family-edge-uncertainty').first()).toBeVisible();
  await page.screenshot({path:info.outputPath('staged-families-automatic.png'),fullPage:true});
  await panel.getByTestId('family-stages').locator('summary').click();
  await panel.getByTestId('family-stages').getByRole('button',{name:/Native state fits/}).click();
  await expect(panel.getByTestId('family-stages')).toContainText('Earlier-stage inspection is read-only');
  await panel.getByTestId('family-stages').getByRole('button',{name:/Final recurrent states/}).click();
  const families=initial.datasets[ds].catalog.map((f:any)=>f.family);
  await panel.getByText('Browse all population classes',{exact:true}).click();
  for(const f of families)await panel.getByRole('checkbox',{name:`Select ${ds} state ${f}`,exact:true}).check();
  const merge=panel.getByRole('button',{name:'Group selected',exact:true});await expect(merge).toBeEnabled();await merge.click();
  await expect.poll(async()=>(await(await page.request.get(url+'/curation')).json()).manual_groups.length).toBe(1);
  const merged=await(await page.request.get(url+'/curation')).json();const gid=merged.manual_groups[0].group_id;
  await panel.getByRole('button',{name:'Undo edit',exact:true}).click();
  await expect.poll(async()=>(await(await page.request.get(url+'/curation')).json()).manual_groups.length).toBe(0);
  await panel.getByRole('button',{name:'Redo edit',exact:true}).click();
  await expect.poll(async()=>(await(await page.request.get(url+'/curation')).json()).manual_groups.length).toBe(1);
  const curated=await(await page.request.get(url+'/curation')).json();
  const exported=await page.request.get(url+'/export');expect(exported.ok()).toBe(true);
  const frozen=JSON.parse(gunzipSync(await exported.body()).toString());
  expect(frozen.evidence_encoding).toBe('shared_json_v1');
  const callId=frozen.datasets[ds].cr.records[0].proposals[0].source_call_id;
  const detail=await page.request.get(url+'/call',{params:{dataset_id:ds,source_call_id:callId}});
  expect(detail.ok()).toBe(true);expect((await detail.json()).call.family_evidence.original).toBeTruthy();
  await page.screenshot({path:info.outputPath('staged-families-manual-merge.png'),fullPage:true});
  const imported=await page.request.post(server.baseUrl+'/api/footprint/consensus/import',{
    multipart:{file:{name:'curated.json.gz',mimeType:'application/gzip',buffer:await exported.body()}}});
  expect(imported.ok(),await imported.text()).toBe(true);
  const restored=await imported.json();
  const history=await(await page.request.get(server.baseUrl+'/api/footprint/consensus/jobs/'+restored.job_id+'/curation')).json();
  expect(history.manual_groups).toHaveLength(1);expect(history.manual_groups[0].group_id).toBe(gid);
  // The import restores the edit history where it was exported (after Redo: one
  // edit, nothing left to redo), not just the resulting groups.
  expect({undo:history.can_undo,redo:history.can_redo,operations:history.operations.length})
    .toEqual({undo:curated.can_undo,redo:curated.can_redo,operations:curated.operations.length});
  expect(history.can_undo).toBe(true);
  expect(errors).toEqual([]);
});
