import { fetchJson } from './sharedFetch';
import { chooseServerPaths, isLocalPage, type FileFilter } from '../utils/serverFileBrowser';
import { dialogFilters, type PickerKind } from '../utils/supportedFiles';

const API_BASE = '/api';

export type PickFileType = 'gtf' | 'bigwig' | 'bam' | 'fasta' | 'fiberlayers' | 'footprint_rules';

export interface PickPathResponse {
  success: boolean;
  path: string | null;
  paths?: string[];
  message?: string;
  /** The user closed the native dialog (as opposed to it failing to open). */
  cancelled?: boolean;
}

async function listServerDirectory(path?: string): Promise<ServerDirectoryListing> {
  const params = path ? `?path=${encodeURIComponent(path)}` : '';
  return fetchJson(`${API_BASE}/files/list${params}`);
}
export { listServerDirectory };

export interface ServerDirectoryListing {
  success: boolean;
  path: string;
  parent?: string | null;
  home?: string;
  entries?: Array<{ name: string; path: string; is_dir: boolean; size: number | null }>;
  truncated?: boolean;
  /** Set when the requested path was a file: preselect it. */
  selected?: string | null;
  /** A lab server's data folders: the only places it lists (outside them it refuses). */
  roots?: Array<{ path: string; label: string; writable: boolean }>;
  message?: string;
}

/**
 * Native OS dialog when the page is local and one is available; otherwise
 * (remote page, or the dialog failed to open) the in-page server file browser.
 * ``fromServerPaths`` turns an in-page choice into the native route's reply
 * when that route does more than return the path (e.g. scanning a folder).
 */
export async function pickWithFallback<T extends { success: boolean; path: string | null; message?: string; cancelled?: boolean }>(
  native: () => Promise<T>,
  options: { title: string; multiple?: boolean; folder?: boolean; filters?: FileFilter[] },
  fromServerPaths?: (paths: string[]) => Promise<T>,
): Promise<T | PickPathResponse> {
  if (isLocalPage()) {
    try {
      const result = await native();
      if ((result as { busy?: boolean }).busy && result.message) {
        // A native dialog is already open (maybe behind the window): say so.
        const message = result.message;
        void import('../stores/browserStore').then(({ useBrowserStore }) => useBrowserStore.getState().setError(message));
      }
      if (result.success || result.cancelled) return result;
    } catch {
      // fall through to the in-page browser
    }
  }
  const paths = await chooseServerPaths(options);
  if (!paths || paths.length === 0) return { success: false, cancelled: true, path: null, paths: [], message: 'No file selected' };
  if (fromServerPaths) return fromServerPaths(paths);
  return { success: true, path: paths[0], paths };
}

export async function pickFolder(prompt?: string): Promise<{ success: boolean; path: string | null; message?: string }> {
  const params = prompt ? `?prompt=${encodeURIComponent(prompt)}` : '';
  return pickWithFallback(() => fetchJson(`${API_BASE}/pick_folder${params}`), { title: prompt || 'Choose a folder', folder: true });
}

export async function loadFolder(path: string): Promise<{ success: boolean; dataset_id?: string; label?: string; message?: string }> {
  return fetchJson(`${API_BASE}/load_folder?path=${encodeURIComponent(path)}`, {
    method: 'POST'
  });
}

export async function pickFile(fileType: PickFileType = 'gtf'): Promise<PickPathResponse> {
  return pickWithFallback(() => fetchJson(`${API_BASE}/pick_file?file_type=${fileType}`), { title: 'Choose a file' });
}

declare global {
  interface Window {
    pywebview?: { api?: { pick_files?: (fileType: string, multiple: boolean) => Promise<PickPathResponse> } };
  }
}

/**
 * The open dialog for files FiberBrowser opens: in the desktop app its own
 * panel (filters: Supported files, each kind, All files; fiberbrowser/desktop.py),
 * else the server's native dialog, else the in-page browser (same filters).
 */
async function pickOpenFiles(picker: PickerKind, title: string): Promise<PickPathResponse> {
  const viaServer = () => fetchJson<PickPathResponse>(`${API_BASE}/pick_file?file_type=${picker}&multiple=true`);
  const appDialog = typeof window !== 'undefined' ? window.pywebview?.api?.pick_files : undefined;
  const native = appDialog
    ? async () => {
      try {
        const result = await appDialog(picker, true);
        if (result && (result.success || result.cancelled)) return result;
      } catch { /* the server's dialog instead */ }
      return viaServer();
    }
    : viaServer;
  return pickWithFallback(native, { title, multiple: true, filters: dialogFilters(picker) });
}

export async function pickDataset(): Promise<PickPathResponse> {
  return pickOpenFiles('dataset', 'Choose data files');
}

/** Load File / File > Open: the files FiberBrowser opens (Supported files first). */
export async function pickFilesToOpen(): Promise<PickPathResponse> {
  return pickOpenFiles('open', 'Choose files');
}

/** Any file, no type filter (run inputs such as FASTQ, relinking, references...). */
export async function pickAnyFile(): Promise<PickPathResponse> {
  return pickWithFallback(() => fetchJson(`${API_BASE}/pick_file?file_type=any&multiple=true`), { title: 'Choose files', multiple: true });
}

export async function uploadFile(file: File): Promise<{ success: boolean; path: string; filename: string }> {
  const formData = new FormData();
  formData.append('file', file);
  return fetchJson(`${API_BASE}/files/upload`, { method: 'POST', body: formData });
}
