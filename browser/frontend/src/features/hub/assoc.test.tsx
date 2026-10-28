import '../testSetup';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useBrowserStore } from '../../stores/browserStore';
import { EMPTY_HUB, normalizeHub, storableRun, type AssocRun } from './hubState';
import { buildRequest, choicesFor, clusterGroup, DEFAULT_DRAFT, markChoices, presets, setChoices } from './assocRequest';
import { AssocResults } from './AssocResults';
import { normalizeOverlay, DEFAULT_OVERLAY } from './overlayTypes';
import { locusOfHit } from './OverlayTab';
import type { ScanInfo } from './api';
import type { AssocResult } from './assocApi';
import type { FeatureHit, FeatureSet, FeatureTypeDecl } from './types';

const T = (typeId: string, provides: FeatureTypeDecl['provides']): FeatureTypeDecl => ({
  typeId, module: typeId.split('.')[0], label: typeId, plural: typeId, provides, anchor: 'centre', zeroWidth: false, scores: [],
});
const hit = (id: string, start: number, extra: Partial<FeatureHit> = {}): FeatureHit => ({
  hitId: id, setId: 's', typeId: 'x', frame: { kind: 'linear', chrom: 'chr3' }, chrom: 'chr3', start, end: start + 100, anchor: start + 50, scores: {}, ...extra,
});
const set = (setId: string, typeId: string, provides: FeatureTypeDecl['provides'], hits: FeatureHit[] = []): FeatureSet => ({
  setId, typeId, type: T(typeId, provides), provenance: { producer: setId.startsWith('hub:') ? 'browser-scan' : 'browser', module: typeId.split('.')[0], inputs: [], units: 'grid' },
  frame: { kind: 'linear', chrom: 'chr3' }, datasets: ['ds1'], groups: [], coverage: { territory: 'units' }, status: 'complete', source: { kind: 'inline', hits },
});
const nucScan = { modules: { nuc: { version: '2.2', settingsHash: 'x', experimental: false } }, annotate: false } as unknown as ScanInfo;

describe('association builder', () => {
  const sets = [set('hub:fp', 'fp.class', ['hit', 'state']), set('hub:nfr', 'nfr.region', ['hit', 'state']),
    set('browser:sv', 'var.sv', ['hit'], [hit('sv:chr3:I:1000:2300', 1000, { legacyRefs: [{ kind: 'sv', source: 'sv', id: 'I:1000:2300', datasetId: 'ds1' } as never] })]),
    set('browser:peaks:r', 'peaks.peak', ['hit'], [hit('p1', 5000)])];
  const all = setChoices(sets, []);

  it('scan sets go by id, browser sets with their hits; states only where the hub has them', () => {
    const fp = all.find(c => c.key === 'hub:fp')!;
    expect(fp.ref).toEqual({ kind: 'scan', setId: 'hub:fp', typeId: 'fp.class', label: 'fp.class' });
    const sv = all.find(c => c.key === 'browser:sv')!;
    expect(sv.hasStates).toBe(true);
    expect(sv.ref.hits?.[0].legacyRefs?.[0]).toMatchObject({ datasetId: 'ds1' });
    expect(all.find(c => c.key === 'browser:peaks:r')!.hasStates).toBe(false);
  });

  it('refuses what the data can\'t run, in words', () => {
    const state = useBrowserStore.getState();
    const marks = markChoices([]);
    const ctx = { all, marks, state, anchors: [] };
    expect(buildRequest({ ...DEFAULT_DRAFT, mode: 'M1', aKey: 'browser:peaks:r', bKey: 'hub:fp' }, ctx)).toEqual({ error: expect.stringContaining('no per-molecule states') });
    expect(buildRequest({ ...DEFAULT_DRAFT, mode: 'M3', aKey: 'marks:nuc.seg.regular' }, ctx)).toEqual({ error: expect.stringContaining('nucleosome scan') });
    const ok = buildRequest({ ...DEFAULT_DRAFT, mode: 'M1', aKey: 'browser:sv', bKey: 'hub:fp', group: 'haplotype' }, ctx);
    expect('request' in ok && ok.request).toMatchObject({ mode: 'M1', a: { kind: 'inline', typeId: 'var.sv' }, b: { kind: 'scan', setId: 'hub:fp' },
      group: { kind: 'haplotype' }, scope: { kind: 'view' } });
    expect(buildRequest({ ...DEFAULT_DRAFT, mode: 'M1', aKey: 'browser:sv', bKey: 'hub:fp', group: 'cluster' }, ctx))
      .toEqual({ error: expect.stringContaining('No cluster run') });
    const m3 = buildRequest({ ...DEFAULT_DRAFT, mode: 'M3', aKey: 'marks:nuc.seg.regular' }, { ...ctx, marks: markChoices([nucScan]) });
    expect('request' in m3 && m3.request.b).toEqual({ kind: 'tf', label: 'TF footprints' });
    expect(choicesFor('M2', all, marks).b).toEqual([]);
  });

  it('the four §7.9 questions say what is missing', () => {
    const qs = presets(all, markChoices([]), 1);
    expect(qs.map(q => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(qs[0].missing).toContain('nucleosome scan');
    expect(qs[1].missing).toBe('');
    expect(qs[1].draft).toMatchObject({ mode: 'M2', aKey: 'hub:nfr', response: 'phasing', group: 'haplotype' });
    expect(qs[2].draft).toMatchObject({ mode: 'M1', aKey: 'browser:sv', bKey: 'hub:fp' });
    expect(qs[3].draft).toMatchObject({ mode: 'M4', aKey: 'browser:sv', bKey: 'browser:peaks:r' });
    expect(presets(all, markChoices([nucScan]), 2)[0]).toMatchObject({ missing: '', draft: { group: 'dataset' } });
  });
});

const RESULT: AssocResult = {
  status: 'empty', mode: 'M1', unit: 'pair', scope: { kind: 'view', regions: [['chr3', 0, 10]], nRegions: 1 },
  limits: ['Every molecule with both states has A in state 1 (every spanning molecule carries it: no reference molecules): there is no contrast.'],
  effects: [{ key: 'pooled', label: 'Pooled (all pairs)', estimate: null, n: 73, scale: 'odds ratio' }],
  anchors: Array.from({ length: 6000 }, (_v, i) => ({ id: `a${i}|b`, chrom: 'chr3', pos: i, a: `a${i}`, b: 'b', estimate: 1, p: 0.5, q: 0.9, n: 12, table: [12, 0, 0, 0] })),
  result: { pooled: { or: 1 } },
};
const RUN: AssocRun = { id: 'job1', createdAt: '2026-10-27T00:00:00Z', label: 'M1 · SVs × classes', status: 'complete',
  definition: { mode: 'M1', a: { kind: 'inline', typeId: 'var.sv', hits: Array.from({ length: 2500 }, (_v, i) => ({ hitId: `h${i}`, chrom: 'chr3', start: i, end: i, anchor: i })) },
    b: { kind: 'scan', setId: 'hub:fp' }, scope: { kind: 'view', chrom: 'chr3', start: 0, end: 10 } }, result: RESULT };

describe('builder inputs (review round 1)', () => {
  it('cluster labels: reads outside the run and reads two panels label differently get none', () => {
    const s = { ...useBrowserStore.getState(), chrom: 'chr3',
      panels: [{ id: 'p1', datasetId: 'ds1', stateKey: 'k1' }, { id: 'p2', datasetId: 'ds1', stateKey: 'k2' }] as never,
      clusterAssignments: { k1: { r1: 0, r2: 1, r3: -1 }, k2: { r1: 1, r2: 1 } }, clusterPeakRegions: [] } as never;
    expect(clusterGroup(s).labels).toEqual({ ds1: { r2: 'C1' } });
  });
  it('browser sets carry where they were computed; anchor scopes keep placed anchors only', () => {
    const peaks = set('browser:peaks:r', 'peaks.peak', ['hit'], [hit('p1', 5000)]);
    peaks.coverage = { territory: 'view' };
    const c = setChoices([peaks], [], { chrom: 'chr3', start: 100, end: 900.5 })[0];
    expect(c.ref.coverage).toEqual([['chr3', 100, 901]]);
    const anchors = [{ id: 'a', label: 'a', sources: [], createdAt: '', anchors: [
      { chrom: 'chr1', pos: 5, frame: { kind: 'source', assembly: 'x', contig: 'c' } as never },
      { chrom: 'chr3', pos: 50 }] }];
    const st = { ...useBrowserStore.getState(), chrom: 'chr3', start: 0, end: 100 } as never;
    const all = setChoices([set('hub:fp', 'fp.class', ['hit', 'state'])], anchors);
    const r = buildRequest({ ...DEFAULT_DRAFT, mode: 'M4', aKey: 'hub:fp', bKey: 'anchors:a', scope: 'anchors', anchorSetId: 'a' }, { all, marks: [], state: st, anchors });
    expect('request' in r && r.request.scope.anchors).toEqual([['chr3', 50]]);
    expect(all.find(x => x.key === 'anchors:a')!.ref.anchors).toEqual([{ chrom: 'chr3', pos: 50 }]);
  });
});

describe('association runs in sessions', () => {
  it('round-trip through the session form, capped', () => {
    const stored = storableRun(RUN);
    expect(stored.result!.anchors).toHaveLength(5000);
    expect(stored.definition.a.hits).toHaveLength(2000);
    expect(stored.definition.truncated).toBe(true);           // "Run again" is off for it
    const back = normalizeHub(JSON.parse(JSON.stringify({ ...EMPTY_HUB, assocRuns: [stored], ui: { ...EMPTY_HUB.ui, tab: 'assoc' } })));
    expect(back.assocRuns).toHaveLength(1);
    expect(back.assocRuns[0].result!.limits).toEqual(RESULT.limits);
    expect(back.ui.tab).toBe('assoc');
    // malformed runs are dropped; old sessions have none
    expect(normalizeHub({ assocRuns: [{ id: 'x' }, { id: 'y', definition: { mode: 'M9', a: {} } }] }).assocRuns).toEqual([]);
    expect(normalizeHub({ scans: [] }).assocRuns).toEqual([]);
  });

  it('a no-contrast run shows its limit, not an odds ratio', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const root = createRoot(div);
    act(() => { root.render(<AssocResults run={storableRun(RUN)} onRerun={() => {}} onRemove={() => {}} />); });
    expect(div.querySelector('[data-testid=assoc-limits]')?.textContent).toContain('no reference molecules');
    expect(div.querySelector('[data-testid=assoc-status]')?.textContent).toBe('nothing to test');
    const est = div.querySelector('[data-testid=assoc-effect-row] td:nth-child(2)')?.textContent;
    expect(est).toBe('—');
    expect(div.querySelectorAll('[data-testid=assoc-row]')).toHaveLength(100);
    act(() => { (div.querySelector('[data-testid=assoc-rows-more]') as HTMLButtonElement).click(); });
    expect(div.querySelectorAll('[data-testid=assoc-row]')).toHaveLength(200);
    act(() => root.unmount());
  });
});

describe('overlay state', () => {
  it('normalizes its session form and keeps graph path statuses on loci', () => {
    expect(normalizeOverlay({})).toEqual(DEFAULT_OVERLAY);
    expect(normalizeOverlay({ align: 'scaled', layer: 'tf', flank: 99999, view: 'pile' })).toMatchObject({ align: 'scaled', layer: 'tf', flank: 20000, view: 'pile' });
    const l = locusOfHit(hit('h', 100, { graph: { registration: 'r', target: 't', binding: 'b', anchor: [100, 200], columns: [], size: 100,
      paths: { MAT: { status: 'carried', carried: 100, total: 100, label: 'MAT', datasets: ['ds1'], hap: 'MAT' }, PAT: { status: 'absent', carried: 0, total: 100, label: 'PAT', datasets: ['ds1'], hap: 'PAT' } } } }), 'hub:x');
    expect(l!.paths).toEqual({ MAT: { status: 'carried', hap: 'MAT', datasets: ['ds1'] }, PAT: { status: 'absent', hap: 'PAT', datasets: ['ds1'] } });
    // a hit of another assembly that doesn't lift has no place here
    expect(locusOfHit(hit('u', 5, { frame: { kind: 'source', assembly: 'a', contig: 'c' }, lift: { status: 'unmapped' } }), 'hub:x')).toBeNull();
  });
});
