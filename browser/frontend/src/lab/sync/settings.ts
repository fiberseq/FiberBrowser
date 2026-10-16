import { create } from 'zustand';
/** The search's adjustable thresholds; kept per viewer in this browser, like the NFR panel's settings. */
export interface SyncSettings {
  profileSupport: number;
  profileAloneR: number;
  profileAloneZ: number;
  /** Percent. */
  sequenceCover: number;
  sequenceIdentity: number;
  maxIndel: number;
  minimum: number;
  perPair: number;
  shapeMinR: number;
  shapeMinZ: number;
  shapeWidth: number;
  /** 1: propose NFR <-> NFR landmark pairs. */
  shapeLandmarks: number;
}
export const DEFAULT_SYNC_SETTINGS: SyncSettings = { profileSupport: 0.3, profileAloneR: 0.4, profileAloneZ: 5, sequenceCover: 50, sequenceIdentity: 90, maxIndel: 2000, minimum: 200, perPair: 3, shapeMinR: 0.6, shapeMinZ: 4, shapeWidth: 300, shapeLandmarks: 0 };
export const SYNC_SETTINGS_KEY = 'fiberhmm-sync-regions-settings-v1';
/** [key, label, min, max, step, one-line help], in the Advanced section's order. */
export const SYNC_KNOBS: [keyof SyncSettings, string, number, number, number, string][] = [
  ['profileSupport', 'Profile support (r)', 0, 1, 0.05, 'Correlation of a profile along a proposal at or above which it supports it.'],
  ['profileAloneR', 'Profile-only proposal (r)', 0, 1, 0.05, 'A profile proposes a shift on its own (no sequence or anchor) only with at least this correlation.'],
  ['profileAloneZ', 'Profile-only proposal (z)', 0, 50, 0.5, 'and only when that shift stands out of all others by this many robust standard deviations.'],
  ['sequenceIdentity', 'Minimum identity (%)', 0, 100, 1, 'Sequence proposals need at least this identity.'],
  ['sequenceCover', 'Sequence coverage (%)', 5, 100, 5, 'Shared sequence must cover this share of a proposal to support it.'],
  ['maxIndel', 'Largest indel in a chain (bp)', 0, 20000, 100, 'Aligned blocks chain across indels up to this size; a larger one splits the proposal.'],
  ['minimum', 'Minimum aligned length (bp)', 30, 50000, 10, 'Shorter chains and profile overlaps are not proposed.'],
  ['perPair', 'Proposals per pair', 1, 50, 1, 'How many proposals per window pair the map and list show before Show all.'],
  ['shapeMinR', 'Chromatin shape (r)', 0, 1, 0.05, 'A local chromatin-shape match needs at least this mean correlation over accessibility, NFR and nucleosome profiles.'],
  ['shapeMinZ', 'Chromatin shape (z)', 0, 50, 0.5, 'and must beat the best match in scrambled template profiles by this many SDs (2 more when it is not centred on an NFR on both sides).'],
  ['shapeWidth', 'Shape seed (bp)', 100, 5000, 50, 'Seeds are this long, twice and four times this; shorter seeds find smaller elements.'],
  ['shapeLandmarks', 'Propose NFR ↔ NFR pairs', 0, 1, 1, 'Also propose each NFR’s best-matching NFR in the template. NFRs resemble one another in general, so these are hypotheses.'],
];
function load(): SyncSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY) ?? '{}') as Partial<SyncSettings>;
    return Object.fromEntries(SYNC_KNOBS.map(([key, , min, max]) => {
      const v = saved[key];
      return [key, typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : DEFAULT_SYNC_SETTINGS[key]];
    })) as unknown as SyncSettings;
  } catch {
    return DEFAULT_SYNC_SETTINGS;
  }
}
export const useSyncSettings = create<SyncSettings>(load);
/** Set thresholds (clamped to their ranges) and remember them for this viewer. */
export function setSyncSettings(next: Partial<SyncSettings>) {
  const clamped = Object.fromEntries(Object.entries(next).map(([key, v]) => {
    const knob = SYNC_KNOBS.find(k => k[0] === key)!;
    return [key, Math.max(knob[2], Math.min(knob[3], Number(v)))];
  }));
  useSyncSettings.setState(clamped);
  try { localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(useSyncSettings.getState())); } catch { /* private mode */ }
}
/** The request fields these settings set. */
export function searchThresholds(s: SyncSettings) {
  return { minimum: s.minimum, thresholds: { profileSupport: s.profileSupport, profileAloneR: s.profileAloneR, profileAloneZ: s.profileAloneZ, sequenceCover: s.sequenceCover / 100, sequenceIdentity: s.sequenceIdentity / 100, maxIndel: s.maxIndel,
    shapeMinR: s.shapeMinR, shapeMinZ: s.shapeMinZ, shapeWidth: s.shapeWidth, shapeLandmarks: s.shapeLandmarks } };
}
