import '../features/testSetup';
import { afterEach, expect, it, vi } from 'vitest';
import { applyImportedState, collectFrontendState } from '../api/session';
import { useBrowserStore } from '../stores/browserStore';
import { useSplitPanelStore } from '../stores/splitPanelStore';
import { splitBySv } from './svAlleleSplit';
import { loadSplitGrouping, openSplitPanels, resolveSplitPanels, splitRows } from './splitPanels';

const initial = useBrowserStore.getState();
afterEach(() => { vi.unstubAllGlobals(); useBrowserStore.setState(initial, true); });

it('single-SV panels keep each group\'s evidence markers through serialize, import and resolution', async () => {
  const source = { id: 'source', contentType: 'dataset' as const, datasetId: 'ds', stateKey: 'source-key',
    subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 };
  useBrowserStore.setState({ panels: [source], chrom: 'chrT', start: 0, end: 2000 });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    assignments: { c: 0, p: 0, x: 0, a: 0, r: 1, n: 2 }, counts: [4, 1, 1],
    evidence_levels: { c: 'confirmed', p: 'putative', x: 'conflicting', a: 'ambiguous' }, margin: 100,
  }))));
  await splitBySv({ stateKey: 'source-key', datasetId: 'ds', chrom: 'chrT', viewStart: 0, viewEnd: 2000,
    includePutative: true, includeConflicting: true, includeAmbiguous: true }, { t: 'I', ref: 1000, len: 100 });
  const grouping = await loadSplitGrouping({ kind: 'frozen', panelId: 'source', title: 'Insertion' });
  expect(grouping.groups.find(g => g.key === '0')?.ruleExtras?.svEvidenceLevels)
    .toEqual({ c: 'confirmed', p: 'putative', x: 'conflicting', a: 'ambiguous' });
  expect(grouping.groups.find(g => g.key === '1')?.ruleExtras?.svEvidenceLevels).toBeUndefined();
  const rows = splitRows(grouping).map(r => ({ ...r, checked: true }));
  expect(openSplitPanels(grouping, rows, [source])).toHaveProperty('groupId');
  const markers = () => useBrowserStore.getState().panels.find(p => p.readSubset?.rule.groupKeys.includes('0'))?.readSubset?.rule.svEvidenceLevels;
  const expected = { c: 'confirmed', p: 'putative', x: 'conflicting', a: 'ambiguous' };
  expect(markers()).toEqual(expected);
  const saved = JSON.parse(JSON.stringify(collectFrontendState()));
  useBrowserStore.setState({ panels: [], svCarrierEvidence: {} });
  useSplitPanelStore.setState({ reads: {} });
  applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: saved,
    viewport: { chrom: 'chrT', start: 0, end: 2000 } });
  await resolveSplitPanels();
  expect(markers()).toEqual(expected);
  const carrier = useBrowserStore.getState().panels.find(p => p.readSubset?.rule.groupKeys.includes('0'))!;
  expect(useSplitPanelStore.getState().reads[carrier.stateKey!].ids).toEqual(new Set(['c', 'p', 'x', 'a']));
});
