import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useDatasetActions } from '../../hooks/useDatasetActions';
import { X } from '../ui/Icons';
import { AnalysisButton } from './shared';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../utils/datasetLabels';

/**
 * The analysis strip's right end: minimized dataset panels (click to restore),
 * the linked-view mode and modification overlays. Arranging, linking and
 * merging panels is the Layout panel's job.
 */
export function DatasetPanel() {
  const { datasets, viewMode, modificationOverlays, panels, setPanelCollapsed } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets, viewMode: s.viewMode,
    modificationOverlays: s.modificationOverlays,
    panels: s.panels, setPanelCollapsed: s.setPanelCollapsed,
  })));
  const { handleRemoveOverlay } = useDatasetActions();
  const [showOverlays, setShowOverlays] = useState(false);

  // Collapsed panels (show as restore buttons)
  const collapsedPanels = panels.filter(p => p.collapsed);

  return (
    <div className="text-[12px] flex items-center gap-1 flex-nowrap">
        {/* Collapsed/minimized panels — restore buttons */}
        {collapsedPanels.map(panel => {
          const ds = datasets.find(d => d.id === panel.datasetId);
          const label = ds ? getDatasetDisplayLabel(ds, 28) : panel.datasetId;
          return (
            <AnalysisButton
              key={panel.id}
              onClick={() => setPanelCollapsed(panel.id, false)}
              data-tour="panel-restore"
              data-panel-restore-id={panel.id}
              variant="neutral"
              className="text-[13px] hover:opacity-80"
              style={{ backgroundColor: ds?.color || '#666', color: '#fff' }}
              title={`Restore ${ds ? getDatasetHoverLabel(ds) : panel.datasetId}`}
            >
              {label} +
            </AnalysisButton>
          );
        })}

        {/* View mode indicator for linked modes */}
        {datasets.length > 1 && (viewMode === 'linked' || viewMode === 'linkedSplit') && (
          <span className="text-[13px] text-gray-500 dark:text-gray-400">
            {viewMode === 'linked' ? 'Linked' : 'Split'} view
          </span>
        )}

        {/* With no datasets the welcome card (and Load File) say what to do; the strip stays quiet. */}


        {/* Overlays indicator with dropdown */}
        {modificationOverlays.length > 0 && (
          <div className="relative">
            <AnalysisButton
              onClick={() => setShowOverlays(!showOverlays)}
              theme="violet"
              variant="soft"
              className="text-[13px]"
              title="Click to manage overlays"
            >
              Overlays ({modificationOverlays.length}) {'\u25BE'}
            </AnalysisButton>

            {showOverlays && (
              <div className="absolute top-full left-0 mt-1 bg-white dark:bg-dark-surface border dark:border-white/10 rounded shadow-lg dark:shadow-dropdown-dark z-50 min-w-[200px]">
                {modificationOverlays.map(overlay => (
                  <div key={overlay.id} className="flex items-center justify-between px-3 py-1.5 text-[13px] hover:bg-gray-50 dark:hover:bg-white/5">
                    <span
                      className="truncate flex-1"
                      title={overlay.path}
                      style={{ color: overlay.color }}
                    >
                      {overlay.label}
                    </span>
                    <AnalysisButton
                      onClick={() => handleRemoveOverlay(overlay.id)}
                      variant="dangerOutline"
                      className="ml-2 px-1 py-0 leading-none"
                      title="Remove overlay"
                    >
                      <X size={12} />
                    </AnalysisButton>
                  </div>
                ))}
                <div className="p-1 border-t dark:border-white/10">
                  <AnalysisButton
                    onClick={() => setShowOverlays(false)}
                    variant="outline"
                    size="sm"
                    className="w-full text-center justify-center text-[13px]"
                  >
                    Close
                  </AnalysisButton>
                </div>
              </div>
            )}
          </div>
        )}
    </div>
  );
}
