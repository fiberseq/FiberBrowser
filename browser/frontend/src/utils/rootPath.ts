/**
 * Serving under a URL prefix, and the CSRF header of a lab server.
 *
 * Behind a reverse proxy that publishes FiberBrowser at a sub-path (Open
 * OnDemand's `/rnode/<host>/<port>/`, a lab proxy's `/fiberbrowser/`), the
 * server injects `window.__FIBERBROWSER_ROOT__` (backend services/root_path.py)
 * and every root-relative URL the app requests (`/api/...`, `/?workspace=new`)
 * must carry that prefix. The app writes plain `/api/...` URLs everywhere, so
 * installRootPath() (run by sandboxBootstrap.ts before anything else) adds the
 * prefix where requests leave the page: fetch, XMLHttpRequest, EventSource,
 * WebSocket, sendBeacon, window.open, and `src`/`href` set on elements
 * (images and download links built from API URLs).
 *
 * The same fetch/XHR layer sends `X-FiberBrowser-CSRF` (the value of the
 * `fiberbrowser_csrf` cookie, when the server set one) with every same-origin
 * POST/PUT/PATCH/DELETE: a lab server refuses state changes without it
 * (double-submit CSRF protection). Without a prefix or that cookie nothing
 * changes.
 */

export const CSRF_COOKIE = 'fiberbrowser_csrf';
export const CSRF_HEADER = 'X-FiberBrowser-CSRF';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PREFIX_RE = /^(\/[A-Za-z0-9._~%!$&'()*+,;=:@-]+)+$/;

interface RootWindow {
  __FIBERBROWSER_ROOT__?: string;
}

let overrideRoot: string | null = null;

/** The URL prefix this page is served under ('' at the site root). */
export function rootPath(win: Window | undefined = typeof window === 'undefined' ? undefined : window): string {
  if (overrideRoot !== null) return overrideRoot;
  const value = win ? (win as unknown as RootWindow).__FIBERBROWSER_ROOT__ : undefined;
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\/+$/, '');
  return PREFIX_RE.test(trimmed) ? trimmed : '';
}

function prefixed(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * A URL as the browser must request it: root-relative (`/api/x`) and
 * same-origin absolute URLs get the prefix; relative, other-origin, `data:`,
 * `blob:` and already-prefixed URLs are returned unchanged.
 */
export function withRootPath(url: string, win: Window | undefined = typeof window === 'undefined' ? undefined : window): string {
  const root = rootPath(win);
  if (!root || typeof url !== 'string' || !url) return url;
  if (url.startsWith('/') && !url.startsWith('//')) {
    return prefixed(url.split(/[?#]/, 1)[0], root) ? url : root + url;
  }
  if (!win || !/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== win.location.origin || prefixed(parsed.pathname, root)) return url;
    parsed.pathname = root + parsed.pathname;
    return parsed.toString();
  } catch {
    return url;
  }
}

function readCookie(win: Window, name: string): string | null {
  try {
    const match = win.document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function isSameOrigin(url: string, win: Window): boolean {
  try {
    return new URL(url, win.location.href).origin === win.location.origin;
  } catch {
    return false;
  }
}

function define(target: object, name: string, value: unknown): void {
  try {
    Object.defineProperty(target, name, { configurable: true, enumerable: true, writable: true, value });
  } catch { /* not replaceable here */ }
}

let installed = false;

/** Install the prefix and CSRF layer (idempotent). `root` overrides the page's (tests). */
export function installRootPath(win: Window = window, root: string | null = null): void {
  if (root !== null) overrideRoot = root.replace(/\/+$/, '');
  if (installed) return;
  installed = true;
  const w = win as Window & typeof globalThis;

  const originalFetch = w.fetch?.bind(w);
  if (originalFetch) {
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
      const rawUrl = request ? request.url : input instanceof URL ? input.href : String(input);
      const url = withRootPath(rawUrl, w);
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const csrf = UNSAFE.has(method) && isSameOrigin(url, w) ? readCookie(w, CSRF_COOKIE) : null;
      if (url === rawUrl && !csrf) return originalFetch(input, init);
      let nextInit = init;
      if (csrf) {
        const headers = new Headers(init?.headers ?? request?.headers ?? undefined);
        if (!headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, csrf);
        nextInit = { ...init, headers };
      }
      if (request) return originalFetch(new Request(url, request), nextInit);
      return originalFetch(url === rawUrl ? input : url, nextInit);
    }) as typeof fetch;
  }

  const Xhr = w.XMLHttpRequest;
  if (Xhr) {
    const open = Xhr.prototype.open;
    const send = Xhr.prototype.send;
    const methods = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    Xhr.prototype.open = function patchedOpen(this: XMLHttpRequest, ...args: unknown[]) {
      const method = String(args[0] ?? 'GET').toUpperCase();
      const url = withRootPath(String(args[1]), w);
      methods.set(this, { method, url });
      (open as (...a: unknown[]) => void).apply(this, [args[0], url, ...args.slice(2)]);
    } as typeof open;
    Xhr.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const info = methods.get(this);
      if (info && UNSAFE.has(info.method) && isSameOrigin(info.url, w)) {
        const csrf = readCookie(w, CSRF_COOKIE);
        if (csrf) {
          try { this.setRequestHeader(CSRF_HEADER, csrf); } catch { /* already sent */ }
        }
      }
      return send.call(this, body);
    };
  }

  if (!rootPath(w)) return;  // everything below only rewrites URLs

  const OriginalEventSource = w.EventSource;
  if (OriginalEventSource) {
    define(w, 'EventSource', class extends OriginalEventSource {
      constructor(url: string | URL, init?: EventSourceInit) { super(withRootPath(String(url), w), init); }
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
            const root = rootPath(w);
            if (!prefixed(parsed.pathname, root)) parsed.pathname = root + parsed.pathname;
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
    define(nav, 'sendBeacon', (url: string | URL, data?: BodyInit | null) => beacon(withRootPath(String(url), w), data));
  }

  if (typeof w.open === 'function') {
    const openWindow = w.open.bind(w);
    w.open = ((url?: string | URL, target?: string, features?: string) =>
      openWindow(url === undefined ? url : withRootPath(String(url), w), target, features)) as typeof w.open;
  }

  // Images and links built from API URLs (<img src="/api/...">, download anchors).
  const ElementProto = w.Element?.prototype;
  if (ElementProto) {
    const setAttribute = ElementProto.setAttribute;
    ElementProto.setAttribute = function patchedSetAttribute(this: Element, name: string, value: string) {
      const lower = String(name).toLowerCase();
      if ((lower === 'src' || lower === 'href') && typeof value === 'string' && this.namespaceURI === 'http://www.w3.org/1999/xhtml') {
        return setAttribute.call(this, name, withRootPath(value, w));
      }
      return setAttribute.call(this, name, value);
    };
  }
  for (const [ctor, prop] of [[w.HTMLImageElement, 'src'], [w.HTMLAnchorElement, 'href'],
    [w.HTMLLinkElement, 'href'], [w.HTMLScriptElement, 'src'], [w.HTMLIFrameElement, 'src'],
    [w.HTMLSourceElement, 'src']] as const) {
    const proto = ctor?.prototype as object | undefined;
    if (!proto) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (!descriptor?.set || !descriptor.get) continue;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(this: Element, value: string) { descriptor.set!.call(this, withRootPath(String(value), w)); },
      });
    } catch { /* leave it */ }
  }
}

/** For tests: forget the override and the installed guard. */
export function resetRootPathForTests(): void {
  overrideRoot = null;
  installed = false;
}
