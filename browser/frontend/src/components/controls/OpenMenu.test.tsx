/**
 * The top bar's Open ▾ (owner, 2 Oct: "is there any way to get to the process
 * dataset menu outside of the welcome? and the library? those are both pretty
 * hidden"): every way in, with the palette's labels, availability and keys.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadFile = vi.fn();
const fileState = { loading: false };
vi.mock('../../hooks/useDatasetActions', () => ({
  useDatasetActions: () => ({ handleLoadFile: loadFile, loading: fileState.loading }),
}));

import { useBrowserStore } from '../../stores/browserStore';
import '../../plugins/builtinPanels';
import { NavBar } from './NavBar';
import { openMenuEntries, OPEN_MENU_GROUPS } from '../../utils/openMenu';
import { APP_COMMAND_INFO } from '../../utils/appCommands';
import { buildPaletteItems } from '../../utils/commandPaletteItems';
import { OPEN_LIBRARY_EVENT } from './library/libraryStore';
import { OPEN_DAF_RUN_EVENT } from './daf-run/dafRunStore';
import { resetSandboxForTests } from '../../utils/sandbox';
import type { KeyboardShortcut } from '../../utils/shortcuts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BAM = { id: 'd1', label: 'sample', path: '/data/sample.bam', data_type: 'bam' } as never;

let box: HTMLDivElement;
let root: Root;
const initial = useBrowserStore.getState();
const width = window.innerWidth;

async function mount() {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => root.render(<NavBar loading={false} scanning={false} clustering={false} />));
}
const q = (testId: string) => box.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const items = () => [...box.querySelectorAll<HTMLElement>('[data-testid="open-menu"] [role="menuitem"]')];
async function openMenu() { await act(async () => q('open-menu-button')!.click()); }
function setLab(info: object | null) {
  if (info) (window as any).__FIBERBROWSER_LAB__ = info;
  else delete (window as any).__FIBERBROWSER_LAB__;
}

beforeEach(() => {
  useBrowserStore.setState({ publicMode: false, datasets: [] });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

afterEach(() => {
  if (root) act(() => root.unmount());
  box?.remove();
  useBrowserStore.setState(initial, true);
  setLab(null);
  resetSandboxForTests(null);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  loadFile.mockClear();
  fileState.loading = false;
});

describe('Open ▾ in the top bar', () => {
  it('the main part still opens the file dialog; ▾ lists every way in, in two groups', async () => {
    await mount();
    const main = q('load-file-button')!;
    expect(main.textContent).toBe('Open');
    await act(async () => main.click());
    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(q('open-menu')).toBeNull();

    const button = q('open-menu-button')!;
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await openMenu();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(items().map(i => i.dataset.testid)).toEqual([
      'open-menu-open-file', 'open-menu-library', 'open-menu-load-by-path', 'open-menu-connect-cluster',
      'open-menu-new-daf-run', 'open-menu-dataset-qc',
    ]);
    expect(items().map(i => i.querySelector('span > span')!.textContent)).toEqual([
      'Open file…', 'Open from Library', 'Load by path / URL…', 'Connect to cluster…',
      'Process raw data (New DAF-seq run)…', 'Data quality (QC a dataset)…',
    ]);
    // One separator, between opening data and making or checking it.
    expect(box.querySelectorAll('[data-testid="open-menu"] [role="separator"]')).toHaveLength(1);
    const sep = box.querySelector('[data-testid="open-menu"] [role="separator"]')!;
    expect(sep.compareDocumentPosition(q('open-menu-new-daf-run')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sep.compareDocumentPosition(q('open-menu-connect-cluster')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('each item runs its command: Library, raw data, quality, path or URL, the file dialog', async () => {
    useBrowserStore.setState({ datasets: [BAM] });
    await mount();
    const library = vi.fn();
    const daf = vi.fn();
    window.addEventListener(OPEN_LIBRARY_EVENT, library);
    window.addEventListener(OPEN_DAF_RUN_EVENT, daf);
    try {
      await openMenu();
      await act(async () => q('open-menu-library')!.click());
      expect(library).toHaveBeenCalledTimes(1);
      expect(q('open-menu')).toBeNull();

      await openMenu();
      await act(async () => q('open-menu-new-daf-run')!.click());
      expect((daf.mock.calls[0][0] as CustomEvent).detail.tab).toBe('new');

      await openMenu();
      await act(async () => q('open-menu-dataset-qc')!.click());
      expect((daf.mock.calls[1][0] as CustomEvent).detail.tab).toBe('qc');

      await openMenu();
      await act(async () => q('open-menu-load-by-path')!.click());
      expect(useBrowserStore.getState().sidebarOpen).toBe(true);

      await openMenu();
      await act(async () => q('open-menu-open-file')!.click());
      expect(loadFile).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_LIBRARY_EVENT, library);
      window.removeEventListener(OPEN_DAF_RUN_EVENT, daf);
    }
  });

  it('Data quality is enabled with no BAM loaded (it QCs one from the Library or a file)', async () => {
    await mount();
    await openMenu();
    const qc = q('open-menu-dataset-qc')!;
    expect(qc.getAttribute('aria-disabled')).toBeNull();
    expect(q('open-menu-reason-dataset-qc')).toBeNull();
    const daf = vi.fn();
    window.addEventListener(OPEN_DAF_RUN_EVENT, daf);
    await act(async () => qc.click());
    window.removeEventListener(OPEN_DAF_RUN_EVENT, daf);
    expect(daf).toHaveBeenCalledTimes(1);
  });

  it('keyboard: ArrowDown opens at the first item, arrows move, Escape closes back on ▾', async () => {
    await mount();
    const button = q('open-menu-button')!;
    button.focus();
    await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(q('open-menu')).not.toBeNull();
    expect(document.activeElement).toBe(q('open-menu-open-file'));
    const key = async (k: string) => act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
    await key('ArrowDown');
    expect(document.activeElement).toBe(q('open-menu-library'));
    await key('ArrowUp');
    await key('ArrowUp');
    // Wraps to the last item (grayed items stay reachable, so their reason is read out).
    expect(document.activeElement).toBe(q('open-menu-dataset-qc'));
    await key('Home');
    expect(document.activeElement).toBe(q('open-menu-open-file'));
    await key('Escape');
    expect(q('open-menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('keys pressed in the open menu stay there (no panning, zooming or undo behind it); Tab closes on ▾', async () => {
    await mount();
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      await openMenu();
      for (const k of ['ArrowLeft', 'ArrowRight', '+', '-', 'z', 'r']) {
        await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: k === 'z', bubbles: true })); });
      }
      expect(behind).not.toHaveBeenCalled();
      expect(q('open-menu')).not.toBeNull();
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); });
      expect(q('open-menu')).toBeNull();
      expect(document.activeElement).toBe(q('open-menu-button'));
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('while the file dialog is open or files load, Open file… waits too (no second picker)', async () => {
    fileState.loading = true;
    await mount();
    expect((q('load-file-button') as HTMLButtonElement).disabled).toBe(true);
    await openMenu();
    const item = q('open-menu-open-file')!;
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(q('open-menu-reason-open-file')!.textContent).toBe('Opening files…');
    await act(async () => item.click());
    expect(loadFile).not.toHaveBeenCalled();
  });

  it('a click outside closes it', async () => {
    await mount();
    await openMenu();
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(q('open-menu')).toBeNull();
  });

  it('compact top bar (1024 px): the main part is icon only, the ▾ stays', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    await mount();
    expect(q('top-nav')!.dataset.chromeCompact).toBe('true');
    const main = q('load-file-button')!;
    expect(main.textContent).toBe('');
    expect(main.getAttribute('aria-label')).toBe('Open file');
    expect(q('open-menu-button')).not.toBeNull();
    await openMenu();
    expect(items()).toHaveLength(6);
  });

  it('not on a public server (nothing there opens host files)', async () => {
    useBrowserStore.setState({ publicMode: true });
    await mount();
    expect(q('load-file-button')).toBeNull();
    expect(q('open-menu-button')).toBeNull();
    expect(openMenuEntries()).toEqual([]);
  });
});

describe('Open ▾ availability (the commands\' own rules)', () => {
  beforeEach(() => useBrowserStore.setState({ publicMode: false, datasets: [BAM] }));

  it('a lab server without runs grays runs and QC with why; no cluster connection there', () => {
    setLab({ user: 'ana', role: 'member', auth: 'accounts', anonymous: false, jobs: false });
    const flat = openMenuEntries().flat();
    const byCommand = Object.fromEntries(flat.map(e => [e.command, e]));
    expect(byCommand['new-daf-run']).toMatchObject({ enabled: false, reason: 'This lab server does not start runs' });
    expect(byCommand['dataset-qc']).toMatchObject({ enabled: false, reason: 'This lab server does not run QC' });
    expect(byCommand['connect-cluster']).toMatchObject({ enabled: false });
    expect(byCommand['connect-cluster'].reason).toMatch(/^Not on a lab server/);
    expect(byCommand.library.enabled).toBe(true);
    expect(byCommand['open-file'].enabled).toBe(true);
  });

  it('a lab server with runs, signed out: sign in first', () => {
    setLab({ user: null, role: null, auth: 'accounts', anonymous: true, jobs: true });
    const flat = openMenuEntries().flat();
    expect(flat.find(e => e.command === 'new-daf-run')).toMatchObject({ enabled: false, reason: 'Sign in to start runs' });
  });

  it('a tour (sandbox) tab leaves out the Library, runs and QC', () => {
    resetSandboxForTests('sb-abcdefghijklmnopqrst');
    const commands = openMenuEntries().flat().map(e => e.command);
    expect(commands).not.toContain('library');
    expect(commands).not.toContain('new-daf-run');
    expect(commands).not.toContain('dataset-qc');
  });

  it('shows each item\'s keys: ⌘O for Open file where the app has it, none in a web tab', () => {
    const inApp: KeyboardShortcut[] = [{ key: '⌘+O', description: 'Open file', category: 'App', commands: { 'open-file': '⌘+O' } }];
    const withKeys = openMenuEntries(inApp).flat();
    expect(withKeys.find(e => e.command === 'open-file')!.shortcut).toBe('⌘+O');
    expect(withKeys.filter(e => e.shortcut).map(e => e.command)).toEqual(['open-file']);
    // A web tab: ⌘O is the browser's own (Open File… keys come from the desktop app's menu).
    expect(openMenuEntries().flat().find(e => e.command === 'open-file')!.shortcut).toBeUndefined();
  });

  it('the command palette (⌘K) has the same labels', () => {
    const palette = new Map(buildPaletteItems().filter(i => i.kind === 'action').map(i => [i.id, i.title]));
    for (const command of OPEN_MENU_GROUPS.flat()) {
      if (command === 'open-file') continue; // registered by the mounted top bar
      expect(palette.get(`cmd:${command}`), command).toBe(APP_COMMAND_INFO[command]!.label);
    }
  });
});
