import { useInsertedBases } from '../../../utils/svInsertedSequence';
import { formatSvSize, svAlleleLabel } from './svDrawing';
import type { SvHover } from './useReadTrackMouse';

/**
 * Hover over an SV (fb-n9-sv): a band cluster's support and what clicks do,
 * or one read's deletion / insertion (with the first inserted bases, fetched
 * on demand).
 */
export function SvTooltip({ hover, width, height, datasetId, chrom }: {
  hover: SvHover; width: number; height: number; datasetId: string; chrom: string;
}) {
  const insertion = hover.kind === 'event' && hover.event.t === 'I'
    ? { datasetId, chrom, readId: hover.read.id, event: hover.event }
    : null;
  const bases = useInsertedBases(insertion, 30);
  const style = {
    left: Math.max(4, Math.min(hover.x + 12, width - 260)),
    top: Math.max(4, Math.min(height - 70, hover.y + 12)),
  };
  if (hover.kind === 'cluster') {
    const c = hover.cluster;
    return (
      <div className="absolute pointer-events-none bg-gray-900 text-white px-2.5 py-1.5 rounded text-xs shadow-lg z-30 whitespace-nowrap" style={style} data-testid="sv-cluster-tooltip" data-fb-hover-tip="">
        <div className="font-medium">{svAlleleLabel(c.t, c.ref, c.len, chrom)}</div>
        <div className="text-gray-300 text-[11px]">
          {c.t === 'D' ? `${chrom}:${(c.ref + 1).toLocaleString()}-${c.end.toLocaleString()} · ` : ''}
          {c.support.toLocaleString()} of {c.informative.toLocaleString()} informative reads carry it
          {c.sa_support > 0 ? ` (${c.sa_support} by split reads)` : ''}
          {(c.clip_support ?? 0) > 0 ? ` (${c.clip_support} clipped at the breakpoint)` : ''}
        </div>
        <div className="text-gray-400 text-[11px]">Click: highlight its reads · Right-click: group or split the reads by it</div>
      </div>
    );
  }
  const ev = hover.event;
  return (
    <div className="absolute pointer-events-none bg-gray-900 text-white px-2.5 py-1.5 rounded text-xs shadow-lg z-30 whitespace-nowrap" style={style} data-testid="sv-event-tooltip" data-fb-hover-tip="">
      <div className="font-medium">
        {ev.t === 'D' ? 'Deletion' : 'Insertion'} {formatSvSize(ev.t, ev.len)}{ev.len < 1000 ? ' bp' : ''}
      </div>
      <div className="text-gray-300 text-[11px]">
        {ev.t === 'D'
          ? `${chrom}:${(ev.ref + 1).toLocaleString()}-${(ev.ref + ev.len).toLocaleString()} (${ev.len.toLocaleString()} bp)`
          : `${ev.len.toLocaleString()} bp after ${chrom}:${ev.ref.toLocaleString()}`}
      </div>
      {ev.t === 'I' && (
        <>
          <div className="font-mono text-[11px] text-purple-200">{bases ? `${bases}${ev.len > bases.length ? '…' : ''}` : 'loading bases…'}</div>
          <div className="text-gray-400 text-[11px]">Click to copy the inserted sequence</div>
        </>
      )}
    </div>
  );
}
