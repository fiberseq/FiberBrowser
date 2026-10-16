import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarSubSection } from './SidebarSubSection';

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

describe('SidebarSubSection', () => {
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

  it('uses wrapped help icons instead of one-line native title tooltips', async () => {
    await act(async () => {
      root.render(
        <SidebarSubSection
          id="analysis-repro"
          label="Analysis"
          defaultOpen
          helpText="Long settings help should wrap in the shared tooltip layer instead of rendering as a clipped native title."
        >
          <div>Body</div>
        </SidebarSubSection>,
      );
    });

    const header = container.querySelector('button')!;
    expect(header.getAttribute('title')).toBeNull();

    const helpIcon = container.querySelector('[aria-label="Help"]')!;
    const trigger = helpIcon.parentElement!;
    mockRect(trigger, { left: 300, top: 80, width: 14, height: 14, right: 314, bottom: 94 });

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    const tooltip = document.querySelector('[role="tooltip"]') as HTMLSpanElement | null;
    expect(tooltip).not.toBeNull();
    expect(container.contains(tooltip)).toBe(false);
    expect(tooltip?.className).toContain('z-[10000]');
    expect(tooltip?.className).toContain('whitespace-normal');
  });
});
