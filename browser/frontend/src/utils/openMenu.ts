/**
 * The top bar's Open ▾ menu (components/controls/OpenMenu): every way to get
 * data in, in two groups, each item an app command (utils/appCommands) so it
 * has the same label, availability and shortcut as in the command palette and
 * the desktop app's File menu (fiberbrowser/app_menu.py).
 */
import { APP_COMMAND_INFO, type AppCommandName } from './appCommands';
import { KEYBOARD_SHORTCUTS, shortcutForCommand, type KeyboardShortcut } from './shortcuts';

/** Open data · then make or check data. */
export const OPEN_MENU_GROUPS: readonly (readonly AppCommandName[])[] = [
  ['open-file', 'library', 'load-by-path', 'connect-cluster'],
  ['new-daf-run', 'dataset-qc'],
];

export interface OpenMenuEntry {
  command: AppCommandName;
  label: string;
  /** Its keys (e.g. ⌘+O in the desktop app); none where the page has none. */
  shortcut?: string;
  enabled: boolean;
  /** Why it is grayed out: not offered here, or not now. */
  reason: string | null;
}

/**
 * The menu as it stands now. A command not available on this page is left
 * out, or grayed out with its reason when it has one (a lab server without
 * runs); one that can't run yet is grayed with why.
 * Empty groups are dropped.
 */
export function openMenuEntries(shortcuts: readonly KeyboardShortcut[] = KEYBOARD_SHORTCUTS): OpenMenuEntry[][] {
  return OPEN_MENU_GROUPS.map(group => group.flatMap((command): OpenMenuEntry[] => {
    const info = APP_COMMAND_INFO[command];
    if (!info) return [];
    const shortcut = shortcutForCommand(command, shortcuts);
    if (info.available && !info.available()) {
      const reason = info.unavailableReason?.() ?? null;
      return reason ? [{ command, label: info.label, shortcut, enabled: false, reason }] : [];
    }
    const reason = info.disabledReason?.() ?? null;
    return [{ command, label: info.label, shortcut, enabled: reason === null, reason }];
  })).filter(group => group.length > 0);
}
