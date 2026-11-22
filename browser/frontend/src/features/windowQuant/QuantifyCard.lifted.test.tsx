/** The Quantify card names the live-lifted datasets it leaves out (never a silent drop). */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';

const state = vi.hoisted(() => ({ lifted: [] as string[] }));
vi.mock('./useWindowQuant', () => ({
  useWindowQuant: () => ({
    readsFor: () => ({}), anchor: null, frame: null, spec: useBrowserStore.getState().windowQuant.spec, readSource: null,
    binBp: null, ctx: null, catalog: [], measures: [], groups: [], bounds: null, result: null, sampled: {}, loading: false,
    error: null, blocker: 'Select a window first.', requestKey: '', liftedLeftOut: state.lifted,
  }),
}));

import { QuantifyCard } from './QuantifyCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function render() {
  const box = document.createElement('div');
  const root = createRoot(box);
  act(() => root.render(<QuantifyCard origin="track" width={500} />));
  return { box, root };
}

describe('QuantifyCard and live-lifted datasets', () => {
  it('names the left-out datasets in one line', () => {
    state.lifted = ['HG002 lifted'];
    const { box, root } = render();
    expect(box.querySelector('[data-testid="quant-lifted-left-out"]')?.textContent)
      .toBe("Live-lifted datasets aren't plotted or quantified yet: left out HG002 lifted.");
    act(() => root.unmount());
  });
  it('says nothing without one', () => {
    state.lifted = [];
    const { box, root } = render();
    expect(box.querySelector('[data-testid="quant-lifted-left-out"]')).toBeNull();
    act(() => root.unmount());
  });
});
