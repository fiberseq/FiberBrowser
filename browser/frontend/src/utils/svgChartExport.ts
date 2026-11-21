import { formatTsv } from './analysisExport';
/**
 * Inline-SVG charts (drawn in currentColor, e.g. the nucleosome panel's) as standalone files for ChartSaveButton:
 * the chart cloned with its colours resolved for print (dark ink on white, whatever the theme), the page's font, and
 * its size from the viewBox; PNG and PDF rasterise that clone.
 */
export const SVG_EXPORT_INK = '#1f2937';

const PAINT_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'opacity'] as const;
/** Text set by classes (Tailwind's text-[9px], font-mono, font-semibold): inlined on text, the file has no stylesheet. */
const TEXT_PROPS = ['font-size', 'font-family', 'font-weight'] as const;

/** Run `fn` with the light theme's computed styles (the page's `dark` class lifted for that synchronous moment, so
 * nothing repaints): a print file is dark ink on white whatever the theme. */
export function withLightTheme<T>(fn: () => T): T {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const dark = !!root?.classList.contains('dark');
  if (dark) root!.classList.remove('dark');
  try { return fn(); } finally { if (dark) root!.classList.add('dark'); }
}

/** Paint set by stylesheet classes (Tailwind's fill-*, stroke-*) inlined on the clone: the standalone file has no
 * stylesheet, and an unstyled SVG shape fills black. Only elements with a class; an inline style wins. */
export function inlineClassStyles(svg: SVGSVGElement, clone: SVGSVGElement): void {
  const src = svg.querySelectorAll('[class]');
  if (!src.length) return;
  const all = Array.from(svg.querySelectorAll('*'));
  const out = Array.from(clone.querySelectorAll('*'));
  if (all.length !== out.length) return;
  for (const el of Array.from(src)) {
    const i = all.indexOf(el);
    const target = out[i] as SVGElement | undefined;
    if (!target) continue;
    let cs: CSSStyleDeclaration;
    try { cs = getComputedStyle(el); } catch { continue; }
    const colour = cs.getPropertyValue('color');
    for (const prop of PAINT_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (!v || target.style.getPropertyValue(prop)) continue;
      // currentColor stays currentColor: the clone's colour is the print ink, not the theme's text colour (an
      // attribute, or a class such as fill-current: the computed paint is then the element's own colour).
      if ((el.getAttribute(prop) ?? '').toLowerCase() === 'currentcolor') continue;
      if ((prop === 'fill' || prop === 'stroke') && colour && v === colour && !el.getAttribute(prop)) {
        target.style.setProperty(prop, 'currentColor');
        continue;
      }
      target.style.setProperty(prop, v);
    }
    if (el.tagName.toLowerCase() === 'text' || el.tagName.toLowerCase() === 'tspan') {
      for (const prop of TEXT_PROPS) {
        const v = cs.getPropertyValue(prop);
        if (v && !target.style.getPropertyValue(prop) && !el.getAttribute(prop)) target.style.setProperty(prop, v);
      }
    }
    target.removeAttribute('class');
  }
}

export function standaloneSvg(svg: SVGSVGElement, background = '#ffffff'): { text: string; width: number; height: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const vb = svg.viewBox?.baseVal;
  const rect = svg.getBoundingClientRect();
  const width = (vb && vb.width) || Number(svg.getAttribute('width')) || rect.width || 300;
  const height = (vb && vb.height) || Number(svg.getAttribute('height')) || rect.height || 150;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  withLightTheme(() => inlineClassStyles(svg, clone));
  clone.removeAttribute('class');
  clone.setAttribute('color', SVG_EXPORT_INK);
  clone.style.color = SVG_EXPORT_INK;
  try { clone.style.fontFamily = getComputedStyle(svg).fontFamily; } catch { /* detached */ }
  if (background) {
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const x = vb && vb.width ? vb.x : 0, y = vb && vb.height ? vb.y : 0;
    bg.setAttribute('x', String(x)); bg.setAttribute('y', String(y));
    bg.setAttribute('width', String(width)); bg.setAttribute('height', String(height)); bg.setAttribute('fill', background);
    clone.insertBefore(bg, clone.firstChild);
  }
  return { text: new XMLSerializer().serializeToString(clone), width, height };
}

/** The standalone chart drawn on a canvas at `scale` px per chart unit (null: the browser could not draw it). */
export async function svgToCanvas(svg: SVGSVGElement, scale = 3): Promise<HTMLCanvasElement | null> {
  const { text, width, height } = standaloneSvg(svg);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  try { await image.decode(); } catch { return null; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Lines as a TSV (series, x, y): a line chart's exact input. */
export function linesTsv(lines: Array<{ key: string; label: string; points: Array<[number, number | null]> }>, xName = 'x', yName = 'y'): string {
  const rows: unknown[][] = [['series', 'label', xName, yName]];
  for (const l of lines) for (const [x, y] of l.points) rows.push([l.key, l.label, x, y ?? '']);
  return formatTsv(rows);   // escaped cells: a label with a tab or newline never breaks the columns
}
