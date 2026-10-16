import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { PanelDisplayContext } from '../../hooks/usePanelDisplayStore';
import { GeneTrack } from './GeneTrack';
import { getGenes } from '../../api/reference';
vi.mock('../../api/reference', () => ({ getGenes: vi.fn(async () => ({ genes: [] })) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useBrowserStore.getState();
afterEach(() => { useBrowserStore.setState(initial, true); vi.clearAllMocks(); });
it.each(['per panel', 'split', 'expanded insert', 'reversed', 'independent copy'])('gene annotation uses the %s locus and reference', async kind => {
  useBrowserStore.setState({ chrom: 'stale', start: 9000, end: 10000, genes: [{ name: 'wrong-reference' }],
    navigationMode: 'perPanel', panels: [{ id: 'p', contentType: 'dataset', datasetId: 'd', reversed: kind === 'reversed' }],
  } as never);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<PanelDisplayContext.Provider value="p"><GeneTrack width={400} height={30}
    overrideChrom="copy" overrideStart={100} overrideEnd={500} genome="own-reference" /></PanelDisplayContext.Provider>));
  expect(getGenes).toHaveBeenCalledWith('copy', 100, 500, undefined, 'own-reference');
  act(() => root.unmount());
});
