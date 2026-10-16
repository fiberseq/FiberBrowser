import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../types';
import { figureFooterText, figureRegions, figureTitleText } from './figureRegions';

/** fb-r2-integ (5): exports name each panel's reference and locus. */
const panel = (over: Partial<PanelConfig>): PanelConfig => ({
  id: over.id ?? 'p', contentType: 'dataset', datasetId: 'ds', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over,
}) as PanelConfig;
const main = { chrom: 'chr2L', start: 1_000, end: 2_000 };
const label = (key: string | null) => (key === null ? 'hg38' : key === 'dm6' ? 'dm6' : key);

describe('figure regions', () => {
  it('one region: the main view, as before (no reference label)', () => {
    const regions = figureRegions({ ...main, panels: [panel({ id: 'a' }), panel({ id: 'b', datasetId: 'ds2' })] }, label);
    expect(regions).toEqual(['chr2L:1,000-2,000']);
    expect(figureTitleText(regions)).toBe('chr2L:1,000-2,000');
    expect(figureFooterText(regions)).toBe('chr2L:1,000-2,000');
  });

  it('panels on two assemblies at the same coordinates are two regions, each with its reference', () => {
    const regions = figureRegions({ ...main, panels: [
      panel({ id: 'a' }),
      panel({ id: 'b', datasetId: 'fly', genome: 'dm6', viewportOverride: { ...main } }),
    ] }, label);
    expect(regions).toEqual(['hg38 chr2L:1,000-2,000', 'dm6 chr2L:1,000-2,000']);
    expect(figureTitleText(regions)).toContain('dm6 chr2L:1,000-2,000');
    expect(figureFooterText(regions)).toContain('hg38 chr2L:1,000-2,000');
  });

  it('per-panel loci on one assembly are listed (minimized panels are not in the figure)', () => {
    const regions = figureRegions({ ...main, panels: [
      panel({ id: 'a', navOwn: true, viewportOverride: { chrom: 'chr1', start: 10, end: 20 } }),
      panel({ id: 'b', navOwn: true, viewportOverride: { chrom: 'chr3', start: 30, end: 40 } }),
      panel({ id: 'c', collapsed: true, viewportOverride: { chrom: 'chr9', start: 1, end: 2 } }),
    ] }, label);
    expect(regions).toEqual(['chr1:10-20', 'chr3:30-40']);
    expect(figureTitleText(['a', 'b', 'c', 'd'])).toBe('4 regions');
    // A folded row is not in the figure either.
    expect(figureRegions({ ...main, collapsedRows: new Set([1]), panels: [
      panel({ id: 'a' }),
      panel({ id: 'b', datasetId: 'fly', genome: 'dm6', layoutRow: 1, viewportOverride: { ...main } }),
    ] }, label)).toEqual(['chr2L:1,000-2,000']);
  });
});
