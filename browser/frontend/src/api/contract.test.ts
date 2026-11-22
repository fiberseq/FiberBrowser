/**
 * Frontend/backend contract (coverage plan #22): the golden responses in __fixtures__/contract are written by the
 * backend test tests/test_api_contract_golden.py from real route calls (and checked there against the live routes).
 * Here each one goes through the real frontend API function, with only `fetch` answered from the file, and the fields
 * the panels read must be present with the types the frontend declares. A backend rename fails the pytest (stale
 * golden file); a regenerated golden file that drops a field the frontend needs fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chroms from './__fixtures__/contract/chroms.json';
import clusterAll from './__fixtures__/contract/cluster_all.json';
import consensusSchema from './__fixtures__/contract/consensus_schema.json';
import datasets from './__fixtures__/contract/datasets.json';
import nucMetrics from './__fixtures__/contract/nuc_metrics.json';
import pipelineJob from './__fixtures__/contract/pipeline_job.json';
import pipelineStatus from './__fixtures__/contract/pipeline_status.json';
import readsCompact from './__fixtures__/contract/reads_compact.json';
import scanPeaksFixture from './__fixtures__/contract/scan_peaks.json';
import status from './__fixtures__/contract/status.json';

import { getDatasets } from './datasets';
import { getStatus } from './status';
import { getChromosomes } from './reference';
import { scanPeaks } from './peaks';
import { clusterAllReads } from './clustering';
import { getConsensusSchema } from './consensusWorkflow';
import { getJob, getPipelineStatus } from './pipeline';
import { getCompactReads } from './readOperations';
import { normalizeMoleculeMetrics } from '../utils/moleculeMetrics';

function answer(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === 'string';

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('golden backend responses through the real API functions', () => {
  it('datasets: id, label, path, color, layers', async () => {
    answer(datasets);
    const { datasets: list } = await getDatasets();
    expect(list.length).toBeGreaterThan(0);
    for (const d of list) {
      expect(isStr(d.id) && isStr(d.label) && isStr(d.path) && isStr(d.color)).toBe(true);
      expect(typeof d.available_layers).toBe('object');
    }
  });

  it('status: counts and the initial position', async () => {
    answer(status);
    const s = await getStatus();
    for (const key of ['datasets', 'gene_count', 'track_count', 'chroms'] as const) expect(isNum(s[key])).toBe(true);
    expect(typeof s.has_gtf).toBe('boolean');
    expect(s.initial_position && isStr(s.initial_position.chrom) && isNum(s.initial_position.start)).toBe(true);
  });

  it('chroms: name and size', async () => {
    answer(chroms);
    const { chroms: list } = await getChromosomes();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(c => isStr(c.name) && isNum(c.size))).toBe(true);
  });

  it('reads/compact: reads with intervals and the counts the read track reads', async () => {
    answer(readsCompact);
    const params = new URLSearchParams({ chrom: 'chr19', start: '47514800', end: '47515800', dataset_id: 'demo', max_reads: '3' });
    const r = await getCompactReads<Record<string, any>>(params);
    for (const key of ['count', 'total', 'width']) expect(isNum(r[key])).toBe(true);
    expect(r.reads.length).toBeGreaterThan(0);
    for (const read of r.reads) {
      expect(isStr(read.id)).toBe(true);
      expect(Array.isArray(read.intervals)).toBe(true);
      for (const iv of read.intervals) expect(iv.length >= 3 && iv.slice(0, 3).every(isNum)).toBe(true);
    }
  });

  it('scan_peaks: peaks and tiers as ScanPeaksResponse declares', async () => {
    answer(scanPeaksFixture);
    const r = await scanPeaks('chr19', 47514800, 47515800, 'demo');
    expect(r.peaks.length).toBeGreaterThan(0);
    for (const p of r.peaks) {
      for (const key of ['start', 'end', 'index', 'score', 'layer', 'width', 'threshold'] as const) expect(isNum(p[key])).toBe(true);
    }
    expect(r.layer_info.every(l => isNum(l.layer) && isStr(l.label) && isNum(l.n_peaks))).toBe(true);
    expect(isNum(r.n_reads) && isStr(r.mode)).toBe(true);
  });

  it('cluster_all: per-dataset assignments, counts and kept reads', async () => {
    answer(clusterAll);
    const r = await clusterAllReads('chr19', 47514800, 47515800, [{ start: 47514981, end: 47515677, mode: 'accessibility' }],
      2, false, ['demo'], 'combinatorial');
    const result = r.results.demo;
    expect(result).toBeTruthy();
    expect(Object.values(result.assignments).every(isNum)).toBe(true);
    expect(Object.values(result.cluster_counts).every(isNum)).toBe(true);
    expect(Array.isArray(result.filtered_read_ids)).toBe(true);
  });

  it('consensus schema: parameter groups, layers and display defaults', async () => {
    answer(consensusSchema);
    const s = await getConsensusSchema();
    expect(isStr(s.schema)).toBe(true);
    expect(Object.values(s.groups).every(Array.isArray)).toBe(true);
    expect(Object.keys(s.groups).length).toBeGreaterThan(0);
    expect(Object.values(s.layers).every(v => Array.isArray(v) && v.length === 2)).toBe(true);
    expect(typeof s.display_defaults).toBe('object');
  });

  it('nuc metrics: the real parser keeps every listed metric', () => {
    const metrics = normalizeMoleculeMetrics(nucMetrics);
    expect(metrics).not.toBeNull();
    expect(metrics!.length).toBe((nucMetrics as { metrics: unknown[] }).metrics.length);
    expect(metrics!.every(m => isStr(m.id) && isStr(m.label) && ['nucmol', 'nfrmol', 'nucreg'].includes(m.group))).toBe(true);
  });

  it('pipeline status: what the run wizard reads', async () => {
    answer(pipelineStatus);
    const s = await getPipelineStatus();
    expect(typeof s.available).toBe('boolean');
    expect(isNum(s.cores) && isNum(s.default_cores)).toBe(true);
    expect(s.enzymes.map(e => e.id).sort()).toEqual(['ddda', 'dddb', 'hia5']);
    expect(s.genomes.every(g => isStr(g.id) && isStr(g.name) && typeof g.downloaded === 'boolean')).toBe(true);
    const o = s.default_options;
    expect(['auto', 'on', 'off']).toContain(o.dedup);
    expect(['flag', 'collapse']).toContain(o.dedup_mode);
    expect(['primary', 'primary-supplementary', 'all']).toContain(o.alignments);
    expect(typeof o.chimera_filter).toBe('boolean');
    expect(['unmethylated-only', 'methylated-only']).toContain(o.cpg_mask_policy);
    expect(['conservative', 'topology']).toContain(o.nuc_recall_policy);
  });

  it('pipeline job: status, progress and outputs the jobs list reads', async () => {
    answer(pipelineJob);
    const j = await getJob('job-1');
    expect(['queued', 'running', 'cancelling', 'done', 'error', 'cancelled', 'interrupted']).toContain(j.status);
    expect(isStr(j.id) && isStr(j.sample) && isStr(j.outdir)).toBe(true);
    expect(j.progress && typeof j.progress === 'object').toBe(true);
    expect(j.outputs && typeof j.outputs === 'object').toBe(true);
  });
});
