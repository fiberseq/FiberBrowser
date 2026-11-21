/**
 * The built-in "Go to" providers: coordinates (chr1:1,000-2,000) and genes
 * (the reference's annotation, as the locus box searches it: a gene name, or
 * "gene +/- 2kb" for a window around its TSS).
 *
 * They move the box's own view (a panel's box: its panel, on its reference)
 * or, from the main box and the palette, the main view; with "Each panel
 * navigates" on, the main view can't be moved from there and they say so.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { parseCoordinates, formatCoordinates } from '../coordinates';
import { findChromInfo } from '../chromAliases';
import { parseReadNames } from '../readNames';
import { searchGene } from '../../api/reference';
import { SEARCH_SCORE, type SearchContext, type SearchProvider, type SearchSuggestion } from './providers';
import { beginNavigationIntent, contextReference } from './navigationIntent';

/** Why the main view can't be moved from here (null: it can). */
const PER_PANEL_REASON = 'Each panel navigates: use the locus box in each panel, or switch navigation to Linked.';

function navigationBlocked(ctx: SearchContext): string | null {
  if (ctx.navigate) return null;  // a panel's box moves its own panel
  return useBrowserStore.getState().navigationMode === 'perPanel' ? PER_PANEL_REASON : null;
}

/**
 * Move the box's view (or the main view), under the reference's own contig
 * name (1 → chr1). (Running the suggestion already superseded the view's
 * pending answers: runSearchSuggestion. An answer completing here is not a
 * new request and supersedes nothing.)
 */
function goTo(ctx: SearchContext, chrom: string, start: number, end: number): void {
  const s = useBrowserStore.getState();
  const name = findChromInfo(ctx.chroms ?? s.chroms, chrom)?.name ?? chrom;
  // A jump: Back (Alt+←) returns to where the view was.
  s.recordJump(ctx.navigate && ctx.target && ctx.target !== 'main' ? ctx.target.panelId : null, { to: { chrom: name, start, end } });
  if (ctx.navigate) ctx.navigate(name, start, end);
  else s.setViewport(name, start, end);
}

/** "roX1 +/- 5kb", "roX1 +- 10kb", "roX1+-5000" → the gene and the half-window in bp. */
export function parseGeneWithPadding(input: string): { gene: string; padding: number } | null {
  const match = input.match(/^(.+?)\s*\+\/?-\s*(\d+(?:\.\d+)?)\s*(kb|bp|mb)?$/i);
  if (!match) return null;
  let padding = parseFloat(match[2]);
  const unit = (match[3] || 'bp').toLowerCase();
  if (unit === 'kb') padding *= 1000;
  else if (unit === 'mb') padding *= 1_000_000;
  return { gene: match[1].trim(), padding: Math.round(padding) };
}

/** Could this be a gene name? One word of letters, digits and . - _ (or "gene +/- N"); not coordinates or read names. */
export function looksLikeGene(query: string): boolean {
  const q = query.trim();
  const name = parseGeneWithPadding(q)?.gene ?? q;
  return /^[A-Za-z0-9][\w.\-:]{0,39}$/.test(name) && !parseCoordinates(q) && !parseReadNames(q);
}

export const locusProvider: SearchProvider = {
  id: 'locus',
  kind: 'locus',
  label: 'Loci',
  order: 10,
  search(query, ctx) {
    const parsed = parseCoordinates(query);
    if (!parsed) return [];
    const chroms = ctx.chroms ?? useBrowserStore.getState().chroms;
    const known = chroms.length === 0 || Boolean(findChromInfo(chroms, parsed.chrom));
    const start = Math.min(parsed.start, parsed.end);
    const end = Math.max(parsed.start, parsed.end);
    const suggestion: SearchSuggestion = {
      id: `${parsed.chrom}:${start}-${end}`,
      kind: 'locus',
      label: formatCoordinates(parsed.chrom, start, end),
      score: SEARCH_SCORE.locus,
      // Coordinates on this reference (runSearchSuggestion refuses them on another).
      reference: contextReference(ctx),
      disabledReason: navigationBlocked(ctx) ?? (known ? undefined : `No chromosome ${parsed.chrom} in this reference`),
      run: runCtx => goTo(runCtx, parsed.chrom, start, end),
    };
    return [suggestion];
  },
};

export const geneProvider: SearchProvider = {
  id: 'gene',
  kind: 'gene',
  label: 'Genes',
  order: 20,
  async: true,
  maxScore: SEARCH_SCORE.geneExact,
  mightAnswer: looksLikeGene,
  async search(query, ctx) {
    const { signal } = ctx;
    if (!looksLikeGene(query)) return [];
    const padded = parseGeneWithPadding(query);
    const name = padded?.gene ?? query.trim();
    // A panel's box (or the palette, for a panel) prefers its own chromosome (the same gene on the
    // other haplotype) and asks its own reference.
    const forPanel = ctx.source === 'panel-locus' || (ctx.source === 'palette' && Boolean(ctx.navigate));
    const chromHint = forPanel ? ctx.viewport?.chrom : undefined;
    const reference = contextReference(ctx);
    const res = await searchGene(name, { signal }, chromHint, ctx.genome);
    if (signal.aborted) return [];
    const blocked = navigationBlocked(ctx) ?? undefined;
    if (res.found && res.chrom && res.start !== undefined && res.end !== undefined) {
      // Under the reference's own contig name (an annotation's "2R" is the reference's chr2R), as goTo moves there.
      const chrom = findChromInfo(ctx.chroms ?? useBrowserStore.getState().chroms, res.chrom)?.name ?? res.chrom;
      // The gene itself, or its TSS ± the padding asked for.
      const center = res.tss ?? (res.start + res.end) / 2;
      const [start, end] = padded
        ? [Math.max(0, Math.round(center - Math.max(50, padded.padding))), Math.round(center + Math.max(50, padded.padding))]
        : [res.start, res.end];
      const gene = res.gene_name ?? name;
      return [{
        id: `${gene}${padded ? `±${padded.padding}` : ''}`,
        kind: 'gene',
        label: `${gene}${padded ? ` ± ${padded.padding.toLocaleString()} bp` : ''}`,
        detail: formatCoordinates(chrom, start, end),
        // The gene named exactly so comes first (above any region); a near name lower.
        score: gene.toLowerCase() === name.toLowerCase() ? SEARCH_SCORE.geneExact : SEARCH_SCORE.geneNear,
        disabledReason: blocked,
        reference,
        run: runCtx => goTo(runCtx, chrom, start, end),
      }];
    }
    // Not found: the names it suggests, each searched again when chosen.
    return (res.suggestions ?? []).slice(0, 3).map((suggested: string, i: number) => ({
      id: suggested,
      kind: 'gene',
      label: suggested,
      detail: `Gene (no gene named ${name})`,
      score: SEARCH_SCORE.guess - i,
      guess: true,
      reference,
      disabledReason: blocked,
      run: async (runCtx: SearchContext) => {
        const intent = beginNavigationIntent(runCtx.target);
        const again = await searchGene(suggested, { signal: runCtx.signal }, chromHint, ctx.genome);
        // Not if its view moved meanwhile (a pan or zoom, another Go to, another assembly).
        if (runCtx.signal.aborted) return { ok: false, cancelled: true };
        if (!intent.isCurrent()) return { ok: false, cancelled: true, message: `Not moved to ${suggested}: the view changed while it was looked up.` };
        if (again.found && again.chrom && again.start !== undefined && again.end !== undefined) {
          goTo(runCtx, again.chrom, again.start, again.end);
          return { ok: true };
        }
        return { ok: false, message: again.message || `Gene not found: ${suggested}` };
      },
    }));
  },
};
