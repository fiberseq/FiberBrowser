import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { CheckboxRow } from '../../shared/CheckboxRow';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';
import { SIGNAL_TOOLTIP, signalCountText } from '../../../../utils/signalFilters';

export const SIGNAL_FILTER_SETTINGS = defineSettings({
  background: { id: 'view.signal-background', label: 'Hide background-compatible reads',
    keywords: ['signal', 'background', 'bg', 'untreated control'], location: inSidebar('view.advanced') },
  unscored: { id: 'view.signal-unscored', label: 'Exclude unscored reads',
    keywords: ['signal', 'unscored', 'missing annotation'], location: inSidebar('view.advanced') },
  detectable: { id: 'view.signal-detectable', label: 'Require detectable signal',
    keywords: ['signal', 'strict'], location: inSidebar('view.advanced') },
  structure: { id: 'view.signal-structure', label: 'Require chromatin-structure evidence',
    keywords: ['signal', 'structure', 'strict'], location: inSidebar('view.advanced') },
});

/** Producer-supplied signal gates, alongside the existing read filters. */
export function SignalReadFilters() {
  const { filters, setFilters, summaries, datasets } = useBrowserStore(useShallow(s => ({
    filters: s.signalFilters, setFilters: s.setSignalFilters, summaries: s.signalCounts, datasets: s.datasets,
  })));
  const current = Object.values(summaries).filter(s => datasets.some(d => d.id === s.datasetId));
  const structureAvailable = current.some(s => s.counts.structure_scored > 0);
  return <div className="space-y-1 text-[12px] text-ink" data-testid="signal-filters">
    <div {...settingAnchor(SIGNAL_FILTER_SETTINGS.background)}>
      <CheckboxRow label={SIGNAL_FILTER_SETTINGS.background.label} checked={filters.hideBackground}
        onChange={hideBackground => setFilters({ hideBackground })} title={SIGNAL_TOOLTIP} testId="signal-hide-background" />
    </div>
    <div {...settingAnchor(SIGNAL_FILTER_SETTINGS.unscored)}>
      <CheckboxRow label={SIGNAL_FILTER_SETTINGS.unscored.label} checked={filters.excludeUnscored}
        onChange={excludeUnscored => setFilters({ excludeUnscored })}
        title="Excludes unscored alignments and unavailable annotations. Keeps scored but unclassified signal evidence."
        testId="signal-exclude-unscored" />
    </div>
    <div {...settingAnchor(SIGNAL_FILTER_SETTINGS.detectable)}>
      <CheckboxRow label={SIGNAL_FILTER_SETTINGS.detectable.label} checked={filters.requireDetectable}
        onChange={requireDetectable => setFilters({ requireDetectable })}
        title="Keeps only alignments annotated with detectable assay signal."
        testId="signal-require-detectable" />
    </div>
    <div {...settingAnchor(SIGNAL_FILTER_SETTINGS.structure)}>
      <CheckboxRow label={SIGNAL_FILTER_SETTINGS.structure.label} checked={filters.requireStructure}
        disabled={!structureAvailable && !filters.requireStructure}
        onChange={requireStructure => setFilters({ requireStructure })}
        description={!structureAvailable ? 'Unavailable: structure is unscored in the current view.' : undefined}
        title="Keeps only supported structure evidence. With Require detectable signal, both conditions must hold. This subset selects structured fibers and may bias accessibility distributions."
        testId="signal-require-structure" />
    </div>
    {current.map(({ datasetId, counts, locus }, i) => <div key={`${datasetId}:${locus}:${i}`}
      className="text-[11px] text-ink-secondary px-1" data-testid="signal-filter-counts"
      title="Signal evidence for alignments in this view, before footprint, quality and name filters and before display sampling.">
      {datasets.find(d => d.id === datasetId)?.label}: {signalCountText(counts)}
    </div>)}
  </div>;
}
