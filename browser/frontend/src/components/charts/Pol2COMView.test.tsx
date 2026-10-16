import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchPol2COM } from '../../api/transcription';
import { Pol2COMView } from './Pol2COMView';

vi.mock('../../api/transcription', () => ({ fetchPol2COM: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Pol II COM with a dataset that has no Pol II reads (L25)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({ measureText: () => ({ width: 30 }) } as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : vi.fn()), set: () => true,
    }) as never);
    useBrowserStore.setState({
      chrom: 'chr2R', start: 9974319, end: 9984319,
      selectedGenes: [{ id: 'eve', name: 'eve' }],
      datasets: [
        { id: 'flyamp', label: 'flyamp_DddB.called', color: '#ef4444' },
        { id: 'daf', label: 'stage_d_recalled', color: '#22c55e' },
      ],
      selectedDatasets: new Set(), panels: [],
    } as never);
    const row = { n_reads: 2, binary_matrix: [[0, 1], [1, 0]], smoothed_matrix: [[0.2, 0.8], [0.6, 0.1]], read_ids: ['a', 'b'], com_values: [1, 2], n_bins: 2, gene_body_size: 1500, viewport_size: 10000 };
    vi.mocked(fetchPol2COM).mockResolvedValue({ results: { flyamp: { ...row, n_reads: 0, binary_matrix: [], smoothed_matrix: [] }, daf: row } } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  it('says so in one plain note and draws charts only for the dataset with reads', async () => {
    await act(async () => root.render(<Pol2COMView width={456} height={300} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const note = container.querySelector('[data-testid="pol2com-empty"]');
    expect(note?.textContent).toBe('No reads with Pol II footprints in these genes: flyamp_DddB.called.');
    expect(note?.className).toContain('break-words');
    expect(container.querySelectorAll('canvas').length).toBe(2);
  });
});
