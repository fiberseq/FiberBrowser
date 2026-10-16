import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SessionRestoreButton } from './SessionRestoreButton';
import { SessionRestoreHost } from './SessionRestoreHost';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionRestoreButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      datasets: [{ id: 'already-loaded' }],
      publicMode: false,
    } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('remains available after data has been loaded', () => {
    act(() => root.render(<><SessionRestoreButton setError={vi.fn()} /><SessionRestoreHost /></>));

    expect(container.querySelector('[data-testid="restore-session-button"]')?.textContent)
      .toBe('Restore Session');
    expect(container.querySelector('[data-testid="restore-session-file-input"]')).not.toBeNull();
  });
});
