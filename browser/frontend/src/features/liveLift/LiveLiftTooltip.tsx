/**
 * A live-lift row's lines in the read tooltip (DESIGN_LIVE_LIFT.md §2.4): where the record is on its source
 * assembly, the molecule's haplotype and strand, the parts that run reversed here, and the badges' reasons. Separate
 * from the fiberhmm-lift provenance line (`read.lift`).
 */
import type { CompactRead } from '../../components/tracks/read-track/types';
import { BADGE_REASONS, formatBadgeBp } from '../../components/tracks/read-track/liveLiftCanvas';
import { liveLiftHaplotypeColor } from './palette';

export function liveLiftTooltipLines(read: Pick<CompactRead, 'live_lift' | 'strand'>): string[] {
  const ll = read.live_lift;
  if (!ll) return [];
  const lines: string[] = [];
  const src = ll.source;
  if (src) {
    lines.push(`Live lift from ${src.contig}:${(src.start + 1).toLocaleString()}-${src.end.toLocaleString()}`
      + `${src.supplementary ? ' (supplementary alignment)' : ''}${ll.alt ? ' · alternative placement' : ''}`);
  }
  const hap = ll.hap_label ?? ll.hap;
  if (hap) lines.push(`Haplotype ${hap}${ll.hap_source === 'record' ? " (this record's contig; primary not found)" : ''}`);
  if (read.strand === 'CT' || read.strand === 'GA') lines.push(`Molecule strand ${read.strand} (st, unchanged by the lift)`);
  const reversed = (ll.segments ?? []).filter(s => s[3] === '-').length;
  if (reversed) {
    lines.push(`${reversed === (ll.segments ?? []).length ? 'Runs' : `${reversed} segment${reversed > 1 ? 's' : ''} run`}`
      + ' reversed relative to this genome (marks shown complemented)');
  }
  if ((ll.connectors ?? []).length) {
    lines.push(`${ll.connectors!.length} gap${ll.connectors!.length > 1 ? 's' : ''} of this genome only (dashed)`);
  }
  for (const badge of (ll.badges ?? []).slice(0, 3)) {
    const [, kind, molBp, , , locus] = badge;
    const where = kind === 'elsewhere' && locus ? ` (${locus[0]}:${(locus[1] + 1).toLocaleString()})` : '';
    lines.push(`${formatBadgeBp(molBp)}: ${BADGE_REASONS[kind] ?? kind}${where}`);
  }
  if ((ll.badges ?? []).length > 3) lines.push(`… ${ll.badges!.length - 3} more badges`);
  lines.push('CIGAR detail: muted HG002 assembly differences; normal read mismatches; amber GRCh38-allele markers (possible mis-phasing).');
  return lines;
}

export function LiveLiftTooltipLines({ read }: { read: CompactRead }) {
  const lines = liveLiftTooltipLines(read);
  if (!lines.length) return null;
  return (
    <div data-testid="read-live-lift" className="text-cyan-200">
      {lines.map((line, i) => <div key={i} style={line.startsWith('Haplotype ')
        ? { color: liveLiftHaplotypeColor(read.live_lift?.hap_label ?? read.live_lift?.hap, true) } : undefined}>{line}</div>)}
    </div>
  );
}
