import { useEffect, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { ChevronDown } from '../ui/Icons';

const ITEM = 'block w-full px-2 py-1 text-left text-[11px] hover:bg-gray-100 dark:hover:bg-gray-700';

/**
 * DAF-seq strand for one panel: both strands, CT only or GA only, or split
 * into a CT panel and a GA panel side by side. Everything computed from the
 * panel's reads (clusters, peaks, footprint counts, metaprofile) follows it.
 */
export function StrandChip({ panelId, strand, narrow }: { panelId: string; strand: 'CT' | 'GA' | null; narrow?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); };
    // stopPropagation: this Escape closes the dropdown only, not the selection behind it.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const store = useBrowserStore.getState;
  const choose = (next: 'CT' | 'GA' | null) => { store().setPanelStrand(panelId, next); setOpen(false); };
  return (
    <div className="relative" ref={ref} onMouseDown={e => e.stopPropagation()}>
      <button
        type="button"
        data-testid="panel-strand-chip"
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        className={`fb-header-pill ${strand ? '!bg-white font-semibold !text-gray-800' : 'hover:!bg-white/30'}`}
        title="DAF-seq strand shown in this panel (clusters, peaks and footprint counts use the same reads)"
      >
        <span className="inline-flex items-center gap-0.5">{strand ? `${strand} strand` : narrow ? 'Strand' : 'Both strands'}<ChevronDown size={11} aria-hidden="true" /></span>
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-40 min-w-[11rem] rounded border border-gray-200 bg-white py-0.5 text-gray-700 shadow-lg dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">
          <button type="button" className={ITEM} aria-pressed={strand === null} onClick={() => choose(null)}>Both strands</button>
          <button type="button" className={ITEM} aria-pressed={strand === 'CT'} onClick={() => choose('CT')}>CT strand only (C→T reads)</button>
          <button type="button" className={ITEM} aria-pressed={strand === 'GA'} onClick={() => choose('GA')}>GA strand only (G→A reads)</button>
          <div className="my-0.5 border-t border-gray-100 dark:border-gray-700" />
          <button type="button" data-testid="split-by-strand" className={ITEM}
            onClick={() => { store().splitPanelByStrand(panelId); setOpen(false); }}
            title="This panel shows CT; a copy next to it shows GA. Both follow the main view.">
            Split: CT | GA side by side
          </button>
        </div>
      )}
    </div>
  );
}
