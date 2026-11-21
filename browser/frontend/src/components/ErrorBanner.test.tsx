import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBanner } from './Browser';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('the error banner', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('shows Retry when the error has an action; Retry dismisses the error, then runs the action', () => {
    const calls: string[] = [];
    const onDismiss = vi.fn(() => calls.push('dismiss'));
    const run = vi.fn(() => calls.push('run'));
    act(() => root.render(<ErrorBanner error="Could not show the insert expanded: deadline" action={{ label: 'Retry', run }} onDismiss={onDismiss} />));
    expect(container.textContent).toContain('Could not show the insert expanded: deadline');
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="error-banner-retry"]')!;
    expect(retry.textContent).toBe('Retry');
    act(() => retry.click());
    expect(calls).toEqual(['dismiss', 'run']);
  });

  it('has no Retry without an action; Dismiss still works', () => {
    const onDismiss = vi.fn();
    act(() => root.render(<ErrorBanner error="Merge failed" action={null} onDismiss={onDismiss} />));
    expect(container.querySelector('[data-testid="error-banner-retry"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
