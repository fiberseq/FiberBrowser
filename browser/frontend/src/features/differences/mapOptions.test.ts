import { describe, expect, it } from 'vitest';
import { mapOptionsFor } from './AssemblyComparisonPanel';
import type { Dataset } from '../../types';

const ds = (id: string, data_type: string, samples?: string[]) => ({ id, label: id, path: `/${id}.bam`, color: '#000', data_type,
  ...(samples ? { read_group_samples: samples } : {}) }) as unknown as Dataset;

describe("the native inspector compares with the assembly of the dataset's own sample", () => {
  const native = ds('nativeA', 'bam', ['A.1', 'A.2']);
  it('picks the lifted dataset of the same sample, whatever was opened first', () => {
    const all = [ds('liftB', 'bam_livelift', ['B.1']), ds('liftA', 'bam_livelift', ['A.2']), native];
    expect(mapOptionsFor(native, all)).toMatchObject({ reason: 'one', map: { id: 'liftA' } });
  });
  it('asks the user when several lifted datasets of the sample are open, and keeps the pick', () => {
    const all = [ds('liftA1', 'bam_livelift', ['A.1']), ds('liftA2', 'bam_livelift', ['A.2']), ds('liftB', 'bam_livelift', ['B.1']), native];
    const open = mapOptionsFor(native, all);
    expect(open.map).toBeNull();
    expect(open.reason).toBe('several_of_sample');
    expect(open.options.map(d => d.id)).toEqual(['liftA1', 'liftA2']);
    expect(mapOptionsFor(native, all, 'liftA2').map?.id).toBe('liftA2');
  });
  it('compares with nothing automatically when no lifted dataset is of the sample, but offers them', () => {
    const all = [ds('liftB', 'bam_livelift', ['B.1']), native];
    const o = mapOptionsFor(native, all);
    expect(o).toMatchObject({ map: null, reason: 'none_of_sample' });
    expect(o.options.map(d => d.id)).toEqual(['liftB']);
    expect(mapOptionsFor(native, all, 'liftB').map?.id).toBe('liftB');
  });
  it('uses the only lifted dataset when samples are unknown, and asks when there are several', () => {
    const anon = ds('native', 'bam');
    expect(mapOptionsFor(anon, [ds('lift1', 'bam_livelift'), anon]).map?.id).toBe('lift1');
    const two = mapOptionsFor(anon, [ds('lift1', 'bam_livelift'), ds('lift2', 'bam_livelift'), anon]);
    expect(two).toMatchObject({ map: null, reason: 'unknown_samples' });
  });
  it("a lifted panel always uses its own map; none open gives none", () => {
    const l = ds('liftA', 'bam_livelift', ['A.1']);
    expect(mapOptionsFor(l, [ds('liftB', 'bam_livelift'), l]).map?.id).toBe('liftA');
    expect(mapOptionsFor(native, [native])).toMatchObject({ map: null, reason: 'none' });
  });
});
