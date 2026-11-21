/** Dev line: FiberHMM var / sv layers stay quiet where they don't apply (live-lift datasets, graph-mode hosts and
 * linked source-assembly panels). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Dataset } from '../../types/dataset';
import type { PanelConfig } from '../../stores/panelSlice';
import { useBrowserStore } from '../../stores/browserStore';
import { trackMenuItems } from '../../components/tracks/trackRegistry';
import { datasetVariantLayers } from './model';
import { registerFiberhmmLayers } from './register';

const bigbed = { id: 'bb', data_type: 'bigbed', layer_type: 'footprint', companion_layers: { var: ['v.bb'], sv: ['s.bb'] } } as unknown as Dataset;
const lifted = { id: 'll', data_type: 'bam_livelift', companion_layers: { var: ['v.bb'], sv: ['s.bb'] } } as unknown as Dataset;
const panel = (extra: Partial<PanelConfig>) => ({ id: 'p', contentType: 'dataset', datasetId: 'bb', ...extra }) as PanelConfig;

describe('FiberHMM var / sv layers on the dev line', () => {
  beforeEach(() => { registerFiberhmmLayers(); useBrowserStore.setState({ datasets: [bigbed, lifted] } as never); });

  it('never apply to live-lift (or other non-bigBed) datasets', () => {
    expect(datasetVariantLayers(lifted)).toEqual({ var: false, sv: false });
    expect(trackMenuItems('reads', { panel: panel({ datasetId: 'll' }), type: 'reads', datasetId: 'll', stateKey: 'll' } as never)
      .filter(i => i.id.startsWith('fiberhmm-'))).toEqual([]);
  });

  it('offer their Show items on a linear bigBed panel only', () => {
    const ids = (p: PanelConfig) => trackMenuItems('reads', { panel: p, type: 'reads', datasetId: 'bb', stateKey: 'bb' } as never)
      .map(i => i.id).filter(id => id.startsWith('fiberhmm-'));
    expect(ids(panel({}))).toEqual(['fiberhmm-sv', 'fiberhmm-var']);
    expect(ids(panel({ viewMode: 'graph' } as Partial<PanelConfig>))).toEqual([]);
    expect(ids(panel({ liftLink: { sourceDatasetId: 'x' } } as unknown as Partial<PanelConfig>))).toEqual([]);
  });

  it('offers no FiberHMM SV / allele items on the meta-locus contig (bigBed layers are on a real assembly)', () => {
    const ids = (p: PanelConfig) => trackMenuItems('reads', { panel: p, type: 'reads', datasetId: 'bb', stateKey: 'bb' } as never)
      .map(i => i.id).filter(id => id.startsWith('fiberhmm-'));
    useBrowserStore.setState({ chrom: 'meta:abc123', start: 0, end: 20000 } as never);
    expect(ids(panel({}))).toEqual([]);
    expect(ids(panel({ viewportOverride: { chrom: 'chr19', start: 0, end: 10 } } as Partial<PanelConfig>))).toEqual(['fiberhmm-sv', 'fiberhmm-var']);
    useBrowserStore.setState({ chrom: 'chr19' } as never);
    expect(ids(panel({ viewportOverride: { chrom: 'meta:abc123', start: 0, end: 10 } } as Partial<PanelConfig>))).toEqual([]);
  });
});
