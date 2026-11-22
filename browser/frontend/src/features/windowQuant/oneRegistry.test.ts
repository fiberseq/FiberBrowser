/** Quantify a window and Plots' metaprofile sources read feature families from one module (hub/familySources). */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/features', async orig => ({ ...(await orig<typeof import('../../api/features')>()),
  getFeatureStates: vi.fn(async () => ({ by_dataset: { ds: { r0: '1', r1: '0', r2: '.' } } })) }));

import * as shared from '../hub/familySources';
import * as wq from './sources';
import { PLOT_FAMILY_KINDS } from '../plots/useFamilySources';
import { GEO_TYPE_ID } from '../nucleosomes/geoHub';
import { listMeasures, unitKey, type LoadContext } from './measures';

describe('one registry for families and NFRs', () => {
  it('the same kinds, ids and geometry type in both features', () => {
    expect(wq.FAMILY_KINDS).toBe(shared.FAMILY_KINDS);
    expect(wq.familyMeasureId).toBe(shared.familyMeasureId);
    for (const k of PLOT_FAMILY_KINDS) expect(shared.FAMILY_KINDS).toContain(k);
    expect(shared.FAMILY_KINDS.find(k => k.source === 'nuc-geometries')!.typeIds).toEqual([GEO_TYPE_ID]);
  });
  it('Quantify\'s picker lists every shared kind as a source, with its step when there are none', () => {
    const ctx = { state: { datasets: [] }, view: { chrom: 'chr1', start: 0, end: 1000, genome: null }, bounds: { from: 0, to: 1000 },
      allReads: { panels: [] }, clusters: null, extras: {} } as never;
    const ids = listMeasures(ctx).map(x => x.source.id);
    for (const k of shared.FAMILY_KINDS) expect(ids).toContain(k.source);
    const nfr = wq.familyMeasures(ctx, shared.FAMILY_KINDS.find(k => k.source === 'nfr-families')!)[0];
    expect(nfr.available).toMatchObject({ step: { prereq: 'nfr' } });
  });
  it('shares come from the shared membership rule (member, scored, not scored)', async () => {
    const hit = { setId: 's', hitId: 'h', start: 0, end: 10, chrom: 'chr1', hasStates: true, refs: [] } as never;
    const spy = vi.spyOn(shared, 'familyHits').mockReturnValue([hit]);
    vi.spyOn(shared, 'loadFamilyMembership').mockResolvedValue(new Map([[shared.familyMeasureId(hit), {
      id: 'fam:s|h', label: 'h', span: [0, 10] as [number, number], chrom: 'chr1', members: { ds: new Set(['r0']) }, evaluated: { ds: new Set(['r0', 'r1']) } }]]));
    const kind = shared.FAMILY_KINDS[0];
    const d = await wq.loadFamilies([{ id: 'fam:s|h' } as never], { state: {}, view: { chrom: 'chr1', start: 0, end: 1000 } } as unknown as LoadContext, kind);
    const units = d['fam:s|h'].units!;
    expect(units.get(unitKey('ds', 'r0'))!.slice(0, 2)).toEqual([1, 1]);
    expect(units.get(unitKey('ds', 'r1'))!.slice(0, 2)).toEqual([0, 1]);
    expect(units.has(unitKey('ds', 'r2'))).toBe(false);
    spy.mockRestore();
  });
});
