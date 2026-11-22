/** The track's floating Quantify card edits the window on the view it quantifies (the active panel's), not the main
 *  locus (release audit 3.1.1). */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ view: null as null | { chrom: string; start: number; end: number } }));
vi.mock('./QuantifyCard', () => ({
  QuantifyCard: () => null,
  QuantWindowBar: ({ view }: { view: { chrom: string; start: number; end: number } }) => { seen.view = view; return null; },
}));

import { useBrowserStore } from '../../stores/browserStore';
import { WindowQuantHost } from './WindowQuantHost';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('WindowQuantHost', () => {
  it('the window bar gets the active panel\'s view', () => {
    useBrowserStore.setState({
      datasets: [{ id: 'B', label: 'B' }], panels: [{ id: 'pB', contentType: 'dataset', datasetId: 'B', stateKey: 'B', viewportOverride: { chrom: 'chr2', start: 5000, end: 6000 } }],
      selectedDatasets: new Set(['pB']), navigationMode: 'perPanel', chrom: 'chr1', start: 100, end: 900,
      windowQuant: { ...useBrowserStore.getState().windowQuant, openIn: 'track' },
    } as never);
    const box = document.createElement('div');
    const root = createRoot(box);
    act(() => root.render(<WindowQuantHost />));
    expect(seen.view).toEqual({ chrom: 'chr2', start: 5000, end: 6000 });
    act(() => root.unmount());
  });
});
