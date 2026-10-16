import type { BrowserState } from '../stores/browserStore';
import { clusterWindows } from './clusterTargets';

/** Only changes to scan inputs invalidate an in-flight result, not panel styling or layout. */
export function peakScanScope(s: BrowserState, ruleId: string): string {
  return JSON.stringify({
    locus: [s.chrom, s.start, s.end, s.currentGenome],
    windows: clusterWindows({ ...s, selectedDatasets: new Set() }, s.datasets.map(d => d.id))
      .map(({ panel, ...w }) => ({ ...w, panelId: panel.id, genome: panel.genome })),
    signalFilters: s.signalFilters, restoredAt: s._lastRestoreTime,
    spanning: s.spanningOnly, sampleSeed: s.analysisSampleSeed,
    sources: s.datasets.map(d => [d.id, d.source_identity ?? d.paths ?? d.path]),
    targeted: [...s.selectedDatasets], selected: [...s.selectedPeaks],
    rule: s.peakRules.find(r => r.id === ruleId),
    maps: s.peakRules.filter(r => r.source === 'matched').map(r => s.peaksByRule[r.id]),
  });
}
