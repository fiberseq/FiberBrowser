import type { CompactRead, ReadsResponse } from '../components/tracks/read-track/types';

/** Recompute the server's uncapped, layer-backed profiles from clipped calls. */
export function readRegionProfiles(reads: CompactRead[], width: number, requested: string[]): NonNullable<ReadsResponse['metaprofile']> {
  const bins = Math.max(1, Math.min(500, width));
  const binSize = width / bins;
  const available = new Set<string>();
  for (const read of reads) {
    for (const name of Object.keys(read.layers || {})) available.add(name);
    for (const name of read.derived_layers || []) available.add(name);
    if (read.fire?.length) available.add('fire');
  }
  if (available.has('msp')) available.add('fire');
  const definitions = new Map<string, { source: string | null; min: number; max: number; diff: Float64Array }>();
  for (let name of requested) {
    name = name === 'msp' ? 'fire' : name === 'mod' ? 'm6a' : name;
    if (!name || definitions.has(name)) continue;
    let source: string | null = name, min = 1, max = 100000;
    if (name === 'nuc' && !available.has('nuc')) {
      source = available.has('footprint') ? 'footprint' : null;
      if (source === null) min = 90;
    } else if (name === 'footprint' && !available.has('footprint')) source = available.has('nuc') ? 'nuc' : null;
    else if (name === 'tf' && !available.has('tf')) { source = null; max = 89; }
    else if (name !== 'fire' && !available.has(name)) continue;
    definitions.set(name, { source, min, max, diff: new Float64Array(bins + 1) });
  }
  const coverage = new Float64Array(bins + 1);
  // Half-open [s, e): the bins of s .. e - 1, for coverage and signal alike (the server's rule since
  // "Use the same half-open bins for metaprofile signal and coverage").
  const add = (diff: Float64Array, s: number, e: number) => {
    s = Math.max(0, Math.min(width, s)); e = Math.max(0, Math.min(width, e));
    if (e <= s) return;
    const lo = Math.min(bins - 1, Math.floor(s / binSize));
    const hi = Math.min(bins - 1, Math.floor(Math.max(s, e - 1) / binSize));
    diff[lo]++; diff[hi + 1]--;
  };
  for (const read of reads) {
    const primary = read.intervals;
    if (!primary.length) continue;
    add(coverage, primary[0][0], primary[primary.length - 1][1]);
    for (const { source, min, max, diff } of definitions.values()) {
      const layer = source ? (read.layers?.[source] ?? (source === 'fire' ? read.layers?.msp : undefined)) : undefined;
      const intervals = source === null ? primary : layer?.intervals
        ?? (read.derived_layers?.includes(source!) ? primary.filter(iv => iv[2] > 0)
          : source === 'fire' ? read.fire || [] : []);
      for (const [s, e, size] of intervals) if (size > 0 && size >= min && size <= max) add(diff, s, e);
    }
  }
  coverage[0] = Math.fround(coverage[0]);
  for (let i = 1; i < bins; i++) coverage[i] = Math.fround(Math.fround(coverage[i]) + coverage[i - 1]);
  const layers: Record<string, number[]> = {};
  for (const [name, { diff }] of definitions) {
    let sum = 0;
    layers[name] = Array.from({ length: bins }, (_, i) => {
      sum = Math.fround(sum + Math.fround(diff[i]));
      const scaled = Math.fround(sum / (coverage[i] || 1)) * 1e6;
      const lo = Math.floor(scaled);
      return (scaled - lo === 0.5 ? lo + lo % 2 : Math.round(scaled)) / 1e6;
    });
  }
  if (layers.footprint && !layers.nuc) layers.nuc = layers.footprint;
  return { nucleosome_profile: layers.nuc || [], subnuc_profile: [], layers };
}
