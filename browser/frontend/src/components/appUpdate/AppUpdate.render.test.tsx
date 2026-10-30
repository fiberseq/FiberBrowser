import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo, DownloadStatus, UpdateCheck } from '../../api/appUpdate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let check: UpdateCheck;
let info: AppInfo;
let download: DownloadStatus = { state: 'idle' };
const calls: string[] = [];
let saveError: Error | null = null;
let releaseSave: (() => void) | null = null;
let holdSave = false;

vi.mock('../../api/appUpdate', () => ({
  checkForUpdates: vi.fn(async (o: { startup?: boolean; force?: boolean }) => { calls.push(`check:${o.startup ? 'startup' : 'manual'}`); return check; }),
  getUpdateDownload: vi.fn(async () => download),
  startUpdateDownload: vi.fn(async () => { calls.push('download'); download = { state: 'done', name: 'FiberBrowser-3.0.1-arm64.dmg', path: '/tmp/Downloads/FiberBrowser-3.0.1-arm64.dmg' }; return { state: 'downloading', received: 0, total: 100 }; }),
  cancelUpdateDownload: vi.fn(async () => { calls.push('cancel'); download = { ...download, state: 'cancelled', error: 'Cancelled.' }; return download; }),
  openUpdateDownload: vi.fn(async () => { calls.push('open'); return { opened: 'x' }; }),
  startUpdateInstall: vi.fn(async () => { calls.push('install'); return { state: 'downloading', mode: 'install', name: 'update.zip' }; }),
  restartUpdateInstall: vi.fn(async () => { calls.push('restart'); return { ...download, state: 'restarting' }; }),
  quitForUpdate: vi.fn(async () => { calls.push('quit'); return { success: true }; }),
  getAppInfo: vi.fn(async () => info),
  setFiberhmmChoice: vi.fn(async (source: string, path: string) => { calls.push(`fiberhmm:${source}:${path}`); return { ...info, checked: { path, version: '3.0.0', missing: ['the extra engine'] } }; }),
  setUpdateSettings: vi.fn(async (values: Record<string, unknown>) => { calls.push(`settings:${JSON.stringify(values)}`); return { ...info, updates: { ...info.updates, ...values } }; }),
  saveGithubToken: vi.fn(async () => { calls.push('token'); return { auth: info.auth }; }),
  removeGithubToken: vi.fn(async () => ({ auth: info.auth })),
}));

vi.mock('../../hooks/useAutoSave', () => ({ autoSaveNow: vi.fn(async () => {
  calls.push('save');
  if (holdSave) await new Promise<void>(resolve => { releaseSave = resolve; });
  if (saveError) throw saveError;
}) }));
vi.mock('../../utils/launchSession', async orig => ({
  ...(await orig<typeof import('../../utils/launchSession')>()),
  markUpdateRestart: vi.fn(async (pending: boolean) => { calls.push(`reopen:${pending}`); }),
}));

import { AppUpdateHost, resetStartupCheckForTests, STARTUP_CHECK_DELAY_MS, updateSummary } from './AppUpdateHost';
import { useAppUpdateStore } from './appUpdateStore';
import { AppSettings } from '../controls/sidebar/analysis/AppSettings';
import { useBrowserStore } from '../../stores/browserStore';
import { runAppCommand } from '../../utils/appCommands';

const available: UpdateCheck = {
  status: 'update_available', current: '3.0.0', build: '20261001.1200', channel: 'lab', packaged: true,
  platform: 'macos-arm64', where: 'example-lab/FiberBrowser-private', private: true, message: null, latest: '3.0.1',
  latest_build: '20261005.1432', notes: 'Faster Find classes.', notes_url: 'https://example.org/notes',
  token_source: 'GitHub CLI', download: { name: 'FiberBrowser-3.0.1-arm64.dmg', kind: 'dmg', size: 190e6, sha256: 'a'.repeat(64) },
};

function appInfo(over: Partial<AppInfo> = {}): AppInfo {
  return {
    version: '3.0.0', packaged: true, build: { channel: 'lab', version: '3.0.0' }, platform: 'macos-arm64',
    fiberhmm: {
      packaged: true, requested: { source: 'app', path: '/src/Release' }, source: 'bundled', source_label: 'bundled with the app',
      root: null, package_dir: '/Applications/FiberBrowser.app/Contents/Resources/fiberhmm', version: '3.0.0',
      bundled: { path: '/Applications/FiberBrowser.app/Contents/Resources/fiberhmm', version: '3.0.0', kind: 'bundled' },
      requirements: ['FiberHMM 3.0 core'], missing: [],
      notices: ['Custom FiberHMM at /src/Release lacks the extra engine; using the bundled FiberHMM 3.0.0.'],
      app_choice: { source: 'custom', custom_path: '/src/Release', restart_needed: false },
      running: { available: true, version: '3.0.0', path: '/Applications/FiberBrowser.app/Contents/Resources/fiberhmm' },
    },
    updates: {
      check_at_startup: true, manifest_url: '', repo: '', channel: 'lab', source: 'github',
      where: 'example-lab/FiberBrowser-private or example-user/FiberBrowser', manifest_from: null, private: true, disabled: null,
      pip_command: 'pip install -U fiberbrowser',
    },
    auth: { gh: { installed: false, signed_in: false }, keychain: { name: 'macOS Keychain', available: true, reason: null, has_token: false }, device_flow: { configured: false } },
    ...over,
  };
}

let root: Root;
let host: HTMLDivElement;
const text = () => host.textContent ?? '';
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(label));

beforeEach(() => {
  calls.length = 0;
  saveError = null; releaseSave = null; holdSave = false;
  download = { state: 'idle' };
  check = available;
  info = appInfo();
  resetStartupCheckForTests();
  useAppUpdateStore.setState({ dialogOpen: false, check: null, checking: false, error: null, download: { state: 'idle' }, bannerDismissed: false, openError: null });
  useBrowserStore.setState({ publicMode: false });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('update check in the window', () => {
  it('runs the quiet check once at startup and shows a banner, then the dialog with notes and a verified download', async () => {
    vi.useFakeTimers();
    await act(async () => { root.render(<AppUpdateHost />); });
    expect(calls).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(STARTUP_CHECK_DELAY_MS + 10); });
    vi.useRealTimers();
    await flush();
    expect(calls).toEqual(['check:startup']);
    expect(host.querySelector('[data-testid="app-update-banner"]')?.textContent).toContain('FiberBrowser 3.0.1 is available (you have 3.0.0).');
    await click(button('View'));
    const dialog = host.querySelector('[data-testid="app-update-dialog"]');
    expect(dialog?.textContent).toContain('Faster Find classes.');
    expect(dialog?.querySelector('a[href="https://example.org/notes"]')).toBeTruthy();
    expect(text()).toContain('checked against its sha256 before it opens');
    expect(text()).toContain('signed in with GitHub CLI');
    await click(host.querySelector('[data-testid="app-update-download"]'));
    expect(calls).toContain('download');
    await act(async () => { useAppUpdateStore.setState({ download: { state: 'done', name: 'FiberBrowser-3.0.1-arm64.dmg', sha256: 'a'.repeat(64), path: '/tmp/Downloads/FiberBrowser-3.0.1-arm64.dmg' } }); });
    await flush();
    expect(text()).toContain('Downloaded and verified');
    await click(host.querySelector('[data-testid="app-update-open"]'));
    expect(calls).toContain('open');
  });


  it('offers install and download, shows progress, then saves before restart and quit', async () => {
    vi.useFakeTimers();
    check = { ...available, installable: true, install_download: { name: 'update.zip', kind: 'zip', size: 100, sha256: 'b'.repeat(64) } };
    await act(async () => { root.render(<AppUpdateHost />); useAppUpdateStore.setState({ check, dialogOpen: true }); });
    expect(host.querySelector('[data-testid="app-update-download"]')).toBeTruthy();
    await click(host.querySelector('[data-testid="app-update-install"]'));
    expect(text()).toContain('Downloading…');
    expect(calls).toEqual(['install']);
    download = { state: 'verifying', mode: 'install', name: 'update.zip' };
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(text()).toContain('Verifying checksum and signature');
    holdSave = true;
    download = { state: 'ready', mode: 'install', name: 'update.zip' };
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(text()).toContain('Ready. Saving session');
    expect(calls).toEqual(['install', 'save']);
    await act(async () => { releaseSave?.(); });
    await flush();
    expect(calls).toEqual(['install', 'save', 'reopen:true', 'restart', 'quit']);
    expect(text()).toContain('Restarting FiberBrowser');
  });

  it('cancels while session saving and never restarts', async () => {
    vi.useFakeTimers();
    check = { ...available, installable: true, install_download: { name: 'update.zip', kind: 'zip', size: 100, sha256: 'b'.repeat(64) } };
    await act(async () => { root.render(<AppUpdateHost />); useAppUpdateStore.setState({ check, dialogOpen: true }); });
    await click(host.querySelector('[data-testid="app-update-install"]'));
    holdSave = true;
    download = { state: 'ready', mode: 'install', name: 'update.zip' };
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await click(button('Cancel'));
    await act(async () => { releaseSave?.(); });
    await flush();
    expect(calls).toContain('cancel');
    expect(calls).not.toContain('restart');
    expect(text()).toContain('Cancelled.');
  });

  it('blocks restart on a failed save, explains the error, and allows retry', async () => {
    vi.useFakeTimers();
    check = { ...available, installable: true, install_download: { name: 'update.zip', kind: 'zip', size: 100, sha256: 'b'.repeat(64) } };
    await act(async () => { root.render(<AppUpdateHost />); useAppUpdateStore.setState({ check, dialogOpen: true }); });
    saveError = new Error('Session storage is full');
    await click(host.querySelector('[data-testid="app-update-install"]'));
    download = { state: 'ready', mode: 'install', name: 'update.zip' };
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(text()).toContain('Session storage is full');
    expect(calls).not.toContain('restart');
    saveError = null;
    await click(button('Retry restart'));
    expect(calls.slice(-4)).toEqual(['save', 'reopen:true', 'restart', 'quit']);
  });


  it('resumes progress after reopening the update dialog', async () => {
    vi.useFakeTimers();
    check = { ...available, installable: true, install_download: { name: 'update.zip', kind: 'zip', size: 100, sha256: 'b'.repeat(64) } };
    download = { state: 'verifying', mode: 'install', name: 'update.zip' };
    await act(async () => { root.render(<AppUpdateHost />); useAppUpdateStore.getState().openDialog(false); });
    await flush();
    expect(text()).toContain('Verifying checksum and signature');
    download = { ...download, state: 'ready' };
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(calls.slice(-4)).toEqual(['save', 'reopen:true', 'restart', 'quit']);
  });

  it('shows verification failure while keeping the DMG fallback available', async () => {
    await act(async () => {
      root.render(<AppUpdateHost />);
      useAppUpdateStore.setState({ check: { ...available, installable: true }, dialogOpen: true,
        download: { state: 'done', mode: 'download', fallback: true, name: available.download!.name,
          error: 'Install failed: spctl assessment failed. The disk image has been opened.' } });
    });
    expect(text()).toContain('spctl assessment failed');
    expect(host.querySelector('[data-testid="app-update-open"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="app-update-install"]')).toBeNull();
  });

  it('keeps source and pip runs on the pip command without install or download', async () => {
    await act(async () => {
      root.render(<AppUpdateHost />);
      useAppUpdateStore.setState({ check: { ...available, packaged: false, download: null, pip_command: 'pip install -U fiberbrowser' }, dialogOpen: true });
    });
    expect(text()).toContain('pip install -U fiberbrowser');
    expect(host.querySelector('[data-testid="app-update-install"]')).toBeNull();
    expect(host.querySelector('[data-testid="app-update-download"]')).toBeNull();
  });

  it('does not offer to open an earlier release downloaded before a newer check', async () => {
    await act(async () => { root.render(<AppUpdateHost />); });
    await act(async () => {
      useAppUpdateStore.setState({ dialogOpen: true, check: { ...available, latest: '3.0.2', download: { ...available.download!, name: 'FiberBrowser-3.0.2-arm64.dmg', sha256: 'b'.repeat(64) } },
        download: { state: 'done', name: 'FiberBrowser-3.0.1-arm64.dmg', sha256: 'a'.repeat(64), path: '/x/FiberBrowser-3.0.1-arm64.dmg' } });
    });
    expect(host.querySelector('[data-testid="app-update-open"]')).toBeNull();
    expect(host.querySelector('[data-testid="app-update-download"]')?.textContent).toContain('Download 3.0.2');
  });

  it('says to sign in when a private channel has no GitHub access, never silently', async () => {
    check = { ...available, status: 'auth_required', latest: undefined, download: null,
      message: 'Sign in to check for lab updates: sign in with the GitHub CLI (gh auth login) or add a read-only GitHub token in Settings > Updates.' };
    await act(async () => { root.render(<AppUpdateHost />); });
    await act(async () => { await useAppUpdateStore.getState().runCheck({ startup: true }); });
    expect(host.querySelector('[data-testid="app-update-banner"]')?.textContent).toContain('Sign in to check for lab updates');
  });

  it('shows nothing when the check is turned off, and the menu command opens the dialog', async () => {
    check = { ...available, status: 'disabled', message: 'The check at startup is turned off.', download: null, latest: undefined };
    await act(async () => { root.render(<AppUpdateHost />); });
    await act(async () => { await useAppUpdateStore.getState().runCheck({ startup: true }); });
    expect(host.querySelector('[data-testid="app-update-banner"]')).toBeNull();
    check = { ...available, status: 'up_to_date', download: null };
    await act(async () => { expect(runAppCommand('check-updates')).toBe(true); });
    await flush();
    expect(calls).toContain('check:manual');
    expect(host.querySelector('[data-testid="app-update-summary"]')?.textContent).toBe('FiberBrowser 3.0.0 is up to date (lab channel).');
  });

  it('is not offered on a public server', () => {
    useBrowserStore.setState({ publicMode: true });
    expect(runAppCommand('check-updates')).toBe(false);
  });

  it('sums up a lab rebuild of the same version by its build', () => {
    expect(updateSummary({ ...available, latest: '3.0.0' })).toBe('FiberBrowser 3.0.0 (build 20261005.1432) is available (you have 3.0.0).');
  });
});

describe('FiberHMM & Updates settings', () => {
  const openSection = async () => {
    localStorage.setItem('fiberhmm_sidebar_analysis.app_collapsed', '0');
    await act(async () => { root.render(<AppSettings />); });
    await flush();
  };

  it('shows which FiberHMM is in use, the fallback notice and the bundled/custom choice', async () => {
    await openSection();
    expect(host.querySelector('[data-testid="app-fiberhmm-in-use"]')?.textContent).toContain('In use: FiberHMM 3.0.0 · bundled with the app');
    expect(text()).toContain('Custom FiberHMM at /src/Release lacks the extra engine; using the bundled FiberHMM 3.0.0.');
    const select = host.querySelector('[data-testid="app-fiberhmm-choice"]') as HTMLSelectElement;
    expect(select.value).toBe('custom');
    expect((host.querySelector('[data-testid="app-fiberhmm-path"]') as HTMLInputElement).value).toBe('/src/Release');
    await click(button('Use'));
    expect(calls).toContain('fiberhmm:custom:/src/Release');
    expect(text()).toContain("That FiberHMM lacks the extra engine; the app will keep using its bundled FiberHMM.");
  });

  it('asks to sign in for a private channel, keeps the token out of the page and has the privacy note', async () => {
    await openSection();
    expect(text()).toContain('Sign in to check for lab updates: run gh auth login, or paste a read-only GitHub token below.');
    expect((host.querySelector('input[type="password"]') as HTMLInputElement)).toBeTruthy();
    expect(text()).toContain('Privacy: a check is a plain request for the update manifest');
    const toggle = host.querySelector('[data-setting-id="app.update-check-startup"] input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await click(toggle);
    expect(calls).toContain('settings:{"check_at_startup":false}');
  });

  it('a source run explains its own rules instead of the app choice', async () => {
    info = appInfo({ packaged: false, auth: null });
    info.fiberhmm = { ...info.fiberhmm, packaged: false, source: 'settings', notices: [], app_choice: null };
    info.updates = { ...info.updates, private: false };
    await openSection();
    expect(host.querySelector('[data-testid="app-fiberhmm-choice"]')).toBeNull();
    expect(text()).toContain('from browser_settings.json');
    expect(text()).toContain('pip install -U fiberhmm');
  });
});
