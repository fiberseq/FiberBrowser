/**
 * One read as the read track's metaprofiles see it (ReadTrack computeMetaprofileFromReads), shared with Quantify a
 * window so the card counts exactly what the curve draws: channel spans (each layer, `layer:<name>`, msp as fire;
 * FIRE calls as 'fire'), marks (mod, layer:m6a, layer:m5c, layer:deam), and the read's span from its call intervals
 * (footprints and gaps as the panel shows them: terminal gaps hidden or not, as the panel asked). Colormap-rule spans
 * are added by the read track itself. Coordinates are the panel's window coordinates [0, view width).
 */
import type { ChannelRead } from '../features/plots/profileEngine';
import type { CompactRead } from '../components/tracks/read-track/types';

/** The mark (point) layers and the layerChannelRead point channels they read, first found wins: the curve draws them
 *  as marks per bp. One place for the read track's channels and Quantify a window's mark measures. */
export const MARK_LAYER_CHANNELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  m6a: ['layer:m6a', 'mod'], mod: ['layer:m6a', 'mod'], m5c: ['layer:m5c'], deam: ['layer:deam'],
});

export const isMarkLayer = (key: string): boolean => Object.prototype.hasOwnProperty.call(MARK_LAYER_CHANNELS, key);

/** A mark layer's positions from a read's point channels (layerChannelRead().points). */
export function markLayerPoints(points: Record<string, number[]>, key: string): number[] {
  for (const ch of MARK_LAYER_CHANNELS[key] ?? []) if (points[ch]?.length) return points[ch];
  return [];
}

/** A read's point channels (marks), region-relative: the same channels layerChannelRead gives. */
export function readPointChannels(read: Pick<CompactRead, 'methyl' | 'methyl_m6a' | 'methyl_m5c' | 'deam'>): Record<string, number[]> {
  const points: Record<string, number[]> = {};
  if (read.methyl?.length) points.mod = read.methyl;
  if (read.methyl_m6a?.length) points['layer:m6a'] = read.methyl_m6a;
  if (read.methyl_m5c?.length) points['layer:m5c'] = read.methyl_m5c;
  if (read.deam?.length) points['layer:deam'] = read.deam.map(([pos]) => pos);
  return points;
}

export function layerChannelRead(read: CompactRead): ChannelRead & { spans: Record<string, Array<[number, number]>>; points: Record<string, number[]> } {
  const spans: Record<string, Array<[number, number]>> = {};
  const points = readPointChannels(read);
  const push = (name: string, a: number, b: number) => { (spans[name] ??= []).push([a, b]); };
  let readStart = Infinity, readEnd = -Infinity;
  for (const [intervalStart, intervalEnd] of read.intervals) {
    if (intervalStart < readStart) readStart = intervalStart;
    if (intervalEnd > readEnd) readEnd = intervalEnd;
  }
  // Per-layer presence (quality filters were applied when the working set was built).
  if (read.layers) {
    for (const [layerName, layer] of Object.entries(read.layers)) {
      const ivs = layer?.intervals;
      if (!ivs || ivs.length === 0) continue;
      const name = `layer:${layerName === 'msp' ? 'fire' : layerName}`;
      for (const [intStart, intEnd, size] of ivs) if (size > 0) push(name, intStart, intEnd);
    }
  }
  if (read.fire) for (const [fStart, fEnd] of read.fire) push('fire', fStart, fEnd);
  return { start: readStart < readEnd ? readStart : 0, end: readStart < readEnd ? readEnd : 0, spans, points };
}
