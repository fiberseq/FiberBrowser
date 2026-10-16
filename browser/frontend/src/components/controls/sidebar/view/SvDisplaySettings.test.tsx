import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../../stores/browserStore';
import { serializeState } from '../../../../stores/historySlice';
import { SESSION_PRE_VIEWPORT_KEYS, applyImportedState } from '../../../../api/session';
import { SvDisplaySettings } from './SvDisplaySettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let initial: ReturnType<typeof useBrowserStore.getState>;
beforeEach(() => {
  initial = useBrowserStore.getState();
  useBrowserStore.setState({ datasets: [{ id: 'ds', data_type: 'bam' }] as never });
});
afterEach(() => {
  act(() => useBrowserStore.setState(initial, true));
  document.body.innerHTML = '';
});

describe('SV display settings', () => {
  it('is on at 50 bp by default; the size field changes the store; the SV track is a panel row (no switch here)', () => {
    expect(useBrowserStore.getState().svDisplayEnabled).toBe(true);
    expect(useBrowserStore.getState().svMinLen).toBe(50);
    expect(useBrowserStore.getState().svMinSupport).toBe(3);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<SvDisplaySettings />));
    const size = host.querySelector('[data-testid="sv-min-size"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(size, '200'); size.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { size.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(useBrowserStore.getState().svMinLen).toBe(200);
    act(() => { setter.call(size, '3'); size.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { size.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(useBrowserStore.getState().svMinLen).toBe(10);
    const support = host.querySelector('[data-testid="sv-min-support"]') as HTMLInputElement;
    act(() => { setter.call(support, '1'); support.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { support.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(useBrowserStore.getState().svMinSupport).toBe(1);
    expect(host.querySelector('[data-testid="sv-track-toggle"]')).toBeNull();
    expect(host.querySelector('[data-testid="sv-track-hint"]')!.textContent).toContain('Tracks button');
    act(() => (host.querySelector('[data-testid="sv-display-toggle"]') as HTMLInputElement).click());
    expect(useBrowserStore.getState().svDisplayEnabled).toBe(false);
    expect(host.querySelector('[data-testid="sv-min-size"]')).toBeNull();
    act(() => root.unmount());
  });

  it('is hidden without a BAM', () => {
    act(() => useBrowserStore.setState({ datasets: [] }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<SvDisplaySettings />));
    expect(host.querySelector('[data-testid="sv-display-settings"]')).toBeNull();
    act(() => root.unmount());
  });

  it('is saved in sessions and snapshots; an older session gets the defaults', () => {
    expect(SESSION_PRE_VIEWPORT_KEYS).toEqual(expect.arrayContaining(['svDisplayEnabled', 'svMinLen', 'svMinSupport']));
    expect(SESSION_PRE_VIEWPORT_KEYS).not.toContain('svTrackCollapsed');
    act(() => useBrowserStore.setState({ svMinLen: 300, svMinSupport: 7, svDisplayEnabled: false }));
    expect(serializeState(useBrowserStore.getState())).toMatchObject({ svMinLen: 300, svMinSupport: 7, svDisplayEnabled: false });
    act(() => applyImportedState({ frontend: { hideTerminalGaps: true } }));
    expect(useBrowserStore.getState()).toMatchObject({ svMinLen: 50, svMinSupport: 3, svDisplayEnabled: true });
    expect('svTrackCollapsed' in useBrowserStore.getState()).toBe(false);
    act(() => applyImportedState({ frontend: { svMinLen: 120 } }));
    expect(useBrowserStore.getState().svMinLen).toBe(120);
    act(() => applyImportedState({ frontend: { svMinSupport: 1 } }));
    expect(useBrowserStore.getState().svMinSupport).toBe(1);
  });
});
