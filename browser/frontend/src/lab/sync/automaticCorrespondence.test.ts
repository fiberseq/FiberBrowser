import { expect, it } from 'vitest';
import { automaticCorrespondences } from './automaticCorrespondence';
import { useBrowserStore } from '../../stores/browserStore';

it('offers identical reference windows as an identity correspondence', () => {
  const windows = ['a', 'b'].map(panelId => ({ panelId, datasetId: panelId, label: panelId, chrom: 'chr1', genome: null, start: 100, end: 200 }));
  expect(automaticCorrespondences(useBrowserStore.getState(), windows)[0]).toMatchObject({
    blocks: [{ template: [100, 200], window: [100, 200] }], identity: 1, aligned: 100,
  });
});

it.each([false, true])('offers cropped SV flanks with the carrier as template=%s', carrierFirst => {
  const s = useBrowserStore.getState();
  const panels = [{ id: 'carrier', datasetId: 'alt', genome: 'alt-ref', contentType: 'dataset', readSubset: { groupId: 'split' },
    altAllele: { cluster: { datasetId: 'bam' }, layout: { chrom: 'chr1', ref: 1000, flank_left: 100, flank_right: 200, name: 'insert', insert_len: 50 } } },
  { id: 'reference', datasetId: 'bam', contentType: 'dataset', readSubset: { groupId: 'split' } }];
  const carrier = { panelId: 'carrier', datasetId: 'alt', label: 'Carrier', genome: 'alt-ref', chrom: 'insert', start: 20, end: 300 };
  const reference = { panelId: 'reference', datasetId: 'bam', label: 'Reference', genome: null, chrom: 'chr1', start: 940, end: 1120 };
  const windows = carrierFirst ? [carrier, reference] : [reference, carrier];
  const proposal = automaticCorrespondences({ ...s, chrom: 'chr1', panels } as never, windows)[0];
  const blocks = [{ template: [40, 100], window: [940, 1000] }, { template: [150, 270], window: [1000, 1120] }];
  expect(proposal.blocks).toEqual(carrierFirst ? blocks : blocks.map(b => ({ template: b.window, window: b.template })));
  expect(proposal.aligned).toBe(180);
});
