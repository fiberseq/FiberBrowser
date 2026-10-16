/**
 * Delete and restore a track in a panel (fb-n11-tracks), the same from the row's
 * ×, its right-click menu and "Tracks in this panel". A built-in row is marked
 * removed in the panel (restore puts it back in its place); a composite or a
 * loaded (ortho) track is unloaded, as the Library / Tracks panel does, unless
 * it cannot be (then it is hidden in the panel).
 */
import { useBrowserStore } from '../../stores/browserStore';
import { useConsensusViewStore } from '../../stores/consensusViewStore';
import type { SubTrackType } from '../../types';
import { unloadCompositeTrack, unloadOrthogonalTrackByIndex } from '../../utils/trackLoader';
import { isDeletableTrack } from './trackRegistry';

export function canDeleteTrack(type: SubTrackType): boolean {
  if (type.startsWith('composite-')) {
    const composite = useBrowserStore.getState().compositeTracks.find(c => c.id === type.slice('composite-'.length));
    return Boolean(composite);
  }
  return type.startsWith('ortho-') || isDeletableTrack(type);
}

export function deleteTrack(panelId: string, type: SubTrackType): void {
  const store = useBrowserStore.getState();
  if (type.startsWith('composite-')) {
    const composite = store.compositeTracks.find(c => c.id === type.slice('composite-'.length));
    if (composite && composite.removable !== false) void unloadCompositeTrack(composite);
    else if (composite) store.removeSubTrack(panelId, type);
    return;
  }
  if (type.startsWith('ortho-')) {
    const index = parseInt(type.slice('ortho-'.length), 10);
    if (Number.isFinite(index) && index >= 0) void unloadOrthogonalTrackByIndex(index);
    return;
  }
  store.removeSubTrack(panelId, type);
}

/** Put a track back in the panel; a row hidden by a global switch turns that switch on too. */
export function restoreTrack(panelId: string, type: SubTrackType): void {
  const store = useBrowserStore.getState();
  // The switch first: the restore's history step then holds both (Undo / Redo keep them together).
  if (type === 'coverage' && !store.showCoverageHistogram) store.setShowCoverageHistogram(true);
  if (type === 'sv' && !store.svDisplayEnabled) store.setSvDisplayEnabled(true);
  if (type === 'consensus' && !useConsensusViewStore.getState().showTrack) useConsensusViewStore.getState().configure({ showTrack: true });
  useBrowserStore.getState().restoreSubTrack(panelId, type);
}
