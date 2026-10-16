import { useState, useCallback } from 'react';
import { drawChartToSvgString, drawChartToPdf } from '../../utils/chartVectorExport';
import type { ChartDrawFn } from '../../utils/chartVectorExport';
import { Download } from '../ui/Icons';

interface ChartSaveButtonProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
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
}

export function ChartSaveButton({
  canvasRef,
  filename = 'chart',
  inline = false,
  drawFn,
  width,
  height,
  dataTsv,
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

  const savePNG = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (blob) downloadBlob(blob, `${filename}_${ts()}.png`);
    }, 'image/png');
    setShowMenu(false);
  }, [canvasRef, filename, downloadBlob]);

  const saveSVG = useCallback(async () => {
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
  }, [canvasRef, drawFn, filename, downloadBlob, resolveCssDims]);

  const savePDF = useCallback(async () => {
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
  }, [canvasRef, drawFn, filename, resolveCssDims]);

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
              onClick={fmt === 'PNG' ? savePNG : fmt === 'SVG' ? saveSVG : savePDF}
              className="block w-full text-left px-2 py-0.5 text-[11px] text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {fmt}
            </button>
          ))}
          {dataTsv && (
            <button
              onClick={saveDataTsv}
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
