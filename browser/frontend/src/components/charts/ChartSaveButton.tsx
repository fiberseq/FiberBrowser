import { useState, useCallback } from 'react';
import { drawChartToSvgString, drawChartToPdf } from '../../utils/chartVectorExport';
import type { ChartDrawFn } from '../../utils/chartVectorExport';
import { Download } from '../ui/Icons';
import { standaloneSvg, svgToCanvas } from '../../utils/svgChartExport';

interface ChartSaveButtonProps {
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** An inline-SVG chart instead of a canvas: SVG is the chart itself (colours resolved for print), PNG / PDF
   * rasterise it (utils/svgChartExport). */
  getSvg?: () => SVGSVGElement | null;
  filename?: string;
  inline?: boolean;
  /** Exact numeric input supplied to the chart, serialized as TSV. */
  dataTsv?: string | (() => string);
  // When supplied, SVG/PDF exports re-render the chart through a
  // canvas2svg context to produce true vectors editable in Illustrator.
  // Without `drawFn`, the legacy raster path is used as a fallback.
  drawFn?: ChartDrawFn;
  width?: number;
  height?: number;
  /** PNG is drawn through `drawFn` at `width` × `height` (2x), not copied from the canvas on screen: the export adds
   *  content the screen draws outside the canvas (a relative x-axis strip). */
  pngFromDrawFn?: boolean;
}

const NO_CANVAS = { current: null } as React.RefObject<HTMLCanvasElement | null>;

export function ChartSaveButton({
  canvasRef = NO_CANVAS,
  getSvg,
  filename = 'chart',
  inline = false,
  drawFn,
  width,
  height,
  dataTsv,
  pngFromDrawFn = false,
}: ChartSaveButtonProps) {
  const [showMenu, setShowMenu] = useState(false);

  const ts = () => new Date().toISOString().replace(/-/g, '').replace(/:/g, '').replace('T', '').slice(0, 15);

  const downloadBlob = useCallback((blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const resolveCssDims = useCallback((): { w: number; h: number } | null => {
    if (width !== undefined && height !== undefined) return { w: width, h: height };
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    return { w: canvas.width / dpr, h: canvas.height / dpr };
  }, [canvasRef, width, height]);

  const savePNG = useCallback(async () => {
    const svg = getSvg?.();
    if (svg) {
      const drawn = await svgToCanvas(svg);
      drawn?.toBlob(blob => { if (blob) downloadBlob(blob, `${filename}_${ts()}.png`); }, 'image/png');
      setShowMenu(false);
      return;
    }
    let canvas = pngFromDrawFn ? null : canvasRef.current;
    // No canvas on screen (a figure drawn only for export), or an export with more than the screen: draw it at 2x.
    if (!canvas && drawFn && width !== undefined && height !== undefined) {
      canvas = document.createElement('canvas');
      canvas.width = Math.round(width * 2);
      canvas.height = Math.round(height * 2);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      drawFn(ctx, width, height);
    }
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (blob) downloadBlob(blob, `${filename}_${ts()}.png`);
    }, 'image/png');
    setShowMenu(false);
  }, [canvasRef, getSvg, filename, downloadBlob, drawFn, width, height, pngFromDrawFn]);

  const saveSVG = useCallback(async () => {
    const inline = getSvg?.();
    if (inline) {
      downloadBlob(new Blob([standaloneSvg(inline).text], { type: 'image/svg+xml' }), `${filename}_${ts()}.svg`);
      setShowMenu(false);
      return;
    }
    const dims = resolveCssDims();
    if (drawFn && dims) {
      try {
        const svg = drawChartToSvgString(drawFn, dims.w, dims.h);
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${filename}_${ts()}.svg`);
        setShowMenu(false);
        return;
      } catch (err) {
        console.warn('Vector SVG export failed, falling back to raster:', err);
      }
    }
    // Raster fallback
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    const dataUrl = canvas.toDataURL('image/png');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <image href="${dataUrl}" width="${w}" height="${h}"/>
</svg>`;
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${filename}_${ts()}.svg`);
    setShowMenu(false);
  }, [canvasRef, getSvg, drawFn, filename, downloadBlob, resolveCssDims]);

  const savePDF = useCallback(async () => {
    const svg = getSvg?.();
    if (svg) {
      const drawn = await svgToCanvas(svg);
      if (drawn) {
        const { jsPDF } = await import('jspdf');
        const pdf = new jsPDF({ orientation: drawn.width > drawn.height ? 'landscape' : 'portrait', unit: 'px', format: [drawn.width, drawn.height] });
        pdf.addImage(drawn.toDataURL('image/png'), 'PNG', 0, 0, drawn.width, drawn.height);
        pdf.save(`${filename}_${ts()}.pdf`);
      }
      setShowMenu(false);
      return;
    }
    const dims = resolveCssDims();
    if (drawFn && dims) {
      try {
        await drawChartToPdf(drawFn, dims.w, dims.h, `${filename}_${ts()}.pdf`);
        setShowMenu(false);
        return;
      } catch (err) {
        console.warn('Vector PDF export failed, falling back to raster:', err);
      }
    }
    // Raster fallback
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { jsPDF } = await import('jspdf');
    const w = canvas.width;
    const h = canvas.height;
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'px', format: [w, h] });
    pdf.addImage(imgData, 'PNG', 0, 0, w, h);
    pdf.save(`${filename}_${ts()}.pdf`);
    setShowMenu(false);
  }, [canvasRef, getSvg, drawFn, filename, resolveCssDims]);

  const saveDataTsv = useCallback(() => {
    const content = typeof dataTsv === 'function' ? dataTsv() : dataTsv;
    if (!content) return;
    downloadBlob(
      new Blob([content], { type: 'text/tab-separated-values' }),
      `${filename}_${ts()}.tsv`,
    );
    setShowMenu(false);
  }, [dataTsv, downloadBlob, filename]);

  return (
    <div className={inline
      ? 'relative z-10'
      : 'absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10'
    }>
      <button
        onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
        className="w-5 h-5 flex items-center justify-center rounded bg-black/40 hover:bg-black/60 text-white text-[11px] leading-none"
        title="Save chart"
        data-testid="chart-save"
      >
        <Download size={11} />
      </button>
      {showMenu && (
        <div
          className="absolute right-0 top-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg py-0.5 min-w-[60px] z-20"
          onMouseLeave={() => setShowMenu(false)}
        >
          {(['PNG', 'SVG', 'PDF'] as const).map(fmt => (
            <button
              key={fmt}
              onClick={() => { void (fmt === 'PNG' ? savePNG() : fmt === 'SVG' ? saveSVG() : savePDF()); }}
              data-testid={`chart-save-${fmt.toLowerCase()}`}
              className="block w-full text-left px-2 py-0.5 text-[11px] text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {fmt}
            </button>
          ))}
          {dataTsv && (
            <button
              onClick={saveDataTsv}
              data-testid="chart-save-tsv"
              className="block w-full whitespace-nowrap border-t border-gray-100 px-2 py-0.5 text-left text-[11px] text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
              title="Download the exact numeric values supplied to this chart"
            >
              Data TSV
            </button>
          )}
        </div>
      )}
    </div>
  );
}
