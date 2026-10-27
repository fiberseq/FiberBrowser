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
import { hostDrawsGraph, stableId } from '../graphPanel/graphCluster';
import { membersOf } from '../graphPanel/hostMode';
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { liftHapLabels } from '../liveLift/types';
import type { NucObservation } from './types';

const FALLBACK_COLOR = '#16a34a';
const readable = (dataType: string | undefined) => dataType === 'bam' || dataType === 'bam_livelift';

export function nucObservations(st: PlanState, dark = false): NucObservation[] {
  // Every shown dataset panel, whatever is targeted: the panel compares them all side by side. Folded graph members
  // are in these windows too (their reads are in the host's sub-bands), with their own read scope.
  const windows = clusterWindows({ ...st, selectedDatasets: new Set() }, st.datasets.map(d => d.id));
  const byKey = new Map(windows.map(w => [w.result_key, w]));
  const out: NucObservation[] = [];
  const seen = new Set<string>();
  const push = (o: NucObservation) => { if (!seen.has(o.obsId)) { seen.add(o.obsId); out.push(o); } };
  for (const w of windows) {
    const panel = w.panel;
    // A member folded into a host's graph: its host's member columns below stand for it.
    if (panel.collapsed) continue;
    const ds = st.datasets.find(d => d.id === w.dataset_id);
    if (!ds || !readable(ds.data_type)) continue;
    const { short } = panelTargetLabel(st, panel);
    const view = { chrom: w.chrom, start: w.start, end: w.end };
    if (hostDrawsGraph(panel)) {
      // One column per member the host draws (itself and its folded members, whatever their dataset), per haplotype
      // path: a pooled lifted member draws each of its haplotypes on its own path.
      const members = membersOf(st.panels, panel);
      for (const { panel: member } of members) {
        const mds = st.datasets.find(d => d.id === member.datasetId);
        if (!mds || !readable(mds.data_type)) continue;
        const key = member.stateKey ?? member.datasetId!;
        const mw = byKey.get(key);
        const memberName = member.id === panel.id ? short : panelTargetLabel(st, member).short;
        // A pooled member leaves the haplotypes its dataset's haplotype members show to them, as the graph draws
        // its bands (GraphPanel: excludeHaps).
        const owned = new Set(member.liftHap ? [] : members.filter(x => x.panel.id !== member.id
          && x.panel.datasetId === member.datasetId && x.panel.liftHap).map(x => x.panel.liftHap!.toUpperCase()));
        const haps: Array<string | null> = member.liftHap ? [member.liftHap]
          : mds.data_type === 'bam_livelift' ? liftHapLabels(mds.live_lift).filter(h => !owned.has(h.toUpperCase())) : [null];
        if (!haps.length) continue;
        for (const hap of haps) {
          push({
            obsId: `${key}:graph${hap ? `:${hap}` : ''}`, label: `${memberName} · graph${hap ? ` ${hap}` : ''}`,
            color: hap ? liveLiftHaplotypeColor(hap, dark) : (mds.color || FALLBACK_COLOR), kind: 'graph',
            datasetId: member.datasetId!, panelId: member.id, stateKey: key, ...view,
            ...(hap ? { liftHap: hap } : {}), ...(mw?.strand ? { strand: mw.strand } : {}),
            ...(mw?.read_ids ? { readIds: mw.read_ids } : {}), graph: hap ? { hap } : {},
          });
        }
      }
      continue;
    }
    push({ datasetId: w.dataset_id, panelId: panel.id, stateKey: w.result_key, ...view, obsId: w.result_key, label: short,
      kind: 'linear', color: w.lift_hap ? liveLiftHaplotypeColor(w.lift_hap, dark) : (ds.color || FALLBACK_COLOR),
      ...(w.lift_hap ? { liftHap: w.lift_hap } : {}), ...(w.strand ? { strand: w.strand } : {}),
      ...(w.read_ids ? { readIds: w.read_ids } : {}) });
  }
  return out;
}

/** The datasets a set of observations reads (each once, in column order). */
export function observationDatasets(observations: NucObservation[]): string[] {
  return [...new Set(observations.map(o => o.datasetId))];
}

/** Each observation's dataset and view, once: what a job computes (lifted views resolve to source windows on the
 * server). */
export function observationViews(observations: NucObservation[]): Array<{ datasetId: string; chrom: string; start: number; end: number }> {
  const out = new Map<string, { datasetId: string; chrom: string; start: number; end: number }>();
  for (const o of observations) out.set(`${o.datasetId}|${o.chrom}|${o.start}|${o.end}`, { datasetId: o.datasetId, chrom: o.chrom, start: o.start, end: o.end });
  return [...out.values()];
}

/** A key that changes when any observation's identity or scope changes (refetch the summary): the full read
 * membership enters through a digest of the sorted ids. */
export function observationsKey(observations: NucObservation[]): string {
  return JSON.stringify(observations.map(o => [o.obsId, o.datasetId, o.kind, o.chrom, o.start, o.end, o.liftHap ?? null,
    o.strand ?? null, o.readIds ? `${o.readIds.length}:${stableId([...o.readIds].sort())}` : null]));
}
