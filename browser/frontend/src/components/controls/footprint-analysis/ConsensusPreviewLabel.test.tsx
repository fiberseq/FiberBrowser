import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getConsensusSchema: vi.fn(),
  getConsensusJobs: vi.fn(),
  getConsensusJob: vi.fn(),
  startConsensus: vi.fn(),
  getConsensusCatalog: vi.fn(),
}));
vi.mock('../../../api/consensusWorkflow', async (orig) => ({ ...(await orig<typeof import('../../../api/consensusWorkflow')>()), ...api }));

import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import { useClassRegionOutlineStore } from '../../../stores/classRegionOutlineStore';
import { DEFAULT_CLASS_REGION_MODE } from '../../../utils/classRegion';
import { ConsensusTools } from './ConsensusTools';
import { FOOTPRINT_CLASSES_PREVIEW } from './preview';
import { allPreviewFeatures, getPreviewFeature, resetPreviewsForTests } from '../../../utils/previewFeatures';
import { PreviewFeaturesSettings } from '../sidebar/view/PreviewFeaturesSettings';
import type { PanelConfig } from '../../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The footprint classes (Find classes: fiberhmm-consensus) are a labelled Preview: the section's heading carries the
 * Preview badge (components/ui/PreviewBadge), shown with previews off too; Settings does not list it as switchable.
 */
const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam', consensus_chemistry: 'ddda' });
const panel = (id: string, datasetId: string) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }) as PanelConfig;
const STRINGENCY = { name: 'stringency', default: 0.9, type: 'float', minimum: 0.05, maximum: 1, step: 0.05, label: 'k-means stringency', help: '' };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  api.getConsensusSchema.mockReset().mockResolvedValue({ schema: 'x', cr_mode: 'lattice_recaller', groups: { recaller: [STRINGENCY] }, layers: {}, display_defaults: {} });
  api.getConsensusJobs.mockReset().mockResolvedValue({ jobs: [], active_job: null });
  api.getConsensusJob.mockReset().mockImplementation(() => new Promise(() => {}));
  api.getConsensusCatalog.mockReset().mockImplementation(() => new Promise(() => {}));
  api.startConsensus.mockReset().mockImplementation(async (request: Record<string, unknown>) => ({
    job_id: 'j1', status: 'queued', request: { ...request, chemistry_overrides: {} }, filters: {}, created_at: 1 }));
  usePanelGenomeStore.setState({ genomes: {}, assignments: {} });
  useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {} } as never);
  useClassRegionOutlineStore.setState({ outline: null, heldForJob: null });
  useBrowserStore.setState({
    chrom: 'chr19', start: 47_517_000, end: 47_521_000, currentGenome: 'hg38', datasets: [ds('a')] as never,
    selectedDatasets: new Set(['pa']), panels: [panel('pa', 'a')], classRegionMode: DEFAULT_CLASS_REGION_MODE,
    _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(node: React.ReactNode = <div data-panel-content-type="footprint-analysis"><ConsensusTools datasetIds={['a']} peaks={[]} /></div>) {
  await act(async () => { root.render(node); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe('footprint classes: a labelled Preview section', () => {
  afterEach(() => resetPreviewsForTests(false));

  it('the Footprint classes heading carries the Preview badge, with previews off too', async () => {
    resetPreviewsForTests(false);
    await mount();
    const section = host.querySelector('[data-testid="consensus-tools"]')!;
    expect(section).not.toBeNull();
    const badges = section.querySelectorAll('[data-testid="preview-badge"]');
    expect(badges).toHaveLength(1);
    const badge = badges[0] as HTMLElement;
    expect(badge.dataset.preview).toBe(FOOTPRINT_CLASSES_PREVIEW);
    expect(badge.textContent).toBe('Preview');
    expect(badge.closest('h3')?.textContent).toBe('Footprint classesPreview');
    expect(badge.title).toMatch(/^Footprint classes: a Preview feature\. /);
    expect(badge.title).not.toMatch(/Settings/);
    // Still usable: Find classes is offered.
    expect(host.querySelector('[data-testid="run-lattice-consensus"]')).not.toBeNull();
  });

  it('is label-only: Settings → Show preview features neither lists nor hides it', async () => {
    expect(getPreviewFeature(FOOTPRINT_CLASSES_PREVIEW)?.labelOnly).toBe(true);
    expect(allPreviewFeatures().some(f => f.id === FOOTPRINT_CLASSES_PREVIEW)).toBe(true);
    resetPreviewsForTests(true);
    await mount(<PreviewFeaturesSettings />);
    expect(host.querySelector('[data-testid="preview-features-setting"]')?.textContent).not.toMatch(/Footprint classes/);
  });
});
