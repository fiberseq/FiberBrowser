import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { PrimerDesignPanel } from './PrimerDesignPanel';
import { designPrimers } from '../../api/primers';
vi.mock('../../api/primers', async orig => ({ ...(await orig<object>()), designPrimers: vi.fn(async () => ({ success: false, message: 'No pair' })) }));
vi.mock('../../hooks/usePrimerBlastConfig', () => ({ usePrimerBlastConfig: () => ({ blastDbChoices: [], setBlastWarning: vi.fn() }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useBrowserStore.getState(), genomes = usePanelGenomeStore.getState();
afterEach(() => { useBrowserStore.setState(initial, true); usePanelGenomeStore.setState(genomes, true); vi.restoreAllMocks(); });
it('designs on a selected peak reference when the main view has no FASTA', async () => {
  useBrowserStore.setState({ chrom: 'stale', start: 9000, end: 10000, hasFasta: false,
    panels: [], selectedPeaks: new Set([1]), getAllPeaks: () => [{ index: 1, chrom: 'copy', start: 100, end: 200, genome: 'own' }],
    primer: { ...initial.primer, mode: 'standard', configBlastDb: '/tmp/test-db', configFasta: '', designing: false },
  } as never);
  usePanelGenomeStore.setState({ genomes: { own: { has_fasta: true } } } as never);
  const container = document.createElement('div'), root = createRoot(container);
  await act(async () => root.render(<PrimerDesignPanel />));
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Design Primers')!;
  expect(button).toBeDefined(); expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(designPrimers).toHaveBeenCalledWith('copy', 100, 200, expect.any(Object), expect.objectContaining({ genome: 'own' }));
  act(() => root.unmount());
});
