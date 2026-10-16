import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { openSummaryTarget } from '../../shared';
import { defineSettings, inSidebar, settingAnchor, storeToggle } from '../../../../utils/settingsCatalog';

export const FOOTPRINT_FILTER_SETTINGS = defineSettings({
  showDuplicateReads: {
    id: 'view.show-duplicate-reads',
    label: 'Show duplicate reads',
    keywords: ['duplicates', '0x400', 'pcr duplicates', 'dedup', 'flag'],
    location: inSidebar('view.advanced'),
    toggle: storeToggle('showDuplicateReads', 'setShowDuplicateReads'),
  },
  minFootprints: {
    id: 'view.min-footprints',
    label: 'Min footprints',
    keywords: ['minimum footprints per read', 'read filter', 'sparse reads', 'hide reads'],
    location: inSidebar('view.advanced'),
  },
  minFpQuality: {
    id: 'view.legacy-fp-quality',
    label: 'Legacy FP quality',
    keywords: ['quality', 'min_fp_quality', 'score cutoff', 'older session'],
    location: inSidebar('view.advanced'),
    hiddenReason: () => (useBrowserStore.getState().minFpQuality > 0 ? null : 'shown only when an older session set it'),
  },
});

export function FootprintReadFilters() {
  const {
    minFootprints, setMinFootprints,
    minFpQuality, setMinFpQuality,
    showDuplicateReads, setShowDuplicateReads,
  } = useBrowserStore(useShallow(s => ({
    minFootprints: s.minFootprints, setMinFootprints: s.setMinFootprints,
    minFpQuality: s.minFpQuality, setMinFpQuality: s.setMinFpQuality,
    showDuplicateReads: s.showDuplicateReads, setShowDuplicateReads: s.setShowDuplicateReads,
  })));

  const hasLegacyQualityFilter = minFpQuality > 0;

  return (
    <>
      <label className="flex items-center gap-2 text-[13px] text-gray-600 dark:text-gray-400" {...settingAnchor(FOOTPRINT_FILTER_SETTINGS.showDuplicateReads)}>
        <input
          type="checkbox"
          checked={showDuplicateReads}
          onChange={e => setShowDuplicateReads(e.target.checked)}
          className="rounded"
        />
        {FOOTPRINT_FILTER_SETTINGS.showDuplicateReads.label}
        <span
          className="text-[11px] text-ink-secondary"
          title="Reads marked with BAM flag 0x400 or FiberHMM BigBed isDuplicate. Hidden from display and analyses by default."
        >
          (0x400)
        </span>
      </label>

      <div className="flex items-center gap-2" {...settingAnchor(FOOTPRINT_FILTER_SETTINGS.minFootprints)}>
        <span className="text-[13px] text-gray-600 dark:text-gray-400">{FOOTPRINT_FILTER_SETTINGS.minFootprints.label}:</span>
        <input
          data-copilot-anchor="min-footprints-input"
          type="number"
          value={minFootprints}
          onChange={e => setMinFootprints(Math.max(0, parseInt(e.target.value) || 0))}
          className="input-tool w-14 text-xs"
          min={0}
          title="Minimum footprints per read. Reads with fewer are hidden. 0 = no filter."
        />
      </div>

      <div className="text-[11px] text-gray-500 dark:text-gray-400">
        Quality filters (score cutoffs) are set in one place, Labeling &gt; Quality.{' '}
        <button
          type="button"
          onClick={() => openSummaryTarget('quality', 'sidebar-footprint-read-filters')}
          className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-300"
        >
          Open
        </button>
      </div>

      {hasLegacyQualityFilter && (
        <div className="rounded-md bg-amber-50/80 dark:bg-amber-950/25 border border-amber-200 dark:border-amber-900/50 px-2 py-1.5 space-y-1">
          <div className="text-[11px] text-amber-800 dark:text-amber-300">
            Legacy primary FP quality filter is active from an older session. Prefer layer quality filters for reproducible analysis.
          </div>
          <div className="flex items-center gap-2" {...settingAnchor(FOOTPRINT_FILTER_SETTINGS.minFpQuality)}>
            <span className="text-[12px] text-gray-600 dark:text-gray-400">{FOOTPRINT_FILTER_SETTINGS.minFpQuality.label}:</span>
            <input
              data-copilot-anchor="quality-filter-input"
              type="number"
              value={minFpQuality}
              onChange={e => setMinFpQuality(Math.max(0, parseInt(e.target.value) || 0))}
              className="input-tool w-14 text-xs"
              min={0}
              max={255}
              title="Legacy BAM-only primary footprint quality score. 0 disables this compatibility filter."
            />
            <button
              onClick={() => setMinFpQuality(0)}
              className="text-[11px] text-amber-700 dark:text-amber-300 hover:underline"
              title="Disable the legacy min_fp_quality request parameter"
            >
              reset
            </button>
          </div>
        </div>
      )}
    </>
  );
}
