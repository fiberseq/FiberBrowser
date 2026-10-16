import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../../stores/browserStore';
import { serializeState } from '../../../../stores/historySlice';
import { SESSION_PRE_VIEWPORT_KEYS, applyImportedState } from '../../../../api/session';
import { GapReadFilters } from './GapReadFilters';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => useBrowserStore.setState({ hideShortEndFootprints: true }));
  document.body.innerHTML = '';
});

describe('Hide footprints cut off at read ends (< 90 bp)', () => {
  it('is on by default and switches off from the read filters', () => {
    expect(useBrowserStore.getState().hideShortEndFootprints).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<GapReadFilters />));
    const box = host.querySelector('[data-testid="hide-short-end-footprints"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(true);
    expect(box.closest('label')!.textContent).toContain('Hide footprints cut off at read ends (< 90 bp)');
    act(() => box.click());
    expect(useBrowserStore.getState().hideShortEndFootprints).toBe(false);
    act(() => root.unmount());
  });

  it('is saved in sessions and in history snapshots', () => {
    expect(SESSION_PRE_VIEWPORT_KEYS).toContain('hideShortEndFootprints');
    act(() => useBrowserStore.setState({ hideShortEndFootprints: false }));
    expect(serializeState(useBrowserStore.getState()).hideShortEndFootprints).toBe(false);
  });

  it('a session saved before the setting existed restores its default, not the open one', () => {
    act(() => useBrowserStore.setState({ hideShortEndFootprints: false }));
    act(() => applyImportedState({ frontend: { hideTerminalGaps: true } }));
    expect(useBrowserStore.getState().hideShortEndFootprints).toBe(true);
    act(() => applyImportedState({ frontend: { hideShortEndFootprints: false } }));
    expect(useBrowserStore.getState().hideShortEndFootprints).toBe(false);
  });
});
