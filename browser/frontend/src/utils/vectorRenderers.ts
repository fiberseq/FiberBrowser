// Custom Canvas2D-shaped renderers that emit clean SVG and PDF output.
//
// We previously used canvas2svg + svg2pdf.js to convert chart canvases into
// vectors, but Illustrator crashed on canvas2svg's <defs>/<clipPath> output
// and svg2pdf wraps the entire drawing in a top-level clipping mask that
// can't be released — so the PDF "looked" editable but every shape was
// trapped inside one un-releasable group.
//
// These renderers implement the small Canvas2D subset our chart drawFns
// actually use (rect/path/text/arc + transforms + line dash + globalAlpha)
// and emit:
//   - SVG: a flat list of <rect>, <path>, <line>, <text>, <circle> elements
//          with no <defs>, no <clipPath>, no nested <g>. Each shape is a
//          stand-alone object selectable in Illustrator.
//   - PDF: native jsPDF primitives (rect, lines, text, ellipse) — no SVG
//          wrapping, so no clipping mask.
//
// Both renderers track the current 2D affine matrix and bake transforms
// into final coordinates, so the output is "what was drawn" without any
// transform attribute on individual shapes (except for rotated text,
// where the rotation is too painful to bake into glyph positions).

import type { jsPDF } from 'jspdf';

type Matrix = [number, number, number, number, number, number]; // a,b,c,d,e,f

function identity(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

function multiply(m: Matrix, n: Matrix): Matrix {
  // m * n
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Decompose a matrix into translate + rotate (radians) + scale, assuming no
// shear (which our charts never introduce). Used so we can express rotated
// text via SVG transform="rotate(...)" rather than baking glyph positions.
function decompose(m: Matrix): { tx: number; ty: number; rot: number; sx: number; sy: number } {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const rot = Math.atan2(m[1], m[0]);
  return { tx: m[4], ty: m[5], rot, sx, sy };
}

/** Uniform scale of the current transform (fonts, strokes and images follow it). */
function matrixScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

interface PathOp {
  type: 'M' | 'L' | 'A' | 'C' | 'Z';
  pts: number[]; // M/L: [x, y]; A: [rx, ry, large, sweep, x, y]; C: [c1x, c1y, c2x, c2y, x, y]
}

interface RendererState {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  lineDash: number[];
  matrix: Matrix;
}

function defaultState(): RendererState {
  return {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    lineDash: [],
    matrix: identity(),
  };
}

// Parse a CSS font shorthand. Charts use simple forms like
// "10px sans-serif", "bold 11px sans-serif", "italic 9px sans-serif".
function parseFont(font: string): { weight: string; style: string; size: number; family: string } {
  let weight = 'normal';
  let style = 'normal';
  let size = 10;
  let family = 'sans-serif';
  const tokens = font.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'bold' || t === 'normal' || /^\d+$/.test(t)) {
      if (t === 'bold' || t === 'normal') weight = t;
      i++;
    } else if (t === 'italic' || t === 'oblique') {
      style = t;
      i++;
    } else if (t.endsWith('px')) {
      size = parseFloat(t);
      i++;
      family = tokens.slice(i).join(' ') || 'sans-serif';
      break;
    } else {
      i++;
    }
  }
  return { weight, style, size, family };
}

// Approximate an elliptical arc with cubic Bezier segments. Used by the PDF
// renderer where jsPDF.lines() takes line + bezier ops but no native arc.
function arcToBeziers(
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
  ccw: boolean,
): Array<[number, number, number, number, number, number]> {
  // Normalize sweep direction. Canvas arc default is CW (when y is down,
  // CW means increasing angle visually — Canvas is just standard math
  // orientation flipped).
  let sweep = end - start;
  if (!ccw) {
    if (sweep < 0) sweep += Math.PI * 2;
  } else {
    if (sweep > 0) sweep -= Math.PI * 2;
  }
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const segAngle = sweep / segments;
  const k = (4 / 3) * Math.tan(segAngle / 4);
  const out: Array<[number, number, number, number, number, number]> = [];
  let a = start;
  for (let i = 0; i < segments; i++) {
    const a1 = a;
    const a2 = a + segAngle;
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    const cp1x = x1 - k * r * Math.sin(a1);
    const cp1y = y1 + k * r * Math.cos(a1);
    const cp2x = x2 + k * r * Math.sin(a2);
    const cp2y = y2 - k * r * Math.cos(a2);
    out.push([cp1x, cp1y, cp2x, cp2y, x2, y2]);
    a = a2;
  }
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textAnchor(align: CanvasTextAlign): string {
  if (align === 'center') return 'middle';
  if (align === 'right' || align === 'end') return 'end';
  return 'start';
}

// Map textBaseline to a y-offset relative to the SVG default (alphabetic)
// instead of relying on `dominant-baseline`, which has uneven Illustrator
// support. Offsets are expressed as fractions of the font size.
function baselineDy(baseline: CanvasTextBaseline, fontSize: number): number {
  switch (baseline) {
    case 'top':
    case 'hanging':
      return fontSize * 0.8;
    case 'middle':
      return fontSize * 0.32;
    case 'bottom':
    case 'ideographic':
      return -fontSize * 0.2;
    case 'alphabetic':
    default:
      return 0;
  }
}

// Hidden offscreen canvas used by both renderers for measureText().
let measureCanvas: HTMLCanvasElement | null = null;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  return measureCanvas.getContext('2d');
}

// =============================================================================
// SvgRenderer
// =============================================================================

export class SvgRenderer implements Pick<
  CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'font' | 'textAlign' | 'textBaseline' | 'globalAlpha'
> {
  fillStyle: string = '#000000';
  strokeStyle: string = '#000000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;

  private lineDash: number[] = [];
  private matrix: Matrix = identity();
  private stateStack: RendererState[] = [];

  private path: PathOp[] = [];
  private subpathStart: [number, number] | null = null;
  private cursor: [number, number] | null = null;

  private elements: string[] = [];

  constructor(public width: number, public height: number) {}

  // --- transforms ---

  save(): void {
    this.stateStack.push({
      fillStyle: this.fillStyle as string,
      strokeStyle: this.strokeStyle as string,
      lineWidth: this.lineWidth,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      globalAlpha: this.globalAlpha,
      lineDash: this.lineDash.slice(),
      matrix: [...this.matrix] as Matrix,
    });
  }

  restore(): void {
    const s = this.stateStack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.font = s.font;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
    this.globalAlpha = s.globalAlpha;
    this.lineDash = s.lineDash.slice();
    this.matrix = [...s.matrix] as Matrix;
  }

  translate(tx: number, ty: number): void {
    this.matrix = multiply(this.matrix, [1, 0, 0, 1, tx, ty]);
  }

  rotate(rad: number): void {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    this.matrix = multiply(this.matrix, [c, s, -s, c, 0, 0]);
  }

  scale(sx: number, sy: number): void {
    this.matrix = multiply(this.matrix, [sx, 0, 0, sy, 0, 0]);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.matrix = [a, b, c, d, e, f];
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.matrix = multiply(this.matrix, [a, b, c, d, e, f]);
  }

  resetTransform(): void {
    this.matrix = identity();
  }

  // --- line dash ---

  setLineDash(pattern: number[]): void {
    this.lineDash = pattern.slice();
  }

  // --- paths ---

  beginPath(): void {
    this.path = [];
    this.subpathStart = null;
    this.cursor = null;
  }

  moveTo(x: number, y: number): void {
    const p = transformPoint(this.matrix, x, y);
    this.path.push({ type: 'M', pts: p });
    this.subpathStart = p;
    this.cursor = p;
  }

  lineTo(x: number, y: number): void {
    const p = transformPoint(this.matrix, x, y);
    if (!this.cursor) {
      this.path.push({ type: 'M', pts: p });
      this.subpathStart = p;
    } else {
      this.path.push({ type: 'L', pts: p });
    }
    this.cursor = p;
  }

  closePath(): void {
    this.path.push({ type: 'Z', pts: [] });
    if (this.subpathStart) this.cursor = this.subpathStart;
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    const p1 = transformPoint(this.matrix, c1x, c1y);
    const p2 = transformPoint(this.matrix, c2x, c2y);
    const p = transformPoint(this.matrix, x, y);
    if (!this.cursor) {
      this.path.push({ type: 'M', pts: p1 });
      this.subpathStart = p1;
    }
    this.path.push({ type: 'C', pts: [p1[0], p1[1], p2[0], p2[1], p[0], p[1]] });
    this.cursor = p;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    // Raise to a cubic in untransformed space; affine maps preserve it.
    const inv = this.cursorInUserSpace();
    const [x0, y0] = inv ?? [cx, cy];
    this.bezierCurveTo(x0 + (2 / 3) * (cx - x0), y0 + (2 / 3) * (cy - y0), x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y), x, y);
  }

  /** Clipping is not expressed (Illustrator mishandles clip paths); drawing continues unclipped. */
  clip(): void {}

  /** Place a raster image (e.g. the read tracks) as one object. */
  image(href: string, x: number, y: number, w: number, h: number): void {
    const [px, py] = transformPoint(this.matrix, x, y);
    const k = matrixScale(this.matrix);
    this.elements.push(`<image x="${px}" y="${py}" width="${w * k}" height="${h * k}" preserveAspectRatio="none" href="${escapeXml(href)}"/>`);
  }

  private cursorInUserSpace(): [number, number] | null {
    if (!this.cursor) return null;
    const [a, b, c, d, e, f] = this.matrix;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return null;
    const x = this.cursor[0] - e;
    const y = this.cursor[1] - f;
    return [(d * x - c * y) / det, (-b * x + a * y) / det];
  }

  arc(cx: number, cy: number, r: number, start: number, end: number, ccw = false): void {
    // Express the arc with SVG path A commands so each donut wedge stays
    // a single editable shape in Illustrator.
    let sweep = end - start;
    if (!ccw) {
      if (sweep < 0) sweep += Math.PI * 2;
    } else {
      if (sweep > 0) sweep -= Math.PI * 2;
    }
    const fullCircle = Math.abs(sweep) >= Math.PI * 2 - 1e-6;
    const sx = cx + r * Math.cos(start);
    const sy = cy + r * Math.sin(start);
    const sP = transformPoint(this.matrix, sx, sy);
    if (!this.cursor) {
      this.path.push({ type: 'M', pts: sP });
      this.subpathStart = sP;
    } else if (Math.hypot(sP[0] - this.cursor[0], sP[1] - this.cursor[1]) > 1e-3) {
      this.path.push({ type: 'L', pts: sP });
    }
    this.cursor = sP;

    if (fullCircle) {
      // SVG can't do a 360° arc in a single A command — split into halves.
      const midAngle = start + (ccw ? -Math.PI : Math.PI);
      const ex = cx + r * Math.cos(midAngle);
      const ey = cy + r * Math.sin(midAngle);
      const mP = transformPoint(this.matrix, ex, ey);
      const sweepFlag = ccw ? 0 : 1;
      const { sx: msx, sy: msy } = decompose(this.matrix);
      this.path.push({ type: 'A', pts: [r * msx, r * msy, 0, sweepFlag, mP[0], mP[1]] });
      const fxP = transformPoint(this.matrix, sx, sy);
      this.path.push({ type: 'A', pts: [r * msx, r * msy, 0, sweepFlag, fxP[0], fxP[1]] });
      this.cursor = fxP;
      return;
    }

    const ex = cx + r * Math.cos(end);
    const ey = cy + r * Math.sin(end);
    const eP = transformPoint(this.matrix, ex, ey);
    const largeArc = Math.abs(sweep) > Math.PI ? 1 : 0;
    const sweepFlag = ccw ? 0 : 1;
    const { sx: msx, sy: msy } = decompose(this.matrix);
    this.path.push({ type: 'A', pts: [r * msx, r * msy, largeArc, sweepFlag, eP[0], eP[1]] });
    this.cursor = eP;
  }

  // --- rect ---

  fillRect(x: number, y: number, w: number, h: number): void {
    const p1 = transformPoint(this.matrix, x, y);
    const p2 = transformPoint(this.matrix, x + w, y);
    const p3 = transformPoint(this.matrix, x + w, y + h);
    const p4 = transformPoint(this.matrix, x, y + h);
    const d = `M ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]} L ${p3[0]} ${p3[1]} L ${p4[0]} ${p4[1]} Z`;
    this.elements.push(`<path d="${d}" fill="${escapeXml(this.fillStyle)}"${this.alphaAttr('fill')}/>`);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    const p1 = transformPoint(this.matrix, x, y);
    const p2 = transformPoint(this.matrix, x + w, y);
    const p3 = transformPoint(this.matrix, x + w, y + h);
    const p4 = transformPoint(this.matrix, x, y + h);
    const d = `M ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]} L ${p3[0]} ${p3[1]} L ${p4[0]} ${p4[1]} Z`;
    this.elements.push(this.strokePathElement(d));
  }

  clearRect(_x: number, _y: number, _w: number, _h: number): void {
    // No-op for SVG. Background is implicit/white. (Charts only call
    // clearRect at the top of drawFn, so this is safe.)
  }

  // --- fill/stroke ---

  fill(): void {
    if (this.path.length === 0) return;
    const d = this.pathToString();
    this.elements.push(`<path d="${d}" fill="${escapeXml(this.fillStyle)}"${this.alphaAttr('fill')}/>`);
  }

  stroke(): void {
    if (this.path.length === 0) return;
    const d = this.pathToString();
    this.elements.push(this.strokePathElement(d));
  }

  // --- text ---

  fillText(text: string, x: number, y: number): void {
    if (!text) return;
    this.elements.push(this.textElement(text, x, y, true));
  }

  strokeText(text: string, x: number, y: number): void {
    if (!text) return;
    this.elements.push(this.textElement(text, x, y, false));
  }

  measureText(text: string): TextMetrics {
    const ctx = getMeasureCtx();
    if (ctx) {
      ctx.font = this.font;
      return ctx.measureText(text);
    }
    // Fallback: rough approximation if no DOM canvas (e.g. in SSR).
    const { size } = parseFont(this.font);
    return {
      width: text.length * size * 0.55,
      actualBoundingBoxAscent: size * 0.8,
      actualBoundingBoxDescent: size * 0.2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      fontBoundingBoxAscent: size * 0.8,
      fontBoundingBoxDescent: size * 0.2,
    } as TextMetrics;
  }

  // --- output ---

  toSvg(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">
${this.elements.join('\n')}
</svg>`;
  }

  // --- internals ---

  private pathToString(): string {
    const parts: string[] = [];
    for (const op of this.path) {
      if (op.type === 'M') parts.push(`M ${op.pts[0]} ${op.pts[1]}`);
      else if (op.type === 'L') parts.push(`L ${op.pts[0]} ${op.pts[1]}`);
      else if (op.type === 'Z') parts.push('Z');
      else if (op.type === 'C') parts.push(`C ${op.pts.join(' ')}`);
      else if (op.type === 'A') {
        const [rx, ry, large, sweep, x, y] = op.pts;
        parts.push(`A ${rx} ${ry} 0 ${large} ${sweep} ${x} ${y}`);
      }
    }
    return parts.join(' ');
  }

  private alphaAttr(kind: 'fill' | 'stroke'): string {
    return this.globalAlpha < 1 ? ` ${kind}-opacity="${this.globalAlpha}"` : '';
  }

  private strokePathElement(d: string): string {
    const k = matrixScale(this.matrix);
    const dash = this.lineDash.length > 0 ? ` stroke-dasharray="${this.lineDash.map(v => v * k).join(' ')}"` : '';
    return `<path d="${d}" fill="none" stroke="${escapeXml(this.strokeStyle)}" stroke-width="${this.lineWidth * k}"${dash}${this.alphaAttr('stroke')}/>`;
  }

  private textElement(text: string, x: number, y: number, fill: boolean): string {
    const parsed = parseFont(this.font);
    const { weight, style, family } = parsed;
    const size = parsed.size * matrixScale(this.matrix);
    // Move (x, y) into screen space, then keep the rotation around that
    // point as an SVG transform — baking glyph positions for rotation
    // would require shaping each glyph independently.
    const [px, py] = transformPoint(this.matrix, x, y);
    const decomp = decompose(this.matrix);
    const dy = baselineDy(this.textBaseline, size);
    const anchor = textAnchor(this.textAlign);
    let attrs = `x="${px}" y="${py + dy}" text-anchor="${anchor}" font-family="${escapeXml(family)}" font-size="${size}"`;
    if (weight !== 'normal') attrs += ` font-weight="${weight}"`;
    if (style !== 'normal') attrs += ` font-style="${style}"`;
    if (Math.abs(decomp.rot) > 1e-4) {
      const deg = (decomp.rot * 180) / Math.PI;
      attrs += ` transform="rotate(${deg} ${px} ${py + dy})"`;
    }
    if (fill) {
      attrs += ` fill="${escapeXml(this.fillStyle)}"`;
      if (this.globalAlpha < 1) attrs += ` fill-opacity="${this.globalAlpha}"`;
    } else {
      attrs += ` fill="none" stroke="${escapeXml(this.strokeStyle)}" stroke-width="${this.lineWidth * matrixScale(this.matrix)}"`;
      if (this.globalAlpha < 1) attrs += ` stroke-opacity="${this.globalAlpha}"`;
    }
    return `<text ${attrs}>${escapeXml(text)}</text>`;
  }
}

// =============================================================================
// PdfRenderer
// =============================================================================

// Parses CSS color strings (#hex, rgb(), rgba(), named) into [r,g,b,a].
function parseColor(input: string): [number, number, number, number] {
  if (!input) return [0, 0, 0, 1];
  const s = input.trim();
  if (s.startsWith('#')) {
    if (s.length === 4) {
      const r = parseInt(s[1] + s[1], 16);
      const g = parseInt(s[2] + s[2], 16);
      const b = parseInt(s[3] + s[3], 16);
      return [r, g, b, 1];
    }
    if (s.length === 7) {
      const r = parseInt(s.slice(1, 3), 16);
      const g = parseInt(s.slice(3, 5), 16);
      const b = parseInt(s.slice(5, 7), 16);
      return [r, g, b, 1];
    }
    if (s.length === 9) {
      const r = parseInt(s.slice(1, 3), 16);
      const g = parseInt(s.slice(3, 5), 16);
      const b = parseInt(s.slice(5, 7), 16);
      const a = parseInt(s.slice(7, 9), 16) / 255;
      return [r, g, b, a];
    }
  }
  const m = s.match(/^rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] !== undefined ? parseFloat(m[4]) : 1];
  }
  // Last resort — let the browser parse via getComputedStyle on a temp div.
  if (typeof document !== 'undefined') {
    const div = document.createElement('div');
    div.style.color = s;
    document.body.appendChild(div);
    const computed = getComputedStyle(div).color;
    document.body.removeChild(div);
    const cm = computed.match(/^rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (cm) {
      return [parseFloat(cm[1]), parseFloat(cm[2]), parseFloat(cm[3]), cm[4] !== undefined ? parseFloat(cm[4]) : 1];
    }
  }
  return [0, 0, 0, 1];
}

const PDF_TEXT_REPLACEMENTS: Record<string, string> = {
  '\u2212': '-', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u2192': '->', '\u2190': '<-',
  '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2009': ' ', '\u00A0': ' ',
  '\u25B8': '>', '\u25B6': '>', '\u25BA': '>', '\u25C2': '<', '\u25C0': '<', '\u25C4': '<', '\u2192\uFE0E': '->',
};

/** Map text to what PDF standard fonts can show; drop the rest (icons, emoji). */
export function toPdfText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xff) out += ch;
    else if (PDF_TEXT_REPLACEMENTS[ch]) out += PDF_TEXT_REPLACEMENTS[ch];
  }
  return out.trim() ? out : '';
}

export class PdfRenderer implements Pick<
  CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'font' | 'textAlign' | 'textBaseline' | 'globalAlpha'
> {
  fillStyle: string = '#000000';
  strokeStyle: string = '#000000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;

  private lineDash: number[] = [];
  private matrix: Matrix = identity();
  private stateStack: RendererState[] = [];

  // Path tracked as a list of subpaths, each subpath as start point + ops.
  private subpaths: { start: [number, number]; ops: Array<['L' | 'C', number[]]>; closed: boolean }[] = [];
  private cursor: [number, number] | null = null;

  constructor(private pdf: jsPDF, public width: number, public height: number) {}

  // --- transforms ---

  save(): void {
    this.stateStack.push({
      fillStyle: this.fillStyle as string,
      strokeStyle: this.strokeStyle as string,
      lineWidth: this.lineWidth,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      globalAlpha: this.globalAlpha,
      lineDash: this.lineDash.slice(),
      matrix: [...this.matrix] as Matrix,
    });
  }

  restore(): void {
    const s = this.stateStack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.font = s.font;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
    this.globalAlpha = s.globalAlpha;
    this.lineDash = s.lineDash.slice();
    this.matrix = [...s.matrix] as Matrix;
  }

  translate(tx: number, ty: number): void {
    this.matrix = multiply(this.matrix, [1, 0, 0, 1, tx, ty]);
  }

  rotate(rad: number): void {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    this.matrix = multiply(this.matrix, [c, s, -s, c, 0, 0]);
  }

  scale(sx: number, sy: number): void {
    this.matrix = multiply(this.matrix, [sx, 0, 0, sy, 0, 0]);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.matrix = [a, b, c, d, e, f];
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.matrix = multiply(this.matrix, [a, b, c, d, e, f]);
  }

  resetTransform(): void {
    this.matrix = identity();
  }

  setLineDash(pattern: number[]): void {
    this.lineDash = pattern.slice();
  }

  // --- paths ---

  beginPath(): void {
    this.subpaths = [];
    this.cursor = null;
  }

  moveTo(x: number, y: number): void {
    const p = transformPoint(this.matrix, x, y);
    this.subpaths.push({ start: p, ops: [], closed: false });
    this.cursor = p;
  }

  lineTo(x: number, y: number): void {
    const p = transformPoint(this.matrix, x, y);
    if (this.subpaths.length === 0) {
      this.subpaths.push({ start: p, ops: [], closed: false });
    } else {
      this.subpaths[this.subpaths.length - 1].ops.push(['L', [p[0], p[1]]]);
    }
    this.cursor = p;
  }

  closePath(): void {
    if (this.subpaths.length > 0) {
      this.subpaths[this.subpaths.length - 1].closed = true;
      this.cursor = this.subpaths[this.subpaths.length - 1].start;
    }
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    const p1 = transformPoint(this.matrix, c1x, c1y);
    const p2 = transformPoint(this.matrix, c2x, c2y);
    const p = transformPoint(this.matrix, x, y);
    if (this.subpaths.length === 0) this.subpaths.push({ start: p1, ops: [], closed: false });
    this.subpaths[this.subpaths.length - 1].ops.push(['C', [p1[0], p1[1], p2[0], p2[1], p[0], p[1]]]);
    this.cursor = p;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    const start = this.cursorInUserSpace() ?? [cx, cy];
    const [x0, y0] = start;
    this.bezierCurveTo(x0 + (2 / 3) * (cx - x0), y0 + (2 / 3) * (cy - y0), x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y), x, y);
  }

  /** Clipping is not expressed; drawing continues unclipped. */
  clip(): void {}

  /** Place a raster image (PNG data URL) as one object. */
  image(dataUrl: string, x: number, y: number, w: number, h: number): void {
    const [px, py] = transformPoint(this.matrix, x, y);
    const k = matrixScale(this.matrix);
    this.applyAlpha(1);
    this.pdf.addImage(dataUrl, 'PNG', px, py, w * k, h * k, undefined, 'FAST');
  }

  private cursorInUserSpace(): [number, number] | null {
    if (!this.cursor) return null;
    const [a, b, c, d, e, f] = this.matrix;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return null;
    const x = this.cursor[0] - e;
    const y = this.cursor[1] - f;
    return [(d * x - c * y) / det, (-b * x + a * y) / det];
  }

  arc(cx: number, cy: number, r: number, start: number, end: number, ccw = false): void {
    const sx = cx + r * Math.cos(start);
    const sy = cy + r * Math.sin(start);
    const sP = transformPoint(this.matrix, sx, sy);
    let sub: typeof this.subpaths[number];
    if (this.subpaths.length === 0) {
      sub = { start: sP, ops: [], closed: false };
      this.subpaths.push(sub);
    } else {
      sub = this.subpaths[this.subpaths.length - 1];
      if (!this.cursor || Math.hypot(sP[0] - this.cursor[0], sP[1] - this.cursor[1]) > 1e-3) {
        sub.ops.push(['L', [sP[0], sP[1]]]);
      }
    }
    this.cursor = sP;

    const beziers = arcToBeziers(cx, cy, r, start, end, ccw);
    for (const [c1x, c1y, c2x, c2y, ex, ey] of beziers) {
      const p1 = transformPoint(this.matrix, c1x, c1y);
      const p2 = transformPoint(this.matrix, c2x, c2y);
      const p3 = transformPoint(this.matrix, ex, ey);
      sub.ops.push(['C', [p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]]]);
      this.cursor = p3;
    }
  }

  // --- rect ---

  fillRect(x: number, y: number, w: number, h: number): void {
    this.applyFill();
    this.applyStrokeStyleForRect();
    this.applyLineDash();
    const path = this.rectAsPolygon(x, y, w, h);
    this.emitFilledPolygon(path);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.applyStroke();
    this.applyLineDash();
    const path = this.rectAsPolygon(x, y, w, h);
    this.emitStrokedPolygon(path, true);
  }

  clearRect(_x: number, _y: number, _w: number, _h: number): void {
    // No-op — PDF page background is white by default.
  }

  // --- fill/stroke ---

  fill(): void {
    if (this.subpaths.length === 0) return;
    this.applyFill();
    this.applyLineDash();
    for (const sp of this.subpaths) {
      this.emitSubpath(sp, 'F');
    }
  }

  stroke(): void {
    if (this.subpaths.length === 0) return;
    this.applyStroke();
    this.applyLineDash();
    for (const sp of this.subpaths) {
      this.emitSubpath(sp, 'S');
    }
  }

  // --- text ---

  fillText(text: string, x: number, y: number): void {
    if (!text) return;
    this.emitText(text, x, y, true);
  }

  strokeText(text: string, x: number, y: number): void {
    if (!text) return;
    this.emitText(text, x, y, false);
  }

  measureText(text: string): TextMetrics {
    const ctx = getMeasureCtx();
    if (ctx) {
      ctx.font = this.font;
      return ctx.measureText(text);
    }
    const { size } = parseFont(this.font);
    return {
      width: text.length * size * 0.55,
      actualBoundingBoxAscent: size * 0.8,
      actualBoundingBoxDescent: size * 0.2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      fontBoundingBoxAscent: size * 0.8,
      fontBoundingBoxDescent: size * 0.2,
    } as TextMetrics;
  }

  // --- internals ---

  private rectAsPolygon(x: number, y: number, w: number, h: number): Array<[number, number]> {
    return [
      transformPoint(this.matrix, x, y),
      transformPoint(this.matrix, x + w, y),
      transformPoint(this.matrix, x + w, y + h),
      transformPoint(this.matrix, x, y + h),
    ];
  }

  private emitFilledPolygon(pts: Array<[number, number]>): void {
    if (pts.length < 2) return;
    const lines: number[][] = [];
    for (let i = 1; i < pts.length; i++) {
      lines.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    }
    this.pdf.lines(lines, pts[0][0], pts[0][1], [1, 1], 'F', true);
  }

  private emitStrokedPolygon(pts: Array<[number, number]>, closed: boolean): void {
    if (pts.length < 2) return;
    const lines: number[][] = [];
    for (let i = 1; i < pts.length; i++) {
      lines.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    }
    this.pdf.lines(lines, pts[0][0], pts[0][1], [1, 1], 'S', closed);
  }

  private emitSubpath(sp: { start: [number, number]; ops: Array<['L' | 'C', number[]]>; closed: boolean }, style: 'F' | 'S' | 'FD'): void {
    if (sp.ops.length === 0) return;
    const lines: number[][] = [];
    let last = sp.start;
    for (const [op, vals] of sp.ops) {
      if (op === 'L') {
        lines.push([vals[0] - last[0], vals[1] - last[1]]);
        last = [vals[0], vals[1]];
      } else if (op === 'C') {
        // jsPDF cubic bezier: [c1x, c1y, c2x, c2y, x, y] all relative.
        lines.push([
          vals[0] - last[0], vals[1] - last[1],
          vals[2] - last[0], vals[3] - last[1],
          vals[4] - last[0], vals[5] - last[1],
        ]);
        last = [vals[4], vals[5]];
      }
    }
    this.pdf.lines(lines, sp.start[0], sp.start[1], [1, 1], style, sp.closed);
  }

  private emitText(rawText: string, x: number, y: number, fill: boolean): void {
    // PDF standard fonts cover Latin-1 only; others print as garbage.
    const text = toPdfText(rawText);
    if (!text) return;
    const parsed = parseFont(this.font);
    const { weight, style, family } = parsed;
    const size = parsed.size * matrixScale(this.matrix);
    const [px, py] = transformPoint(this.matrix, x, y);
    const decomp = decompose(this.matrix);
    const dy = baselineDy(this.textBaseline, size);

    const fontStyle = weight === 'bold' && style === 'italic' ? 'bolditalic'
      : weight === 'bold' ? 'bold'
      : style === 'italic' ? 'italic'
      : 'normal';
    const fontFamily = /serif/i.test(family) && !/sans-serif/i.test(family) ? 'times'
      : /mono/i.test(family) ? 'courier'
      : 'helvetica';
    this.pdf.setFont(fontFamily, fontStyle);
    this.pdf.setFontSize(size);

    const [r, g, b, a] = parseColor(fill ? this.fillStyle : this.strokeStyle);
    const alpha = a * this.globalAlpha;
    this.applyAlpha(alpha);
    if (fill) this.pdf.setTextColor(r, g, b);
    else this.pdf.setTextColor(r, g, b);

    const align = this.textAlign === 'center' ? 'center'
      : (this.textAlign === 'right' || this.textAlign === 'end') ? 'right'
      : 'left';

    const angleDeg = Math.abs(decomp.rot) > 1e-4 ? -(decomp.rot * 180) / Math.PI : 0;
    if (angleDeg !== 0) {
      this.pdf.text(text, px, py + dy, { align, angle: angleDeg });
    } else {
      this.pdf.text(text, px, py + dy, { align });
    }
  }

  private applyFill(): void {
    const [r, g, b, a] = parseColor(this.fillStyle);
    this.pdf.setFillColor(r, g, b);
    this.applyAlpha(a * this.globalAlpha);
  }

  private applyStroke(): void {
    const [r, g, b, a] = parseColor(this.strokeStyle);
    this.pdf.setDrawColor(r, g, b);
    this.pdf.setLineWidth(this.lineWidth * matrixScale(this.matrix));
    this.applyAlpha(a * this.globalAlpha);
  }

  private applyStrokeStyleForRect(): void {
    // fillRect doesn't draw a stroke — make sure the line width is zero
    // so the filled rectangle has no border.
    this.pdf.setLineWidth(0);
  }

  private applyAlpha(alpha: number): void {
    const gs = this.pdf as unknown as { setGState?: (g: unknown) => void; GState?: new (o: unknown) => unknown };
    if (gs.setGState && gs.GState) {
      const a = Math.max(0, Math.min(1, alpha));
      // 'opacity' covers fills and text; strokes need their own.
      gs.setGState(new gs.GState({ opacity: a, 'stroke-opacity': a }));
    }
  }

  private applyLineDash(): void {
    const setDash = (this.pdf as unknown as { setLineDashPattern?: (p: number[], phase: number) => void }).setLineDashPattern;
    if (setDash) setDash.call(this.pdf, this.lineDash, 0);
  }
}
