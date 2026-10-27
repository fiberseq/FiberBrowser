import { describe, expect, it } from 'vitest';
import { deriveModeOptions, nucClusterModeOptions } from './ClusterPanel';

const ids = (options: Array<{ id: string }>) => options.map(o => o.id);

describe('nucleosome cluster modes', () => {
  it('none without nucsz / nucseg', () => {
    expect(nucClusterModeOptions([{ available_layers: { nuc: true, tf: true } }])).toEqual([]);
  });

  it('size modes with nucsz; array and event modes with nucseg', () => {
    expect(ids(nucClusterModeOptions([{ available_layers: { nuc: true, nucsz: true } }]))).toEqual([
      'nuc.size.short', 'nuc.size.mono', 'nuc.size.long', 'nuc.size.multi2', 'nuc.size.multi3',
      'nuc.size.cant_tell', 'nuc.size.edge_truncated', 'nuc.size.tf',
    ]);
    const seg = nucClusterModeOptions([{ available_layers: { nuc: true } }, { available_layers: { nucseg: true } }]);
    expect(ids(seg)).toEqual([
      'nuc.seg.regular', 'nuc.seg.disordered', 'nuc.seg.undetermined', 'nuc.seg.low_information',
      'nuc.event.undersized', 'nuc.event.missing',
    ]);
    expect(seg).toContainEqual({ id: 'nuc.event.missing', label: 'Nuc event: missing nucleosome' });
    expect(seg).toContainEqual({ id: 'nuc.seg.regular', label: 'Nuc array: regular' });
  });

  it('the raw scan groups are never layer modes', () => {
    const options = deriveModeOptions([{ available_layers: { nuc: true, tf: true, nucsz: true, nucseg: true, nucmol: true, nfrmol: true } }]);
    for (const raw of ['nucsz', 'nucseg', 'nucmol', 'nfrmol']) expect(ids(options)).not.toContain(raw);
    expect(ids(options)).toEqual(expect.arrayContaining(['nuc', 'tf']));
  });
});
