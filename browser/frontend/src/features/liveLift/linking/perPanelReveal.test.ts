// Adapted from the post-merge review's round-2 and round-3 probes (Codex): each case failed before the fix or guards a path it touched.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { useLiveLiftStore } from '../store';
import { registerLiftLinking, openLinkedSourceView, chooseLinkChain, sourceViewFor, linkGeneration } from './liftLink';
import { resetNavigation, setNavigationFetcher, prefetchView } from './navigation';
import { popOutPaths } from '../../graphPanel/popOutKind';

let driftTile = false;
let heldTarget: (()=>void)[]=[];
const flush = async () => { for (let i=0;i<50;i++) await Promise.resolve(); };
const view=(id:string)=>useBrowserStore.getState().panels.find(p=>p.id===id)!.viewportOverride;
function tile(side:number) {
 if (!side && driftTile) {
  const out=[0x47,0x4c,0x54,0x31,0,0,2];
  const uv=(v:number)=>{while(v>=128){out.push((v&127)|128);v=Math.floor(v/128);}out.push(v);};
  uv(2000);uv(2000);uv(0);uv(0);
  uv(2000);uv(15000);uv(4000);uv(0);
  return new Uint8Array(out);
 }
 const out=[0x47,0x4c,0x54,0x31,side,0,1];
 const uv=(v:number)=>{while(v>=128){out.push((v&127)|128);v=Math.floor(v/128);}out.push(v);};
 uv(side?0:2000);uv(18000);uv(side?2000:0);uv(0);
 return new Uint8Array(out);
}
async function setup(twoSources=false, holdTarget=false, withDrift=false) {
 heldTarget=[]; driftTile=withDrift;
 resetNavigation();registerLiftLinking();useLiveLiftStore.setState({enabled:true});
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('network forbidden');}));
 setNavigationFetcher({json:async(u:string)=>u.includes('summary')?{
  key:'k',tile_bp:1000000,outline_max_drift:driftTile?1000:0,haplotypes:['H'],labels:{H:'MAT'},sources:{S:'H'},targets:{T:20000},selected:[true],
  chains:[['T',1000,19000,'S',0,driftTile?17000:18000,'+','H',18000,18000]],
 }:{rows:[[1000,19000,0,driftTile?17000:18000,'+',0,driftTile?1000:0,u.includes('side=source')?'T':'S']]},bytes:async(u:string)=>{
 const side=u.includes('side=source')?1:0;const n=new URL(u,'http://x').searchParams.get('tile');
 if(holdTarget && !side && n==='0') return new Promise<Uint8Array>(r=>heldTarget.push(()=>r(tile(0))));
 return tile(side);
 }} as never);
 useBrowserStore.setState({chrom:'T',start:2000,end:3000,navigationMode:'perPanel',isReversed:false,_lastRestoreTime:0,lastMovedPanels:{},
 datasets:[
 {id:'ref',path:'/r.bam',label:'ref',color:'#000',data_type:'bam'},
 {id:'lift',path:'/s.bam',label:'lift',color:'#000',data_type:'bam_livelift',live_lift:{key:'k',haplotypes:['H'],haplotype_labels:{H:'MAT'}}},
 {id:'native',path:'/s.bam',label:'native',color:'#000',data_type:'bam'},
 ],panels:[
 {id:'host',contentType:'dataset',datasetId:'ref',subTracks:[],collapsed:false,linkGroup:null,viewMode:'graph',viewportOverride:{chrom:'T',start:5000,end:7000},
 graphView:{role:'host',registrationId:'r',targetPathKey:'T',targetViewport:null,linkMode:'follow',initiatingPanelId:null,initiatingReferenceId:null,popOutKind:'source'}},
 {id:'mat',contentType:'dataset',datasetId:'lift',subTracks:[],collapsed:true,collapsedByGraphGroup:'host',graphMemberOf:'host',liftHap:'MAT',linkGroup:null,viewportOverride:{chrom:'T',start:5000,end:7000}},
 {id:'src',contentType:'dataset',datasetId:'native',subTracks:[],collapsed:true,linkGroup:null,viewportOverride:{chrom:'S',start:1000,end:2000},
 liftLink:{id:'L',datasetId:'lift',liftPanelId:'mat',hap:'H',hapLabel:'MAT',contig:'S',flip:false,chain:null}},
 ...(twoSources?[{id:'other',contentType:'dataset',datasetId:'native',subTracks:[],collapsed:false,linkGroup:null,viewportOverride:{chrom:'S',start:1000,end:2000},
 liftLink:{id:'L2',datasetId:'lift',liftPanelId:'host',hap:'H',hapLabel:'MAT',contig:'S',flip:false,chain:null}}]:[]),
 ]} as never);
 if(!holdTarget) await prefetchView('lift','k',0,'T',1000,19000);await prefetchView('lift','k',1,'S',0,18000);await flush();
 useBrowserStore.getState().clearHistory();
}

describe('Each panel navigates: revealing, cycles, Linked navigation and split panels (post-merge review, group C round 2)',()=>{
 it('R2-undo: a revealed source view returns to the revealed position on Redo',async()=>{
  await setup();
  popOutPaths('host',['mat']);await flush();
  expect(view('src')).toEqual({chrom:'S',start:4000,end:6000});
  const shown=view('src');
  const st=useBrowserStore.getState();
  expect(st._historyStack).toHaveLength(2);
  st.undo();expect(useBrowserStore.getState().panels.find(p=>p.id==='src')!.collapsed).toBe(true);
  st.redo();await flush();
  expect(useBrowserStore.getState().panels.find(p=>p.id==='src')!.collapsed).toBe(false);
  expect(view('src')).toEqual(shown);
 });
 it('R2-race: a delayed reveal must not overwrite a subsequent source navigation',async()=>{
  await setup(false,true);
  popOutPaths('host',['mat']);
  await flush();
  expect(heldTarget).toHaveLength(1);
  // A second event while the reveal waits on a target tile. The reverse tile is already exact.
  useBrowserStore.getState().setPanelViewport('src',10000,12000);
  expect(view('host')).toEqual({chrom:'T',start:11000,end:13000});
  expect(view('src')).toEqual({chrom:'S',start:10000,end:12000});
  for(const release of heldTarget.splice(0))release();
  await flush();
  expect(view('host')).toEqual({chrom:'T',start:11000,end:13000});
  expect(view('src')).toEqual({chrom:'S',start:10000,end:12000});
 });
 it('R2-transitive: source-host-source cycle moves once and undoes/redoes in one step',async()=>{
  await setup(true);
  const initial=useBrowserStore.getState().panels.map(p=>[p.id,p.viewportOverride]);
  const writes:string[]=[];
  const off=useBrowserStore.subscribe((s,p)=>{
   for(const x of s.panels){const prev=p.panels.find(q=>q.id===x.id);if(JSON.stringify(x.viewportOverride)!==JSON.stringify(prev?.viewportOverride))writes.push(x.id);}
  });
  useBrowserStore.getState().setPanelViewport('src',10000,12000);
  off();
  expect(writes).toEqual(['src','host','other']);
  expect(view('host')).toEqual({chrom:'T',start:11000,end:13000});
  expect(view('other')).toEqual({chrom:'S',start:10000,end:12000});
  expect(useBrowserStore.getState()._historyStack).toHaveLength(2);
  const after=useBrowserStore.getState().panels.map(p=>[p.id,p.viewportOverride]);
  useBrowserStore.getState().undo();expect(useBrowserStore.getState().panels.map(p=>[p.id,p.viewportOverride])).toEqual(initial);
  useBrowserStore.getState().redo();expect(useBrowserStore.getState().panels.map(p=>[p.id,p.viewportOverride])).toEqual(after);
 });
 it('R2-linked: folded-member source follows the main view and moves it back',async()=>{
  await setup();
  useBrowserStore.setState(s=>({navigationMode:'linked',panels:s.panels.map(p=>p.id==='src'?{...p,collapsed:false}:{...p,viewportOverride:undefined})}));
  useBrowserStore.getState().setViewport('T',11000,13000);
  expect(view('src')).toEqual({chrom:'S',start:10000,end:12000});
  useBrowserStore.getState().setPanelViewport('src',9000,10000);
  expect([useBrowserStore.getState().chrom,useBrowserStore.getState().start,useBrowserStore.getState().end]).toEqual(['T',10000,11000]);
  expect(view('src')).toEqual({chrom:'S',start:9000,end:10000});
 });
 it('R2-split: non-graph lifted panel uses its own view for open and chain changes',async()=>{
  await setup();
  useBrowserStore.setState(s=>({panels:s.panels.filter(p=>p.id!=='host').map(p=>p.id==='mat'?{...p,collapsed:false,collapsedByGraphGroup:undefined,graphMemberOf:undefined}:p)}));
  await openLinkedSourceView('mat','MAT');
  expect(view('src')).toEqual({chrom:'S',start:4000,end:6000});
  chooseLinkChain('src',0);
  expect(view('src')).toEqual({chrom:'S',start:4000,end:6000});
 });
});

describe('Each panel navigates: a revealed source view settles exactly, and never after Undo (post-merge review, group C round 3)',()=>{
 it('R3-outline: reveal with outline loaded still settles at the exact tile position',async()=>{
  await setup(false,true,true);
  const src=useBrowserStore.getState().panels.find(p=>p.id==='src')!;
  const own={chrom:'T',start:5000,end:7000};
  sourceViewFor(src,own); await flush(); // outline loaded, target tile absent
  popOutPaths('host',['mat']); await flush();
  expect(heldTarget).toHaveLength(1);
  for(const release of heldTarget.splice(0))release(); await flush();
  const mapped=sourceViewFor(useBrowserStore.getState().panels.find(p=>p.id==='src')!,own);
  expect(mapped && mapped!=='pending' && mapped.mapping.exact).toBe(true);
  expect(mapped && mapped!=='pending' && mapped.span).toEqual({chrom:'S',start:3000,end:5000});
  expect(view('src')).toEqual({chrom:'S',start:3000,end:5000});
 });
 it('R3-undo: pending reveal does not write after the reveal was undone',async()=>{
  await setup(false,true);
  popOutPaths('host',['mat']); await flush();
  useBrowserStore.getState().undo();
  const before=view('src');
  for(const release of heldTarget.splice(0))release(); await flush();
  expect(useBrowserStore.getState().panels.find(p=>p.id==='src')!.collapsed).toBe(true);
  expect(view('src')).toEqual(before);
 });
 it('R3-branch: pending reveal never folds into the step that replaced it after Undo',async()=>{
  await setup(false,true);
  popOutPaths('host',['mat']); await flush();
  useBrowserStore.getState().undo(); await flush();
  useBrowserStore.getState().setPanelReversed('host',true);
  const st=useBrowserStore.getState();
  const id=st._historyStack[st._historyPointer].id;
  const before=st._historyStack[st._historyPointer].state.panels?.find(p=>p.id==='src')?.viewportOverride;
  for(const release of heldTarget.splice(0))release(); await flush();
  const after=useBrowserStore.getState();
  expect(after._historyStack[after._historyPointer].id).toBe(id);
  expect(after._historyStack[after._historyPointer].state.panels?.find(p=>p.id==='src')?.viewportOverride).toEqual(before);
 });
 it('R3-delayed-redo: late exact reveal is included in its own undo step',async()=>{
  await setup(false,true);
  popOutPaths('host',['mat']); await flush();
  for(const release of heldTarget.splice(0))release(); await flush();
  expect(view('src')).toEqual({chrom:'S',start:4000,end:6000});
  useBrowserStore.getState().undo();useBrowserStore.getState().redo();
  expect(view('src')).toEqual({chrom:'S',start:4000,end:6000});
 });
 it('R3-linked-reveal: without an own lifted view reveal leaves source viewport untouched',async()=>{
  await setup();
  useBrowserStore.setState(s=>({navigationMode:'linked',panels:s.panels.map(p=>p.id==='src'?p:{...p,viewportOverride:undefined})}));
  const before=view('src');
  popOutPaths('host',['mat']);await flush();
  expect(view('src')).toEqual(before);
 });
});
