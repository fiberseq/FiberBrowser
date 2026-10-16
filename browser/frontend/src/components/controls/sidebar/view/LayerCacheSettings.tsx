import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { getMetaprofileSourceEntries } from '../../../../utils/layerColors';
import { isLayerCachedByDefault, isLayerCacheEnabled } from '../../../../utils/layerCache';
import { HelpIcon } from '../../../ui/Tooltip';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';

export const LAYER_CACHE_SETTINGS = defineSettings({
  layerCache: {
    id: 'view.layer-cache',
    label: 'Layer cache',
    keywords: ['prefetch', 'cache layers', 'fire', 'deam', 'methylation', 'speed', 'slow machine'],
    location: inSidebar('view.display'),
    hiddenReason: () => (getMetaprofileSourceEntries(useBrowserStore.getState().datasets).length > 0 ? null : 'shown with data loaded'),
  },
});

export function LayerCacheSettings() {
  const {
    datasets,
    cachedLayerTypes,
    setCachedLayerType,
  } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets,
    cachedLayerTypes: s.cachedLayerTypes,
    setCachedLayerType: s.setCachedLayerType,
  })));

  const entries = useMemo(
    () => getMetaprofileSourceEntries(datasets),
    [datasets],
  );
  if (entries.length === 0) return null;

  return (
    <div className="rounded-md border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-2 py-1.5 space-y-1" {...settingAnchor(LAYER_CACHE_SETTINGS.layerCache)}>
      <div className="flex items-center gap-1">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
          Layer Cache
        </span>
        <HelpIcon position="left" text="Checked layers are prefetched with read windows so display toggles and metaprofiles are instant. Uncheck heavy layers on slow machines; using them later will request them on demand." />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map(entry => {
          const key = entry.key === 'mod' ? 'm6a' : entry.key;
          const alwaysCached = isLayerCachedByDefault(key);
          const checked = alwaysCached || isLayerCacheEnabled(key, cachedLayerTypes);
          return (
            <label
              key={entry.key}
              className={`flex items-center gap-1 text-[12px] ${
                alwaysCached
                  ? 'text-slate-400 dark:text-slate-500 cursor-not-allowed'
                  : 'text-slate-700 dark:text-slate-300 cursor-pointer'
              }`}
              title={alwaysCached ? 'Base HMM intervals are always cached' : entry.title}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={alwaysCached}
                onChange={e => setCachedLayerType(key, e.target.checked)}
                className="w-3.5 h-3.5 rounded border-gray-300 dark:border-white/20"
              />
              {entry.label}
            </label>
          );
        })}
      </div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400">
        Base HMM intervals are cached by default. Enable FIRE/deam/methylation/custom cache only when instant profile toggles matter more than navigation speed.
      </div>
    </div>
  );
}
