import type { BrowserState } from '../stores/browserStore';
import type { FirePeak } from '../types';
import { featureKindDef } from '../stores/featureStore';
import { equivalentPeaks } from './equivalentPositions';

/** Selected region features use the same peak overlay and mapped columns as drawn peaks. */
export function equivalentFeaturePeaks(s: BrowserState, groups: FirePeak[][]): FirePeak[] {
  if (!groups.length) return [];
  const peaks = s.selectedFeatures.flatMap((feature, i) => {
    if (feature.start == null || feature.end == null || feature.end <= feature.start) return [];
    const layers = s.datasets.find(d => d.id === feature.datasetId)?.available_layers ?? {};
    const definition = featureKindDef(feature.kind);
    const mode = feature.kind === 'fp-class' ? (layers.tf_rc ? 'tf_rc' : layers.tf_cr ? 'tf_cr' : 'tf')
      : definition?.regionMode ? definition.regionMode(feature) : 'accessibility';
    if (mode === null) return [];
    const region = { start: Math.floor(feature.start), end: Math.ceil(feature.end), mode };
    const panel = s.panels.find(p => p.datasetId === feature.datasetId && !p.collapsed);
    const source: FirePeak = { ...region, index: -1-i, chrom: feature.chrom ?? s.chrom, genome: panel?.genome, memberPanelId: panel?.id,
      ruleId: s.getCustomRuleId(), featureIndex: i, featureMode: region.mode, sourceLabel: feature.label };
    return equivalentPeaks([source], groups, s.chrom);
  });
  return peaks.some(p => p.match) ? peaks : [];
}
