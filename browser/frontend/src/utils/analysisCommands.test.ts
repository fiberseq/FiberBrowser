import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { findFootprintClasses } from './analysisCommands';

/** Codex review (fb-n3-search): the Find button mounts disabled while the Footprints panel loads. */
describe('Find footprint classes from the palette', () => {
  const initial = useBrowserStore.getState();
  const openAnalysisPanel = vi.fn();
  beforeEach(() => {
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'x' }] as never, openAnalysisPanel } as never);
  });
  afterEach(() => {
    useBrowserStore.setState(initial, true);
    document.body.innerHTML = '';
  });

  function mountPanel(label: string, disabled: boolean): HTMLButtonElement {
    const panel = document.createElement('div');
    panel.setAttribute('data-panel-content-type', 'footprint-analysis');
    const button = document.createElement('button');
    button.setAttribute('data-testid', 'run-lattice-consensus');
    button.textContent = label;
    button.disabled = disabled;
    panel.appendChild(button);
    document.body.appendChild(panel);
    return button;
  }

  it('waits for the button to be ready, then presses it', async () => {
    const button = mountPanel('Find footprint classes', true);
    const click = vi.fn();
    button.addEventListener('click', click);
    setTimeout(() => { button.disabled = false; }, 120);
    await expect(findFootprintClasses()).resolves.toBe(true);
    expect(openAnalysisPanel).toHaveBeenCalledWith('footprint-analysis');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('a finished run (Find again) is only shown, not redone', async () => {
    const button = mountPanel('Find again', false);
    const click = vi.fn();
    button.addEventListener('click', click);
    await expect(findFootprintClasses()).resolves.toBe(false);
    expect(click).not.toHaveBeenCalled();
  });
});
