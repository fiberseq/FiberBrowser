/** The selected features (footprint classes, plugin packs' kinds) in the main toolbar: what Cluster, Sort and Filter act on. */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { featureKey, featureKindDef, featureKindWithActions, featureShortName, type FeatureRef } from '../../stores/featureStore';
import { sameChrom } from '../../utils/chromAliases';
import { X } from '../ui/Icons';
import { requestSplitForFeatures } from '../../utils/splitPanels';

export const CHIP_BTN = 'rounded-full px-1.5 text-[10px] font-medium text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/15';

/** The selected features on the main view's chromosome. */
export function useFeaturesInView(): FeatureRef[] {
  const { selected, chrom } = useBrowserStore(useShallow(s => ({ selected: s.selectedFeatures, chrom: s.chrom })));
  return useMemo(() => selected.filter(f => !f.chrom || sameChrom(f.chrom, chrom)), [selected, chrom]);
}

export function FeatureSelectionChip({ peaksAlsoSelected = false }: { peaksAlsoSelected?: boolean }) {
  const features = useFeaturesInView();
  if (!features.length) return null;
  // A kind with actions of its own (a plugin pack's): the chip's buttons are its own, on its features alone.
  const own = featureKindWithActions(features);
  const layers = [...new Set(features.map(f => featureKindDef(f.kind)?.layerLabel ?? f.kind))].join(' + ');
  const title = `Cluster, Sort and Filter act on these ${features.length} feature${features.length === 1 ? '' : 's'} (${layers})`
    + `${peaksAlsoSelected ? ', not on the selected peaks' : ''}. Shift-click in the channels above the reads or in the panels' lists to add or remove; × clears.`;
  return (
    <span data-testid="feature-selection-chip" title={title}
      className="inline-flex max-w-[22rem] items-center gap-1 rounded-full bg-gray-900/5 py-0.5 pl-2 pr-1 text-[11px] text-gray-800 ring-1 ring-gray-300 dark:bg-white/10 dark:text-gray-100 dark:ring-gray-600">
      <span className="flex items-center gap-0.5">
        {features.slice(0, 6).map(f => <span key={featureKey(f)} className="inline-block h-2 w-2 rounded-sm" style={{ background: f.colour ?? '#64748b' }} />)}
      </span>
      <span className="truncate" data-testid="feature-selection-names">{features.map(featureShortName).join(', ')}</span>
      {own ? <own.actions.Chip features={features.filter(f => f.kind === own.kind)} all={features} /> : (
        <button type="button" data-testid="feature-split-panels" className={CHIP_BTN}
          title="Split into panels: one read panel per group of these features (variant, pattern), to cluster them together and compare. Cluster (combinatorial) groups them in this panel instead."
          onClick={() => { const error = requestSplitForFeatures(features); if (error) useBrowserStore.getState().setError(error); }}>
          Split into panels
        </button>
      )}
      <button type="button" aria-label="Clear the feature selection" data-testid="feature-selection-clear"
        className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-white/15 dark:hover:text-white"
        onClick={() => useBrowserStore.getState().clearFeatureSelection()}>
        <X size={10} aria-hidden="true" />
      </button>
    </span>
  );
}
