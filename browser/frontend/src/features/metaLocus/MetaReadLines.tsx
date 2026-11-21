/** The read inspector's (hover card's) provenance lines for a meta-locus read: its site and its real place. */
import type { MetaReadProvenance } from './types';

export function metaReadLines(meta: MetaReadProvenance): string[] {
  const lines: string[] = [];
  const site = meta.site_name || (meta.site != null ? `site ${meta.site}` : 'site');
  if (meta.chrom && meta.window) {
    lines.push(`Site: ${site} · ${meta.chrom}:${meta.window[0].toLocaleString()}-${meta.window[1].toLocaleString()} (${meta.strand ?? '+'})`);
  } else lines.push(`Site: ${site}`);
  const real = meta.real;
  if (real?.reference_start != null && real.reference_end != null) {
    lines.push(`Read: ${real.chrom ?? meta.chrom ?? ''}:${real.reference_start.toLocaleString()}-${real.reference_end.toLocaleString()}${meta.strand === '-' ? ' · shown flipped (minus-strand site)' : ''}`);
  } else if (meta.strand === '-') lines.push('Shown flipped (minus-strand site)');
  if (meta.shared) lines.push('Shared with other sites (one observation per site)');
  return lines;
}

export function MetaReadLines({ meta }: { meta: MetaReadProvenance }) {
  return (
    <div data-testid="read-meta-provenance">
      {metaReadLines(meta).map(line => <div key={line}>{line}</div>)}
      <div className="text-gray-400">Right-click: Open this site</div>
    </div>
  );
}
