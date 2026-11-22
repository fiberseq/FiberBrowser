/** 3.1.1 (deferred MED): a session file (and a headless figure state) whose meta-locus pool comes back under another
 *  id (moved or touched BAMs, a path mapping: the pool id follows the files' identity) keeps its view, clusters and
 *  selections. The contig is asked of the pool before the state is applied, so the reopen finds the page already on
 *  it instead of moving there and clearing the analysis. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/sharedFetch', async (orig) => ({ ...(await orig<typeof import('../../api/sharedFetch')>()), fetchApiResponse: vi.fn() }));
vi.mock('../../api/tracks', async (orig) => ({ ...(await orig<typeof import('../../api/tracks')>()), getTracks: vi.fn(async () => ({ tracks: [] })) }));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), startMetaLocusPool: vi.fn(),
  setMetaLocusView: vi.fn(), probeMetaLocusPool: vi.fn() }));

import { fetchApiResponse } from '../../api/sharedFetch';
import { importSession } from '../../api/session';
import { installRenderFigureBridge } from '../../utils/renderFigureBridge';
import { useBrowserStore } from '../../stores/browserStore';
import { probeMetaLocusPool, setMetaLocusView, startMetaLocusPool } from './api';
import { resetMetaLocusForTests, useMetaLocusStore } from './metaLocusStore';

const mocked = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const REAL = { chrom: 'chr2L', start: 1000, end: 5000 };

function savedResult(): Record<string, unknown> {
  return {
    success: true, datasets: [{ id: 'sample', label: 'Sample', paths: ['/moved/sample.bam'], color: '#123456', data_type: 'bam' }],
    overlays: [], has_fasta: false,
    viewport: { chrom: 'meta:p1', start: 500, end: 1500 },
    frontend: {
      chrom: 'meta:p1', start: 500, end: 1500,
      clusterAssignments: { sample: { r1: 0, r2: 1, r3: 1 } },
      selectedReadIds: { sample: ['r2'] },
      metaLocus: { bed_path: '/beds/sites.bed', name: 'Sites', anchor: 'centre', flank_bp: 1500, dataset_ids: ['sample'],
        seed: 2, count: 30, extra_entries: [], lastRealLocus: REAL, pool_id: 'p1' },
    },
  };
}

function mockPool(probe: () => Promise<unknown>) {
  mocked(probeMetaLocusPool).mockImplementation(probe);
  mocked(startMetaLocusPool).mockResolvedValue({ status: 'ready', pool_id: 'p2', chrom: 'meta:p2', width: 3000, flank_bp: 1500,
    spec: { bed_path: '/beds/sites.bed' } });
  mocked(setMetaLocusView).mockResolvedValue({ chrom: 'meta:p2', length: 3000, generation: 1, entries: 0 } as never);
}

async function expectKept() {
  await vi.waitFor(() => expect(setMetaLocusView).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(useMetaLocusStore.getState().busy).toBe(false));
  const s = useBrowserStore.getState();
  expect([s.chrom, s.start, s.end]).toEqual(['meta:p2', 500, 1500]);
  expect(s.clusterAssignments).toEqual({ sample: { r1: 0, r2: 1, r3: 1 } });
  expect([...(s.selectedReadIds.sample ?? [])]).toEqual(['r2']);
  expect(useMetaLocusStore.getState().status?.pool_id).toBe('p2');
  expect(useMetaLocusStore.getState().notice).toBeNull();
}

describe('a session meta-locus reopened under another pool id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetaLocusForTests();
    useBrowserStore.setState({ chrom: 'chr1', start: 0, end: 10, clusterAssignments: {}, selectedReadIds: {} } as never);
  });

  it('a session file keeps its view, clusters and selections (probe names the new pool)', async () => {
    mockPool(async () => ({ success: true, cached: true, pool_id: 'p2' }));
    mocked(fetchApiResponse).mockResolvedValue({ ok: true, json: async () => savedResult() } as never);
    await importSession({ version: 1 });
    await expectKept();
  });

  it('a session file keeps them when the probe fails (the reopened pool names the contig)', async () => {
    mockPool(async () => { throw new Error('Failed to fetch'); });
    mocked(fetchApiResponse).mockResolvedValue({ ok: true, json: async () => savedResult() } as never);
    await importSession({ version: 1 });
    await expectKept();
  });

  it('a headless figure state keeps them too (the render bridge applies the same import)', async () => {
    mockPool(async () => ({ success: true, cached: true, pool_id: 'p2' }));
    const uninstall = installRenderFigureBridge({ loadStartupData: async () => {} });
    try {
      await window.__fiberbrowserApplyFigureState!(savedResult());
      await expectKept();
    } finally {
      uninstall();
    }
  });
});
