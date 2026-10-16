import type { AppCommandName } from './appCommands';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const MOD = isMac ? '\u2318' : 'Ctrl';

/** The one-line reminder of what clicks on reads do (first-click hint, shortcuts, tour). */
export const READ_ACTIONS_HINT = `Right-click a read for actions \u00b7 \u21e7-click selects a read \u00b7 ${isMac ? '\u2318' : 'Ctrl'}-click a footprint`;
/** Running inside the desktop app window (pywebview exposes window.pywebview). */
const IN_APP = typeof window !== 'undefined' && 'pywebview' in window;
/** Export data… (the toolbar's file button, File > Export Data…): in the app and the web browser. */
export const EXPORT_DATA_SHORTCUT = `${MOD}+Shift+E`;
/** The toolbar Save button's name: Save session, with its shortcut where it has one (the app menu's File > Save Session). */
export const SAVE_SESSION_LABEL = IN_APP ? `Save session (${isMac ? '\u2318S' : 'Ctrl+S'})` : 'Save session';
const APP_MENU_SHORTCUTS: KeyboardShortcut[] = [
  { key: `${MOD}+O`, description: 'Open file', category: 'App', commands: { 'open-file': `${MOD}+O` } },
  { key: `${MOD}+S`, description: 'Save session', category: 'App', commands: { 'save-session': `${MOD}+S` } },
  { key: `${MOD}+E`, description: 'Export figure', category: 'App', commands: { 'export-figure': `${MOD}+E` } },
  { key: `${MOD}+L`, description: 'Go to locus', category: 'App', commands: { 'go-to-locus': `${MOD}+L` } },
  { key: `${MOD}+= / ${MOD}+\u2212`, description: 'Zoom in / out', category: 'App', commands: { 'zoom-in': `${MOD}+=`, 'zoom-out': `${MOD}+\u2212` } },
  { key: `${MOD}+[ / ${MOD}+]`, description: 'Back / forward', category: 'App', commands: { back: `${MOD}+[`, forward: `${MOD}+]` } },
  { key: `${MOD}+Shift+C`, description: 'Copy locus', category: 'App', commands: { 'copy-locus': `${MOD}+Shift+C` } },
  { key: `${MOD}+Shift+N`, description: 'New independent workspace', category: 'App' },
  { key: `${MOD}+,`, description: 'Settings', category: 'App', commands: { settings: `${MOD}+,` } },
  { key: `${MOD}+/`, description: 'Keyboard shortcuts', category: 'App', commands: { 'keyboard-shortcuts': `${MOD}+/` } },
  { key: `${MOD}+Q`, description: 'Quit', category: 'App' },
];

export interface KeyboardShortcut {
  key: string;
  description: string;
  category: 'Navigation' | 'Analysis' | 'View' | 'History' | 'App';
  /** The app commands (utils/appCommands) these keys run, each with its own keys: the command palette shows them. */
  commands?: Partial<Record<AppCommandName, string>>;
}

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  // Navigation
  { key: '\u2190 / \u2192', description: 'Pan left / right', category: 'Navigation' },
  { key: '\u2191 / \u2193 or +/-', description: 'Zoom in / out', category: 'Navigation', commands: { 'zoom-in': '\u2191 or +', 'zoom-out': '\u2193 or \u2212' } },
  { key: 'Alt+\u2190 / Alt+\u2192', description: 'Go back / forward in navigation history', category: 'Navigation', commands: { back: 'Alt+\u2190', forward: 'Alt+\u2192' } },
  { key: 'R', description: 'Reset view: clear clustering, filters and selections', category: 'Navigation', commands: { 'reset-view': 'R' } },
  { key: 'N / P', description: 'Next / previous saved region of the current category (Regions panel)', category: 'Navigation', commands: { 'next-region': 'N', 'previous-region': 'P' } },
  { key: 'Shift+drag ruler', description: 'Highlight a region (the toolbar\u2019s Highlight turns plain drags into highlights too)', category: 'Navigation' },
  { key: `${MOD}+B`, description: 'Show / hide the settings sidebar', category: 'Navigation', commands: { 'toggle-sidebar': `${MOD}+B` } },
  { key: 'Read name in the locus box', description: 'Paste a read name (or several, comma separated) and press Enter: go to the read and highlight it', category: 'Navigation' },

  // Analysis
  { key: isMac ? 'Right-click (or Ctrl+click) read' : 'Right-click read', description: 'Actions for that read and the footprint under the cursor: select, copy its name or locus, zoom to it, keep only or exclude the selection', category: 'Analysis' },
  { key: 'Shift+click read', description: 'Select a read and open Read Stats', category: 'Analysis' },
  { key: `${MOD}+click read`, description: 'Select a footprint and open Footprints', category: 'Analysis' },
  { key: '1\u20139', description: 'Focus cluster by number', category: 'Analysis' },
  { key: '0', description: 'Clear cluster focus', category: 'Analysis' },
  { key: 'Escape', description: 'Close the open menu or dialog; otherwise clear the cluster focus, then the peak selection (a clustering or filter stays: Reset clears those)', category: 'Analysis' },
  { key: 'S', description: 'Scan for accessibility peaks', category: 'Analysis', commands: { 'scan-peaks': 'S' } },

  // View
  { key: `${MOD}+scroll reads`, description: 'Zoom read row height', category: 'View' },
  { key: '[ / ]', description: 'Decrease / increase read row height', category: 'View' },
  { key: 'G', description: 'Toggle genome overview', category: 'View', commands: { 'toggle-genome-map': 'G' } },
  { key: '?', description: 'Show keyboard shortcuts', category: 'View', commands: { 'keyboard-shortcuts': '?' } },
  { key: `${MOD}+K`, description: 'Search commands and settings', category: 'View', commands: { 'command-palette': `${MOD}+K` } },

  // History
  { key: `${MOD}+Z`, description: 'Undo', category: 'History', commands: { undo: `${MOD}+Z` } },
  { key: `${MOD}+Shift+Z`, description: 'Redo', category: 'History', commands: { redo: `${MOD}+Shift+Z` } },

  { key: EXPORT_DATA_SHORTCUT, description: 'Export data: every table, BED, BAM subset and session file', category: 'App', commands: { 'export-data': EXPORT_DATA_SHORTCUT } },
  // App menu (FiberBrowser.app only: fiberbrowser/app_menu.py)
  ...(IN_APP ? APP_MENU_SHORTCUTS : []),
];

export const SHORTCUT_CATEGORIES = ['Navigation', 'Analysis', 'View', 'History', 'App'] as const;

/** The keys of an app command, as the Keyboard shortcuts dialog lists them (the first listed). */
export function shortcutForCommand(command: AppCommandName, shortcuts: readonly KeyboardShortcut[] = KEYBOARD_SHORTCUTS): string | undefined {
  for (const shortcut of shortcuts) {
    const key = shortcut.commands?.[command];
    if (key) return key;
  }
  return undefined;
}
