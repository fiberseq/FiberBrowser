import type { PeakMode } from '../types';

/**
 * Clustering reads from panels at different loci together (a copy on another
 * chromosome or haplotype): each window gets its own peaks, matched
 * one-to-one, so every read is described by the same features.
 */

export interface LocusWindow { result_key: string; chrom: string; start: number; end: number; genome?: string | null }
export interface LocatedPeak { start: number; end: number; mode?: PeakMode | string; chrom?: string; genome?: string }
export interface WindowPeak { start: number; end: number; mode: PeakMode | string }

export interface AlignedLocusPeaks {
  /** result_key -> that window's peaks (absolute), in matched order. */
  byWindow: Record<string, WindowPeak[]>;
  /** How many peaks were matched in each window. */
  count: number;
  /** Set when windows had different numbers of peaks (only the first `count` of each were used). */
  note?: string;
}

const inWindow = (peak: LocatedPeak, w: LocusWindow, mainChrom: string) =>
  sameChrom(peak.chrom ?? mainChrom, w.chrom) && peak.start < w.end && peak.end > w.start
  && (!('genome' in w) || (peak.genome ?? null) === (w.genome ?? null));

/**
 * Peaks drawn or scanned in a window are that window's; a window without any
 * gets the first such window's peaks at the same offsets from its start. Peak
 * i of every window is matched, and each is cropped around its centre to the
 * narrowest of them, so the features line up.
 */
export function alignWindowPeaks(windows: LocusWindow[], peaks: LocatedPeak[], mainChrom: string): AlignedLocusPeaks | null {
  const own = new Map(windows.map(w => [w.result_key,
    peaks.filter(p => inWindow(p, w, mainChrom)).sort((a, b) => a.start - b.start)]));
  const withPeaks = windows.filter(w => own.get(w.result_key)!.length > 0);
  if (withPeaks.length === 0) return null;
  const counts = withPeaks.map(w => own.get(w.result_key)!.length);
  const count = Math.min(...counts);
  const ref = withPeaks[0];
  const refPeaks = own.get(ref.result_key)!.slice(0, count);

  const raw: Record<string, LocatedPeak[]> = {};
  for (const w of windows) {
    const mine = own.get(w.result_key)!;
    raw[w.result_key] = mine.length > 0
      ? mine.slice(0, count)
      : refPeaks.map(p => ({ ...p, start: w.start + (p.start - ref.start), end: w.start + (p.end - ref.start) }));
  }

  const byWindow: Record<string, WindowPeak[]> = {};
  for (const w of windows) byWindow[w.result_key] = [];
  for (let i = 0; i < count; i++) {
    const width = Math.min(...windows.map(w => raw[w.result_key][i].end - raw[w.result_key][i].start));
    for (const w of windows) {
      const p = raw[w.result_key][i];
      const start = Math.round((p.start + p.end) / 2 - width / 2);
      byWindow[w.result_key].push({ start, end: start + width, mode: refPeaks[i].mode ?? 'accessibility' });
    }
  }
  const differ = counts.some(c => c !== count);
  return {
    byWindow,
    count,
    ...(differ ? { note: `The panels have ${counts.join(' / ')} peaks; the first ${count} of each (left to right) were matched.` } : {}),
  };
}

export interface OtherLocusWindow {
  chrom: string; start: number; end: number;
  /** A panel on another assembly: its reference's key. */
  genome?: string;
  datasetIds: string[];
  /** datasetId -> the state keys of its panels there (whose reads a scan uses). */
  stateKeys: Record<string, string[]>;
}

/** Distinct regions shown by dataset panels at another locus than the main view, with their datasets. */
export function otherLocusWindows(
  panels: Array<{ id: string; contentType: string; datasetId?: string | null; stateKey?: string; collapsed?: boolean; genome?: string; viewportOverride?: { chrom: string; start: number; end: number } }>,
  chrom: string, start: number, end: number,
): OtherLocusWindow[] {
  const byKey = new Map<string, OtherLocusWindow>();
  for (const p of panels) {
    const v = p.viewportOverride;
    if (p.contentType !== 'dataset' || !p.datasetId || p.collapsed || !v) continue;
    if (!p.genome && sameChrom(v.chrom, chrom) && v.start === start && v.end === end) continue;
    // Same coordinates on two assemblies are two windows.
    const key = `${p.genome ? `${p.genome}|` : ''}${v.chrom}:${v.start}-${v.end}`;
    const w = byKey.get(key) ?? { chrom: v.chrom, start: v.start, end: v.end, ...(p.genome ? { genome: p.genome } : {}), datasetIds: [], stateKeys: {} };
    if (!w.datasetIds.includes(p.datasetId)) w.datasetIds.push(p.datasetId);
    const keys = (w.stateKeys[p.datasetId] ??= []);
    const stateKey = p.stateKey ?? p.datasetId;
    if (!keys.includes(stateKey)) keys.push(stateKey);
    byKey.set(key, w);
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, w]) => w);
}
import { sameChrom } from './chromAliases';
