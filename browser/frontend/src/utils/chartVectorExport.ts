// Vector chart export helpers. Each chart that wants editable SVG / PDF
// supplies a `drawFn` that takes a Canvas2D-shaped renderer plus
// dimensions; we replay the same draw against custom SvgRenderer /
// PdfRenderer to emit clean vector output.
//
// We deliberately avoid canvas2svg + svg2pdf.js: the former produced
// <defs>/<clipPath> markup that crashed Illustrator, and the latter wraps
// the whole drawing in a single un-releasable clipping mask so individual
// shapes can't be selected. The custom renderers emit a flat list of
// shapes — every rect/line/path/text is its own top-level object — and
// PDF goes through jsPDF's native primitive API so nothing is grouped.

import { SvgRenderer, PdfRenderer } from './vectorRenderers';

export type ChartDrawFn = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => void;

export function drawChartToSvgString(
  drawFn: ChartDrawFn,
  width: number,
  height: number,
): string {
  const renderer = new SvgRenderer(width, height);
  // SvgRenderer implements the Canvas2D subset our charts use; the cast
  // mirrors what canvas2svg required and is local to this call site.
  drawFn(renderer as unknown as CanvasRenderingContext2D, width, height);
  return renderer.toSvg();
}

export async function drawChartToPdf(
  drawFn: ChartDrawFn,
  width: number,
  height: number,
  filename: string,
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({
    orientation: width > height ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [width, height],
  });
  const renderer = new PdfRenderer(pdf, width, height);
  drawFn(renderer as unknown as CanvasRenderingContext2D, width, height);
  pdf.save(filename);
}

/** Several charts as one vector PDF, a page each (the Plots Gallery's "Export selected"). */
export async function drawChartsToPdf(
  pages: Array<{ drawFn: ChartDrawFn; width: number; height: number }>,
  filename: string,
): Promise<void> {
  if (!pages.length) return;
  const { jsPDF } = await import('jspdf');
  const first = pages[0];
  const pdf = new jsPDF({ orientation: first.width > first.height ? 'landscape' : 'portrait', unit: 'pt', format: [first.width, first.height] });
  pages.forEach((page, i) => {
    if (i > 0) pdf.addPage([page.width, page.height], page.width > page.height ? 'landscape' : 'portrait');
    const renderer = new PdfRenderer(pdf, page.width, page.height);
    page.drawFn(renderer as unknown as CanvasRenderingContext2D, page.width, page.height);
  });
  pdf.save(filename);
}
