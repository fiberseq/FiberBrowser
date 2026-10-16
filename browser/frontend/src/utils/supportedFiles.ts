/**
 * What FiberBrowser opens, from the one shared list (data/supportedFiles.json,
 * which the backend's services/supported_files.py reads too): which kind of
 * file a path is, which files are indexes (used with their main file, never
 * opened alone), and the open dialogs' filters.
 */
import spec from '../data/supportedFiles.json';

export interface FormatGroup {
  id: string;
  label: string;
  opens: string;
  suffixes: string[];
}

interface SidecarRule {
  suffix: string;
  label: string;
  for: string[];
  /** A coordinate index (BAI, CSI, ...): what a remote file opens with. A PacBio .pbi is not one. */
  coordinate_index?: boolean;
}

export const FORMAT_GROUPS: FormatGroup[] = spec.groups;
const SIDECARS: SidecarRule[] = spec.sidecars;
const NOT_SUPPORTED: Array<{ suffix: string; why: string }> = spec.not_supported;
const PICKERS: Record<string, string[]> = spec.pickers;

export type PickerKind = 'open' | 'dataset';

export function baseName(path: string): string {
  let text = String(path ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try { text = new URL(text).pathname; } catch { /* keep as is */ }
  }
  return text.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || text;
}

/** A URL without its query (a signed link's index has its own signature). */
function withoutQuery(path: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? path.split(/[?#]/, 1)[0] : path;
}

/**
 * A path's identity for matching an index to its file: a URL without its
 * query (case kept: S3 keys are case-sensitive); a local path with / for \\
 * and without ./ segments or doubled separators.
 */
function pathKey(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return withoutQuery(path);
  return path.replace(/\\/g, '/').replace(/\/(\.\/)+/g, '/').replace(/\/{2,}/g, '/');
}

function lowerName(path: string): string {
  return baseName(path).toLowerCase();
}

function endsWithSuffix(name: string, suffix: string): boolean {
  return name.endsWith(suffix) && name.length > suffix.length;
}

export function sidecarRule(path: string): SidecarRule | null {
  const name = lowerName(path);
  return SIDECARS.find(rule => endsWithSuffix(name, rule.suffix)) ?? null;
}

export function isSidecar(path: string): boolean {
  return sidecarRule(path) !== null;
}

/** A coordinate index (BAI, CSI, CRAI, tabix): one a remote file can be opened with. */
export function isCoordinateIndex(path: string): boolean {
  return Boolean(sidecarRule(path)?.coordinate_index);
}

/** The format group of a file (null: an index, or a type FiberBrowser doesn't open). */
export function formatGroupOf(path: string): FormatGroup | null {
  if (isSidecar(path)) return null;
  const name = lowerName(path);
  let best: FormatGroup | null = null;
  let bestLength = 0;
  for (const group of FORMAT_GROUPS) {
    for (const suffix of group.suffixes) {
      if (endsWithSuffix(name, suffix) && suffix.length > bestLength) {
        best = group;
        bestLength = suffix.length;
      }
    }
  }
  return best;
}

/** The names an index can belong to: x.bam.bai -> x.bam; x.bai -> x.bam. */
export function sidecarMainCandidates(path: string): string[] {
  const rule = sidecarRule(path);
  if (!rule) return [];
  const bare = withoutQuery(path);
  const stem = bare.slice(0, bare.length - rule.suffix.length);
  const out: string[] = [];
  const stemName = lowerName(stem);
  if (rule.for.some(suffix => endsWithSuffix(stemName, suffix))) out.push(stem);
  for (const suffix of rule.for) out.push(stem + suffix);
  return out;
}

export function notSupportedReason(path: string): string | null {
  const name = lowerName(path);
  let best: string | null = null;
  let bestLength = 0;
  for (const entry of NOT_SUPPORTED) {
    if (endsWithSuffix(name, entry.suffix) && entry.suffix.length > bestLength) {
      best = entry.why;
      bestLength = entry.suffix.length;
    }
  }
  return best;
}

export function pickerGroups(picker: PickerKind = 'open'): FormatGroup[] {
  const ids = PICKERS[picker] ?? [];
  return ids.map(id => FORMAT_GROUPS.find(group => group.id === id)).filter((g): g is FormatGroup => Boolean(g));
}

export function supportedSummary(picker: PickerKind = 'open'): string {
  return pickerGroups(picker).map(group => group.label).join('; ');
}

/** Why an index chosen on its own isn't opened, and what to open instead. */
export function sidecarMessage(path: string, knownNames: string[] = []): string {
  const rule = sidecarRule(path);
  const candidates = sidecarMainCandidates(path).map(baseName);
  const known = new Set(knownNames.map(n => n.toLowerCase()));
  const main = candidates.find(c => known.has(c.toLowerCase())) ?? candidates[0];
  return `${baseName(path)}: this is a ${rule?.label ?? 'index'} file, not a file to open on its own. `
    + `Open ${main ?? 'its main file'} instead; FiberBrowser uses the index next to it automatically.`;
}

/** A specific reason a file can't be opened (null when its type is one FiberBrowser opens). */
export function notOpenableReason(path: string): string | null {
  if (isSidecar(path)) return sidecarMessage(path);
  const why = notSupportedReason(path);
  if (why) return `${baseName(path)}: ${why}.`;
  return null;
}

export function unknownTypeMessage(path: string): string {
  return `${baseName(path)}: not a file type FiberBrowser opens. Supported: ${supportedSummary('open')}.`;
}

export interface SelectionPlan {
  /** Files to open (indexes left out). */
  open: string[];
  /** Indexes chosen with their main file: used as they are, nothing to do. */
  indexes: string[];
  /** The coordinate index (BAI/CSI) chosen for each main file (a remote BAM opens with it; never a .pbi). */
  indexFor: Record<string, string>;
  /** One message per file that can't be opened (named). */
  errors: string[];
}

/**
 * Split a selection: indexes chosen with their main file are left out
 * silently (the main file finds its index next to it); an index chosen
 * without it, or a format FiberBrowser can't open, gets a message naming
 * the file. Matching is by full path, or by name for dropped files.
 */
export function planSelection(paths: string[], { byName = false }: { byName?: boolean } = {}): SelectionPlan {
  const mains = paths.filter(p => !isSidecar(p));
  const key = (p: string) => (byName ? baseName(p) : pathKey(p));
  const mainByKey = new Map(mains.map(main => [key(main), main] as const));
  const plan: SelectionPlan = { open: [], indexes: [], indexFor: {}, errors: [] };
  for (const path of paths) {
    if (isSidecar(path)) {
      const candidates = sidecarMainCandidates(byName ? baseName(path) : path);
      const main = candidates.map(c => mainByKey.get(key(c))).find(Boolean);
      if (main) {
        plan.indexes.push(path);
        // Only a coordinate index opens the file; a companion (.pbi) is used as it is.
        if (isCoordinateIndex(path) && !(main in plan.indexFor)) plan.indexFor[main] = path;
      } else {
        plan.errors.push(sidecarMessage(path, mains.map(baseName)));
      }
      continue;
    }
    const why = notSupportedReason(path);
    if (why) {
      plan.errors.push(`${baseName(path)}: ${why}.`);
      continue;
    }
    plan.open.push(path);
  }
  return plan;
}

/** "Supported files" (every type of the picker), one entry per kind, then All files ([]). */
export function dialogFilters(picker: PickerKind = 'open'): Array<{ label: string; suffixes: string[] }> {
  const groups = pickerGroups(picker);
  if (groups.length === 0) return [];
  const every: string[] = [];
  for (const group of groups) for (const s of group.suffixes) if (!every.includes(s)) every.push(s);
  return [
    { label: 'Supported files', suffixes: every },
    ...(groups.length > 1 ? groups.map(g => ({ label: g.label, suffixes: g.suffixes })) : []),
    { label: 'All files', suffixes: [] },
  ];
}

/** True when a file name matches a filter's suffixes ([] = all files). */
export function matchesFilter(name: string, suffixes: string[]): boolean {
  if (suffixes.length === 0) return true;
  const lower = name.toLowerCase();
  return suffixes.some(suffix => endsWithSuffix(lower, suffix));
}

/** An <input type=file> accept list for a picker (indexes can still be dropped). */
export function acceptAttribute(picker: PickerKind = 'open'): string {
  return dialogFilters(picker)[0]?.suffixes.join(',') ?? '';
}
