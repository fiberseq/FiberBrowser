/**
 * The full-window Feature hub workspace is experimental: off by default (Settings › Read Display › Experimental:
 * Feature hub workspace). While it is off there is no Hub in the workspace toggle, no H key, no ⌘K hub entry, no
 * "Open in Hub" on the docked panel and no hub hand-off from Plots; the docked Feature hub panel works as it always has.
 *
 * Overrides for development: `?hub_workspace=1` (or `=0`) in the URL, or VITE_FB_HUB_WORKSPACE=1 at build time; the
 * URL wins over the stored choice, the stored choice over the build. Remembered on this origin, not in sessions.
 */
import { create } from 'zustand';

export const HUB_WORKSPACE_STORAGE_KEY = 'fiberbrowser_experimental_hub_workspace';

const parse = (v: unknown): boolean | null => {
  const t = String(v ?? '').trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'on' ? true : t === '0' || t === 'false' || t === 'off' ? false : null;
};

export function hubWorkspaceUrlOverride(search: string | null | undefined): boolean | null {
  if (!search) return null;
  try { return parse(new URLSearchParams(search).get('hub_workspace')); } catch { return null; }
}

function stored(): boolean | null {
  try { return parse(localStorage.getItem(HUB_WORKSPACE_STORAGE_KEY)); } catch { return null; }
}

function buildDefault(): boolean {
  try { return parse(import.meta.env.VITE_FB_HUB_WORKSPACE) ?? false; } catch { return false; }
}

/** The flag at start-up: URL override, then this origin's choice, then the build (off). */
export function initialHubWorkspaceFlag(search = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  return hubWorkspaceUrlOverride(search) ?? stored() ?? buildDefault();
}

interface FlagState { enabled: boolean }
export const useHubWorkspaceFlagStore = create<FlagState>(() => ({ enabled: initialHubWorkspaceFlag() }));

export const hubWorkspaceEnabled = (): boolean => useHubWorkspaceFlagStore.getState().enabled;
export const useHubWorkspaceEnabled = (): boolean => useHubWorkspaceFlagStore(s => s.enabled);

type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();
/** Called when the flag turns off (the workspace store leaves the hub). */
export function onHubWorkspaceFlag(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

export function setHubWorkspaceEnabled(on: boolean, remember = true): void {
  if (remember) { try { localStorage.setItem(HUB_WORKSPACE_STORAGE_KEY, String(on)); } catch { /* private mode */ } }
  if (useHubWorkspaceFlagStore.getState().enabled === on) return;
  useHubWorkspaceFlagStore.setState({ enabled: on });
  listeners.forEach(l => l(on));
}
