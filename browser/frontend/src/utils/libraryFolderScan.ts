/**
 * Library > Suggested experiments, scanned on demand: the words the review
 * shows for a folder scan (what was scanned, found and left out) and when
 * opening the found set asks first. Pure, so it is tested directly.
 */
import type { FolderScanFile, FolderScanPreview, LibraryKind } from '../api/library';
import { KIND_LABELS } from './library';

/** Opening more BAMs than this at once asks first (saving a group never does). */
export const OPEN_CONFIRM_BAMS = 12;
/** ...and more files than this in all. */
export const OPEN_CONFIRM_FILES = 24;

const KIND_ORDER: LibraryKind[] = ['bam', 'bigbed', 'plasmid_map', 'reference', 'track'];

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "4 BAMs · 1 BigBed · 1 plasmid map" for these files. */
export function kindCounts(files: FolderScanFile[]): string {
  const counts = new Map<LibraryKind, number>();
  for (const file of files) counts.set(file.kind, (counts.get(file.kind) ?? 0) + 1);
  return KIND_ORDER.filter(k => counts.get(k))
    .map(k => {
      const n = counts.get(k)!;
      const label = k === 'plasmid_map' ? 'plasmid map' : KIND_LABELS[k];
      return plural(n, label);
    })
    .join(' · ');
}

/** What the scan looked at, in one sentence. */
export function scanScopeText(preview: Pick<FolderScanPreview, 'mode' | 'subdirs' | 'max_depth'>): string {
  if (preview.mode === 'deep') {
    return `This folder and its sub-folders, ${preview.max_depth ?? 6} levels down (as a watched folder does).`;
  }
  const subdirs = (preview.subdirs ?? []).map(d => `${d}/`);
  const named = subdirs.length > 1 ? `${subdirs.slice(0, -1).join(', ')} and ${subdirs[subdirs.length - 1]}` : subdirs[0];
  return named
    ? `This folder and its ${named} sub-folders (where FiberHMM runs write their outputs); not other sub-folders.`
    : 'This folder only; not its sub-folders.';
}

/** What the scan left out, in one line ('' when only non-dataset files). */
export function leftOutText(preview: Pick<FolderScanPreview, 'left_out' | 'mode'>): string {
  const left = preview.left_out;
  const parts: string[] = [];
  if (left.aligned) parts.push(`${plural(left.aligned, 'aligned-only BAM')} (uncalled pipeline intermediates)`);
  if (left.no_index) parts.push(`${plural(left.no_index, 'BAM')} without an index (.bai/.csi)`);
  if (left.outside) parts.push(`${plural(left.outside, 'link')} to files outside the folder`);
  if (left.big_dirs) parts.push(`${plural(left.big_dirs, 'folder')} with over 20,000 entries`);
  if (left.skipped_dirs) {
    parts.push(preview.mode === 'deep'
      ? `${plural(left.skipped_dirs, 'hidden, system or deeper folder')}`
      : `${plural(left.skipped_dirs, 'other sub-folder')}`);
  }
  if (left.unreadable) parts.push(`${plural(left.unreadable, 'file or folder', 'files or folders')} FiberBrowser can't read`);
  if (left.other_files) parts.push(`${plural(left.other_files, 'non-dataset file')} (indexes, QC, logs…)`);
  return parts.length ? `Left out: ${parts.join('; ')}.` : '';
}

/** Opening these files at once asks first. */
export function openNeedsConfirmation(files: Pick<FolderScanFile, 'kind'>[]): boolean {
  const bams = files.filter(f => f.kind === 'bam').length;
  return bams > OPEN_CONFIRM_BAMS || files.length > OPEN_CONFIRM_FILES;
}

/** An error message without the "API error 400: " prefix fetchJson adds. */
export function plainError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^API error \d+:\s*/, '');
}
