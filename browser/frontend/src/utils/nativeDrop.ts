/**
 * Real paths of files dropped on the desktop app's window.
 *
 * A page only gets a dropped file's bytes, so a web browser uploads a copy.
 * The desktop app (fiberbrowser/desktop.py) also hears the drop, with each
 * file's path, and sends them here with the `native-drop` command; it sets
 * `window.__fiberbrowserNativeDrop` when it does. The drop handler then opens
 * those files where they are (no multi-GB copy, no re-indexing) and uploads
 * only files that came without a path.
 */
export interface NativeDroppedFile { name: string; path: string | null }

declare global {
  interface Window {
    __fiberbrowserNativeDrop?: boolean;
  }
}

let latest: { files: NativeDroppedFile[]; at: number } | null = null;
const waiters: Array<(files: NativeDroppedFile[]) => void> = [];
// Drops that stopped waiting (and uploaded): their reports, if they still come, are dropped.
let abandoned = 0;

/** The app reports a drop (the `native-drop` command): every file in order, its path or null. */
export function receiveNativeDrop(args: unknown): boolean {
  const raw = (args as { files?: unknown } | null)?.files;
  const files: NativeDroppedFile[] = Array.isArray(raw)
    ? raw.filter(f => !!f && typeof (f as NativeDroppedFile).name === 'string').map(f => ({
      name: (f as NativeDroppedFile).name,
      path: typeof (f as NativeDroppedFile).path === 'string' && (f as NativeDroppedFile).path ? (f as NativeDroppedFile).path : null,
    }))
    : [];
  const waiter = waiters.shift();
  if (waiter) waiter(files);
  else if (abandoned > 0) abandoned -= 1;  // late: its drop already uploaded
  else latest = { files, at: Date.now() };
  return true;
}

export function nativeDropAvailable(): boolean {
  return typeof window !== 'undefined' && window.__fiberbrowserNativeDrop === true;
}

/** Path per dropped file (by position): the app lists the drop's files in the page's order. */
function matchPaths(names: string[], files: NativeDroppedFile[]): Map<number, string> {
  const out = new Map<number, string>();
  if (files.length === names.length && files.every((f, i) => f.name === names[i])) {
    files.forEach((f, i) => { if (f.path) out.set(i, f.path); });
    return out;
  }
  // Not the same list: match only names that are unique on both sides.
  const count = (list: string[], name: string) => list.filter(n => n === name).length;
  const reported = files.map(f => f.name);
  names.forEach((name, i) => {
    if (count(names, name) !== 1 || count(reported, name) !== 1) return;
    const path = files.find(f => f.name === name)?.path;
    if (path) out.set(i, path);
  });
  return out;
}

/**
 * The real paths for this drop's files (index in `names` -> path), or none
 * after `timeoutMs`. A report that arrived just before the call counts (the
 * page's handler may still have been reading a session file).
 */
export function awaitNativeDropPaths(names: string[], timeoutMs = 2000): Promise<Map<number, string>> {
  if (!nativeDropAvailable()) return Promise.resolve(new Map());
  if (latest && Date.now() - latest.at <= timeoutMs) {
    const files = latest.files;
    latest = null;
    return Promise.resolve(matchPaths(names, files));
  }
  latest = null;
  return new Promise(resolve => {
    const done = (files: NativeDroppedFile[]) => {
      window.clearTimeout(timer);
      resolve(matchPaths(names, files));
    };
    const timer = window.setTimeout(() => {
      const at = waiters.indexOf(done);
      if (at >= 0) waiters.splice(at, 1);
      abandoned += 1;
      resolve(new Map());
    }, timeoutMs);
    waiters.push(done);
  });
}

/** Tests: forget any report. */
export function resetNativeDrop(): void {
  latest = null;
  waiters.length = 0;
  abandoned = 0;
}
