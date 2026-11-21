import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { usePanelDisplayStore } from '../../hooks/usePanelDisplayStore';
import { useDifferenceAxis } from './useDifferenceAxis';
import { setReferenceSurface } from './referenceCanvas';
import { requestCanvasRedraw } from '../../utils/canvasUtils';

/** Reference-only tracks share columns with the ruler and read overlays. */
export function ReferenceAxisSurface({ width, gutter, view, children }: { width: number; gutter: number;
  view: { chrom: string; start: number; end: number }; children: ReactNode }) {
  const reversed = usePanelDisplayStore(s => s.isReversed);
  const { axis } = useDifferenceAxis(view.chrom,view.start,view.end,Math.max(1,width-gutter),reversed);
  const root=useRef<HTMLDivElement | null>(null);
  const signature=JSON.stringify([view, width, gutter, reversed, axis.blocks.map(b => [b.ins.ins_id,b.ins.length,b.ins.pos])]);
  useLayoutEffect(() => {
    if (root.current) setReferenceSurface(root.current,{axis,...view,width,gutter});
    requestCanvasRedraw();
  },[signature]);
  return <div ref={element => { root.current=element; if(element) setReferenceSurface(element,{axis,...view,width,gutter}); }} style={{width,height:'100%'}}>{children}</div>;
}
