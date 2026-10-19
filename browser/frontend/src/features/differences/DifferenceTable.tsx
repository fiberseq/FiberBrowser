import type { Difference } from '../liveLift/differenceTypes';

/** The canvas and navigation table share records and the scoped inspect action. */
export function DifferenceTable({ items, chrom, inspect }: { items: Difference[]; chrom: string; inspect: (d: Difference) => void }) {
  return <table className="w-full text-left text-xs" aria-label="Differences table"><thead><tr>
    {['Source / phase', 'Reference interval', 'Ref → alt', 'Sequence / support', 'Inspect'].map(h => <th key={h}>{h}</th>)}
  </tr></thead><tbody>{items.map(d => <tr key={d.id}>
    <td>{d.source} {d.hap_label}</td><td>{chrom}:{d.t_start}–{d.t_end}</td><td>{d.ref_bp}→{d.alt_bp} bp · {d.kind}</td>
    <td>{d.sequence_status ?? 'unresolved'} · {d.read_candidates?.length ? `${d.read_candidates.length} candidate links` : d.source === 'reads' ? 'geometry evidence' : 'assembly observation'}</td>
    <td><button onClick={() => inspect(d)}>Inspect</button></td>
  </tr>)}</tbody></table>;
}
