/**
 * Sandbox tabs: a tab opened at `/?sandbox=<id>` (the guided tour's tab, see
 * tourTab.ts) runs on its own server session, created by POST /api/sandbox,
 * and can never change the user's work.
 *
 * installSandbox() (run by sandboxBootstrap.ts, the first import in main.tsx)
 * does the tab's half:
 *   - every same-origin request names the sandbox: fetch and XMLHttpRequest
 *     carry the X-FiberBrowser-Sandbox header; EventSource, WebSocket,
 *     sendBeacon and window.open URLs get `sandbox=<id>` (image URL builders
 *     add it with withSandboxParam). The server also falls back to the
 *     page's Referer, so a plain <img>/<a> that misses both still lands in
 *     the sandbox;
 *   - localStorage and sessionStorage are in-memory for the tab, and
 *     IndexedDB is off, so it never reads or overwrites the user's saved
 *     settings, autosave or crash-recovery data;
 *   - the page runs as a public-mode visitor (no Quit, no host files).
 *
 * An independent workspace (`/?workspace=<ws-id>`, started from
 * `/?workspace=new`, see backend state/workspace.py) is a tab of the same kind
 * with a `ws-` id: its own server session and in-memory storage, but the
 * owner's full UI (not public mode) and no tour.
 */

export const SANDBOX_HEADER = 'X-FiberBrowser-Sandbox';
export const SANDBOX_PARAM = 'sandbox';
export const WORKSPACE_PARAM = 'workspace';
/** Fired on window when the server says this tab's sandbox has ended. */
export const SANDBOX_EXPIRED_EVENT = 'fiberbrowser:sandbox-expired';

const ID_RE = /^(sb|ws)-[A-Za-z0-9_-]{16,64}$/;

interface SandboxWindow {
  __FIBERBROWSER_SANDBOX__?: string;
  __FIBERBROWSER_SANDBOX_EXPIRED__?: boolean;
  __FIBERHMM_PUBLIC__?: boolean;
  __FIBERBROWSER_WORKSPACE__?: boolean;
}

export function validSandboxId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** A workspace id (`ws-`), as opposed to a tour sandbox's (`sb-`). */
export function isWorkspaceId(value: unknown): boolean {
  return validSandboxId(value) && value.startsWith('ws-');
}

function idFromWindow(win: Window): string | null {
  const injected = (win as unknown as SandboxWindow).__FIBERBROWSER_SANDBOX__;
  if (validSandboxId(injected)) return injected;
  try {
    const params = new URLSearchParams(win.location.search);
    const fromUrl = params.get(SANDBOX_PARAM);
    if (validSandboxId(fromUrl)) return fromUrl;
    const workspace = params.get(WORKSPACE_PARAM);
    return isWorkspaceId(workspace) ? workspace : null;
  } catch {
    return null;
  }
}

// Captured once, at first import: the app later rewrites the address bar
// (viewport sync), and must keep working as the same sandbox regardless.
let capturedId: string | null = typeof window === 'undefined' ? null : idFromWindow(window);

/** This tab's sandbox or workspace id, or null in a normal tab. */
export function sandboxId(): string | null {
  return capturedId;
}

/** A tour sandbox tab (public-mode rules). */
export function isSandboxPage(): boolean {
  return capturedId !== null && !isWorkspaceId(capturedId);
}

/** An independent workspace tab (its own session, full local UI). */
export function isWorkspacePage(): boolean {
  return isWorkspaceId(capturedId);
}

/** Whether the server has already said this tab's sandbox ended. */
export function sandboxExpired(): boolean {
  return typeof window !== 'undefined'
    && (window as unknown as SandboxWindow).__FIBERBROWSER_SANDBOX_EXPIRED__ === true;
}

function sameOrigin(url: string, win: Window): URL | null {
  try {
    const parsed = new URL(url, win.location.href);
    return parsed.origin === win.location.origin ? parsed : null;
  } catch {
    return null;
  }
}

/** A same-origin URL with this tab's sandbox in its query (unchanged in a normal tab). */
export function withSandboxParam(url: string, win: Window = window): string {
  const id = capturedId;
  if (!id) return url;
  const parsed = sameOrigin(url, win);
  if (!parsed || parsed.searchParams.get(SANDBOX_PARAM) === id) return url;
  parsed.searchParams.set(SANDBOX_PARAM, id);
  // Keep a relative URL relative (callers compare and cache by it).
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')
    ? parsed.toString()
    : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Storage that lives and dies with the tab. */
export class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
  getItem(key: string): string | null { return this.items.has(String(key)) ? this.items.get(String(key))! : null; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string): void { this.items.delete(String(key)); }
  setItem(key: string, value: string): void { this.items.set(String(key), String(value)); }
}

function define(target: object, name: string, value: unknown): void {
  try {
    Object.defineProperty(target, name, { configurable: true, enumerable: true, writable: true, value });
  } catch { /* not replaceable here: leave it */ }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

let installed = false;

/**
 * Turn this page into a sandbox tab when it was opened with one (idempotent).
 * `id` overrides the page's own (for tests). Returns the id, or null.
 */
export function installSandbox(win: Window = window, id: string | null = null): string | null {
  if (id !== null) capturedId = validSandboxId(id) ? id : null;
  if (!capturedId || installed) return capturedId;
  const sandbox: string = capturedId;
  installed = true;
  const w = win as Window & typeof globalThis & SandboxWindow;

  // A tour tab is a public-mode visitor (the server says so too, in
  // /api/status; this covers the dev server, which doesn't inject it). A
  // workspace keeps the owner's full UI.
  if (isWorkspaceId(sandbox)) w.__FIBERBROWSER_WORKSPACE__ = true;
  else w.__FIBERHMM_PUBLIC__ = true;
  w.__FIBERBROWSER_SANDBOX__ = sandbox;

  const expired = () => {
    if (w.__FIBERBROWSER_SANDBOX_EXPIRED__) return;
    w.__FIBERBROWSER_SANDBOX_EXPIRED__ = true;
    try { w.dispatchEvent(new Event(SANDBOX_EXPIRED_EVENT)); } catch { /* no events here */ }
  };

  const originalFetch = w.fetch?.bind(w);
  if (originalFetch) {
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (!sameOrigin(urlOf(input), w)) return originalFetch(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set(SANDBOX_HEADER, sandbox);
      return originalFetch(input, { ...init, headers }).then(response => {
        if (response.status === 410 && response.headers.get('x-fiberbrowser-sandbox-expired')) expired();
        return response;
      });
    }) as typeof fetch;
  }

  const Xhr = w.XMLHttpRequest;
  if (Xhr) {
    const open = Xhr.prototype.open;
    Xhr.prototype.open = function patchedOpen(this: XMLHttpRequest, ...args: unknown[]) {
      (open as (...a: unknown[]) => void).apply(this, args);
      if (sameOrigin(String(args[1]), w)) this.setRequestHeader(SANDBOX_HEADER, sandbox);
    } as typeof open;
  }

  const OriginalEventSource = w.EventSource;
  if (OriginalEventSource) {
    define(w, 'EventSource', class extends OriginalEventSource {
      constructor(url: string | URL, init?: EventSourceInit) { super(withSandboxParam(String(url), w), init); }
    });
  }

  const OriginalWebSocket = w.WebSocket;
  if (OriginalWebSocket) {
    define(w, 'WebSocket', class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        let target = String(url);
        try {
          const parsed = new URL(target, w.location.href);
          if (parsed.host === w.location.host) {
            parsed.searchParams.set(SANDBOX_PARAM, sandbox);
            target = parsed.toString();
          }
        } catch { /* leave it */ }
        super(target, protocols);
      }
    });
  }

  const nav = w.navigator as Navigator | undefined;
  if (nav && typeof nav.sendBeacon === 'function') {
    const beacon = nav.sendBeacon.bind(nav);
    define(nav, 'sendBeacon', (url: string | URL, data?: BodyInit | null) => beacon(withSandboxParam(String(url), w), data));
  }

  if (typeof w.open === 'function') {
    const open = w.open.bind(w);
    w.open = ((url?: string | URL, target?: string, features?: string) =>
      open(url === undefined ? url : withSandboxParam(String(url), w), target, features)) as typeof w.open;
  }

  // Nothing this tab saves may reach the user's own storage.
  define(w, 'localStorage', new MemoryStorage());
  define(w, 'sessionStorage', new MemoryStorage());
  const blocked = () => { throw new DOMException('Storage is off in a tour tab or workspace', 'SecurityError'); };
  define(w, 'indexedDB', { open: blocked, deleteDatabase: blocked, databases: async () => [], cmp: () => 0 });

  if (w.__FIBERBROWSER_SANDBOX_EXPIRED__) {
    // Reloaded after it ended: say so once the page can show it.
    w.__FIBERBROWSER_SANDBOX_EXPIRED__ = false;
    setTimeout(expired, 0);
  }
  return sandbox;
}

/** For tests: forget the captured id and installed patches' guard. */
export function resetSandboxForTests(id: string | null = null): void {
  capturedId = id;
  installed = false;
}
