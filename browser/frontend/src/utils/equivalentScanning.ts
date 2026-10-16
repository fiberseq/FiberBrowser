import { scanPeaks } from '../api/peaks';
import type { BrowserState } from '../stores/browserStore';
import type { FirePeak, PeakRule } from '../types';
import { clusterWindows, matchedClusterWindows } from './clusterTargets';
import { fetchJson } from '../api/sharedFetch';
import { framePeak, sharedPositionBlocks } from './equivalentPositions';
import { sameChrom } from './chromAliases';

export interface CorrespondenceScan {
  peaks: FirePeak[];
  shared_blocks?: [number, number][];
  n_reads: number;
  profiles: { start: number; end: number; signal: number[]; coverage: number[] }[];
  members: Record<string, { label: string; n_reads: number; signal: number[]; coverage: number[]; profiles: CorrespondenceScan['profiles'] }>;
}

/** Scan each accepted correspondence once, with every member's own read scope and coordinates. */
export async function scanEquivalentRegions(s: BrowserState, rule: PeakRule, source: string, signal?: AbortSignal) {
  const groups = s.peakRules.filter(r => r.source === 'matched').sort((a, b) => Number(a.matchGroup?.origin === 'sv') - Number(b.matchGroup?.origin === 'sv'));
  const peaks: FirePeak[] = [], regions: FirePeak[] = [];
  const summaries: Record<string, CorrespondenceScan> = {};
  const panelIds = new Set<string>();
  const scannedMaps = new Set<string>();
  const windows = clusterWindows({ ...s, selectedDatasets: new Set() }, s.datasets.map(d => d.id));
  for (const group of groups) {
    const members = s.peaksByRule[group.id] ?? [];
    const visible = members.map(m => {
      const w = windows.find(w => (!m.match!.panelId || m.match!.panelId === w.panel.id || w.panel.regionPanelGroup?.regionLabel === m.match!.label)
        && sameChrom(w.chrom, m.chrom ?? s.chrom) && (w.panel.genome ?? null) === (m.genome ?? null)
        && m.start < w.end && m.end > w.start);
      if (!w) return null;
      const blocks = m.match!.blocks.flatMap(b => {
        const a = Math.max(b.genomic[0], w.start), z = Math.min(b.genomic[1], w.end);
        if (z <= a) return [];
        const u = m.match!.reversed ? b.frame[0] + b.genomic[1] - z : b.frame[0] + a - b.genomic[0];
        return [{ genomic: [a, z] as [number, number], frame: [u, u + z - a] as [number, number] }];
      });
      return blocks.length ? { ...m, start: Math.min(...blocks.map(b => b.genomic[0])), end: Math.max(...blocks.map(b => b.genomic[1])), match: { ...m.match!, blocks } } : null;
    }).filter((m): m is NonNullable<typeof m> => m !== null);
    if (visible.length !== members.length) continue;
    const shared = sharedPositionBlocks(visible);
    if (!shared.length) continue;
    const mapped = matchedClusterWindows(windows, visible);
    if (mapped.refusal || mapped.windows.length < 2 || !members.length) continue;
    // An explicit panel selection includes its partners in the same correspondence.
    if (s.selectedDatasets.size && !mapped.windows.some(w => s.selectedDatasets.has(w.panel.id))) continue;
    // A saved proposal can describe the same automatic flanks with a different frame origin.
    const ordered = [...visible].sort((a, b) => (a.match!.panelId ?? a.match!.label).localeCompare(b.match!.panelId ?? b.match!.label));
    const signature = JSON.stringify(shared.map(([a, z]) => ordered.map(m => {
      const p = framePeak(m, a, z, m, group.id)!;
      return [m.match!.panelId, m.chrom, m.genome, p.start, p.end, m.match!.reversed !== ordered[0].match!.reversed];
    })).sort((a, b) => Number(a[0][3]) - Number(b[0][3])));
    if (scannedMaps.has(signature)) continue;
    scannedMaps.add(signature);
    const result = await fetchJson<CorrespondenceScan>('/api/scan-correspondence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ length: members[0].match!.length,
        viewports: mapped.windows.map(({ panel: _p, stateKey: _k, ...w }) => w),
        signal_source: source, min_width: rule.minPeakWidth, min_reads: rule.minReads, smooth_width: rule.smoothWidth,
        threshold_strong: rule.thresholds[0], threshold_medium: rule.thresholds[1], threshold_weak: rule.thresholds[2], threshold_rare: rule.thresholds[3],
        sample_seed: s.analysisSampleSeed }),
    });
    summaries[group.id] = result;
    for (const w of mapped.windows) panelIds.add(w.panel.id);
    for (const [a, z] of result.shared_blocks ?? sharedPositionBlocks(visible)) for (const m of visible) {
      const region = framePeak(m, a, z, m, group.id);
      if (region) regions.push(region);
    }
    // Store the seed on one member. getAllPeaks projects it using the live correspondence.
    for (const p of result.peaks) {
      const seed = framePeak(members[0], p.start, p.end, { ...p, ruleId: rule.id }, group.id);
      if (seed) { const { match: _m, ...plain } = seed; peaks.push({ ...plain, correspondenceId: group.id, memberPanelId: members[0].match!.panelId }); }
    }
  }
  return { peaks, summaries, panelIds, remainder: (p: FirePeak): FirePeak[] => {
    let spans: [number, number][] = [[p.start, p.end]];
    for (const m of regions) {
      if (!sameChrom(m.chrom ?? s.chrom, p.chrom ?? s.chrom) || (m.genome ?? null) !== (p.genome ?? null)
        || (p.memberPanelId && m.match?.panelId && p.memberPanelId !== m.match.panelId)) continue;
      for (const b of m.match!.blocks) spans = spans.flatMap(([a, z]) => {
        if (z <= b.genomic[0] || a >= b.genomic[1]) return [[a, z]] as [number, number][];
        return [a < b.genomic[0] ? [a, b.genomic[0]] : null, z > b.genomic[1] ? [b.genomic[1], z] : null].filter((v): v is [number, number] => v !== null);
      });
    }
    return spans.map(([start, end]) => ({ ...p, start, end }));
  } };
}

/** Scan only unaligned positions in each member; aligned positions were already scanned jointly. */
export async function scanUnsharedRegions(s: BrowserState, rule: PeakRule, source: string,
  pooled: Awaited<ReturnType<typeof scanEquivalentRegions>>, signal?: AbortSignal): Promise<FirePeak[]> {
  const windows = clusterWindows({ ...s, selectedDatasets: new Set() }, s.datasets.map(d => d.id))
    .filter(w => !s.selectedDatasets.size || s.selectedDatasets.has(w.panel.id) || pooled.panelIds.has(w.panel.id));
  const peaks: FirePeak[] = [];
  for (const w of windows) {
    if (w.read_ids?.length === 0) continue;
    const gaps = pooled.remainder({ index: 0, chrom: w.chrom, start: w.start, end: w.end, genome: w.panel.genome, memberPanelId: w.panel.id });
    for (const gap of gaps) {
      const result = await scanPeaks(w.chrom, gap.start, gap.end, rule.minPeakWidth, rule.minReads, w.read_ids, undefined,
        { smoothWidth: rule.smoothWidth, thresholdStrong: rule.thresholds[0], thresholdMedium: rule.thresholds[1], thresholdWeak: rule.thresholds[2], thresholdRare: rule.thresholds[3] },
        w.dataset_id, undefined, source, false, s.analysisSampleSeed, [w.dataset_id], { signal }, w.panel.genome, w.strand);
      peaks.push(...result.peaks.map(p => ({ ...p, chrom: w.chrom, genome: w.panel.genome, memberPanelId: w.panel.id })));
    }
  }
  return peaks;
}
