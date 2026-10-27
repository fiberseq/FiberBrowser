/**
 * The nucleosome panel's observation planner (native/nucleosome_panel/DESIGN.md §0.10, §5.2): one column per shown
 * dataset panel, from the same windows a Cluster run sends (utils/clusterTargets.clusterWindows), so haplotype
 * pop-outs, strand splits, split panels, linked loci (panels at their own view) and filtered or cluster-focused read
 * sets are columns of their own. A dataset panel drawing its graph (graph mode) gives one column per haplotype path:
 * all of that haplotype's molecules over the path's span, the stretches inside insertions included.
 *
 * Never getTargetDatasetIds: it collapses a dataset's panels into one dataset.
 */
import { clusterWindows, panelTargetLabel, type PlanState } from '../../utils/clusterTargets';
import { hostDrawsGraph } from '../graphPanel/graphCluster';
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { liftHapLabels } from '../liveLift/types';
import type { NucObservation } from './types';

const FALLBACK_COLOR = '#16a34a';

export function nucObservations(st: PlanState, dark = false): NucObservation[] {
  // Every shown dataset panel, whatever is targeted: the panel compares them all side by side.
  const windows = clusterWindows({ ...st, selectedDatasets: new Set() }, st.datasets.map(d => d.id));
  const out: NucObservation[] = [];
  for (const w of windows) {
    const panel = w.panel;
    // A member folded into a host's graph: the host's path columns stand for its reads.
    if (panel.collapsed) continue;
    const ds = st.datasets.find(d => d.id === w.dataset_id);
    if (!ds || (ds.data_type !== 'bam' && ds.data_type !== 'bam_livelift')) continue;
    const stateKey = w.result_key;
    const { short } = panelTargetLabel(st, panel);
    const base = {
      datasetId: w.dataset_id, panelId: panel.id, stateKey, chrom: w.chrom, start: w.start, end: w.end,
      ...(w.strand ? { strand: w.strand } : {}), ...(w.read_ids ? { readIds: w.read_ids } : {}),
    };
    if (hostDrawsGraph(panel)) {
      const haps = ds.data_type === 'bam_livelift' ? liftHapLabels(ds.live_lift) : [];
      if (!haps.length) {
        out.push({ ...base, obsId: `${stateKey}:graph`, label: `${short} · graph`, color: ds.color || FALLBACK_COLOR, kind: 'graph', graph: {} });
      }
      for (const hap of haps) {
        out.push({ ...base, obsId: `${stateKey}:graph:${hap}`, label: `${short} · graph ${hap}`,
          color: liveLiftHaplotypeColor(hap, dark), kind: 'graph', liftHap: hap, graph: { hap } });
      }
      continue;
    }
    out.push({ ...base, obsId: stateKey, label: short, kind: 'linear',
      color: w.lift_hap ? liveLiftHaplotypeColor(w.lift_hap, dark) : (ds.color || FALLBACK_COLOR),
      ...(w.lift_hap ? { liftHap: w.lift_hap } : {}) });
  }
  return out;
}

/** The datasets a set of observations reads (each once, in column order). */
export function observationDatasets(observations: NucObservation[]): string[] {
  return [...new Set(observations.map(o => o.datasetId))];
}

/** A key that changes when any observation's identity or scope changes (refetch the summary). */
export function observationsKey(observations: NucObservation[]): string {
  return JSON.stringify(observations.map(o => [o.obsId, o.datasetId, o.kind, o.chrom, o.start, o.end, o.liftHap ?? null,
    o.strand ?? null, o.readIds ? o.readIds.length : null, o.readIds?.slice(0, 3) ?? null]));
}
