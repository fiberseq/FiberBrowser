import { expect,it,vi } from 'vitest';
import { makeAxis } from './axis';
import { projectReferenceContext, referenceCanvasX, setReferenceSurface } from './referenceCanvas';
it.each([false,true])('projects reference drawing and inverse hits through a replacement (reverse=%s)',async reversed=>{
  const root=document.createElement('div'),canvas=document.createElement('canvas');root.appendChild(canvas);canvas.style.width='1792px';
  const axis=makeAxis(0,1000,1792,reversed,[{chrom:'chr1',pos:504,ref_start:500,t_end:504,ref_bp:4,kind:'replacement',length:792,ins_id:'allele',label:'alternate',hap_label:''}]);
  setReferenceSurface(root,{axis,start:0,end:1000,width:1792,gutter:0});
  const ctx:any={save:vi.fn(),restore:vi.fn(),clearRect:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),translate:vi.fn(),scale:vi.fn(),fillRect:vi.fn()};
  projectReferenceContext(canvas,ctx,1792,40).fillRect(0,0,1792,40);await Promise.resolve();
  expect(ctx.rect.mock.calls.map((a:any[])=>a.slice(0,3))).toEqual(reversed?[[1288,0,504],[0,0,496]]:[[0,0,504],[1296,0,496]]);
  expect(referenceCanvasX(canvas,axis.toX(900))).toBeCloseTo((reversed?100:900)*1.792);
  expect(ctx.fillRect).toHaveBeenCalledTimes(2);
});

/** Independent orthographic raster oracle, without a browser listener. */
class Raster {
  pixels=new Uint8Array(1792*40*4);fillStyle='#000000';a=1;e=0;clipBox=[0,0,1792,40];path=[0,0,1792,40];stack:any[]=[];
  save(){this.stack.push([this.a,this.e,this.clipBox.slice(),this.fillStyle]);}
  restore(){[this.a,this.e,this.clipBox,this.fillStyle]=this.stack.pop();}
  translate(x:number){this.e+=this.a*x;}
  scale(x:number){this.a*=x;}
  beginPath(){}
  rect(x:number,y:number,w:number,h:number){this.path=[this.a*x+this.e,y,this.a*w,h];}
  clip(){const [x,y,w,h]=this.path,[a,b,c,d]=this.clipBox;this.clipBox=[Math.max(x,a),Math.max(y,b),Math.max(0,Math.min(x+w,a+c)-Math.max(x,a)),Math.max(0,Math.min(y+h,b+d)-Math.max(y,b))];}
  paint(x:number,y:number,w:number,h:number,rgba:number[]){
    const left=Math.min(this.a*x+this.e,this.a*(x+w)+this.e),right=Math.max(this.a*x+this.e,this.a*(x+w)+this.e),[a,b,c,d]=this.clipBox;
    for(let row=Math.max(0,Math.ceil(Math.max(y,b)));row<Math.min(40,y+h,b+d);row++)for(let col=Math.max(0,Math.ceil(Math.max(left,a)));col<Math.min(1792,right,a+c);col++)this.pixels.set(rgba,(row*1792+col)*4);
  }
  clearRect(x:number,y:number,w:number,h:number){this.paint(x,y,w,h,[0,0,0,0]);}
  fillRect(x:number,y:number,w:number,h:number){const c=this.fillStyle;this.paint(x,y,w,h,[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16),255]);}
  at(x:number,y:number){return [...this.pixels.slice((y*1792+x)*4,(y*1792+x)*4+4)];}
}
it.each([false,true])('matches authored final pixels through expand, reverse and collapse (reverse=%s)',async reversed=>{
  const {drawInsertionPayload}=await import('../../components/tracks/read-track/liveLiftInsertionCanvas');
  const root=document.createElement('div'),canvas=document.createElement('canvas');root.appendChild(canvas);
  const expansion={chrom:'chr1',pos:504,length:792,ins_id:'alternate',hap_label:'',label:'replacement'};
  for(const expanded of [true,false]){
    const axis=makeAxis(0,1000,1792,reversed,expanded?[expansion]:[]),r=new Raster();
    setReferenceSurface(root,{axis,start:0,end:1000,width:1792,gutter:0});
    const ctx=projectReferenceContext(canvas,r as any,1792,40);ctx.fillStyle='#ff0000';ctx.fillRect(490*1.792,0,20*1.792,10);await Promise.resolve();
    if(expanded){
      drawInsertionPayload(r as any,{pos:504,hap_label:'',src:['source',0,792],length:792,mol_bp:792,orientation:'+',covered:[0,792],intervals:[[10,20,10]]},'alternate',axis,{y:20,h:10,sidebar:0,background:'#eeeeee',enabled:{},color:()=>'#00ff00'});
      expect(r.at(reversed?1290:500,5)).toEqual([255,0,0,255]);expect(r.at(reversed?492:1300,5)).toEqual([255,0,0,255]);
      expect(r.at(reversed?1200:600,5)).toEqual([0,0,0,0]);expect(r.at(reversed?1275:518,25)).toEqual([0,255,0,255]);
    }else{expect(r.at(895,5)).toEqual([255,0,0,255]);expect(r.at(518,25)).toEqual([0,0,0,0]);}
  }
});
it.each([false,true])('snaps alternate-interior reference gestures to a finite boundary (reverse=%s)',reversed=>{
  const root=document.createElement('div'),canvas=document.createElement('canvas');root.appendChild(canvas);canvas.style.width='1792px';
  const axis=makeAxis(0,1000,1792,reversed,[{chrom:'chr1',pos:504,length:792,ins_id:'allele',label:'',hap_label:''}]);
  setReferenceSurface(root,{axis,start:0,end:1000,width:1792,gutter:0});
  for(const offset of [1,396,791]){
    const x=referenceCanvasX(canvas,axis.toX(0,{ins_id:'allele',offset}));
    expect(x).toBeCloseTo((reversed?496:504)*1.792);
    expect(Number.isFinite(Math.max(0,Math.min(1792,x)))).toBe(true);
  }
});
