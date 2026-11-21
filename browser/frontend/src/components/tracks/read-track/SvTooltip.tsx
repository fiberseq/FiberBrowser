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
  const insertion = hover.kind === 'event' && hover.event.t === 'I' && !hover.read.live_lift
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
          {c.support.toLocaleString()} confirmed of {c.informative.toLocaleString()} informative reads
          {c.sa_support > 0 ? ` (${c.sa_support} by split reads)` : ''}
          {(c.clip_support ?? 0) > 0 ? ` (${c.clip_support} clipped at the breakpoint)` : ''}
        </div>
        <div className="text-gray-300 text-[11px]">{c.putative ?? 0} putative · {c.conflicting ?? 0} conflicting (clip aligns elsewhere) · {c.ambiguous ?? 0} ambiguous</div>
        <div className="text-gray-400 text-[11px]">{c.t === 'I' ? 'Click: expand and highlight its reads' : 'Click: highlight its reads'} · ⌘-click: inspect · Right-click: inspect, group or split the reads by it</div>
      </div>
    );
  }
  const ev = hover.event;
  if (ev.source === 'assembly' && ev.display_only) {
    const ref = ev.ref_len ?? 0, alt = ev.alt_len ?? 0;
    return <div className="absolute pointer-events-none bg-gray-900 text-white px-2.5 py-1.5 rounded text-xs shadow-lg z-30 whitespace-nowrap" style={style} data-testid="sv-event-tooltip" data-fb-hover-tip="">
      <div className="font-medium">Assembly {ref && alt ? 'replacement' : ref ? 'deletion' : 'insertion'} · {ref.toLocaleString()}→{alt.toLocaleString()} bp</div>
      <div className="text-gray-300 text-[11px]">{chrom}:{ev.ref.toLocaleString()}–{(ev.ref_end ?? ev.ref).toLocaleString()} · read evidence unassessed</div>
      <div className="text-gray-400 text-[11px]">Click to inspect assembly difference</div>
    </div>;
  }
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
          <div className="font-mono text-[11px] text-purple-200">{bases ? `${bases}${ev.len > bases.length ? '…' : ''}` : hover.read.live_lift ? 'sequence unavailable' : 'loading bases…'}</div>
          {!hover.read.live_lift && <div className="text-gray-400 text-[11px]">Click to copy the inserted sequence</div>}
        </>
      )}
    </div>
  );
}
