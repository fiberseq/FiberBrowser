/**
 * The Cluster panel's "Keep workspace full" (meta-locus only): top up each cluster from the pool, so every cluster
 * has examples to fill the display. The display is then enriched; each cluster's pool frequency comes back as
 * matches / read-site observations scanned with a Wilson 95% interval.
 */
import { useEffect } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { getClusterColor, getClusterLabel } from '../../components/tracks/read-track/constants';
import { isMetaChrom } from './metaChrom';
import { refillWorkspace, setKeepFull, useMetaLocusStore } from './metaLocusStore';
import { ENRICHED_TEXT } from './MetaLocusBar';

const pct = (x: number) => `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%`;

export function KeepWorkspaceFull({ hasClusters }: { hasClusters: boolean }) {
  const metaView = useBrowserStore(s => isMetaChrom(s.chrom));
  // A clustering run's identity (refill adds assignments but never new centroids or an order).
  const clusterRun = useBrowserStore(s => s.clusterOrder);
  const keepFull = useMetaLocusStore(s => s.keepFull);
  const refill = useMetaLocusStore(s => s.refill);
  const enriched = useMetaLocusStore(s => Boolean(s.view?.enriched));
  const busy = useMetaLocusStore(s => s.busy);
  const ready = useMetaLocusStore(s => s.status?.status === 'ready');

  // A new clustering while it is on: top up again (the clusters changed).
  useEffect(() => {
    if (keepFull && metaView && hasClusters && ready && !useMetaLocusStore.getState().busy) void refillWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterRun]);

  if (!metaView) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="meta-locus-keep-full">
      <label className="inline-flex items-center gap-1" title={hasClusters ? 'Top up each cluster from the pool so every cluster fills the display (the display becomes enriched)' : 'Cluster first'}>
        <input type="checkbox" data-testid="meta-locus-keep-full-checkbox" checked={keepFull} disabled={!hasClusters || busy || !ready}
          onChange={e => void setKeepFull(e.target.checked)} />
        Keep workspace full
      </label>
      {keepFull && enriched && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" data-testid="meta-locus-keep-full-enriched">{ENRICHED_TEXT}</span>
      )}
      {keepFull && refill && refill.per_cluster.map(c => {
        const id = Number(c.cluster);
        return (
          <span key={String(c.cluster)} className="inline-flex items-center gap-1" data-testid="meta-locus-cluster-estimate"
            title={`${c.found.toLocaleString()} of ${c.scanned.toLocaleString()} read-site observations scanned (matches / read-site observations scanned); Wilson 95% ${pct(c.wilson[0])}–${pct(c.wilson[1])}`}>
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: Number.isFinite(id) ? getClusterColor(id) : '#999' }} />
            {Number.isFinite(id) ? getClusterLabel(id, true) : String(c.cluster)} {pct(c.freq)}
          </span>
        );
      })}
    </span>
  );
}
