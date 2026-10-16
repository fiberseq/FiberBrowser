import { expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { peakScanScope } from './peakScanScope';

it('keeps ordinary scans after cosmetic panel changes and unrelated rule edits', () => {
  const initial = useBrowserStore.getState();
  const s = { ...initial, datasets: [{ id: 'd' }], panels: [{ id: 'p', datasetId: 'd', contentType: 'dataset' }] } as typeof initial;
  const rule = s.peakRules[0];
  const scope = peakScanScope(s, rule.id);
  expect(peakScanScope({ ...s, panels: s.panels.map(p => ({ ...p, title: 'Renamed' })),
    peakRules: [...s.peakRules, { ...rule, id: 'another-rule' }] }, rule.id)).toBe(scope);
  expect(peakScanScope({ ...s, panels: s.panels.map(p => ({ ...p, viewportOverride: { chrom: 'chr1', start: 1, end: 200 } })) }, rule.id)).not.toBe(scope);
  expect(peakScanScope({ ...s, signalFilters: { ...s.signalFilters, requireDetectable: true } }, rule.id)).not.toBe(scope);
  expect(peakScanScope({ ...s, _lastRestoreTime: s._lastRestoreTime + 1 }, rule.id)).not.toBe(scope);
  expect(peakScanScope({ ...s, filteredReadIds: { d: new Set(['read']) } }, rule.id)).not.toBe(scope);
  expect(peakScanScope({ ...s, peakRules: s.peakRules.map(r => r.id === rule.id ? { ...r, minReads: r.minReads + 1 } : r) }, rule.id)).not.toBe(scope);
});
