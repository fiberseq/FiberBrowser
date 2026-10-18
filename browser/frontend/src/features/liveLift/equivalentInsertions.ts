import type { Difference } from './differenceTypes';
import type { LiveLiftExpansion } from './axis';
import type { LiveLiftRow } from '../../components/tracks/read-track/types';

/** Boundary association only: lengths retain a common bp scale. This does
 * not assert an internal sequence alignment between the two inserted alleles. */
export function equivalentInsertions(selected: Difference, items: Difference[]) {
  const byHap = new Map<string, Difference[]>();
  for (const d of items) {
    if (d.kind !== 'insertion' || d.t_start !== selected.t_start || d.alt_bp > 50_000
      || Math.abs(d.alt_bp - selected.alt_bp) > Math.max(3, selected.alt_bp * .1)) continue;
    const group = byHap.get(d.hap_label) ?? [];
    if (!group.some(g => g.id === d.id)) group.push(d);
    byHap.set(d.hap_label, group);
  }
  return [selected, ...[...byHap.entries()].flatMap(([hap, group]) => hap !== selected.hap_label && group.length === 1 ? group : [])];
}

export function payloadForExpansion(row: LiveLiftRow | undefined, block: LiveLiftExpansion) {
  const id = block.alleles?.find(a => a.hap_label === row?.hap_label)?.ins_id ?? block.ins_id;
  const payload = row?.insertions?.[id];
  return payload && !('too_large' in payload) ? payload : undefined;
}
