import type { CompactRead } from '../../components/tracks/read-track/types';
import type { AlleleGrouping } from '../variants/api';
import { useBrowserStore } from '../../stores/browserStore';
import { useTrackFeedStore } from '../../stores/trackFeedStore';
import { groupInPanel } from '../variants/variantSplit';
import type { LiveLiftDatasetInfo } from './types';

export function liftHaplotypeGrouping(datasetId: string, info: LiveLiftDatasetInfo, reads: CompactRead[], region: AlleleGrouping['region']): AlleleGrouping {
  const labels = info.haplotypes.map(h => info.haplotype_labels[h] ?? h);
  const assignments: Record<string, number> = {};
  for (const read of reads) {
    const label = read.live_lift?.hap_label ?? read.live_lift?.hap;
    const group = labels.indexOf(label ?? '');
    if (group >= 0) assignments[read.analysis_id ?? read.id] = group;
  }
  return { dataset_id: datasetId, region, mode: 'lift_hap', scan_key: info.key,
    assignments, n_reads: Object.keys(assignments).length, covering: Object.keys(assignments).length,
    threshold: 0, distinct: labels.length, phase: null, tags: null, snps: [],
    groups: labels.map((label, id) => ({ id, label, key: label, alleles: [label], kind: 'combo',
      count: Object.values(assignments).filter(g => g === id).length })),
  };
}

export function groupLiftPanel(panelId: string) {
  const state = useBrowserStore.getState();
  const panel = state.panels.find(p => p.id === panelId);
  const dataset = state.datasets.find(d => d.id === panel?.datasetId);
  if (!panel || !dataset?.live_lift) return;
  const key = panel.stateKey ?? dataset.id;
  const feed = useTrackFeedStore.getState().byStateKey[key];
  const region = panel.viewportOverride ?? state;
  const grouping = liftHaplotypeGrouping(dataset.id, dataset.live_lift, feed?.reads ?? [], region);
  groupInPanel(grouping, dataset.id, key, 'haplotype');
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === panelId ? { ...p, liftGroupByHaplotype: true } : p) }));
}

let subscribed = false;
export function followLiftGroupingRows() {
  if (subscribed) return;
  subscribed = true;
  useTrackFeedStore.subscribe((current, previous) => {
    const state = useBrowserStore.getState();
    for (const panel of state.panels) {
      if (!panel.liftGroupByHaplotype || !panel.datasetId) continue;
      const key = panel.stateKey ?? panel.datasetId;
      const feed = current.byStateKey[key], old = previous.byStateKey[key];
      if (!feed || feed.reads === old?.reads) continue;
      const dataset = state.datasets.find(d => d.id === panel.datasetId);
      if (!dataset?.live_lift) continue;
      const grouping = liftHaplotypeGrouping(dataset.id, dataset.live_lift, feed.reads, feed);
      state.setClusterAssignments(key, grouping.assignments, { mirror: false, svSplit: true });
    }
  });
}
