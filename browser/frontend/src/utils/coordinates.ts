/**
 * Parse coordinate string like "chr2L:1,000,000-2,000,000"
 */
export function parseCoordinates(input: string): { chrom: string; start: number; end: number } | null {
  const cleaned = input.replace(/,/g, '').replace(/\s/g, '');
  const match = cleaned.match(/^([^:]+):(\d+)-(\d+)$/);
  
  if (!match) return null;
  
  return {
    chrom: match[1],
    start: parseInt(match[2], 10),
    end: parseInt(match[3], 10),
  };
}

/**
 * Format coordinates for display
 */
export function formatCoordinates(chrom: string, start: number, end: number): string {
  return `${chrom}:${start.toLocaleString()}-${end.toLocaleString()}`;
}

/**
 * Format base pairs with suffix
 */
export function formatBp(bp: number): string {
  if (bp >= 1_000_000) return `${(bp / 1_000_000).toFixed(1)} Mb`;
  if (bp >= 1_000) return `${(bp / 1_000).toFixed(1)} kb`;
  return `${bp} bp`;
}

/**
 * Convert genomic position to screen X
 */
export function genomeToScreen(
  pos: number,
  regionStart: number,
  regionEnd: number,
  screenWidth: number
): number {
  return ((pos - regionStart) / (regionEnd - regionStart)) * screenWidth;
}

/**
 * Convert genomic position to screen X, with optional reverse orientation
 */
export function genomeToScreenOriented(
  pos: number,
  start: number,
  end: number,
  width: number,
  reversed: boolean
): number {
  const frac = (pos - start) / (end - start);
  return reversed ? (1 - frac) * width : frac * width;
}

/**
 * Convert screen X to genomic position, with optional reverse orientation
 */
export function screenToGenomeOriented(
  x: number,
  start: number,
  end: number,
  width: number,
  reversed: boolean
): number {
  const frac = x / width;
  return Math.round(start + (reversed ? 1 - frac : frac) * (end - start));
}

/**
 * Format a genomic position relative to a TSS.
 * Sign is gene-strand-relative: + = downstream, - = upstream.
 * Pass reversed=true for minus-strand genes to flip the sign.
 */
export function formatRelativePosition(pos: number, tss: number, reversed = false): string {
  let delta = pos - tss;
  if (reversed) delta = -delta;
  if (delta === 0) return 'TSS';
  return `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;
}


/** A gene's TSS base: start on the + strand, end - 1 on the - strand (genes are 0-based half-open). */
export function geneTss(gene: { start: number; end: number; strand?: string | null }): number {
  return gene.strand === '-' ? gene.end - 1 : gene.start;
}
