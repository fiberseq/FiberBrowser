import { useBrowserStore } from '../../stores/browserStore';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { useUndoToastStore } from '../../stores/undoToastStore';
import { restoreSync } from './syncState';
import type { ComparisonFrame } from './model';

/** Validate the whole batch before saving, then make acceptance one Undo step. */
export function acceptBlocks(frames: ComparisonFrame[]): void {
  if (!frames.length) return;
  if (restoreSync({ comparisonFrames: frames }).comparisonFrames.length !== frames.length)
    throw new Error('These blocks cannot share one ordered region. Accept them as separate groups.');
  const before = useBrowserStore.getState();
  seedHistoryBaseline(before, 'Before accepting matched groups', 'analysis');
  frames.forEach(frame => useBrowserStore.getState().saveComparisonFrame(frame));
  const text = `Accepted ${frames.length} matched group${frames.length === 1 ? '' : 's'}`;
  useBrowserStore.getState().pushSnapshot(text, { kind: 'analysis', explicit: true });
  const current = useBrowserStore.getState();
  const snapshot = current._historyStack[current._historyPointer];
  useUndoToastStore.getState().show('browser', text, () => {
    const s = useBrowserStore.getState();
    if (s._historyStack[s._historyPointer] === snapshot) s.undo();
  });
}
