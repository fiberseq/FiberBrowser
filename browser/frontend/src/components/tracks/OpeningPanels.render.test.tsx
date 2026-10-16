import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpeningPanels } from './OpeningPanels';
import { useOpeningStore } from '../../stores/openingStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('placeholder panels of datasets being opened', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useOpeningStore.setState({ opening: [], retry: {} });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('shows the name and the stage, then the error with Retry and Dismiss', () => {
    act(() => root.render(<OpeningPanels top={0} gap={4} />));
    expect(container.querySelector('[data-testid="opening-panel"]')).toBeNull();
    const retry = vi.fn();
    act(() => useOpeningStore.getState().begin([{ key: '/d/numb.bam', label: 'numb', stage: 'Opening…' }], retry));
    expect(container.querySelector('[data-testid="opening-panel-label"]')?.textContent).toBe('numb');
    act(() => useOpeningStore.getState().stage(['/d/numb.bam'], 'Checking the file and reading its index…'));
    expect(container.querySelector('[data-testid="opening-panel-stage"]')?.textContent).toMatch(/reading its index/);
    act(() => useOpeningStore.getState().fail('/d/numb.bam', 'Permission denied'));
    expect(container.querySelector('[data-testid="opening-panel-error"]')?.textContent).toBe('Permission denied');
    act(() => (container.querySelector('[data-testid="opening-panel-retry"]') as HTMLButtonElement).click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(useOpeningStore.getState().opening).toEqual([]);
  });

  it('a placeholder goes when its dataset has opened', () => {
    act(() => root.render(<OpeningPanels top={0} gap={4} />));
    act(() => useOpeningStore.getState().begin([{ key: 'a', label: 'A', stage: 'Opening…' }]));
    act(() => useOpeningStore.getState().done('a'));
    expect(container.querySelector('[data-testid="opening-panel"]')).toBeNull();
  });
});
