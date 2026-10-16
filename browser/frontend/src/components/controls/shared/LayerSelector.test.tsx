import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { LayerSelector } from './LayerSelector';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('LayerSelector consensus layers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      datasets: [{
        id: 'daf',
        label: 'DAF',
        path: '/tmp/daf.bam',
        data_type: 'bam',
        available_layers: {
          nuc: true,
          tf: true,
          nuc_sr: true,
          tf_sr: true,
          tf_consensus: true,
          ddda_mcg: true,
        },
      }],
    } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('surfaces both consensus layers to analysis consumers', async () => {
    await act(async () => {
      root.render(<LayerSelector value={null} onChange={vi.fn()} />);
    });

    expect(container.textContent).toContain('Nuc refined');
    expect(container.textContent).toContain('TF refined');
    expect(container.textContent).toContain('CR · within dataset');
    expect(container.textContent).toContain('TF inference · added layers');
  });

  it('retains consensus layers when an analysis panel supplies an allow-list', async () => {
    await act(async () => {
      root.render(
        <LayerSelector
          value={null}
          onChange={vi.fn()}
          availableLayers={['tf_sr']}
          variant="dropdown"
        />,
      );
    });

    const options = Array.from(container.querySelectorAll('option')).map(option => option.value);
    expect(options).toEqual(['', 'tf_sr']);
    expect(container.querySelector('optgroup')?.label).toBe('TF inference (added layers)');
  });

  it('does not count DddA mCG spans as footprints in the All FP selector', async () => {
    useBrowserStore.setState({
      datasets: [{
        id: 'mcg-only',
        label: 'mCG only',
        path: '/tmp/mcg.bam',
        data_type: 'bam',
        available_layers: { ddda_mcg: true },
      }],
    } as any);

    await act(async () => {
      root.render(<LayerSelector value={null} onChange={vi.fn()} showAllFpOption />);
    });

    expect(container.textContent).toContain('DddA mCG');
    expect(container.textContent).not.toContain('All FP');
  });
});
