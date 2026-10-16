import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { useDatasetActions } from '../../../hooks/useDatasetActions';
import { CollapsedPanelChips } from './dataset/CollapsedPanelChips';
import { DatasetToolbar } from './dataset/DatasetToolbar';
import { LoadedDatasetsList } from './dataset/LoadedDatasetsList';
import { ModificationOverlaysList } from './dataset/ModificationOverlaysList';

export function DatasetSection() {
  const { datasets,
          modificationOverlays,
          panels, linkPanels, unlinkPanel, setPanelCollapsed } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets,
    modificationOverlays: s.modificationOverlays,
    panels: s.panels, linkPanels: s.linkPanels, unlinkPanel: s.unlinkPanel, setPanelCollapsed: s.setPanelCollapsed,
  })));

  const { handleRemoveOverlay } = useDatasetActions();

  const [showOverlays, setShowOverlays] = useState(false);

  // Dataset selection for scoped operations + link/unlink
  const selectedDatasets = useBrowserStore(s => s.selectedDatasets);
  const clearDatasetSelection = useBrowserStore(s => s.clearDatasetSelection);

  const mergeSelectedPanels = useBrowserStore(s => s.mergeSelectedPanels);
  const unmergeSelectedPanel = useBrowserStore(s => s.unmergeSelectedPanel);
  const clearPanelSelection = useBrowserStore(s => s.clearPanelSelection);

  const collapsedPanels = panels.filter(p => p.collapsed);

  // Dataset-selected panels for scoped link/merge controls.
  const dsSelectedPanels = panels.filter(p => selectedDatasets.has(p.id));
  const anyLinked = dsSelectedPanels.some(p => p.linkGroup !== null);
  const canLink = selectedDatasets.size >= 2;

  const selectedDatasetPanels = dsSelectedPanels.filter(p => p.contentType === 'dataset' && p.datasetId);
  const selectedMergedDatasetPanels = selectedDatasetPanels.filter(p => {
    const ds = datasets.find(d => d.id === p.datasetId);
    return ds?.paths && ds.paths.length > 1;
  });
  const canMerge = selectedDatasetPanels.length >= 2;

  const canUnmerge = selectedMergedDatasetPanels.length > 0;
  const unmergeCount = selectedMergedDatasetPanels.reduce((count, panel) => {
    const ds = datasets.find(d => d.id === panel.datasetId);
    return count + (ds?.paths?.length ?? 0);
  }, 0);

  const handleLink = () => {
    if (anyLinked) {
      for (const p of dsSelectedPanels) {
        unlinkPanel(p.id);
      }
      useBrowserStore.getState().pushSnapshot('Unlink datasets');
    } else if (canLink) {
      linkPanels(dsSelectedPanels.map(p => p.id));
      useBrowserStore.getState().pushSnapshot('Link datasets');
    }
    clearDatasetSelection();
  };

  const handleMerge = async () => {
    if (!canMerge) return;
    useBrowserStore.setState({ selectedPanelIds: new Set(selectedDatasetPanels.map(p => p.id)) });
    await mergeSelectedPanels();
    clearPanelSelection();
    clearDatasetSelection();
  };

  const handleUnmerge = async () => {
    for (const panel of selectedMergedDatasetPanels) {
      useBrowserStore.setState({ selectedPanelIds: new Set([panel.id]) });
      await unmergeSelectedPanel();
    }
    clearPanelSelection();
    clearDatasetSelection();
  };

  return (
    <div className="space-y-2">
      <DatasetToolbar
        selectedDatasetsCount={selectedDatasets.size}
        anyLinked={anyLinked}
        canLink={canLink}
        canMerge={canMerge}
        selectedDatasetPanelCount={selectedDatasetPanels.length}
        canUnmerge={canUnmerge}
        unmergeCount={unmergeCount}
        onOpenLayoutPanel={() => useBrowserStore.getState().openAnalysisPanel('dataset-layout')}
        onLinkToggle={handleLink}
        onMerge={handleMerge}
        onUnmerge={handleUnmerge}
      />

      <CollapsedPanelChips
        panels={collapsedPanels}
        datasets={datasets}
        onRestore={panelId => setPanelCollapsed(panelId, false)}
      />

      <LoadedDatasetsList datasets={datasets} />

      <ModificationOverlaysList
        overlays={modificationOverlays}
        open={showOverlays}
        onOpenChange={setShowOverlays}
        onRemove={handleRemoveOverlay}
      />
    </div>
  );
}
