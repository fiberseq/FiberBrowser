import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChartMaximizeContext } from './ChartMaximizeButton';
import { ChartSaveButton } from './ChartSaveButton';
import { X } from '../ui/Icons';

interface ChartMaximizeModalProps {
  renderChart: (width: number, height: number) => React.ReactNode;
  title?: string;
  filename?: string;
  onClose: () => void;
}

function useModalSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const update = useCallback(() => {
    const w = Math.max(400, Math.floor(window.innerWidth * 0.8));
    const h = Math.max(300, Math.floor(window.innerHeight * 0.8) - 48);
    setSize({ width: w, height: h });
  }, []);
  useEffect(() => {
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [update]);
  return size;
}

export function ChartMaximizeModal({ renderChart, title, filename, onClose }: ChartMaximizeModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { width, height } = useModalSize();

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Discover canvas after render
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const timer = requestAnimationFrame(() => {
      canvasRef.current = el.querySelector('canvas');
    });
    return () => cancelAnimationFrame(timer);
  }, [width, height]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Chart'}
      className="fixed inset-0 z-[100] flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Modal content */}
      <div className="relative bg-white dark:bg-gray-900 rounded-lg shadow-2xl flex flex-col"
        style={{ width: width + 32, maxWidth: '92vw', maxHeight: '92vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b dark:border-gray-700 shrink-0">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">
            {title || 'Chart'}
          </span>
          <div className="flex items-center gap-2">
            <ChartSaveButton canvasRef={canvasRef as React.RefObject<HTMLCanvasElement>} filename={filename || 'chart_hires'} inline />
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 text-sm"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Chart area */}
        <div ref={contentRef} className="flex-1 overflow-auto flex items-center justify-center p-4">
          <ChartMaximizeContext.Provider value={true}>
            {renderChart(width, height)}
          </ChartMaximizeContext.Provider>
        </div>
      </div>
    </div>,
    document.body
  );
}
