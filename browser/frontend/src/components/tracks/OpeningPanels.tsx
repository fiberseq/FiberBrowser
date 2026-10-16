import { Refresh, RotateCcw, X } from '../ui/Icons';
import { useOpeningStore } from '../../stores/openingStore';

/**
 * Datasets being opened (stores/openingStore.ts): a placeholder panel each, the moment Open is clicked,
 * with the dataset's name and what the open is doing; its real panel replaces it. A failed open keeps its
 * placeholder with the reason, Retry and Dismiss (never a click that seems to do nothing).
 */
export function OpeningPanels({ top, gap }: { top: number; gap: number }) {
  const opening = useOpeningStore(s => s.opening);
  const retry = useOpeningStore(s => s.retry);
  if (!opening.length) return null;
  return (
    <div className="absolute z-30 flex flex-col" style={{ top: top + gap, left: gap, right: gap, rowGap: gap }}
      data-testid="opening-panels" data-render-hide="true">
      {opening.map(o => (
        <div key={o.key} role="status" aria-live="polite" data-testid="opening-panel" data-error={o.error ? 'true' : undefined}
          className={`overflow-hidden rounded-fb border bg-white shadow-sm dark:bg-dark-surface ${o.error ? 'border-rose-300 dark:border-rose-700/60' : 'border-line dark:border-white/10'}`}>
          <div className="flex h-7 items-center gap-2 border-b border-line px-2 text-[12px] font-semibold text-ink dark:border-white/10 dark:text-gray-100">
            <span className="h-3 w-1 shrink-0 rounded-sm bg-gray-400" aria-hidden="true" />
            <span className="min-w-0 truncate" title={o.key} data-testid="opening-panel-label">{o.label}</span>
            <span className="ml-auto shrink-0 text-[11px] font-normal text-ink-muted">{o.error ? 'Could not open' : 'Opening'}</span>
            <button type="button" className="shrink-0 rounded p-0.5 text-ink-muted hover:bg-gray-100 dark:hover:bg-white/10"
              onClick={() => useOpeningStore.getState().dismiss(o.key)} aria-label={`Dismiss ${o.label}`} title="Dismiss"
              data-testid="opening-panel-dismiss"><X size={13} /></button>
          </div>
          <div className="flex min-h-[44px] items-center gap-2 px-3 py-2 text-[12px]">
            {o.error ? (
              <>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-rose-700 dark:text-rose-300" data-testid="opening-panel-error">{o.error}</span>
                {retry[o.key] && (
                  <button type="button" className="fb-btn-secondary inline-flex h-7 shrink-0 items-center gap-1 px-2 text-[12px]"
                    onClick={() => { const again = retry[o.key]; useOpeningStore.getState().dismiss(o.key); again(); }}
                    data-testid="opening-panel-retry"><RotateCcw size={12} /> Retry</button>
                )}
              </>
            ) : (
              <>
                <Refresh size={14} className="shrink-0 animate-spin text-ink-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ink-muted" data-testid="opening-panel-stage">{o.stage}</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
