import {test,expect,readWindow} from './fixtures/server';
import fs from 'node:fs/promises';

test('full UI download retains the far-right read panel at enlarged UI size',async({server,page},testInfo)=>{
  await page.setViewportSize({width:1800,height:1100});
  await page.addInitScript(()=>{
    window.__FIBERBROWSER_E2E_EXPOSE_STORE=true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD=true;
    localStorage.clear();
  });
  await page.goto(server.baseUrl);await page.waitForLoadState('networkidle');
  await page.evaluate(win=>{
    const store=window.__FIBERBROWSER_STORE__!;
    const panel=store.getState().panels.find(p=>p.contentType==='dataset')!;
    store.setState({uiScale:1.6,panels:Array.from({length:5},(_,i)=>({...panel,id:`export-panel-${i}`,layoutRow:0,layoutColumn:i,widthFraction:.2}))});
    store.getState().setViewport(win[0],win[1],win[2]);
  },readWindow(server));
  await page.waitForLoadState('networkidle');
  const reads=page.locator('canvas[data-copilot-track="reads"]');
  await expect(reads).toHaveCount(5);
  await expect.poll(()=>page.locator('[data-read-track-loading="true"]').count()).toBe(0);
  await page.screenshot({path:testInfo.outputPath('live.png')});
  const box=(await reads.last().boundingBox())!;
  const peakGroup=(await page.getByTestId('toolbar-group-peaks').boundingBox())!;
  await page.getByTestId('export-screenshot-button').click();
  await page.getByLabel('Capture full UI').check();
  await page.getByRole('button',{name:'4x',exact:true}).click();
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export PNG',exact:true}).click();
  const download=await pending;
  const output=testInfo.outputPath('full-ui.png');await download.saveAs(output);
  const data=(await fs.readFile(output)).toString('base64');
  const result=await page.evaluate(async({data,box,peakGroup})=>{
    const img=new Image();img.src=`data:image/png;base64,${data}`;await img.decode();
    const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=1100;
    const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0,1800,1100);
    const pixels=ctx.getImageData(Math.round(box.x+10),Math.round(box.y+10),Math.floor(box.width-20),Math.floor(box.height-20)).data;
    let green=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+1]>pixels[i]*1.3&&pixels[i+1]>pixels[i+2]*1.3)green++;
    const scan=ctx.getImageData(Math.floor(peakGroup.x),Math.floor(peakGroup.y),Math.ceil(peakGroup.width),Math.ceil(peakGroup.height+40));
    let scanInk=0,scanBottom=0;
    for(let y=0;y<scan.height;y++)for(let x=0;x<scan.width;x++){
      const i=(y*scan.width+x)*4;
      if(scan.data[i]<140&&scan.data[i+1]<130&&scan.data[i+2]>160){scanInk++;scanBottom=y;}
    }
    return {green:green/(pixels.length/4),scanInk,scanBottom};
  },{data,box,peakGroup});
  expect(result.green).toBeGreaterThan(.05);
  expect(result.scanInk).toBeGreaterThan(5);
  expect(result.scanBottom).toBeLessThan(peakGroup.height);
});
