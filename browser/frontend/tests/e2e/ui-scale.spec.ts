import {test,expect} from './fixtures/server';
import {readWindow} from './fixtures/server';

test('Fit resamples to a small scaled read viewport',async({server,page})=>{
  await page.setViewportSize({width:1800,height:1100});
  await page.addInitScript(()=>{
    window.__FIBERBROWSER_E2E_EXPOSE_STORE=true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;
    localStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const win=readWindow(server);
  for(const scale of [1,1.5,2]){
    await page.evaluate(([scale,win])=>{
      const store=window.__FIBERBROWSER_STORE__!;
      store.setState({uiScale:scale,readDisplayMode:'sample',readRowHeight:1,showCoverageHistogram:true});
      store.getState().setViewport(win[0],win[1],win[2]);
    },[scale,win] as const);
    const track=page.locator('[data-read-track-render-count]').first();
    await expect.poll(()=>track.evaluate(el=>{
      const height=(el as HTMLElement).clientHeight;
      const count=Number(el.getAttribute('data-read-track-render-count'));
      // The coverage histogram is a row of its own above the reads (fb-n11-tracks), no longer 30 px of this canvas.
      return count>0&&count<=height&&el.getAttribute('data-read-track-loading')==='false';
    })).toBe(true);
  }
});

test('figure scaling preserves available space, axis hit coordinates and buttons',async({server,page})=>{
  await page.setViewportSize({width:2400,height:3200});
  await page.addInitScript(()=>{
    window.__FIBERBROWSER_E2E_EXPOSE_STORE=true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;
    localStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForFunction(()=>!!window.__FIBERBROWSER_STORE__);
  await page.waitForLoadState('networkidle');
  const win=readWindow(server);
  for(const scale of [.5,1,1.5,2,3,4]){
    await page.evaluate(scale=>{
      const s=window.__FIBERBROWSER_STORE__!.getState();
      s.setUiScale(scale);s.setViewport(s.chrom,100000,110000);
    },scale);
    await page.waitForTimeout(250);
    const controls=page.getByTestId('scaled-main-controls');
    expect(await controls.evaluate(el=>Number(getComputedStyle(el).zoom))).toBe(scale);
    const settingsSize=await page.getByTestId('toolbar-more-button').evaluate(el=>({rendered:el.getBoundingClientRect().width,logical:el.clientWidth}));
    expect(settingsSize.rendered/settingsSize.logical).toBeCloseTo(scale,1);
    const area=page.locator('[data-export-container]');
    const sizes=await area.evaluate(el=>({width:el.getBoundingClientRect().width,parent:el.parentElement!.getBoundingClientRect().width}));
    expect(Math.abs(sizes.width-sizes.parent)).toBeLessThan(3);
    const axis=page.locator('canvas.cursor-crosshair').first();
    await axis.scrollIntoViewIfNeeded();
    const box=await axis.boundingBox();expect(box).not.toBeNull();
    await page.mouse.move(box!.x+box!.width*.25,box!.y+box!.height*.5);
    await page.mouse.down();
    await page.mouse.move(box!.x+box!.width*.75,box!.y+box!.height*.5,{steps:8});
    await page.mouse.up();
    await expect.poll(()=>page.evaluate(()=>window.__FIBERBROWSER_STORE__!.getState().start)).toBeCloseTo(102500,-1);
    await expect.poll(()=>page.evaluate(()=>window.__FIBERBROWSER_STORE__!.getState().end)).toBeCloseTo(107500,-1);
    await page.getByTestId('settings-rail-view').click();
    await expect(page.getByTestId('settings-sidebar')).toBeVisible();
    await page.getByTestId('settings-sidebar-collapse').click();
    await page.evaluate(win=>{
      const s=window.__FIBERBROWSER_STORE__!.getState();
      s.setViewport(win[0],win[1],win[2]);
      s.setReadRowHeight(5);
    },win);
    const reads=page.locator('canvas[data-copilot-track="reads"]').first();
    await expect(reads).toBeVisible();
    // Ctrl-wheel ignores an empty read track, so wait until this window's reads are drawn.
    // (waitForLoadState('networkidle') resolves at once after the first page load, and a
    // lab BAM takes ~2 s to return this window.)
    await page.waitForTimeout(500);
    const track=page.locator('[data-read-track-render-count]').first();
    await expect.poll(()=>track.evaluate(el=>Number(el.getAttribute('data-read-track-render-count'))>0
      &&el.getAttribute('data-read-track-loading')==='false'),{timeout:30_000}).toBe(true);
    await reads.evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.waitForTimeout(250);
    let rb=(await reads.boundingBox())!;
    // Aim at the middle of the visible reads canvas. At UI scale 4, 30 px below its
    // top edge, Chromium hit-tests the wheel to the (zoomed) axis canvas above it
    // even though elementFromPoint reports the reads canvas.
    const readsY=(b:{y:number;height:number})=>Math.min(b.y+b.height/2,3200-10);
    await page.mouse.move(rb.x+rb.width*.5,readsY(rb));
    await page.keyboard.down('Control');
    await page.mouse.wheel(0,-100);
    await page.waitForTimeout(200);
    await page.keyboard.up('Control');
    await expect.poll(()=>page.evaluate(()=>window.__FIBERBROWSER_STORE__!.getState().readRowHeight),{message:`Ctrl-wheel enlarges read rows at UI scale ${scale}`}).toBeGreaterThan(5);
    await reads.evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.waitForTimeout(250);
    rb=(await reads.boundingBox())!;
    await page.mouse.move(rb.x+rb.width*.5,readsY(rb));
    const before=await page.evaluate(()=>window.__FIBERBROWSER_STORE__!.getState().start);
    await page.mouse.down();
    await page.mouse.move(rb.x+rb.width*.6,readsY(rb),{steps:8});
    await page.mouse.up();
    const after=await page.evaluate(()=>window.__FIBERBROWSER_STORE__!.getState().start);
    expect(before-after).toBeGreaterThan(30);
    expect(before-after).toBeLessThan(40);
  }
});
