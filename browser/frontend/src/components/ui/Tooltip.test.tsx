import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from './Tooltip';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function mockRect(element: Element, rect: Partial<DOMRect>) {
  element.getBoundingClientRect = vi.fn(() => ({
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    left: rect.left ?? 0,
    top: rect.top ?? 0,
    right: rect.right ?? (rect.left ?? 0) + (rect.width ?? 0),
    bottom: rect.bottom ?? (rect.top ?? 0) + (rect.height ?? 0),
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    toJSON: () => ({}),
  } as DOMRect));
}

describe('Tooltip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.querySelectorAll('[role="tooltip"]').forEach(node => node.remove());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders wrapped tooltips in a body-level layer', async () => {
    await act(async () => {
      root.render(
        <Tooltip content="This is intentionally long settings help text that should wrap instead of being clipped." delay={0}>
          <button type="button">?</button>
        </Tooltip>,
      );
    });

    const trigger = container.querySelector('span')!;
    mockRect(trigger, { left: 100, top: 80, width: 20, height: 20, right: 120, bottom: 100 });

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    const tooltip = document.querySelector('[role="tooltip"]') as HTMLSpanElement | null;
    expect(tooltip).not.toBeNull();
    expect(container.contains(tooltip)).toBe(false);
    expect(tooltip?.className).toContain('fixed');
    expect(tooltip?.className).toContain('z-[10000]');
    expect(tooltip?.className).toContain('block');
    expect(tooltip?.className).toContain('whitespace-normal');
    expect(tooltip?.style.maxWidth).toBe('352px');
    expect(tooltip?.style.left).toBe('184px');
  });
});
