import type { Difference } from '../liveLift/differenceTypes';
import type { ComparisonResponse } from './comparison';

/** The assembly-comparison cell: the design's label for read differences, identity and links for assembly ones. */
export function comparisonCell(d: Difference, comparison?: ComparisonResponse | null, readText?: string): string {
  if (d.source === 'reads' && readText) return readText;
  if (!comparison) return d.source === 'reads' ? 'not compared' : 'assembly observation';
  if (d.source === 'reads') return comparison.reads[d.id]?.label_text ?? 'not compared';
  const a = comparison.assembly[d.id];
  if (!a) return 'assembly observation';
  const shared = a.shared_with.map(id => comparison.assembly[id]?.hap_label).filter(Boolean);
  const confirmed = a.read_links.filter(l => l.relation === 'exact').length;
  return [`${a.identity_state} identity`, shared.length ? `same allele as ${shared.join(', ')}` : '',
    confirmed ? `confirms ${confirmed} read difference${confirmed > 1 ? 's' : ''}` : a.read_links.length ? `${a.read_links.length} read link(s)` : '']
    .filter(Boolean).join(' · ');
}

/** The canvas and navigation table share records and the scoped inspect action. */
export function DifferenceTable({ items, chrom, inspect, comparison, readText }: { items: Difference[]; chrom: string; inspect: (d: Difference) => void;
  comparison?: ComparisonResponse | null; readText?: (d: Difference) => string | undefined }) {
  return <table className="w-full text-left text-xs" aria-label="Differences table"><thead><tr>
    {['Source / phase', 'Reference interval', 'Ref → alt', 'Sequence', 'Assembly comparison', 'Inspect'].map(h => <th key={h}>{h}</th>)}
  </tr></thead><tbody>{items.map(d => <tr key={d.id} data-difference-id={d.id}>
    <td>{d.source} {d.hap_label}</td><td>{chrom}:{d.t_start}–{d.t_end}</td><td>{d.ref_bp}→{d.alt_bp} bp · {d.kind}</td>
    <td>{d.sequence_status ?? (d.source === 'reads' ? 'geometry only' : 'unresolved')}</td>
    <td data-testid="difference-table-comparison">{comparisonCell(d, comparison, readText?.(d))}</td>
    <td><button onClick={() => inspect(d)}>Inspect</button></td>
  </tr>)}</tbody></table>;
}
