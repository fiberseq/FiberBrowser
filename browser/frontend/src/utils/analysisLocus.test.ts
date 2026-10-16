import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../types';
import { analysisLoci, stateKeysAtLocus } from './analysisLocus';

const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;
const main = { chrom: 'chr1', start: 100, end: 200 };

describe('analysisLoci (fb-r2-integ)', () => {
  it('panels at the main view: one region, the main view', () => {
    const loci = analysisLoci({ ...main, panels: [panel('pa', 'a'), panel('pb', 'b')] }, ['a', 'b']);
    expect(loci).toEqual([{ ...main, genome: null, datasetIds: ['a', 'b'], stateKeys: ['a', 'b'], panelIds: ['pa', 'pb'] }]);
  });

  it('one region per locus and reference; untargeted panels do not count, minimized ones do', () => {
    const panels = [
      panel('pa', 'a', { navOwn: true, viewportOverride: { chrom: 'chr2', start: 1, end: 9 } }),
      panel('pf', 'fly', { genome: 'dm6', viewportOverride: { chrom: 'chr2', start: 1, end: 9 } }),
      panel('pc', 'c', { collapsed: true, viewportOverride: { chrom: 'chr9', start: 1, end: 9 } }),
      panel('pd', 'd', { viewportOverride: { chrom: 'chr7', start: 1, end: 9 } }),
    ];
    const loci = analysisLoci({ ...main, panels }, ['a', 'fly', 'c']);
    // A minimized panel's dataset is analysed all the same: its region counts.
    expect(loci.map(l => `${l.genome ?? ''}|${l.chrom}`)).toEqual(['|chr2', 'dm6|chr2', '|chr9']);
    // A dataset chosen by hand counts with all its panels.
    expect(analysisLoci({ ...main, panels }, [], ['d']).map(l => l.chrom)).toEqual(['chr7']);
    // No targeted panel: the main view.
    expect(analysisLoci({ ...main, panels }, ['zz'])).toEqual([{ ...main, genome: null, datasetIds: [], stateKeys: [], panelIds: [] }]);
  });

  it('results go to the panels showing the analysed region only', () => {
    const panels = [panel('pa', 'a'), panel('pc', 'a', { stateKey: 'pc', viewportOverride: { chrom: 'chr5', start: 1, end: 9 } })];
    expect(stateKeysAtLocus({ ...main, panels }, { chrom: 'chr5', start: 1, end: 9 })).toEqual(['pc']);
    expect(stateKeysAtLocus({ ...main, panels }, { ...main, genome: null })).toEqual(['a']);
  });
});
