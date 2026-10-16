import '../../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';

const seen: Array<{ chrom: string; start: number; end: number }> = [];
vi.mock('../../../components/controls/co-accessibility/CoaccMatrixView', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../components/controls/co-accessibility/CoaccMatrixView')>()),
  CoaccMatrixView: (p: { chrom: string; start: number; end: number }) => { seen.push(p); return null; },
}));
import { PositionCorrelation } from './PositionCorrelation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Integration review (Codex, fb43): in Per panel mode the position matrix must analyse the NFR panel's locus, not the main view.
describe('Position correlation follows the NFR panel\'s locus', () => {
  it('passes the chosen reference and panel orientation to the position matrix', () => {
    useBrowserStore.setState({ chrom: 'stale', start: 0, end: 10, navigationMode: 'perPanel', isReversed: false,
      datasets: [{ id: 'd1' }], panels: [{ id: 'p', contentType: 'dataset', datasetId: 'd1', genome: 'own', reversed: true }] } as never);
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<PositionCorrelation locus={{ chrom: 'copy', start: 1000, end: 2000, genome: 'own', panelIds: ['p'] }} />));
    expect(seen.at(-1)).toMatchObject({ chrom: 'copy', start: 1000, end: 2000, genome: 'own', reversed: true });
    act(() => root.unmount());
  });

  it('uses the resolved locus; with several regions it asks for one instead of computing', () => {
    useBrowserStore.setState({ chrom: 'chr19', start: 47_517_650, end: 47_518_985,
      datasets: [{ id: 'd1', label: 'a', color: '#000', path: 'x' }], panels: [] } as never);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<PositionCorrelation locus={{ chrom: 'chr2', start: 1000, end: 2000 }} />));
    expect(seen.at(-1)).toMatchObject({ chrom: 'chr2', start: 1000, end: 2000 });
    act(() => root.render(<PositionCorrelation locus={null} regionsDiffer />));
    expect(container.querySelector('[data-testid="nfr-poscorr-regions-differ"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
