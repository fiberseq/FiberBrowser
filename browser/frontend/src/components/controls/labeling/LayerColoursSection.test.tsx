import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { registerLayerColours } from '../../../features/layerColours/state';
import { setLayerColorSource } from '../../../utils/layerColors';
import { LayerColoursSection, layerColourRows } from './LayerColoursSection';
import { LayerToggles } from '../shared/LayerToggles';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
registerLayerColours();

const DS = [{ id: 'd', label: 'D', path: '/tmp/d.bam', data_type: 'bam', available_layers: { nuc: true, tf: true, msp: true, tf2: true } }];

/** Set a controlled colour input's value and fire React's change event. */
function pick(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Labels → Layer colours', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ datasets: DS, layerColorOverrides: {}, userLayerColors: {}, enabledModTypes: { nuc: true, tf: true } } as never);
    setLayerColorSource(DS);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('lists the loaded layers (canonical keys) and colours set for layers not loaded', () => {
    const rows = layerColourRows(DS, ['mod', 'gone']);
    expect(rows.map(r => r.key)).toEqual(['nuc', 'fire', 'tf', 'tf2', 'm6a', 'gone']);
    expect(rows.filter(r => r.absent).map(r => r.key)).toEqual(['m6a', 'gone']);
  });

  it('picker, per-row Reset, Reset all, Save as my default colours, and the precedence line', () => {
    act(() => root.render(<LayerColoursSection />));
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(q('layer-colours-precedence')!.textContent).toContain("This session's colours win over your saved defaults");
    act(() => pick(q('layer-colour-input-nuc') as HTMLInputElement, '#ff00ff'));
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ nuc: '#ff00ff' });
    expect(q('layer-colour-source-nuc')!.textContent).toBe('this session');
    act(() => (q('layer-colour-save-default') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().userLayerColors).toEqual({ nuc: '#ff00ff' });
    act(() => (q('layer-colour-reset-nuc') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({});
    expect(q('layer-colour-source-nuc')!.textContent).toBe('your default');
    act(() => pick(q('layer-colour-input-tf') as HTMLInputElement, '#123456'));
    act(() => (q('layer-colour-reset-all') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({});
    act(() => (q('layer-colour-clear-default') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().userLayerColors).toEqual({});
  });

  it('warns (without blocking) when a chosen colour nearly matches another loaded layer', () => {
    act(() => root.render(<LayerColoursSection />));
    expect(container.querySelector('[data-testid="layer-colours-similar"]')).toBeNull();
    act(() => useBrowserStore.setState({ layerColorOverrides: { tf: '#17a44b' } } as never));    // ≈ the nuc green
    const warning = container.querySelector('[data-testid="layer-colours-similar"]');
    expect(warning?.textContent).toMatch(/look nearly the same/);
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ tf: '#17a44b' });
  });

  it('a layer toggle\'s right-click opens "Change colour…" with the same picker', () => {
    act(() => root.render(<LayerToggles compact />));
    const label = container.querySelector('[data-copilot-anchor="layer-toggle-nuc"]')!;
    act(() => { label.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
    const input = container.querySelector<HTMLInputElement>('[data-testid="layer-colour-menu-input"]')!;
    expect(input).toBeTruthy();
    act(() => pick(input, '#00aaff'));
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ nuc: '#00aaff' });
    const swatch = label.querySelector<HTMLElement>('span[aria-hidden="true"]')!;
    expect(swatch.style.backgroundColor).toBe('rgb(0, 170, 255)');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="layer-colour-menu-reset"]')!.click());
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({});
  });
});
