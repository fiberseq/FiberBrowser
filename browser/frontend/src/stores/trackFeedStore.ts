import { create } from 'zustand';
import type { CompactRead, SvSummary } from '../components/tracks/read-track/types';

/**
 * What a read panel hands the rows drawn from its reads (fb-n11-tracks): the SV
 * summary row and the coverage row are their own tracks now (resized, deleted
 * and restored like any other), but their data come with the panel's reads.
 * ReadTrack publishes here by state key; SvTrack / CoverageTrack read it.
 * Not saved anywhere (it is the reads in view).
 */
export interface ReadPanelFeed {
  datasetId: string;
  /** The view the panel shows now (it moves before its data arrive). */
  chrom: string;
  start: number;
  end: number;
  isReversed: boolean;
  /** The cluster column left of the reads (px): rows keep their x in line with the reads. */
  sidebarWidth: number;
  /** Reads are positioned relative to this (a linked session's bounds), else `start`. */
  linkedOffset: number;
  /** The reads drawn (the last settled view's; [] while zoomed out). */
  reads: CompactRead[];
  /** The view the reads/SVs above belong to. */
  dataChrom: string;
  dataStart: number;
  dataEnd: number;
  /** SV clusters at the min size in the last settled view (null: none passes, no row). */
  sv: SvSummary | null;
  /** Past the read limit: the reads row shows coverage, these rows have nothing. */
  zoomedOut: boolean;
  /** The pan scope the read canvas follows ('main' or `panel:<key>`). */
  panScope: string;
  /** The panel is a DAF-C linked pair (no SV split). */
  linked: boolean;
}

interface TrackFeedState {
  byStateKey: Record<string, ReadPanelFeed>;
  publish: (stateKey: string, feed: ReadPanelFeed) => void;
  drop: (stateKey: string) => void;
}

const SHALLOW_KEYS: (keyof ReadPanelFeed)[] = [
  'datasetId', 'chrom', 'start', 'end', 'isReversed', 'sidebarWidth', 'linkedOffset', 'reads',
  'dataChrom', 'dataStart', 'dataEnd', 'sv', 'zoomedOut', 'panScope', 'linked',
];

export function sameFeed(a: ReadPanelFeed | undefined, b: ReadPanelFeed): boolean {
  return Boolean(a) && SHALLOW_KEYS.every(key => a![key] === b[key]);
}

export const useTrackFeedStore = create<TrackFeedState>((set, get) => ({
  byStateKey: {},
  publish: (stateKey, feed) => {
    if (sameFeed(get().byStateKey[stateKey], feed)) return;
    set(state => ({ byStateKey: { ...state.byStateKey, [stateKey]: feed } }));
  },
  drop: (stateKey) => {
    if (!(stateKey in get().byStateKey)) return;
    set(state => {
      const next = { ...state.byStateKey };
      delete next[stateKey];
      return { byStateKey: next };
    });
  },
}));

/** The SV row has something to draw for this panel (its clusters are on the view's chromosome). */
export function feedHasSv(feed: ReadPanelFeed | undefined): boolean {
  return Boolean(feed && !feed.zoomedOut && feed.sv && feed.dataChrom === feed.chrom
    && (feed.sv.clusters.length > 0 || feed.sv.clips.length > 0));
}

/** The coverage row has reads to count. */
export function feedHasCoverage(feed: ReadPanelFeed | undefined): boolean {
  return Boolean(feed && !feed.zoomedOut && feed.dataChrom === feed.chrom);
}
