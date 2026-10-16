import type { PerReadStats, ReadStatsResponse } from '../../../api/readStats';
import { SignalDetails } from './SignalDetails';
import { CigarDetail } from './CigarDetail';
import type { ClusterSummaryRow } from '../../../utils/readStatsScope';

export function SummaryTab({ aggregate: agg, isBam, perRead, chrom, containerWidth, byCluster, onPickCluster }: {
  aggregate: ReadStatsResponse['aggregate'];
  isBam: boolean;
  perRead: PerReadStats[];
  /** The one read's chromosome: where it was requested (its panel's locus, see readLocus.ts), not the main locus. */
  chrom: string;
  containerWidth: number;
  /** The same reads by cluster (when the reads are clustered). */
  byCluster?: ClusterSummaryRow[];
  onPickCluster?: (cluster: number) => void;
}) {
  const isSingle = perRead.length === 1;
  const read = isSingle ? perRead[0] : null;

  const cards: { label: string; value: string; show: boolean }[] = isSingle && read ? [
    { label: 'Accessibility', value: `${read.accessibility_pct.toFixed(1)}%`, show: true },
    { label: 'Footprints', value: `${read.footprint_count} (${read.nucleosome_count} nuc, ${read.subnuc_count} small)`, show: true },
    { label: 'Avg FP Size', value: `${read.avg_footprint_size.toFixed(0)} bp`, show: true },
    { label: 'Read Length', value: `${read.read_length.toLocaleString()} bp`, show: true },
    { label: 'MAPQ', value: read.mapq != null ? `${read.mapq}` : '-', show: isBam },
    { label: 'Strand', value: read.strand ?? '-', show: isBam },
    { label: 'Edit Distance', value: read.nm != null ? `${read.nm}` : '-', show: isBam && read.nm != null },
    { label: 'Aligned Span', value: `${read.aligned_span.toLocaleString()} bp`, show: true },
    { label: 'Modifications', value: read.methyl_count != null ? `${read.methyl_count} modified bases (${read.methyl_pct?.toFixed(1)}%)` : '-', show: read.methyl_count != null },
  ] : [
    { label: 'Mean Accessibility', value: `${agg.mean_accessibility_pct?.toFixed(1) ?? '-'}%`, show: true },
    { label: 'Mean FP Count', value: `${agg.mean_footprint_count?.toFixed(1) ?? '-'}`, show: true },
    { label: 'Mean FP Size', value: `${agg.mean_footprint_size?.toFixed(0) ?? '-'} bp`, show: true },
    { label: 'Median FP Size', value: `${agg.median_footprint_size?.toFixed(0) ?? '-'} bp`, show: true },
    { label: 'Mean Read Length', value: `${agg.mean_read_length?.toFixed(0) ?? '-'} bp`, show: true },
    { label: 'Mean MAPQ', value: agg.mean_mapq != null ? `${agg.mean_mapq.toFixed(1)}` : '-', show: isBam },
    {
      label: 'Strand Balance',
      value: `+${agg.strand_counts?.['+'] ?? 0} / -${agg.strand_counts?.['-'] ?? 0}`,
      show: isBam,
    },
    { label: 'Mean Mod %', value: agg.mean_methyl_pct != null ? `${agg.mean_methyl_pct.toFixed(1)}%` : '-', show: agg.mean_methyl_pct != null },
  ];

  return (
    <div className="space-y-2">
      {isSingle && read && (
        <div className="space-y-0.5">
          <div className="text-[11px] text-ink-secondary">Read ID</div>
          <div className="text-[11px] font-mono text-gray-700 dark:text-gray-300 break-all select-all">
            {read.read_id}
          </div>
          {isBam && read.ref_start != null && read.ref_end != null && (
            <div className="text-[11px] text-gray-500">
              {chrom}:{read.ref_start.toLocaleString()}-{read.ref_end.toLocaleString()}
              {read.strand && <span className="ml-1">({read.strand})</span>}
            </div>
          )}
        </div>
      )}

      {isSingle && isBam && <SignalDetails signal={read?.signal} />}
      <div className="grid grid-cols-2 gap-2">
        {cards.filter(c => c.show).map(c => (
          <div key={c.label} className="bg-violet-50 dark:bg-violet-900/20 rounded p-2">
            <div className="text-[11px] text-gray-500 dark:text-gray-400">{c.label}</div>
            <div className="text-sm font-semibold text-violet-700 dark:text-violet-300">{c.value}</div>
          </div>
        ))}
      </div>

      {byCluster && byCluster.length > 0 && (
        <div className="space-y-1" data-testid="read-stats-by-cluster">
          <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">By cluster</div>
          <table className="w-full text-[11px] tabular-nums">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400">
                <th className="py-0.5 pr-2 font-medium">Cluster</th>
                <th className="py-0.5 pr-2 text-right font-medium">Reads</th>
                <th className="py-0.5 pr-2 text-right font-medium">Accessibility</th>
                <th className="py-0.5 pr-2 text-right font-medium">Footprints</th>
                <th className="py-0.5 pr-2 text-right font-medium">FP size</th>
                {byCluster.some(r => r.meanModPct != null) && <th className="py-0.5 text-right font-medium">Mod %</th>}
              </tr>
            </thead>
            <tbody>
              {byCluster.map(row => (
                <tr
                  key={row.cluster}
                  className="cursor-pointer border-t border-gray-100 text-gray-700 hover:bg-violet-50 dark:border-white/10 dark:text-gray-200 dark:hover:bg-violet-900/20"
                  onClick={() => onPickCluster?.(row.cluster)}
                  title={`Show statistics for ${row.label} only`}
                >
                  <td className="py-0.5 pr-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: row.color }} />
                      {row.label}
                    </span>
                  </td>
                  <td className="py-0.5 pr-2 text-right">{row.n.toLocaleString()}</td>
                  <td className="py-0.5 pr-2 text-right">{row.meanAccessibility.toFixed(1)}%</td>
                  <td className="py-0.5 pr-2 text-right">{row.meanFootprints.toFixed(1)}</td>
                  <td className="py-0.5 pr-2 text-right">{row.meanFootprintSize.toFixed(0)} bp</td>
                  {byCluster.some(r => r.meanModPct != null) && (
                    <td className="py-0.5 text-right">{row.meanModPct != null ? `${row.meanModPct.toFixed(1)}%` : '-'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11px] text-ink-secondary">Means per read over these reads. Click a cluster to inspect all its reads.</div>
        </div>
      )}

      {isSingle && isBam && read?.cigar_ops && (
        <CigarDetail
          cigarString={read.cigar_string}
          cigarOps={read.cigar_ops}
          fpIntervals={read.fp_intervals}
          methylPositions={read.methyl_pos}
          width={containerWidth - 16}
        />
      )}
    </div>
  );
}
