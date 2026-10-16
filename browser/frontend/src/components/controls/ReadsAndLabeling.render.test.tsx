import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import '../../plugins/builtinPanels';
import { ColormapEditorInline } from './ColormapEditor';
import { ReadDisplayToolbarControls } from './ReadDisplayToolbarControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Reads toolbar and Labeling display options', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 500,
      datasets: [{ id: 'ds1', available_layers: { nuc: true, tf: true, fire: true, deam: true } }],
      readDisplayMode: 'sample', downsampleCount: null, readRowHeight: 1, readSeparatorMode: 'auto',
    } as any);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // M12: every control in the Reads group says what it does.
  it('Reads group controls carry plain labels and tooltips', async () => {
    await act(async () => {
      root.render(<div><ReadDisplayToolbarControls mode="compact" /><ReadDisplayToolbarControls mode="advanced" /></div>);
    });
    const text = container.textContent ?? '';
    expect(text).toContain('row 1px');
    expect(text).toContain('max reads');
    expect(text).toContain('row lines');
    expect(text).toContain('when rows ≥');
    expect(text).toContain('Reset');
    // Row height steps are icons from the set, not "-" and "+" characters.
    const stepper = container.querySelector('[data-testid="read-display-row-height-compact"]')!;
    for (const button of stepper.querySelectorAll('button')) {
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.getAttribute('aria-label')).toMatch(/read row height/);
    }
    // Each input or select sits in a labelled control with a tooltip.
    for (const field of container.querySelectorAll('input, select')) {
      expect(field.closest('[title]'), field.outerHTML).not.toBeNull();
    }
  });

  // L13: the layer names in Display options aren't cut at a fixed 72 px.
  it('Display options size the layer-name column to the longest name', async () => {
    await act(async () => { root.render(<ColormapEditorInline />); });
    const grid = container.querySelector('[data-testid="unmatched-layer-opacity"]')!;
    expect(grid).not.toBeNull();
    expect(grid.className).not.toContain('4.5rem');
    expect(grid.className).toContain('max-content');
    // One grid for all rows, so every name shares the column width.
    const names = grid.querySelectorAll('[data-testid="unmatched-layer-name"]');
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) expect(name.parentElement!.className).toBe('contents');
  });

  // M9/L10 pattern in Labeling: delete controls are icons from the set, not "×".
  it('Labeling rules use icon delete buttons and the same Add rule wording', async () => {
    await act(async () => { root.render(<ColormapEditorInline />); });
    expect(container.textContent).not.toContain('×');
    expect(container.textContent).not.toContain('+ Rule');
    const add = container.querySelector('[data-copilot-anchor="colormap-add-rule"]')!;
    expect(add.textContent).toBe('Add rule');
    const removes = container.querySelectorAll('button[aria-label="Remove rule"]');
    expect(removes.length).toBeGreaterThan(0);
    for (const button of removes) expect(button.querySelector('svg')).not.toBeNull();
  });
});
