import { expect, it } from 'vitest';
import { alternativesFor, frameWindows, multiwayBlocks, repeatGroups, selectBlock, selectProposal, type Proposal, type SyncResult } from './model';
import { restoreSync } from './syncState';
const base: Proposal = { id: 'ab', panelId: 'w', partnerId: 'w', rank: 0, template: [100, 500], window: [800, 1200], strand: '-', sources: ['sequence'], metrics: { sequence: { score: .98, verdict: 'supports' } }, status: 'single-metric', supports: 1, assessed: 1, confidence: .98 };
const result: SyncResult = { windows: [{ panelId: 'w', datasetId: 'd', genome: null, chrom: 'chr1', label: 'W1', start: 0, end: 3000 }], metrics: ['sequence'], coverage: {}, notes: [], proposals: [base, { ...base, id: 'bc', template: [800, 1200], window: [1600, 2000] }] };
it('composes connected copies over shared blocks, preserving two reversals and session restoration', () => {
  expect(repeatGroups(result)[0].coverage).toBe(3);
  const selection = selectProposal(result, base)!;
  const windows = frameWindows(result, selection);
  expect(windows.map(w => [w.start, w.end, w.strand, w.copy])).toEqual([[100, 500, '+', 'a'], [800, 1200, '-', 'b'], [1600, 2000, '+', 'c']]);
  const restored = restoreSync({ comparisonFrames: [{ id: 'f', name: 'Copies', version: 1, status: 'accepted', templatePanelId: 'w', alignedOn: ['sequence'], length: 400, windows }], activeComparisonFrameId: 'f' });
  expect(restored.activeComparisonFrameId).toBe('f');
  expect(restored.comparisonFrames[0].windows).toHaveLength(3);
});
it('refuses a repeat group with inconsistent copy triangles', () => {
  const bad: SyncResult = { ...result, proposals: [...result.proposals, { ...base, id: 'ac', window: [1600, 2000] }] };
  expect(repeatGroups(bad)[0].inconsistent.length).toBeGreaterThan(0);
  expect(selectProposal(bad, base)).toBeNull();
});

it('offers three construct copies beside a native window without confusing internal edges with native matches', () => {
  const native = { ...result.windows[0], panelId: 'native', datasetId: 'native', chrom: 'native' };
  const matches = [100, 800, 1600].map((start, i): Proposal => ({ ...base, id: `native${i}`, partnerId: 'native', strand: '+', template: [50, 450], window: [start, start + 400] }));
  const combined: SyncResult = { ...result, windows: [native, ...result.windows], proposals: [...result.proposals, ...matches] };
  const initial = selectProposal(combined, matches[0])!;
  expect(alternativesFor(combined, initial, 'w').map(p => p.id)).toEqual(matches.map(p => p.id));
  const chosen = selectProposal(combined, matches[0], { w: matches.map(p => p.id) })!;
  expect(frameWindows(combined, chosen).map(w => [w.panelId, w.copy])).toEqual([['native', undefined], ['w', 'a'], ['w', 'b'], ['w', 'c']]);
});
it('restores a manually reversed template copy', () => {
  const windows = frameWindows(result, selectProposal(result, base)!, { 'w#a': true });
  windows[0].provenance.metric = 'template + manual strand';
  expect(restoreSync({ comparisonFrames: [{ id: 'f', name: 'Copies', version: 1, status: 'accepted', templatePanelId: 'w', alignedOn: ['sequence'], length: 400, windows }] }).comparisonFrames).toHaveLength(1);
});

it('keeps sequence-supported copies when their chromatin profiles disagree', () => {
  const different: SyncResult = { ...result, proposals: result.proposals.map(p => ({ ...p, status: 'disagreement',
    metrics: { ...p.metrics, accessibility: { score: .1, verdict: 'disagrees' } } })) };
  expect(repeatGroups(different)[0].coverage).toBe(3);
  expect(frameWindows(different, selectProposal(different, different.proposals[0])!)).toHaveLength(3);
  expect(different.proposals[0].metrics.accessibility?.verdict).toBe('disagrees');
});

it.each(['+', '-'] as const)('counts circular copies once and keeps the full %s match through the origin', strand => {
  const full: Proposal = { ...base, strand, template: [1650, 2151], window: [550, 1051] };
  const clipped: Proposal = { ...full, id: 'clipped', template: strand === '+' ? [800, 1051] : [550, 801], window: [1900, 2151] };
  const r: SyncResult = { ...result, circular: { w: 1900 }, proposals: [clipped, full] };
  expect(repeatGroups(r)[0].coverage).toBe(2);
  const selected = selectProposal(r, clipped)!;
  const windows = frameWindows(r, selected);
  expect(windows.map(w => [w.start, w.end])).toEqual([[550, 1051], [1650, 2151]]);
  expect(selected.end - selected.start).toBe(501);
  expect(windows.map(w => w.strand)).toEqual(['+', strand]);
  expect(alternativesFor(r, selected, 'w')).toHaveLength(1);
});

it('groups a sparse graph of 101 copies without scanning disconnected triangles', () => {
  const proposals = Array.from({ length: 100 }, (_, i): Proposal => ({ ...base, id: `p${i}`, strand: '+', template: [0, 400], window: [(i + 1) * 490, (i + 1) * 490 + 400] }));
  const r = { ...result, proposals };
  const start = performance.now();
  const groups = repeatGroups(r);
  expect(groups[0].coverage).toBe(101);
  expect(groups[0].inconsistent).toEqual([]);
  expect(repeatGroups(r)).toBe(groups);
  expect(repeatGroups({ ...r, proposals: [] })).toEqual([]);
  expect(frameWindows(r, selectProposal(r, proposals[0])!)).toHaveLength(101);
  expect(performance.now() - start).toBeLessThan(300);
});

for (const confidence of [.98, 1]) it(`selects direct windows from a block when a self-match ranks first (${confidence})`, () => {
  const self = { ...base, confidence, strand: '+' as const };
  const direct = { ...base, id: 'direct', panelId: 'other', strand: '+' as const };
  const r: SyncResult = { ...result, windows: [...result.windows, ...['other', 'third'].map(panelId => ({ ...result.windows[0], panelId }))], proposals: [self, direct, { ...direct, id: 'third', panelId: 'third' }] };
  const block = multiwayBlocks(r)[0];
  const selected = selectBlock(r, block)!;
  expect(selected.templateId).toBeUndefined();
  expect(selected.excluded ?? []).toEqual([]);
  expect(frameWindows(r, selected).map(w => w.panelId)).toEqual(['w', 'other', 'third']);
});
