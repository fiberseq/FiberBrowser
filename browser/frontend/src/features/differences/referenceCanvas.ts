import type { DifferenceAxis } from './axis';

export interface ReferenceSurface { axis: DifferenceAxis; start: number; end: number; width: number; gutter: number }
const surfaces = new WeakMap<Element, ReferenceSurface>();
export function setReferenceSurface(element: Element, surface: ReferenceSurface) { surfaces.set(element, surface); }

/** Replay reference-only drawing through the same piecewise transform as reads.
 * Draw commands (including vector-export recording) retain one reference scale;
 * alternate interiors receive no invented reference signal. No read decode or
 * duplicate React track is involved. The ordinary path is a zero-work bypass.
 */
export function projectReferenceContext(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, width: number, height: number): CanvasRenderingContext2D {
  let root: Element | null = canvas.parentElement;
  while (root && !surfaces.has(root)) root = root.parentElement;
  const surface = root && surfaces.get(root);
  if (!surface || !surface.axis.blocks.length) return ctx;
  const gutter = width === surface.width ? surface.gutter : 0;
  const available = width-gutter;
  const scale = available / Math.max(1, surface.end-surface.start);
  const axis = surface.axis;
  const ratio = available/Math.max(1, surface.width-surface.gutter);
  const cuts = [surface.start, ...new Set(axis.blocks.map(b => b.ins.pos)), surface.end];
  type Command = { method: string; args: any[] } | { property: string; value: any };
  const commands: Command[] = [];
  let pending = false;
  const flush = () => {
    pending = false;
    ctx.save(); ctx.clearRect(0, 0, width, height);
    // The gutter is screen space, retained once.
    if (gutter) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, gutter, height); ctx.clip(); replay(); ctx.restore();
    }
    for (let i=0; i<cuts.length-1; i++) {
      const a=cuts[i], b=cuts[i+1];
      if (b<=a) continue;
      const spans=axis.spans(a,b);
      for (const span of spans) {
        const oldA=(a-surface.start)*scale;
        // Source tracks already reverse themselves. Their reference pixels
        // therefore use the same reversal as this axis, exactly once.
        const forward=canvas.dataset.referenceForward === 'true' || axis.toX(surface.start) < axis.toX(surface.end);
        const oldLeft=forward ? oldA : available-(b-surface.start)*scale;
        const destLeft=canvas.dataset.referenceForward === 'true' && axis.toX(surface.start)>axis.toX(surface.end) ? available-(span.x+span.w)*ratio : span.x*ratio;
        const factor=span.w*ratio/((b-a)*scale);
        ctx.save(); ctx.beginPath(); ctx.rect(gutter+destLeft,0,span.w*ratio,height); ctx.clip();
        ctx.translate(gutter+destLeft-(gutter+oldLeft)*factor,0); ctx.scale(factor,1); replay(); ctx.restore();
      }
    }
    ctx.restore();
  };
  const replay = () => {
    for (const command of commands) {
      if ('property' in command) (ctx as any)[command.property]=command.value;
      else (ctx as any)[command.method](...command.args);
    }
  };
  const schedule = () => { if (!pending) { pending=true; queueMicrotask(flush); } };
  return new Proxy(ctx, {
    get(target, property) {
      const value=Reflect.get(target,property,target);
      if (typeof value !== 'function') return value;
      const method=String(property);
      if (['measureText','createImageData','getContextAttributes','getImageData','getLineDash','getTransform','isPointInPath','isPointInStroke','createLinearGradient','createRadialGradient','createPattern'].includes(method)) return value.bind(target);
      return (...args: any[]) => {
        if (method==='putImageData') {
          const image=document.createElement('canvas'); image.width=args[0].width; image.height=args[0].height;
          image.getContext('2d')?.putImageData(args[0],0,0);
          commands.push({method:'drawImage',args:[image,args[1],args[2]]});
        } else commands.push({method,args});
        schedule();
      };
    },
    set(target,property,value) {
      commands.push({property:String(property),value}); schedule();
      return Reflect.set(target,property,value,target);
    },
  });
}

/** Inverse mapping for reference-only track hit tests and drag selections. */
export function referenceCanvasX(canvas: HTMLElement | null, x: number): number {
  if (!canvas) return x;
  let root: Element | null=canvas.parentElement;
  while(root && !surfaces.has(root)) root=root.parentElement;
  const s=root && surfaces.get(root);
  if(!s || !s.axis.blocks.length) return x;
  const width=canvas.clientWidth || Number.parseFloat(canvas.style.width) || s.width;
  const gutter=width===s.width?s.gutter:0;
  const ratio=(s.width-s.gutter)/Math.max(1,width-gutter);
  const p=s.axis.fromX((x-gutter)*ratio);
  if(p.ins_id) return Number.NaN;
  const forward=s.axis.toX(s.start)<s.axis.toX(s.end);
  return gutter+(forward?p.pos-s.start:s.end-p.pos)/(s.end-s.start)*(width-gutter);
}

export function referenceDisplayX(element: HTMLElement | null, x:number):number {
  if(!element)return x;
  let root:Element|null=element.parentElement;while(root&&!surfaces.has(root))root=root.parentElement;
  const s=root&&surfaces.get(root);if(!s||!s.axis.blocks.length)return x;
  const width=element.clientWidth||Number.parseFloat(element.style.width)||s.width;
  const gutter=width===s.width?s.gutter:0;
  const forward=s.axis.toX(s.start)<s.axis.toX(s.end);
  const p=s.start+(forward?(x-gutter)/(width-gutter):1-(x-gutter)/(width-gutter))*(s.end-s.start);
  return gutter+s.axis.toX(p)*(width-gutter)/(s.width-s.gutter);
}
