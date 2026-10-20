import { useTrackFeedStore } from '../../stores/trackFeedStore';
import type { PanelConfig } from '../../types';

/** An opened difference reads its per-read observations straight away up to this many reads in view. */
export const AUTO_LOAD_MAX_READS = 2_000;

export interface AutoLoadBound { auto: boolean; reason: string }

/** Whether an inspector loads its reads' observations on open, and why not when it waits for "Load". */
export function autoLoadBound(feed: { reads: unknown[]; zoomedOut: boolean } | undefined): AutoLoadBound {
  if (!feed) return { auto: false, reason: 'This panel has no reads loaded in view.' };
  if (feed.zoomedOut) return { auto: false, reason: 'The view is past the read limit: zoom in, or load them here.' };
  const n = feed.reads.length;
  if (n > AUTO_LOAD_MAX_READS) return { auto: false,
    reason: `${n.toLocaleString()} reads in view: observations load by themselves up to ${AUTO_LOAD_MAX_READS.toLocaleString()}.` };
  return { auto: true, reason: '' };
}

export function useAutoLoadBound(panel: Pick<PanelConfig, 'id' | 'stateKey' | 'datasetId'> | null | undefined): AutoLoadBound {
  const key = panel ? panel.stateKey ?? panel.datasetId ?? panel.id : '';
  const feed = useTrackFeedStore(s => (key ? s.byStateKey[key] : undefined));
  return autoLoadBound(feed);
}
