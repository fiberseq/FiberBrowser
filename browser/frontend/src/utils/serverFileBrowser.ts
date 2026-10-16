/**
 * In-page file browser for choosing files on the server. Used instead of the
 * native OS dialog when the page is opened from another machine (the dialog
 * would appear on the server's screen) or when no native dialog is available.
 */
/** A file-type choice in the dialog: the names ending in `suffixes` ([] = all files). */
export interface FileFilter {
  label: string;
  suffixes: string[];
}

export interface ServerFileRequest {
  /** Unique per request, so a replacement never inherits the old dialog's state. */
  id: number;
  title: string;
  multiple: boolean;
  folder: boolean;
  /** File-type choices, the first selected (none: every file is listed). */
  filters?: FileFilter[];
  resolve: (paths: string[] | null) => void;
}

type Listener = (request: ServerFileRequest | null) => void;

let listener: Listener | null = null;
let pending: ServerFileRequest | null = null;
let nextId = 1;

export function setServerFileBrowserListener(next: Listener | null): void {
  listener = next;
  if (next && pending) next(pending);
}

/** Ask the user to pick file(s) or a folder on the server; null if cancelled. */
export function chooseServerPaths(options: { title: string; multiple?: boolean; folder?: boolean; filters?: FileFilter[] }): Promise<string[] | null> {
  return new Promise(resolve => {
    // A newer request replaces (cancels) any open one.
    pending?.resolve(null);
    let settled = false;
    const request: ServerFileRequest = {
      id: nextId++,
      title: options.title,
      multiple: !!options.multiple,
      folder: !!options.folder,
      filters: options.filters,
      resolve: paths => {
        if (settled) return;
        settled = true;
        // Only the current request may close the dialog.
        if (pending === request) {
          pending = null;
          listener?.(null);
        }
        resolve(paths);
      },
    };
    pending = request;
    if (listener) listener(request);
    else request.resolve(null);
  });
}

/** True when the page is served from this machine, so a native dialog is visible. */
export function isLocalPage(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
