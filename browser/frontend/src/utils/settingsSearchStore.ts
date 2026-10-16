import { create } from 'zustand';

/** The settings sidebar's search field (its text filters the sidebar live). */
export const useSettingsSearchStore = create<{ query: string }>(() => ({ query: '' }));

export function setSettingsSearchQuery(query: string): void {
  useSettingsSearchStore.setState({ query });
}
