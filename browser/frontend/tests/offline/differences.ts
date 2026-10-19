import {getCanvasRenderScale,setupHighDpiCanvas} from '../../src/utils/canvasUtils';
import {DEFAULT_COLORMAP} from '../../src/types';
import {drawReadTrack} from '../../src/components/tracks/read-track/ReadTrackCanvas';
import {makeAxis} from '../../src/features/differences/axis';
import {referenceCanvasX,setReferenceSurface} from '../../src/features/differences/referenceCanvas';
import type {CompactRead} from '../../src/components/tracks/read-track/types';
const START=10000;function draw(reads: CompactRead[], extra: Record<string, unknown> = {}) {
  const canvas=document.createElement('canvas');canvas.style.width='1100px';document.getElementById('canvas')!.replaceChildren(canvas);const rec={canvas,ctx:canvas.getContext('2d')!};
  drawReadTrack({
    canvas: rec.canvas, displayReads: reads, width: 1000, height: 100, regionWidth: 1000,
    chrom: 'chrSV', start: START, end: START + 1000, loading: false,
    datasetId: 'd', sidebarWidth: 0, hasCluster: false, myClusterAssignments: {}, myClusterOrder: [],
    hasClusterFocus: false, myClusterFocus: null, mySelectedClusters: null,
    enabledModTypes: { nuc: true, msp: true, footprint: true }, enabledCigarTypes: { mismatches: false, insertions: true, deletions: true },
    isBAM: true, fillReadHeight: false, storeReadRowHeight: 20, readScrollOffset: 0,
    readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
    showCoverageHistogram: false, isReversed: false,
    activeColormap: DEFAULT_COLORMAP, genes: [], allPeaks: [], orthogonalTracks: [],
    modificationOverlays: [], overlayMarks: {}, jupyterReadHighlights: new Map(),
    jupyterFootprintColorMap: new Map(), allJupyterMarkers: [],
    selectedReadIds: undefined, selectedFootprints: [], footprintCrossHighlight: false,
    footprintGroups: [], selectedFamilyGroupId: null, footprintAnalysisLayer: null,
    clusterStateConsensus: new Map(), hasFilter: false, myFilteredReadIds: null,
    maxRegionForReads: 100_000,
    svEnabled: true, svMinLen: 50,
    ...extra,
  } as unknown as Parameters<typeof drawReadTrack>[0]);
  return rec;
}


(window as any).probe=async(reversed:boolean,expanded:boolean,orientation:'+'|'-'='+')=>{
 const e={chrom:'chrSV',pos:10504,ref_start:10500,t_end:10504,ref_bp:4,kind:'replacement' as const,length:792,ins_id:'alternate',label:'',hap_label:''};
 const axis=makeAxis(10000,11000,1792,reversed,expanded?[e]:[]);
 const row:any={id:'synthetic',analysis_id:'qualified',intervals:[[0,1000,-1000]],alternate_blocks:{alternate:{pos:10504,length:792,mol_bp:792,covered:[0,792],intervals:[[10,20,10]],hap_label:'',orientation,src:['source',0,792],observed_ref_start:10500,observed_ref_end:10504}}};
 const r=draw([row],{axis,width:1792,isReversed:reversed});
 const pixel=(x:number,y:number)=>Array.from(r.ctx.getImageData(Math.floor(x*getCanvasRenderScale()),Math.floor(y*getCanvasRenderScale()),1,1).data);
 const y=expanded?32:8;
 // Independent numeric oracle: 1 bp/pixel when expanded, 1.792 collapsed.
 // These sample positions are not derived with the production axis mapper.
 const bpScale=1792/(1000+(expanded?792:0));
 const x=(bp:number)=>reversed?1792-bp*bpScale:bp*bpScale;
 const result:any={reversed,expanded,orientation,flank:pixel(x(490),y),hole:pixel(x(502),y)};
 const referenceRoot=document.createElement('div'),referenceCanvas=document.createElement('canvas');
 document.getElementById('canvas')!.appendChild(referenceRoot);referenceRoot.appendChild(referenceCanvas);
 setReferenceSurface(referenceRoot,{axis,start:10000,end:11000,width:1792,gutter:0});
 const reference=setupHighDpiCanvas(referenceCanvas,1792,16)!;
 reference.fillStyle='#ff0000';reference.fillRect(490*1.792,0,20*1.792,10);
 await Promise.resolve(); // The reference proxy replays the drawing per span.
 const referencePixel=(px:number)=>Array.from(referenceCanvas.getContext('2d')!.getImageData(Math.floor(px*getCanvasRenderScale()),5*getCanvasRenderScale(),1,1).data);
 result.referenceFlank=referencePixel(x(500));
 result.referenceReplaced=referencePixel(x(502));
 if(expanded){
   result.alternate=pixel(x(519),y);
   result.referenceAlternate=referencePixel(x(700));
   result.referenceRight=referencePixel(x(1300));
   const hitRoot=document.createElement('div'),hitCanvas=document.createElement('canvas');
   hitCanvas.style.width='1792px';hitRoot.appendChild(hitCanvas);
   setReferenceSurface(hitRoot,{axis,start:10000,end:11000,width:1792,gutter:0});
   result.hit=referenceCanvasX(hitCanvas,x(554));
   result.expectedHit=(reversed?496:504)*1.792;
 }
 return result;
};
