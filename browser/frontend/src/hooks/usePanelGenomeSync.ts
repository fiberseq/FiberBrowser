import { useEffect } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { usePanelGenomeStore } from '../stores/panelGenomeStore';
import { needsPerPanelLocus, panelsForPerPanelMode } from '../utils/panelNavigation';

/**
 * Keeps panels in step with their datasets' references and the navigation mode:
 *
 * - whenever the datasets change (opened, closed, a session restored) the
 *   references besides the main genome are re-read, and each panel follows
 *   its dataset's (PanelConfig.genome);
 * - in "Each panel navigates", a dataset panel opened since gets its own
 *   locus too (starting at the main view).
 */
export function usePanelGenomeSync(): void {
  const datasetKey = useBrowserStore(s => s.datasets.map(d => d.id).join('\n'));
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);
  useEffect(() => {
    if (!datasetKey && Object.keys(usePanelGenomeStore.getState().assignments).length === 0) return;
    void usePanelGenomeStore.getState().refresh();
  }, [datasetKey, refreshGeneration]);

  // A panel opened since (a copy, a comparison, a dataset reopened) follows its dataset's reference too.
  // Only with the server's current assignments (a restored session's panels arrive before them).
  const assignments = usePanelGenomeStore(s => s.assignments);
  const ready = usePanelGenomeStore(s => s.ready);
  const outOfStep = useBrowserStore(s => ready && s.panels.some(p => p.contentType === 'dataset' && !!p.datasetId
    && (p.genome ?? null) !== (assignments[p.datasetId] ?? null)));
  useEffect(() => {
    // A refresh started in this same commit (datasets changed) makes these stale.
    if (outOfStep && usePanelGenomeStore.getState().ready) usePanelGenomeStore.getState().applyAssignments();
  }, [outOfStep]);

  const perPanel = useBrowserStore(s => s.navigationMode === 'perPanel');
  const pending = useBrowserStore(s => s.navigationMode === 'perPanel' && needsPerPanelLocus(s.panels));
  useEffect(() => {
    if (!perPanel || !pending) return;
    const st = useBrowserStore.getState();
    const panels = panelsForPerPanelMode(st.panels, { chrom: st.chrom, start: st.start, end: st.end });
    // Part of whatever opened the panel: no undo point of its own.
    if (panels !== st.panels) useBrowserStore.setState({ panels });
  }, [perPanel, pending]);
}
