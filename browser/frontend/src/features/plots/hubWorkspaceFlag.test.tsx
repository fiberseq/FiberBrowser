/**
 * The full-window Feature hub is experimental and off by default: no Hub in the workspace toggle, no H, no ⌘K entry,
 * no "Open in Hub" on the docked panel, no Hub hand-off in Differential; 'hub' is never set. On, all of them work. URL
 * override; turning it off while the hub is open goes back to the browser.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_COMMAND_INFO } from '../../utils/appCommands';
import { buildPaletteItems } from '../../utils/commandPaletteItems';
import { KEYBOARD_SHORTCUTS } from '../../utils/shortcuts';
import { HUB_WORKSPACE_STORAGE_KEY, hubWorkspaceUrlOverride, initialHubWorkspaceFlag, setHubWorkspaceEnabled } from './hubWorkspaceFlag';
import { setWorkspace, toggleFeatureHub, useWorkspaceStore, workspaceKeyAction } from './workspace';
import { WorkspaceToggle } from './WorkspaceToggle';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.removeItem(HUB_WORKSPACE_STORAGE_KEY);
  setHubWorkspaceEnabled(false, false);
  useWorkspaceStore.setState({ view: 'browser' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const paletteIds = () => buildPaletteItems(() => {}).map(i => i.id);

describe('hub workspace flag', () => {
  it('is off by default: nothing stored, no URL override', () => {
    expect(initialHubWorkspaceFlag('')).toBe(false);
    expect(hubWorkspaceUrlOverride('?hub_workspace=1')).toBe(true);
    expect(hubWorkspaceUrlOverride('?hub_workspace=0')).toBe(false);
    expect(hubWorkspaceUrlOverride('?other=1')).toBeNull();
    localStorage.setItem(HUB_WORKSPACE_STORAGE_KEY, 'true');
    expect(initialHubWorkspaceFlag('')).toBe(true);
    expect(initialHubWorkspaceFlag('?hub_workspace=0')).toBe(false);
  });

  it('off: no Hub button, no H, no ⌘K entry, no shortcut row, and the hub view is never set', () => {
    act(() => root.render(<WorkspaceToggle />));
    expect(container.querySelector('[data-testid="workspace-hub"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-plots"]')).not.toBeNull();
    expect(workspaceKeyAction({ key: 'h' }, 'browser')).toBeNull();
    expect(toggleFeatureHub()).toBe(false);
    setWorkspace('hub');
    expect(useWorkspaceStore.getState().view).toBe('browser');
    expect(APP_COMMAND_INFO['toggle-feature-hub']?.available?.()).toBe(false);
    expect(paletteIds()).not.toContain('cmd:toggle-feature-hub');
    const h = KEYBOARD_SHORTCUTS.find(s => s.key === 'H')!;
    expect(h.available?.()).toBe(false);
  });

  it('on: the Hub button, H and the ⌘K entry work; turning it off leaves the hub for the browser', () => {
    setHubWorkspaceEnabled(true, false);
    act(() => root.render(<WorkspaceToggle />));
    expect(container.querySelector('[data-testid="workspace-hub"]')).not.toBeNull();
    expect(workspaceKeyAction({ key: 'h' }, 'browser')).toBe('toggle-hub');
    expect(paletteIds()).toContain('cmd:toggle-feature-hub');
    act(() => { (container.querySelector('[data-testid="workspace-hub"]') as HTMLButtonElement).click(); });
    expect(useWorkspaceStore.getState().view).toBe('hub');
    act(() => setHubWorkspaceEnabled(false, false));
    expect(useWorkspaceStore.getState().view).toBe('browser');
    expect(container.querySelector('[data-testid="workspace-hub"]')).toBeNull();
  });

  it('the setting is remembered on this origin', () => {
    setHubWorkspaceEnabled(true);
    expect(localStorage.getItem(HUB_WORKSPACE_STORAGE_KEY)).toBe('true');
    setHubWorkspaceEnabled(false);
    expect(localStorage.getItem(HUB_WORKSPACE_STORAGE_KEY)).toBe('false');
  });
});
