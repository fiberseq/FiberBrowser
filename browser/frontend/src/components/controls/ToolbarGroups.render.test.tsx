import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolbarGroup, ToolbarRow, rememberedGroupOpen } from './ToolbarGroups';
import { rememberToolbarGroup, restoreToolbarGroups, setToolbarGroupOpen } from '../../utils/guidedTour';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const GROUPS = [
  { id: 'reads', overflowRank: 3 },
  { id: 'cluster', overflowRank: 5 },
  { id: 'sort', overflowRank: 2 },
  { id: 'quality', overflowRank: 0 },
];

/**
 * Audit H5: at UI size 150% the open groups filled the window and left no reads.
 * A fake layout: the toolbar ends 100 px down plus 100 px per group drawn open,
 * in a 700 px window, so the reads (half the window: 350 px) have room for at most
 * two open groups.
 */
describe('toolbar groups keep the reads their height', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('innerHeight', 700);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid !== 'operations-toolbar') return new DOMRect(0, 0, 0, 0);
      const open = this.querySelectorAll('[data-toolbar-controls]').length;
      return new DOMRect(0, 0, 1000, 100 + 100 * open);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = () => act(() => root.render(
    <div data-testid="operations-toolbar">
      <ToolbarRow groups={GROUPS}>
        {GROUPS.map(g => (
          <ToolbarGroup key={g.id} id={g.id} label={g.id} summary={<span>{g.id} values</span>}>
            <span>{g.id} controls</span>
          </ToolbarGroup>
        ))}
      </ToolbarRow>
    </div>,
  ));
  const group = (id: string) => container.querySelector<HTMLElement>(`[data-testid="toolbar-group-${id}"]`)!;
  const toggle = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="toolbar-group-toggle-${id}"]`)!;
  const shownOpen = () => GROUPS.map(g => g.id).filter(id => group(id).dataset.open === 'true');

  it('all four remembered open: the least used show folded, still open (not remembered as folded)', () => {
    for (const g of GROUPS) localStorage.setItem(`fiberbrowser_toolbar_group_v2_${g.id}`, 'open');
    render();
    expect(shownOpen()).toEqual(['reads', 'cluster']);
    expect(group('quality').dataset.foldedForRoom).toBe('true');
    expect(group('sort').dataset.foldedForRoom).toBe('true');
    expect(toggle('sort').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('sort').title).toContain('room');
    // Still open as far as the user's choice goes.
    expect(rememberedGroupOpen('sort', false)).toBe(true);
    expect(rememberedGroupOpen('quality', false)).toBe(true);
  });

  it('showing a group folded for room shows it, and folds another instead', () => {
    for (const g of GROUPS) localStorage.setItem(`fiberbrowser_toolbar_group_v2_${g.id}`, 'open');
    render();
    act(() => toggle('quality').click());
    expect(shownOpen()).toContain('quality');
    expect(shownOpen()).toHaveLength(2);
    expect(rememberedGroupOpen('quality', false)).toBe(true);
  });

  it('a group the user opens stays open; folding one gives a room-folded group back', () => {
    render();
    act(() => toggle('reads').click());
    act(() => toggle('cluster').click());
    expect(shownOpen()).toEqual(['reads', 'cluster']);
    act(() => toggle('sort').click());
    // Sort was just opened: it shows; Reads (less used than Cluster) folds for room.
    expect(shownOpen()).toEqual(['cluster', 'sort']);
    expect(group('reads').dataset.foldedForRoom).toBe('true');
    act(() => toggle('cluster').click());
    expect(rememberedGroupOpen('cluster', true)).toBe(false);
    expect(shownOpen()).toEqual(['reads', 'sort']);
  });

  it('a tall window: every open group shows open', () => {
    vi.stubGlobal('innerHeight', 2000);
    for (const g of GROUPS) localStorage.setItem(`fiberbrowser_toolbar_group_v2_${g.id}`, 'open');
    render();
    expect(shownOpen()).toEqual(['reads', 'cluster', 'sort', 'quality']);
    expect(container.querySelector('[data-folded-for-room]')).toBeNull();
  });

  // Codex review: the tour noted a group folded for room as folded, and its clean-up then
  // folded it for good (remembered closed), though the user had it open.
  it('the tour puts a group folded for room back open, not folded', async () => {
    for (const g of GROUPS) localStorage.setItem(`fiberbrowser_toolbar_group_v2_${g.id}`, 'open');
    render();
    expect(group('sort').dataset.foldedForRoom).toBe('true');
    const session = { toolbarGroups: new Map<string, boolean>() } as never;
    rememberToolbarGroup(session, 'sort');
    await act(() => setToolbarGroupOpen('sort', true));
    expect(group('sort').dataset.open).toBe('true');
    act(() => restoreToolbarGroups(session));
    expect(rememberedGroupOpen('sort', false)).toBe(true);
    expect(toggle('sort').dataset.groupOpen).toBe('true');
  });
});
