/**
 * 3.1.0 ships live lift and graph mode as labelled previews (owner, 20 Nov 2026): their entry points show the Preview
 * badge, and nothing is hidden while Settings → Show preview features is off.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { ensureBuiltinPanelsRegistered } from '../../stores/__tests__/helpers';
import type { Dataset } from '../../types';
import { getPreviewFeature, previewHidden, resetPreviewsForTests } from '../../utils/previewFeatures';
import { useLiveLiftHeader } from './register';
import { LiveLiftDialog } from './LiveLiftDialog';
import { useLiveLiftStore } from './store';
import { LIVE_LIFT_PREVIEW } from './preview';
import { GRAPH_MODE_PREVIEW } from '../graphPanel/graphModePreview';
import { OpenSplitButton } from '../../components/controls/OpenMenu';

const dataset: Dataset = {
  id: 'lift', path: 'x.bam', label: 'lift', color: '#000', data_type: 'bam_livelift', source_identity: 'v1',
  live_lift: { manifest: '/map.json', map_label: 'map', haplotypes: ['H#1', 'H#2'],
    haplotype_labels: { 'H#1': 'MAT', 'H#2': 'PAT' }, settings: { haplotype_mode: 'split' }, key: 'v1' },
};
const originalState = useBrowserStore.getState();
const roots: Root[] = [];
function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  return { root, host };
}
const badges = (host: HTMLElement, feature: string) => host.querySelectorAll(`[data-testid="preview-badge"][data-preview="${feature}"]`);

beforeEach(() => {
  localStorage.clear();
  resetPreviewsForTests(false);           // previews off: labelled previews still show
  ensureBuiltinPanelsRegistered();
  useBrowserStore.setState({ ...originalState, datasets: [dataset], panels: [] }, true);
});
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  document.body.innerHTML = '';
  useLiveLiftStore.setState({ dialogOpen: false });
  useBrowserStore.setState(originalState, true);
});

it('registers live lift and graph mode as labelled previews that are never hidden', () => {
  for (const id of [LIVE_LIFT_PREVIEW, GRAPH_MODE_PREVIEW]) {
    expect(getPreviewFeature(id)?.labelOnly).toBe(true);
  }
});

it('shows the live-lift badge beside a lifted panel\'s chip, but not on a graph host (graph mode has its own)', async () => {
  const { root, host } = mount();
  function Header({ graph }: { graph: boolean }) {
    const panel = { id: 'p', datasetId: 'lift', liftHap: 'MAT', ...(graph ? { viewMode: 'graph' } : {}) };
    const header = useLiveLiftHeader({ panel, dataset } as Parameters<typeof useLiveLiftHeader>[0]);
    return <>{header?.chips}</>;
  }
  await act(async () => root.render(<Header graph={false} />));
  expect(host.querySelector('[data-testid="live-lift-chip"]')).not.toBeNull();
  expect(badges(host, LIVE_LIFT_PREVIEW)).toHaveLength(1);
  expect(badges(host, LIVE_LIFT_PREVIEW)[0].textContent).toBe('Preview');
  await act(async () => root.render(<Header graph />));
  expect(badges(host, LIVE_LIFT_PREVIEW)).toHaveLength(0);
});

it('shows the badge in the Add live lift dialog title', async () => {
  const { root, host } = mount();
  useLiveLiftStore.setState({ dialogOpen: true });
  await act(async () => root.render(<LiveLiftDialog />));
  const title = host.querySelector('#live-lift-title') as HTMLElement;
  expect(title.textContent).toContain('Add live lift');
  expect(title.querySelector(`[data-preview="${LIVE_LIFT_PREVIEW}"]`)).not.toBeNull();
});

it('shows the badge on Open ▾ → Add live lift… with previews off', async () => {
  expect(previewHidden(LIVE_LIFT_PREVIEW)).toBe(true); // the switch is off; the labelled item is still shown
  useLiveLiftStore.setState({ enabled: true });
  const { root, host } = mount();
  await act(async () => root.render(<OpenSplitButton onOpenFile={() => {}} />));
  await act(async () => (host.querySelector('[data-testid="open-menu-button"]') as HTMLElement).click());
  const item = host.querySelector('[data-testid="open-menu-add-live-lift"]') as HTMLElement;
  expect(item).not.toBeNull();
  expect(item.querySelector(`[data-preview="${LIVE_LIFT_PREVIEW}"]`)).not.toBeNull();
});

async function graphBound<T>(datasetId: string, run: (useGraphModeHeader: typeof import('../graphPanel/hostHeader').useGraphModeHeader) => Promise<T>): Promise<T> {
  const { useGraphModeHeader } = await import('../graphPanel/hostHeader');
  const { useGraphStatusStore } = await import('../graphPanel/statusStore');
  const { useGraphBindingsStore } = await import('../graphPanel/bindingsStore');
  const fetchStub = () => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [{ id: 'g', revisions: { package: '1' } }] } } as never);
    useGraphBindingsStore.setState({ byDataset: { [datasetId]: [{}] }, refresh: () => Promise.resolve() } as never);
    return await run(useGraphModeHeader);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const native: Dataset = { id: 'nat', path: 'n.bam', label: 'native', color: '#000', data_type: 'bam' } as Dataset;
const allBadges = (host: HTMLElement) => host.querySelectorAll('[data-testid="preview-badge"]');

it('shows the graph-mode badge beside a bound panel\'s Linear ⇄ Graph toggle when it is the only preview marker', async () => {
  useBrowserStore.setState({ datasets: [dataset, native] });
  await graphBound('nat', async useGraphModeHeader => {
    const { root, host } = mount();
    function Header() {
      const header = useGraphModeHeader({ panel: { id: 'p', contentType: 'dataset', datasetId: 'nat' }, dataset: native } as Parameters<typeof useGraphModeHeader>[0]);
      return <>{header?.chips}</>;
    }
    await act(async () => root.render(<Header />));
    expect(host.querySelector('[data-testid="graph-mode-toggle"]')?.textContent).toContain('Graph');
    expect(badges(host, GRAPH_MODE_PREVIEW)).toHaveLength(1);
  });
});

it('shows one Preview badge on a lifted panel outside graph mode, on its live-lift chip (owner, 20 Nov 2026)', async () => {
  await graphBound('lift', async useGraphModeHeader => {
    for (const liftHap of ['MAT', undefined]) {   // split by haplotype, and pooled
      const { root, host } = mount();
      function Header() {
        const panel = { id: 'p', contentType: 'dataset', datasetId: 'lift', ...(liftHap ? { liftHap } : {}) };
        const lift = useLiveLiftHeader({ panel, dataset } as Parameters<typeof useLiveLiftHeader>[0]);
        const graph = useGraphModeHeader({ panel, dataset } as Parameters<typeof useGraphModeHeader>[0]);
        return <>{lift?.chips}{graph?.chips}</>;
      }
      await act(async () => root.render(<Header />));
      expect(host.querySelector('[data-testid="live-lift-chip"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="graph-mode-toggle"]')).not.toBeNull();
      expect(allBadges(host)).toHaveLength(1);
      expect(badges(host, LIVE_LIFT_PREVIEW)).toHaveLength(1);
      expect(badges(host, GRAPH_MODE_PREVIEW)).toHaveLength(0);
    }
  });
});
