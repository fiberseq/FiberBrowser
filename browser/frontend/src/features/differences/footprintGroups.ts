import type { LensLayout } from '../insertion/insertionLensModel';

export type FootprintGrouping = 'none' | 'nuc' | 'msp';
export interface FootprintGroup { pattern: string; indices: number[] }

/** Combinatorial footprint clustering at fixed alternate-local probes.
 * 1 = footprint, 0 = observed without that footprint, ? = unavailable.
 * Groups only reorder an already frozen cohort; no read is dropped or rescanned.
 */
export function footprintGroups(layout: LensLayout, layer: FootprintGrouping, sites = 4): FootprintGroup[] {
  if (layer === 'none') return [];
  const n = Math.max(2, Math.min(4, Math.round(sites)));
  const groups = new Map<string, number[]>();
  const names = layer === 'msp' ? ['msp', 'fire'] : ['nuc'];
  layout.carriers.forEach((read, index) => {
    const layers = names.flatMap(name => read.layers?.[name] ? [read.layers[name]] : []);
    const covered = layout.carrierCoverage?.[index] ?? [];
    const pattern = Array.from({ length: n }, (_, i) => {
      const forward = Math.floor(layout.axis.flank + (i + 0.5) * layout.axis.displayLen / n);
      const x = layout.axis.reversed ? layout.axis.total - 1 - forward : forward;
      if (!layers.length || !covered.some(([a, b]) => a <= x && x < b)) return '?';
      return layers.some(value => value.intervals.some(([a, b]) => a <= x && x < b)) ? '1' : '0';
    }).join('');
    const indices = groups.get(pattern) ?? [];
    indices.push(index); groups.set(pattern, indices);
  });
  return [...groups].map(([pattern, indices]) => ({ pattern, indices }))
    .sort((a, b) => b.indices.length - a.indices.length || a.pattern.localeCompare(b.pattern));
}
