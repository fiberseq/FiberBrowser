import { createContext, useContext, useState } from 'react';
import { ChartMaximizeModal } from './ChartMaximizeModal';
import { Maximize } from '../ui/Icons';

/** When true, we are inside a maximized modal — hide the maximize button. */
export const ChartMaximizeContext = createContext(false);

interface ChartMaximizeButtonProps {
  renderChart: (width: number, height: number) => React.ReactNode;
  title?: string;
  filename?: string;
}

export function ChartMaximizeButton({ renderChart, title, filename }: ChartMaximizeButtonProps) {
  const insideModal = useContext(ChartMaximizeContext);
  const [open, setOpen] = useState(false);

  if (insideModal) return null;

  return (
    <>
      <button
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        className="absolute top-1 right-7 opacity-0 group-hover:opacity-100 transition-opacity z-10
          w-5 h-5 flex items-center justify-center rounded bg-black/40 hover:bg-black/60 text-white text-[11px] leading-none"
        title="Maximize chart"
      >
        <Maximize size={11} />
      </button>
      {open && (
        <ChartMaximizeModal
          renderChart={renderChart}
          title={title}
          filename={filename}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
