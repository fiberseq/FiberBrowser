/**
 * Owner (1 Oct): "the drawer ... just needs to be able to pop out as a panel and be
 * resized". Its left edge is a resize handle: drag it, or focus it and use the keys.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAWER_RESIZE_STEP, DrawerResizeHandle, drawerWidthForKey } from './DrawerResizeHandle';
import { useDrawerTabsStore } from '../../stores/drawerTabsStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('drawerWidthForKey', () => {
  it('Left widens and Right narrows the drawer (its handle is on the left edge); Shift moves further', () => {
    expect(drawerWidthForKey('ArrowLeft', false, 480, 320, 900)).toBe(480 + DRAWER_RESIZE_STEP);
    expect(drawerWidthForKey('ArrowRight', false, 480, 320, 900)).toBe(480 - DRAWER_RESIZE_STEP);
    expect(drawerWidthForKey('ArrowLeft', true, 480, 320, 900)).toBe(480 + 4 * DRAWER_RESIZE_STEP);
  });
  it('stays within its range; Home and End go to the ends', () => {
    expect(drawerWidthForKey('ArrowRight', true, 330, 320, 900)).toBe(320);
    expect(drawerWidthForKey('ArrowLeft', true, 890, 320, 900)).toBe(900);
    expect(drawerWidthForKey('Home', false, 480, 320, 900)).toBe(320);
    expect(drawerWidthForKey('End', false, 480, 320, 900)).toBe(900);
    expect(drawerWidthForKey('a', false, 480, 320, 900)).toBeNull();
  });
});

describe('DrawerResizeHandle', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const handle = () => container.querySelector<HTMLElement>('[data-testid="analysis-overlay-resize"]')!;

  it('is a focusable vertical separator with its range', () => {
    act(() => root.render(<DrawerResizeHandle width={480} min={320} max={900} onResize={() => {}} onReset={() => {}} />));
    expect(handle().getAttribute('role')).toBe('separator');
    expect(handle().getAttribute('aria-orientation')).toBe('vertical');
    expect(handle().tabIndex).toBe(0);
    expect([handle().getAttribute('aria-valuenow'), handle().getAttribute('aria-valuemin'), handle().getAttribute('aria-valuemax')]).toEqual(['480', '320', '900']);
  });

  it('arrow keys resize it and do not reach the genome navigation', () => {
    const onResize = vi.fn();
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    act(() => root.render(<DrawerResizeHandle width={480} min={320} max={900} onResize={onResize} onReset={() => {}} />));
    act(() => { handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(onResize).toHaveBeenCalledWith(480 + DRAWER_RESIZE_STEP);
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outer);
  });

  it('dragging the edge left widens it, in layout px under a UI zoom', () => {
    const onResize = vi.fn();
    act(() => root.render(<DrawerResizeHandle width={480} min={320} max={900} zoom={2} onResize={onResize} onReset={() => {}} />));
    const fire = (type: string, clientX: number) => act(() => {
      const e = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      handle().dispatchEvent(Object.assign(e, {}));
    });
    // jsdom has no PointerEvent constructor: React listens for the pointer event names.
    fire('pointerdown', 1000);
    fire('pointermove', 900);
    expect(onResize).toHaveBeenLastCalledWith(480 + 50);
    fire('pointerup', 900);
    fire('pointermove', 800);
    expect(onResize).toHaveBeenCalledTimes(1);
  });
});

describe('a drag cut short', () => {
  it('the drawer going away mid-drag gives the page its cursor and text selection back', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    act(() => root.render(<DrawerResizeHandle width={480} min={320} max={900} onResize={() => {}} onReset={() => {}} />));
    act(() => {
      container.querySelector('[data-testid="analysis-overlay-resize"]')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 500, button: 0 }));
    });
    expect(document.body.style.cursor).toBe('col-resize');
    act(() => root.unmount());
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    container.remove();
  });
});

describe('the drawer width is remembered', () => {
  it('across reloads (per viewer), and reset clears it', () => {
    useDrawerTabsStore.getState().setWidth(612.4);
    expect(useDrawerTabsStore.getState().width).toBe(612);
    expect(localStorage.getItem('fiberbrowser_drawer_width')).toBe('612');
    useDrawerTabsStore.getState().setWidth(null);
    expect(useDrawerTabsStore.getState().width).toBeNull();
    expect(localStorage.getItem('fiberbrowser_drawer_width')).toBeNull();
  });
});
