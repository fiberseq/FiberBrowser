import { useBrowserStore } from '../../stores/browserStore';
import { recordKey } from '../../utils/recordKeys';
import type { GraphRunObservation } from '../../utils/clusterMatchedRun';

/** A linear fit's record origins use the node's durable record-provenance contract too. */
export function adoptLinearSources(key: string, datasetId: string,
  sources: Record<string, { contig: string; hap: string }>, merge = false): void {
  useBrowserStore.setState(s => {
    const nid = s.activeClusterTreeNodeId, node = nid ? s.clusterTreeNodes[nid] : undefined;
    if (!nid || !node || !Object.keys(sources).length) return {};
    const prior = merge ? node.graphProvenance?.[key] : undefined;
    const observations: GraphRunObservation[] = [...(prior?.observations ?? [])];
    const seen = new Set(observations.map(o => o.id));
    const ownership = new Map(Object.entries(prior?.owned ?? {}).map(([id, keys]) => [id, new Set(keys)]));
    for (const [rid, src] of Object.entries(sources)) {
      const id = `source:${JSON.stringify([datasetId, src.contig, src.hap])}`;
      if (!seen.has(id)) {
        observations.push({ id, dataset_id: datasetId, kind: 'graph', hap: src.hap, chrom: src.contig, label: src.hap });
        seen.add(id);
      }
      const rk = recordKey(rid) ?? rid;
      if (!ownership.has(id)) ownership.set(id, new Set());
      ownership.get(id)!.add(rk);
    }
    const owned = Object.fromEntries([...ownership].map(([id, keys]) => [id, [...keys]]));
    return { clusterTreeNodes: { ...s.clusterTreeNodes, [nid]: { ...node,
      graphProvenance: { ...node.graphProvenance, [key]: { observations, owned } },
      graphLabelsReplaced: { ...node.graphLabelsReplaced, [key]: true } } } };
  });
}
