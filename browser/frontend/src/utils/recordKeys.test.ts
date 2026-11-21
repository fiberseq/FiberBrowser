import { describe, expect, it } from 'vitest';
import fixture from '../features/graphPanel/fixtures/recordKeys.json';
import { idSetHas, orderIndex, recordKey, recordKeysOf, recordValueIndex } from './recordKeys';
import { filterReadsByReadIdSet, readIdKeys } from '../components/tracks/read-track/readFilter';

const aid = (molecule: string, q: string, record: string | null, row: number | null, placement = 'primary') =>
  `lift-cohort:v1 ${JSON.stringify([molecule, q, record, row, placement])}`;

describe('record keys (DESIGN_GRAPH_PRIMARY §3.1)', () => {
  it('derive exactly as the server does (shared fixture)', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of fixture.cases) expect(recordKey(c.id), c.note).toBe(c.record_key);
  });

  it('name every row of a record and only that record', () => {
    const graph = aid('d#0|q1', 'q1', 's:0', 0);
    const split = aid('d#0|q1', 'q1', 's:0', 1, 'alt:2');
    expect(recordKey(split)).toBe(recordKey(graph));
    expect(recordKey(aid('d#0|q1', 'q1', 's:1', 0))).not.toBe(recordKey(graph));
    // A record key in an id set keeps the linear rows of that record (exact ids stay exact).
    const rows = [{ id: 'q1', analysis_id: graph }, { id: 'q1', analysis_id: split }, { id: 'q2', analysis_id: aid('d#0|q2', 'q2', 's:0', 0) }];
    expect(filterReadsByReadIdSet(rows, new Set([recordKey(graph)!])).map(r => r.analysis_id)).toEqual([graph, split]);
    expect(filterReadsByReadIdSet(rows, new Set([split])).map(r => r.analysis_id)).toEqual([split]);
    expect(readIdKeys(rows[0])).toContain(recordKey(graph));
  });

  it('re-key assignments with the primary placement\'s lowest row first', () => {
    const a = { [aid('m|q', 'q', 'r', 1)]: 4, [aid('m|q', 'q', 'r', 0, 'alt:1')]: 5, [aid('m|q', 'q', 'r', 0)]: 2, plain: 9 };
    const idx = recordValueIndex(a);
    expect(idx.get(recordKey(aid('m|q', 'q', 'r', 0))!)).toBe(2);
    expect(idx.size).toBe(1);
    expect(recordValueIndex(a)).toBe(idx);   // memoised
  });

  it('match id sets and orders by identity or record key', () => {
    const linear = aid('m|q', 'q', 'r', 1);
    const set = new Set([linear]);
    expect(recordKeysOf(set).has(recordKey(linear)!)).toBe(true);
    expect(idSetHas(set, ['q', aid('m|q', 'q', 'r', 0)], recordKey(linear))).toBe(true);
    expect(idSetHas(new Set(['other']), ['q'], recordKey(linear))).toBe(false);
    expect(orderIndex(['x', linear]).get(recordKey(linear)!)).toBe(1);
  });
});

describe('record keys review fixes (G0 Codex)', () => {
  it('ranks the linear producer\'s own placements: numeric chains are primary, alt chains are alternatives', () => {
    const alt = aid('m|q', 'q', 'r', 0, 'alt9');
    const primary = aid('m|q', 'q', 'r', 0, '17');
    // The alternative first in the map: the primary still wins.
    expect(recordValueIndex({ [alt]: 9, [primary]: 2 }).get(recordKey(primary)!)).toBe(2);
    expect(recordValueIndex({ [aid('m|q', 'q', 'r', 1, '17')]: 5, [aid('m|q', 'q', 'r', 0, 'alt3')]: 6 }).get(recordKey(primary)!)).toBe(5);
  });
  it('escapes DEL as Python does', () => {
    const id = `lift-cohort:v1 ["g\\u007f|q","q","r",0,"primary"]`;
    expect(recordKey(id)).toBe('lift-record:v1 ["g\\u007f|q","q","r"]');
  });
});
