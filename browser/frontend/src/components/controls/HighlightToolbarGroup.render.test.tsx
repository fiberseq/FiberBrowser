import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { HighlightToolbarGroup } from './HighlightToolbarGroup';
import { ToolbarRow } from './ToolbarGroups';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Highlight toolbar group', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    useBrowserStore.setState({ highlights: [], highlightDrawMode: false, _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0, chrom: 'chr2L', start: 0, end: 1000, currentGenome: 'dm6' } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);

  it('the action turns ruler highlighting on and off; the list renames, and Undo shows the old name at once', async () => {
    await act(async () => root.render(<ToolbarRow groups={[{ id: 'highlight', overflowRank: 1 }]}><HighlightToolbarGroup /></ToolbarRow>));
    await act(async () => q<HTMLButtonElement>('[data-testid="highlight-run-button"]')!.click());
    expect(useBrowserStore.getState().highlightDrawMode).toBe(true);
    expect(q('[data-testid="highlight-run-button"]')!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => q<HTMLButtonElement>('[data-testid="highlight-run-button"]')!.click());
    expect(useBrowserStore.getState().highlightDrawMode).toBe(false);

    await act(async () => { useBrowserStore.getState().addHighlight({ genome: 'dm6', chrom: 'chr2L', start: 100, end: 300, label: 'Before' }); });
    // Open the group (its controls) and the list.
    const toggle = q<HTMLButtonElement>('[data-testid="toolbar-group-toggle-highlight"]')!;
    if (toggle.getAttribute('aria-expanded') !== 'true') await act(async () => toggle.click());
    await act(async () => q<HTMLButtonElement>('[data-testid="highlight-list-button"]')!.click());
    const input = q<HTMLInputElement>('[data-testid="highlight-label-input"]')!;
    expect(input.value).toBe('Before');
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'After');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
    expect(useBrowserStore.getState().highlights[0].label).toBe('After');
    await act(async () => { useBrowserStore.getState().undo(); });
    expect(useBrowserStore.getState().highlights[0].label).toBe('Before');
    expect(q<HTMLInputElement>('[data-testid="highlight-label-input"]')!.value).toBe('Before');
    // Leaving the field without typing writes nothing back.
    await act(async () => { const i = q<HTMLInputElement>('[data-testid="highlight-label-input"]')!; i.focus(); i.blur(); });
    expect(useBrowserStore.getState().highlights[0].label).toBe('Before');
  });

  // Owner, 1 Oct: Clear was only in the List popover; the group itself carries it, like Peaks and Filter.
  it('Clear on the group clears every highlight in one undo step, and says why it is off with none', async () => {
    await act(async () => root.render(<ToolbarRow groups={[{ id: 'highlight', overflowRank: 1 }]}><HighlightToolbarGroup /></ToolbarRow>));
    const toggle = q<HTMLButtonElement>('[data-testid="toolbar-group-toggle-highlight"]')!;
    if (toggle.getAttribute('aria-expanded') !== 'true') await act(async () => toggle.click());
    const clear = () => q<HTMLButtonElement>('[data-testid="highlight-clear-button"]')!;
    expect(clear()).not.toBeNull();
    expect(clear().disabled).toBe(true);
    expect(clear().title).toMatch(/no highlights/i);
    // A group control: within the toolbar's 24 px row (AnalysisButton size sm, as Filter's Clear).
    expect(clear().className).toContain('py-1');
    expect(clear().className).toContain('text-xs');

    await act(async () => {
      useBrowserStore.getState().addHighlight({ genome: 'dm6', chrom: 'chr2L', start: 100, end: 300 });
      useBrowserStore.getState().addHighlight({ genome: 'dm6', chrom: 'chr2L', start: 500, end: 700 });
    });
    expect(clear().disabled).toBe(false);
    expect(clear().title).toMatch(/clear all 2 highlights/i);
    await act(async () => clear().click());
    expect(useBrowserStore.getState().highlights).toEqual([]);
    expect(clear().disabled).toBe(true);
    await act(async () => { useBrowserStore.getState().undo(); });
    expect(useBrowserStore.getState().highlights).toHaveLength(2);
  });
});
