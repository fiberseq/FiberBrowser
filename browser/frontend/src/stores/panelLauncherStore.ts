/**
 * Where the analysis panel launchers live: the sidebar rail at the window's
 * right edge, under the settings icons (the default since FiberBrowser 1.0),
 * or the classic analysis strip above the reads (Settings › Reads & Display ›
 * Analysis panels: Strip (classic)).
 *
 * A per-viewer UI preference like dark mode (localStorage), never part of a
 * session. Its starting value, first match wins:
 *   1. `?panels=rail` / `?panels=strip` in the page address (also saved, so a
 *      test build or a link sticks after the address loses it);
 *   2. the viewer's saved choice;
 *   3. the build's default, e.g. `VITE_DEFAULT_PANEL_LAUNCHER=strip npm run build`
 *      (an app with the classic strip by default);
 *   4. 'rail'.
 */
import { create } from 'zustand';

export type PanelLauncherMode = 'strip' | 'rail';

export const PANEL_LAUNCHER_STORAGE_KEY = 'fiberbrowser_panel_launcher';
/** The rail's one-time coach mark ("Analysis panels: hover for names") was seen. */
export const PANEL_RAIL_COACH_KEY = 'fiberbrowser_panel_rail_coach_seen';

const isMode = (value: unknown): value is PanelLauncherMode => value === 'strip' || value === 'rail';

/** The build's default (VITE_DEFAULT_PANEL_LAUNCHER), else 'rail'. */
export function buildDefaultPanelLauncher(): PanelLauncherMode {
  const fromBuild = String(import.meta.env.VITE_DEFAULT_PANEL_LAUNCHER ?? '').trim().toLowerCase();
  return isMode(fromBuild) ? fromBuild : 'rail';
}

/** The starting mode: the address, the saved choice, the build default (see the file comment). */
export function initialPanelLauncher(search: string = typeof location !== 'undefined' ? location.search : ''): PanelLauncherMode {
  let fromUrl: string | null = null;
  try { fromUrl = new URLSearchParams(search).get('panels'); } catch { /* no address */ }
  fromUrl = fromUrl?.trim().toLowerCase() ?? null;
  if (isMode(fromUrl)) {
    try { localStorage.setItem(PANEL_LAUNCHER_STORAGE_KEY, fromUrl); } catch { /* per-viewer preference */ }
    return fromUrl;
  }
  try {
    const saved = localStorage.getItem(PANEL_LAUNCHER_STORAGE_KEY);
    if (isMode(saved)) return saved;
  } catch { /* storage blocked: the build default */ }
  return buildDefaultPanelLauncher();
}

function coachSeen(): boolean {
  try { return localStorage.getItem(PANEL_RAIL_COACH_KEY) === '1'; } catch { return true; }
}

interface PanelLauncherState {
  mode: PanelLauncherMode;
  setMode: (mode: PanelLauncherMode) => void;
  /** The rail's coach mark was dismissed (or a launcher used): never shown again for this viewer. */
  coachSeen: boolean;
  dismissCoach: () => void;
}

export const usePanelLauncherStore = create<PanelLauncherState>((set) => ({
  mode: initialPanelLauncher(),
  setMode: (mode) => {
    if (!isMode(mode)) return;
    try { localStorage.setItem(PANEL_LAUNCHER_STORAGE_KEY, mode); } catch { /* per-viewer preference */ }
    set(state => (state.mode === mode ? state : { mode }));
  },
  coachSeen: coachSeen(),
  dismissCoach: () => {
    try { localStorage.setItem(PANEL_RAIL_COACH_KEY, '1'); } catch { /* per-viewer preference */ }
    set(state => (state.coachSeen ? state : { coachSeen: true }));
  },
}));

/** True while the launchers are in the sidebar rail (non-React callers: the tour, the palette). */
export function panelLauncherIsRail(): boolean {
  return usePanelLauncherStore.getState().mode === 'rail';
}
