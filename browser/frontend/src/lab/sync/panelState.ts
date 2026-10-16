import { useCallback } from 'react';
import { create } from 'zustand';
/** Transient panel state (search, results, selection). Kept outside the component so
 * expanding to full view or re-docking, which remounts the panel, keeps the map. Not saved in sessions. */
export const useSyncPanelState = create<Record<string, unknown>>(() => ({}));
type Update<T> = T | ((previous: T) => T);
/** `useState` backed by the panel store under `key`. */
export function usePanelField<T>(key: string, initial: T): [T, (value: Update<T>) => void] {
  const value = useSyncPanelState(s => (key in s ? s[key] : initial)) as T;
  const set = useCallback((next: Update<T>) => useSyncPanelState.setState(s => {
    const previous = (key in s ? s[key] : initial) as T;
    return { [key]: typeof next === 'function' ? (next as (p: T) => T)(previous) : next };
  }), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, set];
}
