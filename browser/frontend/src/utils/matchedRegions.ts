import type { FirePeak, PeakRule } from '../types';
import type { BrowserState } from '../stores/browserStore';

export const MATCHED_COLORS = ['#155e75', '#475569', '#164e63', '#334155'];
export const isMatchedRule = (rule: PeakRule) => rule.source === 'matched';
export const isScannedRule = (rule: PeakRule) => rule.source !== 'custom' && !isMatchedRule(rule);
export type MatchedGroupInput = { id?: string; name: string; color?: string; regions: FirePeak[]; matchGroup?: PeakRule['matchGroup'] };

/** Carry durable regions, selection and modes through transient peak resets. */
export function keepMatched(state: BrowserState, partial: Partial<BrowserState>): Partial<BrowserState> {
  const groups = state.peakRules.filter(isMatchedRule);
  if (!groups.length) return partial;
  const out = { ...partial };
  if (out.peakRules) out.peakRules = [...out.peakRules, ...groups.filter(r => !out.peakRules!.some(q => q.id === r.id))];
  const rules = out.peakRules ?? state.peakRules;
  const moves = groups.flatMap(r => (state.peaksByRule[r.id] ?? []).map((p, i) => ({ p, index: rules.findIndex(q => q.id === r.id) * 10000 + i })));
  if (out.peaksByRule) {
    out.peaksByRule = { ...out.peaksByRule };
    for (const r of groups) out.peaksByRule[r.id] = moves.filter(m => m.p.ruleId === r.id || m.p.match?.groupId === r.id).map(({ p, index }) => index === p.index ? p : { ...p, index });
  }
  const occupied = new Set(Object.entries(out.peaksByRule ?? state.peaksByRule)
    .filter(([id]) => !groups.some(r => r.id === id)).flatMap(([, peaks]) => peaks.map(p => p.index)));
  if (out.selectedPeaks) {
    out.selectedPeaks = new Set(out.selectedPeaks);
    for (const { p } of moves) if (!occupied.has(p.index)) out.selectedPeaks.delete(p.index);
    for (const { p, index } of moves) if (state.selectedPeaks.has(p.index)) out.selectedPeaks.add(index);
  }
  if (out.peakModes) {
    out.peakModes = { ...out.peakModes };
    for (const { p } of moves) if (!occupied.has(p.index)) delete out.peakModes[p.index];
    for (const { p, index } of moves) if (state.peakModes[p.index]) out.peakModes[index] = state.peakModes[p.index];
  }
  return out;
}

/** Reject invalid maps on session restore; never infer missing coordinates. */
export function validMatchedPeak(p: FirePeak, id: string): boolean {
  const m = p?.match;
  if (!m || m.groupId !== id || !p.chrom || typeof m.label !== 'string' || typeof m.reversed !== 'boolean'
    || !Number.isInteger(m.length) || m.length <= 0 || !Array.isArray(m.blocks) || !m.blocks.length) return false;
  const interval = (v: number[]) => Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) && v[0] >= 0 && v[1] > v[0];
  if (!m.blocks.every(b => b && interval(b.frame) && interval(b.genomic) && b.frame[1] <= m.length
    && b.frame[1] - b.frame[0] === b.genomic[1] - b.genomic[0])) return false;
  for (const axis of ['frame', 'genomic'] as const) {
    const blocks = [...m.blocks].sort((a, b) => a[axis][0] - b[axis][0]);
    if (blocks.some((b, i) => i > 0 && blocks[i - 1][axis][1] > b[axis][0])) return false;
  }
  return p.start === Math.min(...m.blocks.map(b => b.genomic[0])) && p.end === Math.max(...m.blocks.map(b => b.genomic[1]));
}

export function restoreMatchedPeaks(rules: PeakRule[], peaks: Record<string, FirePeak[]>) {
  return Object.fromEntries(Object.entries(peaks).map(([id, ps]) => [id,
    rules.some(r => r.id === id && isMatchedRule(r)) ? (Array.isArray(ps) ? ps.filter(p => validMatchedPeak(p, id)) : []) : ps]));
}

/** Every member of a group uses the same feature type. */
export function matchedModeIndices(state: BrowserState, index: number): number[] {
  const peak = state.getAllPeaks().find(p => p.index === index);
  return peak?.match ? state.getAllPeaks().filter(p => p.match?.groupId === peak.match!.groupId).map(p => p.index) : [index];
}

/** Make equal-width rigid regions without altering the source peaks. */
export function rigidMatchedRegions(peaks: FirePeak[], chrom: string): FirePeak[] {
  const length = Math.min(...peaks.map(p => p.end - p.start));
  return peaks.map((p, i) => {
    const start = Math.floor((p.start + p.end - length) / 2);
    return { ...p, start, end: start + length, chrom: p.chrom ?? chrom, isCustom: false,
      match: { sourceRegion: p.match?.sourceRegion ?? { chrom: p.chrom ?? chrom, genome: p.genome, start: p.start, end: p.end }, groupId: '', label: `W${i + 1}`, length, reversed: false, blocks: [{ frame: [0, length], genomic: [start, start + length] }] } };
  });
}


/** Remove only invalid authored-region indices from a restored selection. */
export function validateMatchedState(partial: Partial<BrowserState>): Partial<BrowserState> {
  if (!partial.peakRules || !partial.peaksByRule) return partial;
  const old = partial.peaksByRule;
  const peaksByRule = restoreMatchedPeaks(partial.peakRules, old);
  const removed = new Set(partial.peakRules.filter(isMatchedRule).flatMap(r =>
    (Array.isArray(old[r.id]) ? old[r.id] : []).filter(p => p && !(peaksByRule[r.id] ?? []).includes(p)).map(p => p.index)));
  return { ...partial, peaksByRule,
    ...(partial.selectedPeaks ? { selectedPeaks: new Set([...partial.selectedPeaks].filter(i => !removed.has(i))) } : {}),
    ...(partial.peakModes ? { peakModes: Object.fromEntries(Object.entries(partial.peakModes).filter(([i]) => !removed.has(Number(i)))) } : {}) };
}

/** Durable selections do not hold up scanning a newly navigated view. */
export function hasOrdinaryPeakSelection(state: BrowserState): boolean {
  const matched = new Set(state.peakRules.filter(isMatchedRule).flatMap(r => (state.peaksByRule[r.id] ?? []).map(p => p.index)));
  return [...state.selectedPeaks].some(index => !matched.has(index));
}
