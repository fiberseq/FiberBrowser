/**
 * Quantify a window: the browser's engine and its Python twin (browser/services/window_quant.py, used by headless
 * scripts and `fiberbrowser quantify`) give the same table. Both compute from tests/fixtures/window_quant/input.json
 * (real meta-locus inputs on the demo BAM: the panels' profile pools, fresh samples, clusters, bounds; plus synthetic
 * shares) and are checked against tests/fixtures/window_quant/golden.json, which this test writes with
 * FIBERBROWSER_WRITE_QUANT_GOLDEN=1. tests/test_window_quant_twin.py holds the Python side to the same file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ fetch: new Map<string, unknown[]>() }));
vi.mock('../../api/sharedFetch', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../api/sharedFetch')>();
  return {
    ...real,
    // The fresh-sample requests (sources.ts compactReads): answered from the fixture, by dataset and kind.
    fetchJson: vi.fn(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams;
      const kind = q.get('include_methylation') === 'true' ? 'marks' : 'fresh';
      return { reads: fixtures.fetch.get(`${kind}|${q.get('dataset_id')}`) ?? [] };
    }),
  };
});

import { setProfileReadPool, clearProfileReadPool } from '../../utils/profileReadPool';
import { buildGroups, computeQuant, quantTsv, type QuantGroupDef } from './engine';
import { loadLayers, loadSizeBand, SIZE_BAND_MEASURE } from './sources';
import { normalizeQuantSpec } from './spec';
import type { LoadContext, MeasureData, MeasureDef } from './measures';
import type { UnitSums } from './windowMaths';

const ROOT = path.resolve(__dirname, '../../../../..');
const INPUT = path.join(ROOT, 'tests/fixtures/window_quant/input.json');
const GOLDEN = path.join(ROOT, 'tests/fixtures/window_quant/golden.json');

type Read = Record<string, unknown>;
interface Input { reads: Record<string, Read>; cases: Array<Record<string, any>> }

const input = JSON.parse(fs.readFileSync(INPUT, 'utf8')) as Input;
const R = (ids: string[]) => ids.map(id => input.reads[id]);

/** sources.ts layerMeasures / sizeBandMeasures for the fixture's measures (the twin builds the same defs). */
function defOf(id: string, hasTf: boolean): MeasureDef {
  if (id === SIZE_BAND_MEASURE) {
    return { id, label: 'Footprints in the size band', source: 'size-band', kind: 'ratio', unit: 'share of footprints in the size band', enrichment: true, windowed: true,
      note: 'footprints counted by their centre (one wider than the view, with no known centre, is left out); the band is set in Options', available: true };
  }
  const key = id.slice('layer:'.length);
  const marks = ['m6a', 'mod', 'm5c', 'deam'].includes(key);
  const labels: Record<string, string> = { tf: 'TF', fire: 'Accessibility', msp: 'Accessibility', deam: 'Deam', m6a: 'm6A', m5c: '5mC' };
  return { id, label: key === 'nuc' || key === 'footprint' ? (hasTf ? 'Nuc' : 'FP') : labels[key] ?? key, source: 'layers', kind: marks ? 'rate' : 'fraction',
    unit: marks ? 'marks per kb of read' : 'fraction of covered bp', enrichment: true, windowed: true, available: true };
}

async function pipeline(c: Record<string, any>) {
  const spec = normalizeQuantSpec(c.spec);
  const view = { ...c.view, genome: null };
  const panels = c.panels as Array<{ key: string; datasetId: string; label: string; datasetLabel?: string; color?: string }>;
  fixtures.fetch.clear();
  for (const [ds, ids] of c.fresh) fixtures.fetch.set(`fresh|${ds}`, R(ids));
  for (const [ds, ids] of c.marks) fixtures.fetch.set(`marks|${ds}`, R(ids));
  for (const [ds, ids] of c.size_reads) fixtures.fetch.set(`size|${ds}`, R(ids));
  for (const p of c.pools) {
    if (p.pool) setProfileReadPool(p.key, { ...p.pool, reads: R(p.pool.reads) as never });
    else clearProfileReadPool(p.key);
  }
  const ctx = {
    state: {} as never, view, bounds: { from: c.bounds.from, to: c.bounds.to }, allReads: { ...view, panels } as never, clusters: null, extras: {},
    sizeBand: [spec.sizeFrom, spec.sizeTo], layerUnits: spec.layerUnits, readSource: spec.readSource, readCap: spec.readCap, seed: spec.seed,
    flankFraction: spec.flankFraction, viewBins: c.view_bins,
  } as LoadContext;
  const defs = (c.measures as string[]).map(id => defOf(id, c.has_tf));
  const layerDefs = defs.filter(d => d.id.startsWith('layer:'));
  const data: Record<string, MeasureData> = {};
  if (layerDefs.length) Object.assign(data, await loadLayers(layerDefs, ctx));
  if (defs.some(d => d.id === SIZE_BAND_MEASURE)) {
    // loadSizeBand's request is the fresh sample's with Nuc + TF: answer it with the size fixture.
    fixtures.fetch.clear();
    for (const [ds, ids] of c.size_reads) fixtures.fetch.set(`fresh|${ds}`, R(ids));
    Object.assign(data, await loadSizeBand(defs.filter(d => d.id === SIZE_BAND_MEASURE), ctx));
  }
  const groups = buildGroups(c.comparison, { panels, clusterPanels: c.cluster_panels, visible: c.visible, clusterLabel: (k: number) => `C${k}` });
  const result = computeQuant({ spec: { ...spec, comparison: c.comparison }, measures: defs.map(def => ({ def, data: data[def.id] ?? {} })), groups,
    assignments: c.assignments, boundsBp: c.bounds.to - c.bounds.from, seed: spec.bootSeed ?? spec.seed, yScaleBaseline: c.y_baseline });
  const readSource = Object.values(data).some(d => d.readSource === 'panel') ? 'panel' : Object.values(data).some(d => d.readSource === 'fetch') ? 'fetch' : null;
  return { result, readSource };
}

function engine(c: Record<string, any>) {
  const spec = normalizeQuantSpec(c.spec);
  const measures = (c.measures as Array<{ def: MeasureDef; units: Record<string, number[]> }>).map(m => ({
    def: { ...m.def, available: true as const }, data: { units: new Map(Object.entries(m.units).map(([k, v]) => [k, v as unknown as UnitSums])) },
  }));
  return { result: computeQuant({ spec, measures, groups: c.groups as QuantGroupDef[], assignments: c.assignments, boundsBp: c.boundsBp, seed: c.seed }), readSource: null };
}

const clean = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x)));

describe('Quantify: the browser engine and its Python twin share a golden', () => {
  it('computes every case and matches the golden (or writes it)', async () => {
    const out: Record<string, unknown> = {};
    for (const c of input.cases) {
      const { result, readSource } = c.kind === 'engine' ? engine(c) : await pipeline(c);
      out[c.name] = clean({ result, readSource, tsv: quantTsv(result, []) });
    }
    if (process.env.FIBERBROWSER_WRITE_QUANT_GOLDEN) {
      fs.writeFileSync(GOLDEN, JSON.stringify(out, null, 1));
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(Object.keys(golden).sort());
    for (const name of Object.keys(golden)) expect(out[name], name).toEqual(golden[name]);
  });

  it('covers both read sources, curve and exact units, every baseline kind and the share tests', () => {
    const names = input.cases.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['curve_clusters_raw', 'fresh_layers', 'fresh_size_band_flank', 'exact_area_clusters_datasets', 'engine_shares_chi2']));
    const baselines = new Set(input.cases.map(c => c.spec?.baseline ?? 'auto'));
    for (const b of ['auto', 'flank', 'dataset', 'pooled']) expect(baselines.has(b)).toBe(true);
  });
});
