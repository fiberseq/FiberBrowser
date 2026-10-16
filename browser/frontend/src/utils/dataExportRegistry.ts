/**
 * Every data export of the app, in one list (Export data…, the top bar's
 * file button, File > Export Data…, ⌘⇧E, and the Export dialog's Data tab).
 *
 * An export is registered once with what it is about (its group), what is in
 * it and its format, whether it applies now (and if not, why), and what it
 * does: download, copy, or open the panel where it is exported from (tables
 * whose data lives in an open panel). Other features add theirs with
 * `registerDataExport` (the same id replaces an entry, so a feature can take
 * over a placeholder):
 *
 *   registerDataExport({
 *     id: 'cluster-projection', group: 'clusters', title: 'Projection coordinates',
 *     format: 'TSV', description: 'x/y of each read on the t-SNE map, with its cluster',
 *     available: ({ state }) => state.someMap ? { ok: true } : { ok: false, reason: 'Compute a map in Clusters > Projection' },
 *     run: () => downloadTextFile(...),
 *   });
 */
import { useSyncExternalStore } from 'react';
import type { BrowserState } from '../stores/browserStore';
import type { ReadScopeKey } from './exportReadScopes';

export type DataExportGroup = 'reads' | 'peaks' | 'classes' | 'clusters' | 'analysis' | 'session';

export const DATA_EXPORT_GROUPS: ReadonlyArray<{ id: DataExportGroup; title: string; description: string }> = [
  { id: 'reads', title: 'Reads', description: 'The reads you pick below: their names, a BAM of them, or a table of their statistics and clusters.' },
  { id: 'peaks', title: 'Peaks & regions', description: 'Peaks, regions and track values as BED, bedGraph or TSV.' },
  { id: 'classes', title: 'Classes & footprints', description: 'Footprint classes, saved footprints, co-occupancy and tagged BAMs.' },
  { id: 'clusters', title: 'Clusters', description: 'Cluster assignments per read, saved clusterings and map coordinates.' },
  { id: 'analysis', title: 'Analysis tables', description: "Each analysis panel's table. Every chart's Save menu also has Data TSV." },
  { id: 'session', title: 'Session & working set', description: 'Everything to reload this session, and the reads behind the view.' },
];

export type DataExportAvailability = { ok: true; detail?: string } | { ok: false; reason: string };

export interface DataExportContext {
  /** The browser store now. */
  state: BrowserState;
  /** Which reads the Reads exports are about. */
  readScope: ReadScopeKey;
}

export interface DataExportEntry {
  /** Stable id (data-testid `export-entry-<id>`); registering the same id again replaces the entry. */
  id: string;
  group: DataExportGroup;
  title: string;
  /** What is in it (one line). */
  description: string;
  /** Format shown on the entry: TSV, BED, JSON, .bam, text… */
  format: string;
  /** What the button does: download a file (default), copy to the clipboard, or open the panel it's exported from. */
  action?: 'download' | 'copy' | 'open';
  /** Button text (default: "Download .<format>", "Copy", "Open"). */
  buttonLabel?: string;
  /** The one filled button of the list (the session file). */
  primary?: boolean;
  /** Sort within its group (lower first; default 100). */
  order?: number;
  /** About the reads picked in the Reads group's scope. */
  usesReadScope?: boolean;
  available: (ctx: DataExportContext) => DataExportAvailability;
  /** A warning shown under the entry (a very large file). */
  sizeWarning?: (ctx: DataExportContext) => string | null;
  /** Do it; a returned string is shown as the result ("Copied 12 names"). Throw to show an error. */
  run: (ctx: DataExportContext) => void | string | Promise<void | string>;
}

const entries = new Map<string, DataExportEntry>();
const listeners = new Set<() => void>();
let snapshot: DataExportEntry[] = [];

function changed() {
  snapshot = [...entries.values()];
  for (const listener of listeners) listener();
}

/** Add (or replace, by id) an export. Returns a function that removes it. */
export function registerDataExport(entry: DataExportEntry): () => void {
  entries.set(entry.id, entry);
  changed();
  return () => {
    if (entries.get(entry.id) === entry) {
      entries.delete(entry.id);
      changed();
    }
  };
}

/** The registered exports, by group order then their own order. */
export function listDataExports(group?: DataExportGroup): DataExportEntry[] {
  const rank = new Map(DATA_EXPORT_GROUPS.map((g, i) => [g.id, i]));
  return snapshot
    .filter(e => !group || e.group === group)
    .sort((a, b) => (rank.get(a.group)! - rank.get(b.group)!) || ((a.order ?? 100) - (b.order ?? 100)));
}

export function getDataExport(id: string): DataExportEntry | undefined {
  return entries.get(id);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The registered exports, re-rendering when one is added or removed. */
export function useDataExports(): DataExportEntry[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** What the entry's button says. */
export function entryButtonLabel(entry: DataExportEntry): string {
  if (entry.buttonLabel) return entry.buttonLabel;
  if (entry.action === 'copy') return 'Copy';
  if (entry.action === 'open') return 'Open';
  const ext = entry.format.replace(/^\./, '').split(/[\s/,]/)[0].toLowerCase();
  return `Download .${ext}`;
}

/** Whether an entry applies, never throwing (a broken entry is shown disabled). */
export function entryAvailability(entry: DataExportEntry, ctx: DataExportContext): DataExportAvailability {
  try {
    if (entry.group === 'reads' && Object.values(ctx.state.readTrackStatus ?? {}).some(track => track.loading || track.stale)) {
      return { ok: false, reason: 'Wait for the complete read set before exporting.' };
    }
    return entry.available(ctx);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
