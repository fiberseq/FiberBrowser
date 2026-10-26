/**
 * What a host drawn linear cannot show (DESIGN_GRAPH_PRIMARY §7.4 "Carrier-only regions are listed as 'not drawn in
 * linear view'"): the features of its graph cluster run with no target coordinate — inserted sequence some or all
 * of the paths carry and the target does not. Target features and deleted stretches are target sequence and are
 * drawn (and outlined) in linear.
 */
import type { ClusterMatchedRun } from '../../utils/clusterMatchedRun';

export interface RunFeature { kind: string; length: number; samples: number; label: string }

/** The columns a graph run records (graphCluster.ts runGraphCluster). */
interface RunColumns { shared?: RunFeature[]; carrier_sets?: { carriers: string[]; features: RunFeature[] }[] }

/** The current graph run's features of this host that linear does not draw (none: no run, another host's run). */
export function notDrawnInLinear(run: ClusterMatchedRun | null | undefined, hostId: string): RunFeature[] {
  const g = run?.graph;
  if (!g || g.hostPanelId !== hostId) return [];
  const c = (g.columns ?? {}) as RunColumns;
  const all = [...(c.shared ?? []), ...(c.carrier_sets ?? []).flatMap(cs => cs.features ?? [])];
  const seen = new Set<string>();
  return all.filter(f => f && f.kind === 'insertion' && !seen.has(f.label) && seen.add(f.label));
}

/** "insertion I1 (312 bp)" for the notice. */
export function featureText(f: RunFeature): string {
  return `${f.kind} ${f.label} (${f.length.toLocaleString()} bp)`;
}
