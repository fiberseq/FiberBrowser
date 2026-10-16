import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPanelLauncher, buildDefaultPanelLauncher, PANEL_LAUNCHER_STORAGE_KEY } from './panelLauncherStore';

describe('where the analysis panel launchers start', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to the sidebar rail (the shipped default)', () => {
    expect(buildDefaultPanelLauncher()).toBe('rail');
    expect(initialPanelLauncher('')).toBe('rail');
  });

  it('uses the viewer\'s saved choice', () => {
    localStorage.setItem(PANEL_LAUNCHER_STORAGE_KEY, 'strip');
    expect(initialPanelLauncher('')).toBe('strip');
    localStorage.setItem(PANEL_LAUNCHER_STORAGE_KEY, 'nonsense');
    expect(initialPanelLauncher('')).toBe('rail');
  });

  it('?panels=rail in the address wins and is saved', () => {
    localStorage.setItem(PANEL_LAUNCHER_STORAGE_KEY, 'strip');
    expect(initialPanelLauncher('?panels=rail')).toBe('rail');
    expect(localStorage.getItem(PANEL_LAUNCHER_STORAGE_KEY)).toBe('rail');
    expect(initialPanelLauncher('?panels=STRIP')).toBe('strip');
    expect(initialPanelLauncher('?panels=sideways')).toBe('strip');
    localStorage.clear();
    expect(initialPanelLauncher('?panels=sideways')).toBe('rail');
  });

  it('a build with VITE_DEFAULT_PANEL_LAUNCHER=strip starts in the classic strip unless the viewer chose', () => {
    vi.stubEnv('VITE_DEFAULT_PANEL_LAUNCHER', 'strip');
    expect(buildDefaultPanelLauncher()).toBe('strip');
    expect(initialPanelLauncher('')).toBe('strip');
    localStorage.setItem(PANEL_LAUNCHER_STORAGE_KEY, 'rail');
    expect(initialPanelLauncher('')).toBe('rail');
  });
});
