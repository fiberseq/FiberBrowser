import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/demo', () => ({ getDemo: () => Promise.resolve({ available: false }), loadDemo: vi.fn() }));
// The Copilot panel itself talks to the server; a stand-in is enough to see whether it is shown.
vi.mock('../components/controls/CopilotCommandPanel', () => ({
  CopilotCommandPanel: () => <div data-testid="copilot-panel" />,
}));

import { isCopilotIncluded } from './copilotIncluded';
import { tourOutline, tourSteps } from './guidedTour';
import { HistoryAnalysisPanel } from '../components/controls/HistoryAnalysisPanel';
import { useSessionLog } from '../hooks/useSessionLog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setLeftOut = (leftOut: boolean) => {
  if (leftOut) (window as any).__FIBERBROWSER_NO_COPILOT__ = true;
  else delete (window as any).__FIBERBROWSER_NO_COPILOT__;
};

function SessionLogProbe() {
  useSessionLog();
  return null;
}

describe('a FiberBrowser without the Copilot (FiberBrowser.app)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setLeftOut(false);
    vi.unstubAllGlobals();
  });

  it('reads the flag the server puts in the page', () => {
    expect(isCopilotIncluded()).toBe(true);
    setLeftOut(true);
    expect(isCopilotIncluded()).toBe(false);
  });

  it('the Tutorial panel shows the guided tour only, with no Copilot tab', async () => {
    setLeftOut(true);
    await act(async () => { root.render(<HistoryAnalysisPanel />); });
    expect(container.querySelector('[data-analysis-tab="copilot"]')).toBeNull();
    expect(container.querySelector('[data-testid="copilot-panel"]')).toBeNull();
    // One tab left, so no tab bar: the tour's step list is the panel.
    expect(container.querySelector('[data-tour="tutorial-tour-list"]')).not.toBeNull();
  });

  it('the pip install keeps the Copilot tab', async () => {
    await act(async () => { root.render(<HistoryAnalysisPanel />); });
    expect(container.querySelector('[data-analysis-tab="copilot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="copilot-panel"]')).not.toBeNull();
  });

  it('the guided tour skips its Copilot step (and the Tutorial list does not show it)', () => {
    expect(tourSteps(null, false).some(s => s.id === 'copilot')).toBe(true);
    setLeftOut(true);
    expect(tourSteps(null, false).some(s => s.id === 'copilot')).toBe(false);
    expect(tourOutline().some(s => s.id === 'copilot' || /Copilot/.test(s.text))).toBe(false);
    expect(tourSteps(null, false).map(s => s.id)).toContain('end');
  });

  it('no Copilot usage-log requests are made', async () => {
    setLeftOut(true);
    await act(async () => { root.render(<SessionLogProbe />); });
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/nl/'))).toBe(false);
  });
});
