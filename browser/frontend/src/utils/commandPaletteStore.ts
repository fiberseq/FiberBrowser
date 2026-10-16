import { create } from 'zustand';

/**
 * Whether the command palette (⌘K / Ctrl+K) is open, and the text it opens
 * with. Opened by the keyboard, the top bar's search button, the menu bar
 * (`command-palette`), the Keyboard shortcuts dialog and the settings search's
 * "try the command palette".
 */
interface CommandPaletteState {
  open: boolean;
  /** The query it opened with (bumps `openCount` so a reopen resets the field). */
  initialQuery: string;
  openCount: number;
}

export const useCommandPaletteStore = create<CommandPaletteState>(() => ({
  open: false,
  initialQuery: '',
  openCount: 0,
}));

export function openCommandPalette(query = ''): void {
  useCommandPaletteStore.setState(s => ({ open: true, initialQuery: query, openCount: s.openCount + 1 }));
}

export function closeCommandPalette(): void {
  useCommandPaletteStore.setState({ open: false });
}

export function toggleCommandPalette(): void {
  if (useCommandPaletteStore.getState().open) closeCommandPalette();
  else openCommandPalette();
}
