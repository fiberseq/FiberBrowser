import {test,expect,DEMO_FIXTURE} from './fixtures/server';
import path from 'node:path';
import {readFileSync} from 'node:fs';

test('UI screenshot scales text along with layout and canvas tracks',async({page})=>{
  await page.setViewportSize({width:1200,height:900});
  let baseline=0;
  for(const zoom of [1,1.5,2,4]){
    await page.setContent(`<div id="root" style="background:white;width:1000px;height:800px;display:flex;flex-direction:column"><div style="flex:1;overflow:hidden"><div style="zoom:${zoom};width:100%;height:100%;overflow:hidden;position:relative;font:20px Arial;color:black"><span>HHHH</span><canvas width="100" height="20" style="display:block;width:100px;height:20px"></canvas><div style="position:absolute;right:0;top:60px;width:10px;height:10px;background:red"></div></div></div></div>`);
    await page.addScriptTag({path:path.resolve('node_modules/html-to-image/dist/html-to-image.js')});
    const result=await page.evaluate(async()=>{
      const root=document.getElementById('root')!;
      const track=root.querySelector('canvas')!;
      const ctx=track.getContext('2d')!;ctx.fillStyle='#0000ff';ctx.fillRect(0,0,100,20);
      const canvas=await (window as any).htmlToImage.toCanvas(root,{pixelRatio:1});
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let textTop=Infinity,textBottom=-1,blueLeft=Infinity,blueRight=-1,redRight=-1;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
        const i=(y*canvas.width+x)*4;
        if(pixels[i]<80&&pixels[i+1]<80&&pixels[i+2]<80){textTop=Math.min(textTop,y);textBottom=Math.max(textBottom,y);}
        if(pixels[i]<20&&pixels[i+1]<20&&pixels[i+2]>230){blueLeft=Math.min(blueLeft,x);blueRight=Math.max(blueRight,x);}
        if(pixels[i]>230&&pixels[i+1]<20&&pixels[i+2]<20)redRight=Math.max(redRight,x);
      }
      return {textHeight:textBottom-textTop+1,trackWidth:blueRight-blueLeft+1,redRight,liveZoom:(root.firstElementChild!.firstElementChild as HTMLElement).style.zoom};
    });
    if(zoom===1)baseline=result.textHeight;
    expect(Math.abs(result.textHeight-baseline*zoom)).toBeLessThanOrEqual(3);
    expect(Math.abs(result.trackWidth-100*zoom)).toBeLessThanOrEqual(1);
    expect(result.liveZoom).toBe(String(zoom));
    expect(result.redRight).toBe(999);
  }
});

// Owner, 2026-10-01: "the UI size is meant to be reflected in exports ... the point is to make it both
// easier to use for small screens and to allow figure generation to be readable." A 150% UI gives a 150%
// figure (text, labels, row heights, strokes); "Match UI size" off exports at 100%.
test.describe('exported figures follow the UI size',()=>{
  test.use({fixtureBam:'demo'});

  test('SVG text, header rows and strokes scale with the UI size; Match UI size off is 100%',async({server,page},info)=>{
    test.setTimeout(180_000);
    await page.setViewportSize({width:1500,height:1000});
    await page.addInitScript(()=>{
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE=true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;
      localStorage.clear();
    });
    await page.goto(server.baseUrl);
    await page.waitForFunction(()=>!!(window as any).__FIBERBROWSER_STORE__);
    await page.waitForLoadState('networkidle');
    const r=DEMO_FIXTURE.region;
    await page.evaluate(([c,s,e])=>(window as any).__FIBERBROWSER_STORE__.getState().setViewport(c,s,e),[r.chrom,r.start,r.end] as const);

    async function exportSvg(uiScale:number,match:boolean,name:string){
      await page.evaluate(scale=>(window as any).__FIBERBROWSER_STORE__.getState().setUiScale(scale),uiScale);
      const track=page.locator('[data-read-track-render-count]').first();
      await expect.poll(()=>track.evaluate(el=>Number(el.getAttribute('data-read-track-render-count'))>0
        &&el.getAttribute('data-read-track-loading')==='false'),{timeout:30_000}).toBe(true);
      // The other tracks too (the metaprofile's lines came in after the reads in one run): nothing left loading.
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(400);
      await page.getByTestId('export-screenshot-button').click();
      await page.getByRole('button',{name:'SVG',exact:true}).click();
      const box=page.getByTestId('export-match-ui-size');
      await expect(box).toBeChecked();  // on by default
      if(!match)await box.uncheck();
      const download=page.waitForEvent('download');
      await page.getByRole('button',{name:'Export SVG',exact:true}).click();
      const file=info.outputPath(name);
      await (await download).saveAs(file);
      const svg=readFileSync(file,'utf8');
      const attr=(re:RegExp)=>Number(svg.match(re)?.[1]);
      const fontOf=(text:string)=>attr(new RegExp(`font-size="([\\d.]+)"[^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}</text>`));
      // The header bar under the dataset label: its fill rect's height.
      const coords=`${r.chrom}:${r.start.toLocaleString()}-${r.end.toLocaleString()}`;
      // Every kind of stroke, not one median: the median sat between two kinds (10 strokes of 1, 11 of 1.5) and flipped
      // when a track's lines were in one export and not another.
      const strokes=[...new Set([...svg.matchAll(/stroke-width="([\d.]+)"/g)].map(m=>Number(m[1])).filter(w=>w>0)
        .map(w=>Math.round(w*100)/100))].sort((a,b)=>a-b);
      return {
        width:attr(/<svg[^>]*width="([\d.]+)"/),
        title:fontOf(coords),
        header:fontOf('napa_ddda'),
        headerRow:(()=>{
          const m=svg.match(/<path d="M [\d.-]+ ([\d.-]+) L [\d.-]+ [\d.-]+ L [\d.-]+ ([\d.-]+) L [^"]*Z" fill="[^"]*"\/>\s*<text[^>]*>napa_ddda<\/text>/);
          return m?Number(m[2])-Number(m[1]):NaN;
        })(),
        strokes,
        layoutWidth:await page.locator('[data-export-container]').evaluate(el=>(el as HTMLElement).offsetWidth),
      };
    }

    const at100=await exportSvg(1,true,'figure-100.svg');
    const at150=await exportSvg(1.5,true,'figure-150.svg');
    const at150off=await exportSvg(1.5,false,'figure-150-off.svg');
    info.attach('sizes',{body:JSON.stringify({at100,at150,at150off},null,1),contentType:'application/json'});

    expect(at100.title).toBe(18);
    expect(at100.header).toBe(13);
    // 150%: every size 1.5 times.
    expect(at150.title).toBeCloseTo(27,5);
    expect(at150.header).toBeCloseTo(19.5,5);
    expect(at150.headerRow/at100.headerRow).toBeCloseTo(1.5,2);
    expect(at100.strokes.length).toBeGreaterThan(0);
    expect(at150.strokes).toEqual(at100.strokes.map(w=>Math.round(w*1.5*100)/100));
    expect(at150.width).toBeCloseTo(at150.layoutWidth*1.5,0);
    // Match UI size off: 100% sizes, the 150% view's layout.
    expect(at150off.title).toBe(18);
    expect(at150off.header).toBe(13);
    expect(at150off.headerRow).toBeCloseTo(at100.headerRow,1);
    expect(at150off.strokes).toEqual(at100.strokes);
    expect(at150off.width).toBeCloseTo(at150off.layoutWidth,0);
  });
});
