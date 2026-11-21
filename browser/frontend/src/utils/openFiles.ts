/**
 * Opening files by path, the one way every route does it: Load File (toolbar,
 * File > Open, the welcome screen), Load by path, and drag-and-drop (dropped
 * files are uploaded first in a web browser; the desktop app passes their
 * real paths).
 *
 * - An index chosen with its main file (x.bam + x.bam.bai) is used as it is.
 * - Each file opens on its own: one that fails never stops the others.
 * - Every file that can't be opened is named with the reason, and all of them
 *   are reported together (formatOpenErrors) instead of the last one only.
 */
import { useBrowserStore } from '../stores/browserStore';
import { addDataset, addDatasetsGrouped } from '../api/datasets';
import { loadFasta, loadGtf } from '../api/reference';
import { loadDerivedLayers, loadFootprintRules } from '../api/footprints';
import { readSessionFile } from '../api/session';
import { registerTrack, looksLikeMotifFile } from './trackLoader';
import { addMotifFile } from './motifLoader';
import { loadContactMapFile } from './contactMapLoader';
import { loadPlasmidFiles, type PlasmidPlacement } from './plasmidLoader';
import { looksLikeSession, requestSessionRestore } from './sessionRestore';
import { showLoadedReference } from './referenceNavigation';
import { messageFromError } from './fileLoadErrors';
import { baseName, formatGroupOf, planSelection, unknownTypeMessage } from './supportedFiles';
import { nativeOpensAsGraph, openNativeAsGraph } from '../features/graphPanel/openAsGraph';

export interface OpenReport {
  /** Files that opened (datasets, tracks, references, ...). */
  opened: string[];
  /** Indexes chosen with their main file (used, not opened). */
  indexes: string[];
  /** One message per file that could not be opened, naming it. */
  errors: string[];
}

export interface OpenOptions {
  /** Where a plasmid map shows: with reads in the batch, the main view. */
  plasmidPlacement?: PlasmidPlacement;
  /** Native BAM datasets open in graph mode when a package binds them (default: the browser's Graph mode setting). */
  openAsGraph?: boolean;
}

/** "name: reason", unless the reason already names the file. */
export function namedError(path: string, message: string): string {
  const name = baseName(path);
  return message.includes(name) ? message : `${name}: ${message}`;
}

/** One banner for every file that couldn't be opened (null: none). */
export function formatOpenErrors(errors: string[], attempted?: number): string | null {
  const unique = [...new Set(errors.filter(Boolean))];
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  const of = attempted && attempted > unique.length ? ` of ${attempted}` : '';
  return `${unique.length}${of} files could not be opened:\n${unique.map(e => `• ${e}`).join('\n')}`;
}

type Kind = 'dataset' | 'bigbed' | 'derived' | 'rules' | 'session' | 'reference' | 'annotation' | 'track'
  | 'plasmid' | 'contact_map' | 'motif' | 'maybe_motif' | 'unknown';

function kindOf(path: string): Kind {
  const name = baseName(path).toLowerCase();
  if (name.endsWith('.fiberlayer-rules.json') || name.endsWith('.fiberlayers.json')) return 'rules';
  if (/\.fiberlayers\.(bb|bigbed|bed)$/.test(name)) return 'derived';
  const group = formatGroupOf(path);
  switch (group?.id) {
    case 'alignments': return 'dataset';
    case 'fiberseq': return 'bigbed';
    case 'sessions': return 'session';
    case 'reference': return 'reference';
    case 'annotations': return 'annotation';
    case 'tracks': return 'track';
    case 'plasmids': return 'plasmid';
    case 'contacts': return 'contact_map';
    case 'motifs': return 'motif';
    // A .txt may be a motif matrix; if it isn't, it is a file FiberBrowser doesn't open.
    default: return looksLikeMotifFile(path) ? 'maybe_motif' : 'unknown';
  }
}

// Datasets first (derived layers need their source), sessions last.
const ORDER: Kind[] = ['plasmid', 'dataset', 'bigbed', 'unknown', 'reference', 'annotation', 'track', 'contact_map',
  'motif', 'maybe_motif', 'derived', 'rules', 'session'];

/** Open files by path (server paths). Never throws; see OpenReport. */
export async function openLocalPaths(paths: string[], options: OpenOptions = {}): Promise<OpenReport> {
  const plan = planSelection(paths);
  const report: OpenReport = { opened: [], indexes: plan.indexes, errors: [...plan.errors] };
  const byKind = new Map<Kind, string[]>();
  for (const path of plan.open) {
    const kind = kindOf(path);
    byKind.set(kind, [...(byKind.get(kind) ?? []), path]);
  }
  const store = () => useBrowserStore.getState();
  const fail = (path: string, message: string | null | undefined, fallback: string) => {
    report.errors.push(namedError(path, message || fallback));
  };
  const attempt = async (path: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      fail(path, messageFromError(err, 'the request failed'), 'the request failed');
    }
  };
  const hasReads = (byKind.get('dataset')?.length ?? 0) + (byKind.get('bigbed')?.length ?? 0) > 0;
  const isHttp = (path: string) => /^https?:\/\//i.test(path);
  const openDataset = async (path: string) => {
    // A remote BAM chosen with its own (e.g. separately signed) index URL opens with it.
    const index = plan.indexFor[path];
    const target = index && isHttp(path) && isHttp(index) ? `${path}##idx##${index}` : path;
    const r = await addDataset(target);
    if (r.success && r.dataset) {
      store().addDataset(r.dataset);
      if (r.dataset.data_type === 'bam' && (options.openAsGraph ?? nativeOpensAsGraph())) openNativeAsGraph(r.dataset.id);
      report.opened.push(path);
      report.errors.push(...((r as { warnings?: string[] }).warnings ?? []));
    } else {
      fail(path, r.error, formatGroupOf(path)?.id === 'alignments' ? 'could not be opened as a BAM dataset' : 'unknown file type or unreadable file');
    }
  };

  for (const kind of ORDER) {
    const list = byKind.get(kind) ?? [];
    if (list.length === 0) continue;

    if (kind === 'plasmid') {
      try {
        const r = await loadPlasmidFiles(list, options.plasmidPlacement ?? (hasReads ? 'main' : 'auto'));
        const failures = r.failures ?? [];
        const failed = new Set(failures.map(f => f.path));
        if (r.success) report.opened.push(...list.filter(path => !failed.has(path)));
        for (const failure of failures) fail(failure.path || list[0], failure.error, 'could not be opened as a plasmid map');
        if (!r.success && failures.length === 0) for (const path of list) fail(path, r.error, 'could not be opened as a plasmid map');
      } catch (err) {
        for (const path of list) fail(path, messageFromError(err, 'the request failed'), 'the request failed');
      }
      continue;
    }

    if (kind === 'bigbed') {
      // Layer companions of one sample (footprint, TF, m6A...) become one dataset.
      let grouped: Awaited<ReturnType<typeof addDatasetsGrouped>> | null = null;
      try {
        grouped = await addDatasetsGrouped(list);
      } catch {
        grouped = null;  // e.g. a lab server refusing one path refuses the request: try each file
      }
      if (grouped) {
        for (const dataset of grouped.datasets ?? []) store().addDataset(dataset);
        if (grouped.success && grouped.datasets) {
          report.opened.push(...list);
          report.errors.push(...(grouped.errors ?? []));
        } else {
          report.errors.push(grouped.error || `${list.map(baseName).join(', ')}: could not be opened`);
        }
        continue;
      }
      // Each file on its own instead ('unknown' comes next in ORDER).
      byKind.set('unknown', [...(byKind.get('unknown') ?? []), ...list]);
      continue;
    }

    for (const path of list) {
      await attempt(path, async () => {
        switch (kind) {
          case 'dataset':
          case 'unknown':
            // Unknown: a folder of BigBeds, or a file the server explains.
            await openDataset(path);
            return;
          case 'reference': {
            const r = await loadFasta(path);
            if (!r.success) { fail(path, r.error, 'could not be opened as a FASTA reference'); return; }
            store().setHasFasta(true);
            store().setFastaPath(r.path || path);
            store().setCurrentGenome(r.inferred_genome ?? null);
            report.opened.push(path);
            // Off a contig the new reference lacks, as the genome picker does.
            await showLoadedReference();
            return;
          }
          case 'annotation': {
            const r = await loadGtf(path);
            if (r.success) report.opened.push(path);
            else fail(path, r.message, 'could not be opened as a GTF/GFF annotation');
            return;
          }
          case 'track': {
            const r = await registerTrack({ pathOrUrl: path, source: 'local', showWarning: false });
            if (r.success) {
              report.opened.push(path);
              // Opened, but on another assembly than the main genome: say so (it shows nothing there).
              if (r.warning) report.errors.push(namedError(path, r.warning));
            } else fail(path, r.message, 'could not be opened as a track');
            return;
          }
          case 'contact_map': {
            const r = await loadContactMapFile(path);
            if (r.success) report.opened.push(path);
            else fail(path, r.error, 'could not be opened as a contact map');
            return;
          }
          case 'motif':
          case 'maybe_motif': {
            const r = await addMotifFile(path);
            if (r.success) report.opened.push(path);
            else if (kind === 'maybe_motif') report.errors.push(unknownTypeMessage(path));
            else fail(path, r.message, 'could not be read as a motif file');
            return;
          }
          case 'derived': {
            const loaded = store().datasets;
            if (loaded.length === 0) {
              fail(path, 'open the source BAM/BigBed dataset before its derived layers', '');
              return;
            }
            const r = await loadDerivedLayers(path, loaded.map(d => d.id));
            if (r.success && r.datasets) {
              store().setDatasets(r.datasets);
              report.opened.push(path);
            } else {
              fail(path, r.error, 'could not be opened as a derived-layer bundle');
            }
            return;
          }
          case 'rules': {
            const r = await loadFootprintRules(path);
            if (!r.success || !r.groups) { fail(path, r.error, 'could not be read as footprint rules'); return; }
            // Never discard an active cart without an explicit choice in the Footprint Analysis cart UI.
            const current = store().footprintGroups;
            const replace = current.length === 0;
            const loadedGroups = replace ? r.groups : r.groups.map(group => ({ ...group, id: crypto.randomUUID() }));
            store().setFootprintGroups(replace ? loadedGroups : [...current, ...loadedGroups]);
            store().openAnalysisPanel('footprint-analysis');
            window.dispatchEvent(new CustomEvent('fiberbrowser:open-footprint-analysis-tab', { detail: { tab: 'saved' } }));
            report.opened.push(path);
            return;
          }
          case 'session': {
            const r = await readSessionFile(path);
            if (!r.success || !r.session) { fail(path, r.error, 'could not read the session file'); return; }
            if (!looksLikeSession(r.session)) { fail(path, 'not a FiberBrowser session file', ''); return; }
            await requestSessionRestore(r.session);
            report.opened.push(path);
            return;
          }
        }
      });
    }
  }
  return report;
}
