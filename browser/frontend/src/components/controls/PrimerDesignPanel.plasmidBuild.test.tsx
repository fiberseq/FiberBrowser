import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { PrimerDesignPanel } from './PrimerDesignPanel';

// Only plasmid maps loaded: "FASTA ready" for design, but Build has no genome FASTA to build from.
const hook = vi.hoisted(() => ({ buildFastaLocal: null as string | null | undefined }));
vi.mock('../../hooks/usePrimerBlastConfig', () => ({
  usePrimerBlastConfig: () => ({
    blastDbChoices: [], blastSetupBusy: false, blastSetupMessage: null, blastWarning: null, blastTool: null,
    buildFastaLocal: hook.buildFastaLocal, buildBlastDbFromFasta: vi.fn(), handlePickBlast: vi.fn(),
    selectBlastDb: vi.fn(), setBlastDbChoices: vi.fn(), setBlastWarning: vi.fn(),
  }),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useBrowserStore.getState();
afterEach(() => { useBrowserStore.setState(initial, true); });

async function renderPanel() {
  useBrowserStore.setState({ chrom: 'pUAST-attB', start: 0, end: 5000, hasFasta: true, panels: [],
    primer: { ...initial.primer, mode: 'standard', configBlastDb: null, configFasta: null, designing: false },
  } as never);
  const container = document.createElement('div'), root = createRoot(container);
  await act(async () => root.render(<PrimerDesignPanel />));
  return { container, root };
}

it('offers Browse, not Build, when only a plasmid map is loaded', async () => {
  hook.buildFastaLocal = null;
  const { container, root } = await renderPanel();
  const labels = [...container.querySelectorAll('button')].map(b => b.textContent?.trim());
  expect(labels).toContain('Browse');
  expect(labels).not.toContain('Build DB');
  expect(container.textContent).toContain("Browse to your genome's BLAST database");
  act(() => root.unmount());
});

it('offers Build when the server reports a local genome FASTA', async () => {
  hook.buildFastaLocal = '/data/dm6.fa';
  const { container, root } = await renderPanel();
  const labels = [...container.querySelectorAll('button')].map(b => b.textContent?.trim());
  expect(labels).toContain('Build DB');
  act(() => root.unmount());
});
