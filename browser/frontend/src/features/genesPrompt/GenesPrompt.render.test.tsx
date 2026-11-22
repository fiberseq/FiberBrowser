/** The genes prompt in the main view: under the genome banner when no Genes track shows it, one click to load,
 *  progress, and on failure the error with Retry. */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ results: [] as Array<{ success: boolean; error?: string }>, n: 0 }));
vi.mock('../../utils/annotationReset', () => ({
  resetRegistryAnnotation: vi.fn(async () => { calls.n += 1; return calls.results.shift() ?? { success: true }; }),
}));

import { useBrowserStore } from '../../stores/browserStore';
import { useGenomeCheckStore } from '../../stores/genomeCheckStore';
import { ReferenceNotices } from '../../components/controls/ReferenceNotices';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CHECK = {
  reference: { kind: 'registry', label: 'dm6', assembly: 'dm6' }, problems: [], datasets: [],
  annotation: { loaded: false, gene_count: 0, genome_id: null, fits: null, current: false, can_reset: true,
    target: { genome_id: 'dm6', name: 'D. melanogaster (dm6)', gtf_label: '', cached: true } },
};

function render() {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  act(() => root.render(<ReferenceNotices />));
  return { box, root };
}

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('genes prompt notice', () => {
  afterEach(() => { try { localStorage.clear(); } catch { /* none */ } calls.n = 0; calls.results = []; });

  it('shows under the banner without a Genes track, loads in one click, and retries after a failure', async () => {
    useGenomeCheckStore.setState({ check: CHECK as never });
    useBrowserStore.setState({ panels: [], publicMode: false } as never);
    const { box, root } = render();
    const q = (id: string) => box.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    expect(q('genes-notice-prompt-message')?.textContent).toBe('No genes loaded for dm6');
    expect(q('genes-notice-prompt-button')?.textContent).toBe('Load dm6 genes');
    calls.results = [{ success: false, error: 'connection refused' }, { success: true }];
    await act(async () => { q('genes-notice-prompt-button')!.click(); });
    await flush();
    expect(q('genes-notice-prompt-error')?.textContent).toBe('connection refused');
    await act(async () => { q('genes-notice-prompt-retry')!.click(); });
    await flush();
    expect(calls.n).toBe(2);
    expect(q('genes-notice-prompt-error')).toBeNull();
    act(() => root.unmount());
  });

  it('is left to the Genes track when one shows, hides on a public server, and stays dismissed per genome', () => {
    useGenomeCheckStore.setState({ check: CHECK as never });
    useBrowserStore.setState({ panels: [{ id: 'p', contentType: 'dataset', collapsed: false, subTracks: [{ type: 'gene', visible: true }] }],
      publicMode: false } as never);
    let { box, root } = render();
    expect(box.querySelector('[data-testid="genes-notice"]')).toBeNull();
    act(() => root.unmount());

    useGenomeCheckStore.setState({ check: { ...CHECK, annotation: { ...CHECK.annotation, can_reset: false } } as never });
    useBrowserStore.setState({ panels: [], publicMode: true } as never);
    ({ box, root } = render());
    expect(box.querySelector('[data-testid="genes-notice"]')).toBeNull();
    act(() => root.unmount());

    useGenomeCheckStore.setState({ check: CHECK as never });
    useBrowserStore.setState({ panels: [], publicMode: false } as never);
    ({ box, root } = render());
    act(() => { (box.querySelector('[data-testid="genes-notice-dismiss"]') as HTMLElement).click(); });
    expect(box.querySelector('[data-testid="genes-notice"]')).toBeNull();
    act(() => root.unmount());
    ({ box, root } = render());
    expect(box.querySelector('[data-testid="genes-notice"]')).toBeNull();   // remembered for dm6
    act(() => root.unmount());
  });

  it('another genome starts fresh: no earlier genome\'s error or Retry', async () => {
    useGenomeCheckStore.setState({ check: CHECK as never });
    useBrowserStore.setState({ panels: [], publicMode: false } as never);
    const { box, root } = render();
    const q = (id: string) => box.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    calls.results = [{ success: false, error: 'connection refused' }];
    await act(async () => { q('genes-notice-prompt-button')!.click(); });
    await flush();
    expect(q('genes-notice-prompt-error')).not.toBeNull();
    const MM10 = { ...CHECK, reference: { kind: 'registry', label: 'mm10', assembly: 'mm10' },
      annotation: { ...CHECK.annotation, target: { genome_id: 'mm10', name: 'Mouse (mm10)', gtf_label: '', cached: false } } };
    act(() => { useGenomeCheckStore.setState({ check: MM10 as never }); });
    expect(q('genes-notice-prompt-message')?.textContent).toBe('No genes loaded for mm10');
    expect(q('genes-notice-prompt-error')).toBeNull();
    expect(q('genes-notice-prompt-button')?.textContent).toBe('Load mm10 genes');
    act(() => root.unmount());
  });
});
