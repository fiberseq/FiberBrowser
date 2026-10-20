/**
 * Display options of the Differences rows (saved in the session's differencesSession.options): how lifted reads
 * show insertions. Per-panel choices (sources, minimum size) live on the panel (differenceSources, liveLiftMinBp).
 */
import { useBrowserStore } from '../../stores/browserStore';
import type { LiveLiftBadgeMode } from '../../components/tracks/read-track/liveLiftCanvas';

export const READ_BADGE_MODES: Array<{ mode: LiveLiftBadgeMode; label: string; title: string }> = [
  { mode: 'off', label: 'Off', title: 'No insertion marks on the reads (the Differences row still shows them)' },
  { mode: 'ticks', label: 'Ticks', title: 'A small tick where a read has bases with no target here' },
  { mode: 'labels', label: 'Ticks with size', title: 'Ticks labelled with the inserted size where rows are tall enough (7 px or more)' },
];

export function readBadgeMode(s: { differencesSession?: { options?: { readBadges?: LiveLiftBadgeMode } } }): LiveLiftBadgeMode {
  const m = s.differencesSession?.options?.readBadges;
  return m === 'off' || m === 'labels' ? m : 'ticks';
}

export function setReadBadgeMode(mode: LiveLiftBadgeMode): void {
  useBrowserStore.setState(s => ({ differencesSession: { ...s.differencesSession,
    options: { ...s.differencesSession.options, readBadges: mode } } }));
}

/** Set a Differences row's per-panel options (sources shown, minimum size). */
export function setDifferenceRowOptions(panelId: string, patch: { sources?: { assembly: boolean; reads: boolean }; minBp?: number }): void {
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id !== panelId ? p : {
    ...p, ...(patch.sources ? { differenceSources: patch.sources } : {}), ...(patch.minBp != null ? { liveLiftMinBp: patch.minBp } : {}) }) }));
}
