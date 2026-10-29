import { useAnalysisRegionStore } from '../../stores/analysisRegionStore';
import { useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import type { PanelConfig } from '../../types';
import type { Highlight } from '../../types/regions';
import { sameChrom } from '../../utils/chromAliases';
import { panelGenomeKey } from '../../utils/regionNavigation';
import { usePanOffsetTransform } from '../../hooks/usePanOffsetTransform';
import { useClassRegionOutlineStore } from '../../stores/classRegionOutlineStore';
import { useLiveLiftAxis } from '../../features/liveLift/useLiveLiftAxis';
import type { LiftAxis } from '../../features/liveLift/axis';

/** Opacity of a highlight's wash, on screen (multiplied in) and in figures. */
export const HIGHLIGHT_WASH_OPACITY = 0.55;
export const HIGHLIGHT_FIGURE_OPACITY = 0.35;

/** A split-by-SNP panel's guide through its reads at each SNP it was split by: thin (1.5 px), dashed, neutral. */
export const SPLIT_SNP_GUIDE_COLOUR = '#374151';
export const SPLIT_SNP_GUIDE_OPACITY = 0.7;
export const SPLIT_SNP_GUIDE_WIDTH = 1.5;

/** Screen spans [x, w] of the highlights in a view `width` px wide (reversed: right to left). */
export function highlightSpans(
  highlights: Highlight[],
  view: { chrom: string; start: number; end: number; genome: string },
  width: number,
  reversed = false,
  axis?: LiftAxis,
): Array<{ highlight: Highlight; x: number; w: number }> {
  const span = view.end - view.start;
  if (!(span > 0) || width <= 0) return [];
  const out: Array<{ highlight: Highlight; x: number; w: number }> = [];
  for (const h of highlights) {
    if (h.genome !== view.genome || !sameChrom(h.chrom, view.chrom) || h.end <= view.start || h.start >= view.end) continue;
    if (axis?.blocks.length) {
      for (const s of axis.spans(Math.max(h.start, view.start), Math.min(h.end, view.end))) out.push({ highlight: h, ...s });
      continue;
    }
    let x1 = ((Math.max(h.start, view.start) - view.start) / span) * width;
    let x2 = ((Math.min(h.end, view.end) - view.start) / span) * width;
    if (reversed) [x1, x2] = [width - x2, width - x1];
    out.push({ highlight: h, x: x1, w: Math.max(2, x2 - x1) });
  }
  return out;
}

/**
 * The highlights over one track row of a dataset panel: a pale wash in the
 * highlight's colour, multiplied into the track so the reads under it keep
 * their colours (the read canvas is opaque, so "behind the reads" is drawn as
 * a wash the reads show through). Never takes the pointer. `labels`: the
 * highlight's name on this row (the ruler's). Exported figures draw the same
 * washes (data-figure-overlay, utils/figureExport.ts).
 */
/** What the dashed Footprints box on the reads is, for its tag's tooltip. */
export function outlineHint(label: string | undefined): string {
  return /^finding/i.test(label ?? '')
    ? 'Window analysed by the Find classes run in progress (Footprints panel)'
    : 'Window the next Find classes run analyses (Footprints panel); "Analysed" under the class list says what the last run covered';
}

export function HighlightBands({ panel, width, gutter, labels = false, guides = false }: {
  panel: PanelConfig;
  /** The row's full width (the cluster column included). */
  width: number;
  /** The cluster column at the left (0 without clusters). */
  gutter: number;
  labels?: boolean;
  /** The reads row: a split-by-SNP panel's guides at its SNPs (readSubset.rule.splitSnps, variants/variantSplit.ts). */
  guides?: boolean;
}) {
  const { highlights, chrom, start, end, isReversed, currentGenome, fastaPath } = useBrowserStore(useShallow(s => ({
    highlights: s.highlights, chrom: s.chrom, start: s.start, end: s.end, isReversed: s.isReversed,
    currentGenome: s.currentGenome, fastaPath: s.fastaPath,
  })));
  const ref = useRef<HTMLDivElement>(null);
  const vpo = panel.viewportOverride;
  // Panning drags the canvases before the new view is drawn: the washes move with them.
  usePanOffsetTransform(ref, { scope: vpo ? `panel:${panel.stateKey ?? panel.datasetId}` : 'main' });
  const genome = panelGenomeKey(panel, { currentGenome, fastaPath });
  const view = vpo ?? { chrom, start, end };
  const inner = Math.max(0, width - gutter);
  const { axis } = useLiveLiftAxis(view.chrom, view.start, view.end, inner, isReversed);
  const spans = useMemo(
    () => highlightSpans(highlights, { ...view, genome }, inner, isReversed, axis),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [highlights, view.chrom, view.start, view.end, genome, inner, isReversed, axis],
  );
  // The region Find classes analyses, on the panels of the datasets it analyses (stores/classRegionOutlineStore).
  const extraOutlines = useAnalysisRegionStore(s => s.outlines);
  const outline = useClassRegionOutlineStore(s => s.outline);
  const outlineSpan = useMemo(() => {
    if (!outline || !panel.datasetId || !outline.datasetIds.includes(panel.datasetId)) return null;
    if (outline.genomeKey !== genome) return null;
    const box: Highlight = { id: 'class-region', genome, chrom: outline.chrom, start: outline.start, end: outline.end, color: '' };
    return highlightSpans([box], { ...view, genome }, inner, isReversed)[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline, panel.datasetId, panel.genome, view.chrom, view.start, view.end, genome, inner, isReversed]);
  const rule = panel.readSubset?.rule;
  const guideSpans = useMemo(() => {
    if (!guides || !rule?.splitSnps?.length || rule.splitSnpGuide === false) return [];
    const span = view.end - view.start;
    if (!(span > 0) || inner <= 0) return [];
    return rule.splitSnps.flatMap(snp => {
      if (!sameChrom(snp.chrom, view.chrom) || snp.pos < Math.floor(view.start) || snp.pos >= Math.ceil(view.end)) return [];
      return [{ snp, x: axis.toX(snp.pos + .5) }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guides, rule, view.chrom, view.start, view.end, genome, inner, isReversed, axis]);
  // Without highlights here the box stays (empty), so the pan transform is attached from the start.
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute inset-y-0 z-[5] overflow-hidden"
      style={{ left: gutter, width: inner }}
      data-testid="highlight-bands"
    >
      {spans.map(({ highlight, x, w }) => (
        <div key={`${highlight.id}:${x}`} className="contents">
          <div
            className="absolute inset-y-0"
            style={{ left: x, width: w, backgroundColor: highlight.color, opacity: HIGHLIGHT_WASH_OPACITY, mixBlendMode: 'multiply' }}
            data-highlight-id={highlight.id}
            data-figure-overlay={highlight.color}
            data-figure-overlay-opacity={HIGHLIGHT_FIGURE_OPACITY}
          />
          {labels && highlight.label && w > 24 && (
            <span
              className="absolute bottom-0 truncate rounded-sm bg-white/70 px-0.5 text-[9px] font-semibold leading-3 text-gray-800"
              style={{ left: x + 1, maxWidth: w - 2 }}
              data-figure-text={highlight.label}
            >
              {highlight.label}
            </span>
          )}
        </div>
      ))}
      {Object.entries(extraOutlines).flatMap(([kind, outlines]) => outlines.flatMap((o, i) => {
        if (!panel.datasetId || !o.datasetIds.includes(panel.datasetId) || o.genomeKey !== genome) return [];
        const span = highlightSpans([{ ...o, id: `${kind}-${i}`, genome }], { ...view, genome }, inner, isReversed)[0];
        if (!span) return [];
        return <div key={`${kind}-${i}`} data-testid={`${kind}-region-outline`} data-region={`${o.chrom}:${o.start}-${o.end}`}
          className={`absolute inset-y-0 border-dashed ${labels ? 'border-2' : 'border-x-2'} ${o.onSelect ? 'pointer-events-auto cursor-pointer' : ''}`}
          style={{ left: span.x, width: span.w, borderColor: o.color, opacity: o.selected === false ? 0.55 : 1 }}
          role={o.onSelect ? 'button' : undefined} tabIndex={o.onSelect ? 0 : undefined}
          aria-label={o.onSelect ? `Select ${o.label} in Feature hub` : undefined}
          title={o.onSelect ? `${o.label}. Click to select in Feature hub; Shift-click to add or remove.` : undefined}
          onPointerDown={o.onSelect ? e => e.stopPropagation() : undefined}
          onMouseDown={o.onSelect ? e => e.stopPropagation() : undefined}
          onClick={o.onSelect ? e => { e.stopPropagation(); o.onSelect!(e.shiftKey || e.metaKey || e.ctrlKey); } : undefined}
          onKeyDown={o.onSelect ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); o.onSelect!(e.shiftKey || e.metaKey || e.ctrlKey); } } : undefined}>
          {labels && span.w > 24 && <span className="absolute right-0.5 top-0 truncate rounded-sm bg-white/80 dark:bg-gray-900/80 px-0.5 text-[9px] font-semibold leading-3"
            style={{ maxWidth: span.w - 4, color: o.color }}>{o.label}</span>}
        </div>;
      }))}
      {guideSpans.map(({ snp, x }) => (
        // On screen dashed; in figures (data-figure-overlay) a solid line of the same width and opacity.
        <div key={`snp-guide-${snp.id}`} className="absolute inset-y-0" data-testid="split-snp-guide" data-snp={snp.id}
          style={{ left: x - SPLIT_SNP_GUIDE_WIDTH / 2, width: SPLIT_SNP_GUIDE_WIDTH, borderLeft: `${SPLIT_SNP_GUIDE_WIDTH}px dashed ${SPLIT_SNP_GUIDE_COLOUR}`, opacity: SPLIT_SNP_GUIDE_OPACITY }}
          data-figure-overlay={SPLIT_SNP_GUIDE_COLOUR} data-figure-overlay-opacity={SPLIT_SNP_GUIDE_OPACITY} />
      ))}
      {outlineSpan && (
        // Dashed, in the Footprints colour: the analysis region, not a highlight (no wash, not in figures).
        <div
          className={`absolute inset-y-0 border-dashed border-emerald-600 dark:border-emerald-400 ${labels ? 'border-2' : 'border-x-2'}`}
          style={{ left: outlineSpan.x, width: outlineSpan.w }}
          data-testid="class-region-outline"
          data-region={`${outline!.chrom}:${outline!.start}-${outline!.end}`}
          title={labels ? outline!.label : undefined}
        >
          {labels && outlineSpan.w > 60 && (
            // The tag explains the dashed box on hover (the box itself lets clicks through to the reads).
            <span className="pointer-events-auto absolute right-0.5 top-0 cursor-help truncate rounded-sm bg-white/80 px-0.5 text-[9px] font-semibold leading-3 text-emerald-800"
              style={{ maxWidth: outlineSpan.w - 4 }} data-testid="class-region-outline-tag"
              title={outlineHint(outline!.label)}>
              {outline!.label}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
