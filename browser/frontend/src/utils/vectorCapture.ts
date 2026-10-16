/**
 * Records what each track canvas draws while a vector (SVG/PDF) export is
 * running, so the figure can replay those drawings as editable shapes.
 *
 * setupHighDpiCanvas hands every track its 2D context; during capture that
 * context is wrapped so each call is still drawn on screen and also recorded.
 * A canvas whose drawing uses something the vector renderers can't express
 * (images, pixel access, gradients, patterns) or that draws too many shapes
 * (read tracks: effectively a heatmap) is marked unusable and exported as an
 * image instead, so a figure never breaks.
 */

export type RecordedOp =
  | { kind: 'call'; name: string; args: unknown[] }
  | { kind: 'set'; name: string; value: unknown };

export interface CanvasRecording {
  ops: RecordedOp[];
  /** Drawing used a feature the vector renderers can't express. */
  unsupported: boolean;
  /** Drawing had more shapes than is useful as vectors (e.g. reads). */
  overflow: boolean;
}

/** Shapes beyond this are better as an image (a read track easily has 100k). */
export const MAX_VECTOR_OPS = 60_000;

const REPLAYED_CALLS = new Set([
  'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'resetTransform',
  'setLineDash', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'rect', 'clip',
  'quadraticCurveTo', 'bezierCurveTo', 'fillRect', 'strokeRect', 'clearRect',
  'fill', 'stroke', 'fillText', 'strokeText',
]);
/** Called on screen but not needed for the vector copy. */
const IGNORED_CALLS = new Set(['measureText', 'getLineDash', 'isPointInPath', 'isPointInStroke', 'getTransform']);
const REPLAYED_PROPS = new Set([
  'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'globalAlpha',
]);
const IGNORED_PROPS = new Set([
  'imageSmoothingEnabled', 'imageSmoothingQuality', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
  'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'direction', 'letterSpacing', 'wordSpacing',
  'fontKerning', 'textRendering', 'filter', 'globalCompositeOperation',
]);

let capturing = false;
let generation = 0;
let recordings = new WeakMap<HTMLCanvasElement, CanvasRecording>();

export function beginVectorCapture(): void {
  capturing = true;
  generation += 1;
  recordings = new WeakMap();
}

/** Stop recording: drawing after this (or by contexts from an earlier export) is not added. */
export function endVectorCapture(): void {
  capturing = false;
  generation += 1;
}

export function isVectorCapturing(): boolean {
  return capturing;
}

export function getCanvasRecording(canvas: HTMLCanvasElement): CanvasRecording | undefined {
  return recordings.get(canvas);
}

/** Wrap a freshly set-up context so its drawing is recorded during capture. */
export function wrapForVectorCapture(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): CanvasRenderingContext2D {
  // Read tracks (many thousands of shapes) are placed as an image.
  if (!capturing || canvas.dataset?.figureRaster === 'true') return ctx;
  // Each setup starts a new drawing: the last complete one wins.
  const recording: CanvasRecording = { ops: [], unsupported: false, overflow: false };
  recordings.set(canvas, recording);
  const myGeneration = generation;
  const live = () => capturing && generation === myGeneration;
  const record = (op: RecordedOp) => {
    if (!live() || recording.unsupported || recording.overflow) return;
    if (recording.ops.length >= MAX_VECTOR_OPS) {
      recording.overflow = true;
      recording.ops = [];
      return;
    }
    recording.ops.push(op);
  };
  return new Proxy(ctx, {
    get(target, prop, _receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const name = String(prop);
      return (...args: unknown[]) => {
        if (!live()) return (value as (...a: unknown[]) => unknown).apply(target, args);
        if (REPLAYED_CALLS.has(name)) {
          // Path2D arguments and fill rules aren't replayable.
          if ((name === 'fill' || name === 'stroke') && args.length > 0) recording.unsupported = true;
          else record({ kind: 'call', name, args: args.map(arg => (Array.isArray(arg) ? [...arg] : arg)) });
        } else if (!IGNORED_CALLS.has(name)) {
          recording.unsupported = true;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
    set(target, prop, value) {
      const name = String(prop);
      if (!live()) return Reflect.set(target, prop, value, target);
      if (REPLAYED_PROPS.has(name)) {
        if (typeof value === 'string' || typeof value === 'number') record({ kind: 'set', name, value });
        else recording.unsupported = true; // gradient or pattern
      } else if (!IGNORED_PROPS.has(name)) {
        recording.unsupported = true;
      }
      return Reflect.set(target, prop, value, target);
    },
  });
}

interface ReplayTarget {
  [key: string]: unknown;
  measureText?: (text: string) => { width: number };
}

type Rect = { x: number; y: number; w: number; h: number };
type ClipRect = Rect | null;
/** Canvas transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = [number, number, number, number, number, number];
type Point = [number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const EPS = 1e-6;

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

function apply(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const axisAligned = (m: Matrix) => Math.abs(m[1]) < EPS && Math.abs(m[2]) < EPS;
const inside = (b: Rect, [x, y]: Point) =>
  x >= b.x - EPS && x <= b.x + b.w + EPS && y >= b.y - EPS && y <= b.y + b.h + EPS;

/** Clip a polygon to a rectangle (Sutherland-Hodgman). */
function clipPolygon(points: Point[], b: Rect): Point[] {
  const edges: [(p: Point) => boolean, (p: Point, q: Point) => Point][] = [
    [p => p[0] >= b.x, (p, q) => [b.x, p[1] + (q[1] - p[1]) * (b.x - p[0]) / (q[0] - p[0])]],
    [p => p[0] <= b.x + b.w, (p, q) => [b.x + b.w, p[1] + (q[1] - p[1]) * (b.x + b.w - p[0]) / (q[0] - p[0])]],
    [p => p[1] >= b.y, (p, q) => [p[0] + (q[0] - p[0]) * (b.y - p[1]) / (q[1] - p[1]), b.y]],
    [p => p[1] <= b.y + b.h, (p, q) => [p[0] + (q[0] - p[0]) * (b.y + b.h - p[1]) / (q[1] - p[1]), b.y + b.h]],
  ];
  let out = points;
  for (const [keep, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i += 1) {
      const p = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (keep(p)) {
        if (!keep(prev)) out.push(cross(prev, p));
        out.push(p);
      } else if (keep(prev)) {
        out.push(cross(prev, p));
      }
    }
    if (out.length === 0) break;
  }
  return out;
}

/** Clip a line segment to a rectangle (Liang-Barsky); null when outside. */
function clipSegment(p: Point, q: Point, b: Rect): [Point, Point] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const checks: [number, number][] = [
    [-dx, p[0] - b.x], [dx, b.x + b.w - p[0]], [-dy, p[1] - b.y], [dy, b.y + b.h - p[1]],
  ];
  for (const [pk, qk] of checks) {
    if (Math.abs(pk) < EPS) {
      if (qk < -EPS) return null;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [[p[0] + t0 * dx, p[1] + t0 * dy], [p[0] + t1 * dx, p[1] + t1 * dy]];
}

interface Subpath { points: Point[]; closed: boolean }
interface PathOp { name: string; args: unknown[]; m: Matrix }

/** Straight-edged subpaths of a path in canvas pixels, or null if it has curves. */
function straightSubpaths(ops: PathOp[]): Subpath[] | null {
  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  for (const op of ops) {
    const a = op.args as number[];
    if (op.name === 'moveTo') {
      current = { points: [apply(op.m, a[0], a[1])], closed: false };
      subpaths.push(current);
    } else if (op.name === 'lineTo') {
      const p = apply(op.m, a[0], a[1]);
      if (!current) {
        current = { points: [p], closed: false };
        subpaths.push(current);
      } else if (current.closed) {
        // After closePath a new subpath starts where the last one began.
        current = { points: [current.points[0], p], closed: false };
        subpaths.push(current);
      } else {
        current.points.push(p);
      }
    } else if (op.name === 'rect') {
      const [x, y, w, h] = a;
      current = { points: [apply(op.m, x, y), apply(op.m, x + w, y), apply(op.m, x + w, y + h), apply(op.m, x, y + h)], closed: true };
      subpaths.push(current);
    } else if (op.name === 'closePath') {
      if (current) current.closed = true;
    } else {
      return null;
    }
  }
  return subpaths;
}

/**
 * Replay a recording into an SvgRenderer/PdfRenderer-shaped target.
 *
 * save/restore stay balanced within the recording, so a track can't pop the
 * caller's placement. Clipping is used by tracks only to keep a label inside
 * its box: a rectangular clip shortens text drawn while it is active (vector
 * clip paths break Illustrator), and shapes are left as drawn.
 *
 * With `bounds` (the canvas box, in the recording's own pixels) whatever the
 * canvas cut off on screen is cut here too: straight-edged shapes are clipped
 * geometrically, text entirely outside is dropped and text running off the
 * right edge is shortened. Curves are left as drawn.
 */
export function replayRecording(recording: CanvasRecording, target: ReplayTarget, bounds?: Rect): void {
  let depth = 0;
  let pathRect: ClipRect = null;
  let pathIsRect = false;
  let clip: ClipRect = null;
  const clipStack: ClipRect[] = [];
  // Transform from the track's drawing coordinates to canvas pixels.
  let m: Matrix = IDENTITY;
  const matrixStack: Matrix[] = [];
  let path: PathOp[] = [];
  // The target's path no longer matches `path` (a clipped copy replaced it).
  let targetPathStale = false;
  const call = (name: string, args: unknown[]) => {
    const fn = target[name];
    if (typeof fn === 'function') (fn as (...a: unknown[]) => void).apply(target, args);
  };
  /** Run `draw` with canvas-pixel coordinates. */
  const inCanvasPixels = (draw: () => void) => {
    const inverse = invert(m);
    if (!inverse) return;
    call('save', []);
    call('transform', inverse);
    draw();
    call('restore', []);
  };
  /** Rebuild the target's path, clipped to the bounds; false if it can't be. */
  const emitClippedPath = (mode: 'fill' | 'stroke'): boolean => {
    if (!bounds) return false;
    const subpaths = straightSubpaths(path);
    if (!subpaths) return false;
    const allInside = subpaths.every(sp => sp.points.every(p => inside(bounds, p)));
    if (allInside && !targetPathStale) return true;
    targetPathStale = true;
    call('beginPath', []);
    inCanvasPixels(() => {
      for (const sp of subpaths) {
        if (mode === 'fill') {
          const polygon = clipPolygon(sp.points, bounds);
          if (polygon.length < 3) continue;
          call('moveTo', polygon[0]);
          for (const p of polygon.slice(1)) call('lineTo', p);
          call('closePath', []);
        } else {
          const pts = sp.closed ? [...sp.points, sp.points[0]] : sp.points;
          let pen: Point | null = null;
          for (let i = 1; i < pts.length; i += 1) {
            const seg = clipSegment(pts[i - 1], pts[i], bounds);
            if (!seg) { pen = null; continue; }
            if (!pen || Math.abs(pen[0] - seg[0][0]) > EPS || Math.abs(pen[1] - seg[0][1]) > EPS) call('moveTo', seg[0]);
            call('lineTo', seg[1]);
            pen = seg[1];
          }
        }
      }
    });
    return true;
  };
  /** Put the recorded (unclipped) path back after a clipped copy replaced it. */
  const restoreRawPath = () => {
    if (!targetPathStale) return;
    targetPathStale = false;
    const now = m;
    const inverse = invert(now);
    call('beginPath', []);
    for (const op of path) {
      if (!inverse) break;
      call('save', []);
      call('transform', multiply(inverse, op.m));
      call(op.name, op.args);
      call('restore', []);
    }
  };
  const drawRect = (name: 'fillRect' | 'strokeRect', args: unknown[]) => {
    const [x, y, w, h] = args as number[];
    if (!bounds) { call(name, args); return; }
    const corners: Point[] = [apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)];
    if (corners.every(p => inside(bounds, p))) { call(name, args); return; }
    if (name === 'fillRect') {
      const polygon = clipPolygon(corners, bounds);
      if (polygon.length < 3) return;
      if (axisAligned(m)) {
        const xs = polygon.map(p => p[0]);
        const ys = polygon.map(p => p[1]);
        inCanvasPixels(() => call('fillRect', [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]));
      } else {
        call('beginPath', []);
        inCanvasPixels(() => {
          call('moveTo', polygon[0]);
          for (const p of polygon.slice(1)) call('lineTo', p);
          call('closePath', []);
        });
        call('fill', []);
        targetPathStale = true;
      }
      return;
    }
    // Stroke only the visible parts of the outline (no line along the cut).
    call('beginPath', []);
    inCanvasPixels(() => {
      for (let i = 0; i < 4; i += 1) {
        const seg = clipSegment(corners[i], corners[(i + 1) % 4], bounds);
        if (!seg) continue;
        call('moveTo', seg[0]);
        call('lineTo', seg[1]);
      }
    });
    call('stroke', []);
    targetPathStale = true;
  };
  const drawText = (name: string, args: unknown[]) => {
    const [text, x, y] = args as [string, number, number];
    let room = clip && target.measureText ? clip.x + clip.w - x : Infinity;
    if (bounds && axisAligned(m) && target.measureText) {
      const sx = Math.abs(m[0]) || 1;
      const width = target.measureText(String(text)).width * sx;
      const [ax, ay] = apply(m, x, y);
      const align = String(target.textAlign ?? 'left');
      const left = align === 'right' || align === 'end' ? ax - width : align === 'center' ? ax - width / 2 : ax;
      const size = (Number(/([\d.]+)px/.exec(String(target.font ?? ''))?.[1]) || 12) * (Math.abs(m[3]) || 1);
      const off = left > bounds.x + bounds.w || left + width < bounds.x
        || ay - size > bounds.y + bounds.h || ay + size < bounds.y;
      if (off) return;
      if (align === 'left' || align === 'start') room = Math.min(room, (bounds.x + bounds.w - ax) / sx);
    }
    if (room === Infinity || !target.measureText) { call(name, args); return; }
    let shown = String(text);
    while (shown && target.measureText(shown).width > room) shown = shown.slice(0, -1);
    if (shown) call(name, [shown, x, y, ...args.slice(3)]);
  };
  const setMatrix = (next: Matrix) => { m = next; };

  for (const op of recording.ops) {
    if (op.kind === 'set') {
      target[op.name] = op.value;
      continue;
    }
    const args = op.args;
    switch (op.name) {
      case 'save':
        depth += 1;
        clipStack.push(clip);
        matrixStack.push(m);
        call('save', args);
        break;
      case 'restore':
        if (depth === 0) break; // unmatched: never pop the caller's state
        depth -= 1;
        clip = clipStack.pop() ?? null;
        m = matrixStack.pop() ?? IDENTITY;
        call('restore', args);
        break;
      case 'translate': {
        const [tx, ty] = args as number[];
        setMatrix(multiply(m, [1, 0, 0, 1, tx, ty]));
        call('translate', args);
        break;
      }
      case 'scale': {
        const [sx, sy] = args as number[];
        setMatrix(multiply(m, [sx, 0, 0, sy, 0, 0]));
        call('scale', args);
        break;
      }
      case 'rotate': {
        const [rad] = args as number[];
        const c = Math.cos(rad);
        const sn = Math.sin(rad);
        setMatrix(multiply(m, [c, sn, -sn, c, 0, 0]));
        call('rotate', args);
        break;
      }
      case 'setTransform': case 'resetTransform':
        // Tracks draw in logical pixels from setupHighDpiCanvas; an absolute
        // transform would also drop the figure placement, so keep it relative.
      {
        // setTransform() with no matrix resets, like resetTransform().
        const next = op.name === 'setTransform' && args.length >= 6 ? (args as number[]).slice(0, 6) as Matrix : IDENTITY;
        const inverse = invert(m);
        if (inverse) call('transform', multiply(inverse, next));
        setMatrix(next);
        break;
      }
      case 'beginPath':
        pathRect = null;
        pathIsRect = true;
        path = [];
        targetPathStale = false;
        call('beginPath', args);
        break;
      case 'rect': {
        const [x, y, w, h] = args as number[];
        pathIsRect = pathIsRect && pathRect === null;
        pathRect = { x, y, w, h };
        // Put back the recorded path first, then add this op once.
        restoreRawPath();
        path.push({ name: 'rect', args, m });
        call('rect', args);
        break;
      }
      case 'moveTo': case 'lineTo': case 'arc': case 'quadraticCurveTo': case 'bezierCurveTo': case 'closePath':
        if (op.name !== 'closePath') pathIsRect = false;
        restoreRawPath();
        path.push({ name: op.name, args, m });
        call(op.name, args);
        break;
      case 'clip':
        if (pathIsRect && pathRect) {
          clip = clip ? intersect(clip, pathRect) : pathRect;
        }
        break;
      case 'fill': case 'stroke':
        if (!emitClippedPath(op.name)) restoreRawPath();
        call(op.name, args);
        break;
      case 'fillRect': case 'strokeRect':
        drawRect(op.name, args);
        break;
      case 'fillText': case 'strokeText':
        drawText(op.name, args);
        break;
      default:
        call(op.name, args);
    }
  }
  for (; depth > 0; depth -= 1) call('restore', []);
}

export function isVectorUsable(recording: CanvasRecording | undefined): recording is CanvasRecording {
  return !!recording && !recording.unsupported && !recording.overflow;
}
