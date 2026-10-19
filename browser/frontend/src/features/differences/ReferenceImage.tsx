import { useEffect, useRef, useState } from 'react';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';

/** Reference raster tracks use the same clipped column transform as vectors. */
export function ReferenceImage({ src, width, height, reversed, left=0, onLoad, onError }: {
  src:string;width:number;height:number;reversed:boolean;left?:number;onLoad?:()=>void;onError?:()=>void;
}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const [image,setImage]=useState<HTMLImageElement|null>(null);
  const version=useCanvasRenderVersion();
  useEffect(()=>{const next=new Image();let current=true;
    next.onload=()=>{if(current){setImage(next);onLoad?.();}};
    next.onerror=()=>{if(current)onError?.();};next.src=src;
    return()=>{current=false;next.onload=null;next.onerror=null;};
  },[src]);
  useEffect(()=>{if(canvas.current&&image){const ctx=setupHighDpiCanvas(canvas.current,width,height);ctx?.drawImage(image,0,0,width,height);}},[image,width,height,version]);
  return <canvas ref={canvas} aria-label="Contact matrix strip" data-reference-forward="true" style={{position:'absolute',left,top:0,width,height,pointerEvents:'none',transform:reversed?'scaleX(-1)':undefined}}/>;
}
