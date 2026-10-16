import { useBrowserStore } from '../stores/browserStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import { useUndoToastStore } from '../stores/undoToastStore';
import type { PeakRule } from '../types';

/** The same group label in the peak row, panels and removal message. */
export function matchedGroupLabel(rule: PeakRule, rules = useBrowserStore.getState().peakRules): string {
  return `F${rules.filter(r => r.source === 'matched').findIndex(r => r.id === rule.id) + 1} · ${rule.name}`;
}

let dismissOnHistoryChange: (() => void) | undefined;

/** Remove one group or all matched regions as a single undoable action. */
export function removeMatchedGroups(id?: string): void {
  const s = useBrowserStore.getState();
  const groups = s.peakRules.filter(r => r.source === 'matched' && (id === undefined || r.id === id));
  if (!groups.length) return;
  const text = id === undefined ? 'Removed all matched regions' : `Removed ${matchedGroupLabel(groups[0])}`;
  seedHistoryBaseline(s, 'Before removing matched regions', 'analysis');
  for (const group of groups) s.removeMatchedGroup(group.id);
  s.pushSnapshot(text, { kind: 'analysis', explicit: true });
  const snapshot = useBrowserStore.getState()._historyStack[useBrowserStore.getState()._historyPointer];
  dismissOnHistoryChange?.();
  useUndoToastStore.getState().show('browser', text, () => {
    const now = useBrowserStore.getState();
    if (now._historyStack[now._historyPointer] === snapshot) now.undo();
  });
  const toastId = useUndoToastStore.getState().toast!.id;
  dismissOnHistoryChange = useBrowserStore.subscribe(now => {
    if (now._historyStack[now._historyPointer] !== snapshot) {
      useUndoToastStore.getState().dismiss(toastId);
      dismissOnHistoryChange?.();
      dismissOnHistoryChange = undefined;
    }
  });
}
