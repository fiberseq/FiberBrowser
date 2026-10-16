import { describe, expect, it } from 'vitest';
import { metaprofileExportColumns } from './metaprofileExport';

describe('metaprofileExportColumns', () => {
  const base = { chrom: 'chr1', start: 0, end: 100 };
  const src = { id: 's', ref: { kind: 'metaprofile', ruleId: 'nuc' }, color: '#000', visible: true } as never;

  it("reads each main-view panel's own profile, including a copy's state key", () => {
    const cols = metaprofileExportColumns({
      ...base,
      datasets: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'a' },
        { id: 'p2', contentType: 'dataset', datasetId: 'b', stateKey: 'copyB' },
        // At another locus: its profile isn't for this region.
        { id: 'p3', contentType: 'dataset', datasetId: 'a', stateKey: 'far', viewportOverride: { chrom: 'chr2', start: 0, end: 100 } },
      ] as never,
      datasetProfiles: { a: { layers: { nuc: [1] } }, copyB: { layers: { nuc: [2] } }, far: { layers: { nuc: [3] } } } as never,
    }, [src]);
    expect(cols).toEqual([
      { label: 'A:nuc', values: [1] },
      { label: 'B (copyB):nuc', values: [2] },
    ]);
  });

  it('keeps a single panel\'s column label plain', () => {
    const cols = metaprofileExportColumns({
      ...base,
      datasets: [{ id: 'a', label: 'A' }],
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'a', stateKey: 'k' }] as never,
      datasetProfiles: { k: { layers: { nuc: [5] } } } as never,
    }, [src]);
    expect(cols).toEqual([{ label: 'nuc', values: [5] }]);
  });
});
