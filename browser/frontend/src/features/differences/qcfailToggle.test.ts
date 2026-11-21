/** The toolbar's Show QC-fail reads (incl. FiberHMM chimeras) reaches the dev-only panels' requests:
 * nucleosome routes, Differences inspection and alternate blocks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { geometryRequestBody, nucStatus, nucRegularity } from '../nucleosomes/api';
import { DEFAULT_EVIDENCE_POLICY, getAlternateBlocks, inspectDifference, type WorkspaceQuery } from './api';

const bodies: Array<Record<string, unknown>> = [];
beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return { ok: true, status: 200, json: async () => ({ available: true, datasets: [] }), text: async () => '{}' } as unknown as Response;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); useBrowserStore.setState({ showQcFailReads: false }); });

const Q: WorkspaceQuery = { dataset_id: 'd', chrom: 'chrT', start: 0, end: 1000,
  target: { target_id: 't', revision: 1, target_type: 'geometry', chrom: 'chrT', ref_start: 100, ref_end: 100, alt_bp: 60 } };

describe('QC-fail toggle in the dev-only panels', () => {
  it.each([false, true])('nucleosome routes send include_qcfail=%s with the duplicate policy', async on => {
    useBrowserStore.setState({ showQcFailReads: on });
    await nucStatus(['d'], undefined, false);
    await nucRegularity([], undefined, 'overlapping', false).catch(() => undefined);
    expect(bodies.map(b => b.include_qcfail)).toEqual([on, on]);
    expect(geometryRequestBody([], { cohort: 'overlapping', includeDuplicates: false } as never).include_qcfail).toBe(on);
  });

  it.each([false, true])('Differences inspection and alternate blocks send include_qcfail=%s', async on => {
    useBrowserStore.setState({ showQcFailReads: on });
    await inspectDifference(Q, DEFAULT_EVIDENCE_POLICY);
    await getAlternateBlocks(Q, undefined, ['nuc'], false);
    expect(bodies.map(b => b.include_qcfail)).toEqual([on, on]);
  });
});
