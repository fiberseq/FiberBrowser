import type { CompactRead, ReadsResponse } from '../components/tracks/read-track/types';
import { addReadIntervals } from '../utils/metaprofileBins';

/** Recompute the server's uncapped, layer-backed profiles from clipped calls. */
export function readRegionProfiles(reads: CompactRead[], width: number, requested: string[]): NonNullable<ReadsResponse['metaprofile']> {
  const bins = Math.max(1, Math.min(500, width));
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
  // Half-open [s, e), for coverage and signal alike: an interval touches the bins floor(s / bin) .. ceil(e / bin) - 1,
  // as on the server, in ReadTrack and in the headless engine (also when bins are fractional bases wide). Each read
  // adds the union of its intervals' bins per profile (two calls meeting inside a bin count the read once there;
  // utils/metaprofileBins).
  for (const read of reads) {
    const primary = read.intervals;
    if (!primary.length) continue;
    // Coverage spans every layer and FIRE interval the read carries, whichever profiles were asked for (as ReadTrack).
    let readStart = primary[0][0], readEnd = primary[primary.length - 1][1];
    const widen = (s: number, e: number) => { if (s < readStart) readStart = s; if (e > readEnd) readEnd = e; };
    for (const layer of Object.values(read.layers || {})) for (const [s, e, size] of layer?.intervals || []) if (size > 0) widen(s, e);
    for (const [s, e] of read.fire || []) widen(s, e);
    addReadIntervals(coverage, [[readStart, readEnd]], width, bins);
    for (const { source, min, max, diff } of definitions.values()) {
      const layer = source ? (read.layers?.[source] ?? (source === 'fire' ? read.layers?.msp : undefined)) : undefined;
      const intervals = source === null ? primary : layer?.intervals
        ?? (read.derived_layers?.includes(source!) ? primary.filter(iv => iv[2] > 0)
          : source === 'fire' ? read.fire || [] : []);
      const kept: [number, number][] = [];
      for (const [s, e, size] of intervals) if (size > 0 && size >= min && size <= max) kept.push([s, e]);
      addReadIntervals(diff, kept, width, bins);
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
