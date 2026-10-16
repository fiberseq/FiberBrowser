/**
 * The tour opens the toolbar's More menu for a group that went there, and puts
 * everything back as it was when it ends. (Groups open in the row stay open:
 * opening More no longer folds them, as the dropdowns of 1 Oct did.)
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ToolbarGroup, ToolbarRow } from '../components/controls/ToolbarGroups';
import { rememberToolbarGroup, restoreToolbarGroups, setToolbarGroupOpen, toolbarGroupInMore } from './guidedTour';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

describe('the tour and the real toolbar row', () => {
  it('opening More for a group leaves an open group open; the end of the tour closes More again', async () => {
    // jsdom has no layout: every group measures 100 px, the row 120 px.
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    const client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 120 });
    const box = document.createElement('div');
    document.body.appendChild(box);
    localStorage.clear();
    const root = createRoot(box);
    // No room for both: Quality (may leave) goes to More; Reads never leaves.
    act(() => root.render(
      <ToolbarRow groups={[{ id: 'reads', overflowRank: Infinity }, { id: 'quality', overflowRank: 0 }]}>
        <ToolbarGroup id="reads" label="Reads"><span>reads controls</span></ToolbarGroup>
        <ToolbarGroup id="quality" label="Quality"><span>quality controls</span></ToolbarGroup>
      </ToolbarRow>,
    ));
    await flush();
    expect(toolbarGroupInMore('quality')).toBe(true);
    const readsToggle = () => document.querySelector('[data-tour="reads-controls-expand"]') as HTMLElement;
    act(() => readsToggle().click());
    expect(readsToggle().getAttribute('aria-expanded')).toBe('true');

    const session = { toolbarGroups: new Map<string, boolean>() } as never;
    rememberToolbarGroup(session, 'quality');
    await act(() => setToolbarGroupOpen('quality', true));
    expect(document.querySelector('[data-testid="toolbar-groups-more-menu"] [data-testid="toolbar-group-quality"]')).not.toBeNull();
    expect(readsToggle().getAttribute('aria-expanded')).toBe('true');

    act(() => restoreToolbarGroups(session));
    await flush();
    expect(document.querySelector('[data-testid="toolbar-groups-more-menu"]')).toBeNull();
    expect(readsToggle().getAttribute('aria-expanded')).toBe('true');
    act(() => root.unmount());
    box.remove();
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset);
    Object.defineProperty(Element.prototype, 'clientWidth', client);
  });
});

// Codex review (fb-r2-layout): a group the tour opened that went to More before the tour
// ended (the window narrowed) kept the tour's "open" for good.
describe('the tour puts back a group that went to More meanwhile', () => {
  it('restores its remembered state without its toggle', async () => {
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    const client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    let rowWidth = 1000;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => rowWidth });
    localStorage.clear();
    const box = document.createElement('div');
    document.body.appendChild(box);
    const root = createRoot(box);
    const tree = (key: number) => (
      <ToolbarRow key={key} groups={[{ id: 'quality', overflowRank: Infinity }, { id: 'reads', overflowRank: 0 }]}>
        <ToolbarGroup id="quality" label="Quality"><span>quality controls</span></ToolbarGroup>
        <ToolbarGroup id="reads" label="Reads"><span>reads controls</span></ToolbarGroup>
      </ToolbarRow>
    );
    act(() => root.render(tree(1)));
    await flush();
    const session = { toolbarGroups: new Map<string, boolean>() } as never;
    rememberToolbarGroup(session, 'reads');
    await act(() => setToolbarGroupOpen('reads', true));
    expect(localStorage.getItem('fiberbrowser_toolbar_group_v2_reads')).toBe('open');

    // The window narrows: Reads goes to More, so it has no toggle when the tour ends.
    rowWidth = 120;
    act(() => root.render(tree(2)));
    await flush();
    expect(toolbarGroupInMore('reads')).toBe(true);
    act(() => restoreToolbarGroups(session));
    expect(localStorage.getItem('fiberbrowser_toolbar_group_v2_reads')).toBe('closed');

    // Widened again: folded, as before the tour.
    rowWidth = 1000;
    act(() => root.render(tree(3)));
    await flush();
    expect(document.querySelector('[data-tour="reads-controls-expand"]')!.getAttribute('aria-expanded')).toBe('false');
    act(() => root.unmount());
    box.remove();
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset);
    Object.defineProperty(Element.prototype, 'clientWidth', client);
  });
});
