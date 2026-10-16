/**
 * A read panel zoomed out past the read window ("Show reads up to"): it draws
 * coverage, not reads, so it says so (not "No reads in this view") and offers
 * the two ways out: zoom in to the limit, or raise the limit once to show
 * this view's reads (with how many there are, from the coverage it already
 * fetched, since a deep view is slow to load).
 */
import { SLOW_LOAD_READS, formatLimitBp, limitFor } from '../../../utils/readLimit';
import { X } from '../../ui/Icons';

const BUTTON = 'shrink-0 whitespace-nowrap px-1.5 py-px rounded border border-gray-300 dark:border-white/15 text-[11px] font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10';

export interface ZoomedOutCardProps {
  datasetId: string;
  /** The view's width and the read window (bp). */
  width: number;
  limit: number;
  /** Reads in this view (from the coverage count), when known. */
  reads: number | null;
  /** Zoom to the limit around the centre; omitted where the panel cannot move the view. */
  onZoom?: () => void;
  /** Raise the limit to `limit` (the smallest offered one that shows this view). */
  onRaise: (limit: number) => void;
  onOpenSetting: () => void;
}

export function zoomedOutMessage(width: number, limit: number, reads: number | null): string {
  const count = reads === null ? '' : ` (${reads.toLocaleString()} read${reads === 1 ? '' : 's'} here`
    + `${reads >= SLOW_LOAD_READS ? ': slow at this depth' : ''})`;
  return `Zoomed out past the read limit (${formatLimitBp(limit)}): this view is ${formatLimitBp(width)}. `
    + `Zoom in, or load reads for this view${count}.`;
}

/** The banner's height: the coverage plot stops above it (ReadTrackCanvas `coverageFooterHeight`). */
export const ZOOMED_OUT_BANNER_HEIGHT = 24;

/** Short form on the banner's line (the full message is its tooltip). */
export function zoomedOutShort(width: number, limit: number, reads: number | null): string {
  const count = reads === null ? '' : ` · ${reads.toLocaleString()} read${reads === 1 ? '' : 's'} here${reads >= SLOW_LOAD_READS ? ' (slow to load)' : ''}`;
  return `Coverage: this ${formatLimitBp(width)} view is past the ${formatLimitBp(limit)} read limit${count}`;
}

/**
 * One line along the bottom of the panel, under the coverage plot (never over
 * it): what the view is, the ways out, and × to dismiss it in this panel.
 */
export function ZoomedOutCard({ datasetId, width, limit, reads, onZoom, onRaise, onOpenSetting, onDismiss }: ZoomedOutCardProps & {
  /** Hide it in this panel. */
  onDismiss?: () => void;
}) {
  const raiseTo = limitFor(width);
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 pointer-events-none" data-render-hide="true" style={{ height: ZOOMED_OUT_BANNER_HEIGHT }}>
      <div className="flex h-full items-center gap-1.5 border-t border-gray-200 bg-white/95 px-2 text-[11px] text-gray-600 pointer-events-auto dark:border-white/10 dark:bg-gray-900/95 dark:text-gray-300"
        data-testid={`read-track-zoomed-out-${datasetId}`} role="status">
        <span className="min-w-0 flex-1 truncate" title={zoomedOutMessage(width, limit, reads)}
          data-testid={`read-track-zoomed-out-text-${datasetId}`} data-full-text={zoomedOutMessage(width, limit, reads)}>
          {zoomedOutShort(width, limit, reads)}
        </span>
        {onZoom && (
          <button type="button" className={BUTTON} onClick={onZoom} data-testid={`read-track-zoom-to-limit-${datasetId}`}>
            Zoom to {formatLimitBp(limit)} here
          </button>
        )}
        {raiseTo !== null && (
          <button type="button" className={BUTTON} onClick={() => onRaise(raiseTo)}
            title={`Sets "Show reads up to" to ${formatLimitBp(raiseTo)} (View settings).`}
            data-testid={`read-track-raise-limit-${datasetId}`}>
            Load reads (limit {formatLimitBp(raiseTo)})
          </button>
        )}
        <button type="button" className="shrink-0 whitespace-nowrap underline underline-offset-2 hover:no-underline" onClick={onOpenSetting}
          data-testid={`read-track-limit-setting-${datasetId}`}>
          Read limit setting…
        </button>
        {onDismiss && (
          <button type="button" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-100"
            onClick={onDismiss} aria-label="Dismiss" title="Hide this note in this panel"
            data-testid={`read-track-zoomed-out-dismiss-${datasetId}`}>
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
