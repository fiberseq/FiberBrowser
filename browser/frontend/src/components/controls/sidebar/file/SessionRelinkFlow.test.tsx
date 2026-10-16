import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  checkSessionFiles: vi.fn(),
  importSession: vi.fn(),
}));
vi.mock('../../../../api/session', () => api);

import { useBrowserStore } from '../../../../stores/browserStore';
import { SessionRestoreButton } from './SessionRestoreButton';
import { SessionRestoreHost } from './SessionRestoreHost';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const session = { version: '2.0', datasets: [{ id: 'a', paths: ['/old/a.bam'] }] };
const missingFile = { kind: 'dataset', label: 'a', path: '/old/a.bam', resolved_path: '/old/a.bam', status: 'missing', relinked: false };

async function chooseSessionFile(container: HTMLElement) {
  const input = container.querySelector('[data-testid="restore-session-file-input"]') as HTMLInputElement;
  // jsdom's File lacks text(); the component only needs that method.
  const file = { name: 'session.json', text: async () => JSON.stringify(session) };
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}

describe('session restore relinking', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    api.checkSessionFiles.mockReset();
    api.importSession.mockReset().mockResolvedValue({ results: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ publicMode: false } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('restores directly when every file is found', async () => {
    api.checkSessionFiles.mockResolvedValue({ files: [], mapping: {}, missing: 0, changed: 0 });
    act(() => root.render(<><SessionRestoreButton setError={vi.fn()} /><SessionRestoreHost /></>));
    await chooseSessionFile(container);

    expect(api.importSession).toHaveBeenCalledWith(session, undefined);
    expect(document.querySelector('[data-testid="session-relink-dialog"]')).toBeNull();
  });

  it('asks to relink missing files before clearing anything, then restores with the mapping', async () => {
    api.checkSessionFiles.mockResolvedValue({ files: [missingFile], mapping: {}, missing: 1, changed: 0 });
    act(() => root.render(<><SessionRestoreButton setError={vi.fn()} /><SessionRestoreHost /></>));
    await chooseSessionFile(container);

    const dialog = document.querySelector('[data-testid="session-relink-dialog"]');
    expect(dialog).not.toBeNull();
    expect(api.importSession).not.toHaveBeenCalled();

    api.checkSessionFiles.mockResolvedValue({
      files: [{ ...missingFile, resolved_path: '/new/a.bam', status: 'ok', relinked: true }],
      mapping: { '/old/a.bam': '/new/a.bam' },
      missing: 0,
      changed: 0,
    });
    const pathInput = dialog!.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(pathInput, '/new/a.bam');
      pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(api.checkSessionFiles).toHaveBeenLastCalledWith(session, {
      mapping: {},
      anchor: { old: '/old/a.bam', new: '/new/a.bam' },
    });

    const restoreButton = document.querySelector('[data-testid="session-relink-restore"]') as HTMLButtonElement;
    expect(restoreButton.textContent).toBe('Restore');
    await act(async () => { restoreButton.click(); });
    expect(api.importSession).toHaveBeenCalledWith(session, { '/old/a.bam': '/new/a.bam' });
  });
});
