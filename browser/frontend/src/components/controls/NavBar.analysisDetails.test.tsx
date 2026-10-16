import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import '../../plugins/builtinPanels';
import { NavBar } from './NavBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// 2026-09-30 UI audit M11: More → Analysis details seemed to do nothing (the menu closed, no sign where details went).
describe('More → Analysis details', () => {
  const initial = useBrowserStore.getState();
  afterEach(() => useBrowserStore.setState(initial, true));

  it('stays open after the click and says what changed and where', async () => {
    useBrowserStore.getState().setShowAnalysisDetails(false);
    const box = document.createElement('div');
    document.body.appendChild(box);
    const root = createRoot(box);
    await act(async () => root.render(<NavBar loading={false} scanning={false} clustering={false} />));
    await act(async () => (box.querySelector('[data-testid="toolbar-more-button"]') as HTMLButtonElement).click());
    const caption = () => box.querySelector('[data-testid="analysis-details-caption"]')?.textContent ?? '';
    expect(caption()).toMatch(/^Off: .*Run details .* analysis panels/);
    await act(async () => (box.querySelector('[data-testid="analysis-details-toggle"]') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().showAnalysisDetails).toBe(true);
    expect(box.querySelector('[data-testid="toolbar-more-menu"]')).not.toBeNull();
    expect(box.querySelector('[data-testid="analysis-details-toggle"]')!.getAttribute('aria-checked')).toBe('true');
    expect(caption()).toMatch(/^On: analysis panels show Run details/);
    act(() => root.unmount());
    box.remove();
  });
});
