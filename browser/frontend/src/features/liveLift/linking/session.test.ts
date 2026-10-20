import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { deserializeSavedState, serializeState } from '../../../stores/historySlice';
import type { PanelConfig } from '../../../types';
import { registerLiftLinkingUi } from './register';
import { LIFT_RIBBON_TRACK } from './liftLink';

describe('linked source views in sessions', () => {
  it('keep their link, orientation, picked correspondence and ribbon row through save and restore', () => {
    registerLiftLinkingUi();
    const source = { id: 'src', contentType: 'dataset', datasetId: 'native', collapsed: false, linkGroup: null, genome: 'contigs:native',
      subTracks: [{ type: LIFT_RIBBON_TRACK, visible: true }, { type: 'axis', visible: true }, { type: 'reads', visible: true }],
      viewportOverride: { chrom: 'chr3_MATERNAL', start: 100, end: 200 },
      liftLink: { id: 'L', datasetId: 'lift', liftPanelId: 'mat', hap: 'HG002#2', hapLabel: 'MAT', contig: 'chr3_MATERNAL', flip: true, chain: 7 } } as PanelConfig;
    useBrowserStore.setState({ panels: [source], datasets: [{ id: 'native', path: '/s.bam', label: 'n', color: '#000', data_type: 'bam' }] });
    const saved = JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())));
    const restored = deserializeSavedState(saved);
    const panel = (restored.panels as PanelConfig[]).find(p => p.id === 'src')!;
    expect(panel.liftLink).toEqual(source.liftLink);
    expect(panel.viewportOverride).toEqual(source.viewportOverride);
    expect(panel.subTracks.map(t => t.type)).toContain(LIFT_RIBBON_TRACK);
  });
});
