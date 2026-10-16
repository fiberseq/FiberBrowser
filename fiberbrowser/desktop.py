"""FiberBrowser in its own app window (``fiberbrowser --app`` and the Mac app).

The window is a native web view (pywebview: WKWebView on macOS, WebView2 on
Windows, WebKitGTK/Qt on Linux) on a FiberBrowser server that this process
starts as a child:

- the server runs as a separate process (``/api/quit`` and the tab-closed
  shutdown stop their own process with SIGTERM, which must not take the window
  down mid-reply), on a free port, with the per-launch access token (this
  process picks it and passes it in ``FIBERBROWSER_TOKEN``) and its usual
  entry in ``~/.fiberhmm/browser_runtime.json``;
- every window opens the tokened link, so it never depends on sharing
  cookies with another window;
- the server stops when the app quits (File > Quit, Cmd+Q, the last window
  closed) and, through ``FIBERBROWSER_EXIT_WITH_PARENT``, even when the app is
  force-quit; the app closes when the server stops (the page's Quit button);
  if the server crashes instead, the window shows the end of its log
  (``~/.fiberhmm/logs/fiberbrowser-app-server.log``, line-buffered, with a
  timestamped line for stuck, slow or failing requests and every traceback);
- pages that open a new tab (the guided tour's sandbox tab, "New independent
  workspace") get a new app window instead: a small script replaces
  ``window.open`` in each page, because the web view would otherwise refuse
  it and the tour would fall back to running in the user's own workspace.

- ``fiberbrowser://open?session=...`` links (the Mac app registers the
  scheme) are staged on this app's server and shown in a new window at
  ``/?open_link=<id>``, where the user confirms before anything loads
  (``fiberbrowser.open_link``); links that arrive while the server starts wait.

- opening files: the page's open dialogs use the app's own panel
  (``_PageApi.pick_files``: an NSOpenPanel on macOS) with the filters of
  ``browser/frontend/src/data/supportedFiles.json`` ("Supported files", one per
  kind, "All files"); files dropped on a window open from where they are (the
  page gets their paths through the ``native-drop`` command) instead of being
  uploaded to the server as a copy.

The menu bar (fiberbrowser.app_menu) mirrors the app's commands with the usual
shortcuts (File > Open File... Cmd+O, Save Session Cmd+S, Edit > Undo Cmd+Z, Copy,
Paste, View > Go to Locus... Cmd+L, ...); most run in the front window's page
through its command bus, ``window.fiberbrowserCommand(name)``.
"""
from __future__ import annotations

import errno
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Optional, Sequence
from urllib.parse import urlencode, urlsplit

from ._paths import browser_dir, build_flavor, icons_dir, is_frozen, version

APP_NAME = "FiberBrowser"
# A stable port keeps the pages' origin, and with it their saved preferences
# (localStorage), the same from one launch to the next; the next free one is
# used when it's taken (a second copy, another program).
PREFERRED_PORTS = range(8756, 8776)
READY_TIMEOUT_S = 180.0

# Injected into every page: window.open() and target=_blank links to this
# server open another app window (through the Python API below); other
# addresses open in the default web browser.
WINDOW_OPEN_SHIM = r"""
(function () {
  if (window.__fiberbrowserAppShim) return;
  window.__fiberbrowserAppShim = true;
  function openNative(url) {
    try {
      var absolute = new URL(String(url), window.location.href).href;
      if (window.pywebview && window.pywebview.api && window.pywebview.api.open_window) {
        window.pywebview.api.open_window(absolute);
      }
    } catch (e) { /* malformed address: ignore, as a blocked popup would */ }
  }
  window.open = function (url) {
    var target = url ? String(url) : '';
    var opened = target && target !== 'about:blank';
    if (opened) openNative(target);
    // Stands in for the new tab: the tour opens about:blank, then sets
    // location.href once its sandbox exists.
    var stub = {
      closed: false, opener: null, name: '',
      document: { title: '', body: { textContent: '' } },
      focus: function () {}, blur: function () {}, postMessage: function () {},
      close: function () { stub.closed = true; }
    };
    var go = function (href) { if (!stub.closed) { stub.closed = true; openNative(href); } };
    stub.location = {
      get href() { return opened ? target : 'about:blank'; },
      set href(value) { go(value); },
      assign: go, replace: go, toString: function () { return stub.location.href; }
    };
    if (opened) stub.closed = true;
    return stub;
  };
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[target="_blank"]') : null;
    if (!link || !link.href || link.hasAttribute('download')) return;
    event.preventDefault();
    openNative(link.href);
  }, true);
})();
"""

SPLASH_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>FiberBrowser</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1f2937;background:#f8fafc}
@media (prefers-color-scheme:dark){body{color:#e5e7eb;background:#0f172a}}
.box{text-align:center}.box p{opacity:.7;margin:.3em 0}</style></head>
<body><div class="box"><h2>FiberBrowser</h2><p>Starting&hellip;</p></div></body></html>"""


_ABOUT_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>About FiberBrowser</title>
<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:3em;text-align:center;color:#1f2937}
@media (prefers-color-scheme:dark){body{color:#e5e7eb;background:#0f172a}}</style></head>
<body><p>{text}</p><p><a href="https://github.com/fiberseq/FiberBrowser" target="_blank">github.com/fiberseq/FiberBrowser</a></p>
<p style="font-size:12px;opacity:.8">{cite}</p></body></html>"""


def citation_text() -> str:
    """How to cite: FiberBrowser (CITATION.cff) and FiberHMM, which calls the footprints it shows."""
    return (f"How to cite: {APP_NAME} {version()} (github.com/fiberseq/FiberBrowser; CITATION.cff) "
            "and FiberHMM (github.com/fiberseq/FiberHMM).")


def fiberhmm_version() -> str:
    """The FiberHMM this app runs (its package metadata; the module as a fallback)."""
    try:
        from importlib.metadata import version as dist_version
        return dist_version("fiberhmm")
    except Exception:
        pass
    try:
        import fiberhmm
        return str(getattr(fiberhmm, "__version__", "unknown"))
    except Exception:
        return "not installed"


def _error_html(message: str, log_path: Path, heading: str = "FiberBrowser could not start") -> str:
    import html
    tail = ""
    try:
        tail = "\n".join(log_path.read_text(errors="replace").splitlines()[-40:])
    except OSError:
        pass
    return ("<!doctype html><html><head><meta charset='utf-8'><title>FiberBrowser</title>"
            "<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:2em;color:#1f2937}"
            "pre{background:#f3f4f6;padding:1em;overflow:auto;font-size:12px}</style></head><body>"
            f"<h2>{html.escape(heading)}</h2><p>{html.escape(message)}</p>"
            f"<p>Full log: <code>{html.escape(str(log_path))}</code></p><pre>{html.escape(tail)}</pre>"
            "</body></html>")


def _stamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# How the server ends when it was asked to (the page's Quit button, the last
# tab closed, the app quitting): uvicorn stops on SIGTERM/SIGINT and re-raises
# it (on Windows, os.kill(SIGTERM) exits with code 15).
_REQUESTED_EXITS = {0, -signal.SIGTERM, -signal.SIGINT} | ({int(signal.SIGTERM)} if sys.platform == "win32" else set())


def exit_was_requested(code: Optional[int]) -> bool:
    return code in _REQUESTED_EXITS


def describe_exit(code: Optional[int]) -> str:
    if code is not None and code < 0:
        try:
            name = signal.Signals(-code).name
        except ValueError:
            name = f"signal {-code}"
        return f"The server stopped unexpectedly ({name})."
    return f"The server stopped unexpectedly (exit code {code})."


def user_cache_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / APP_NAME
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / APP_NAME / "Cache"
    return Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "fiberbrowser"


def log_dir() -> Path:
    return Path(os.environ.get("FIBERBROWSER_LOG_DIR", str(Path.home() / ".fiberhmm" / "logs"))).expanduser()


def _something_listens(port: int, host: str) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        try:
            code = sock.connect_ex((host, port))
        except OSError:
            return True
    return code not in (errno.ECONNREFUSED, getattr(errno, "WSAECONNREFUSED", errno.ECONNREFUSED))


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    """Whether the app's server can listen on the port.

    The server (uvicorn) binds with SO_REUSEADDR on POSIX, so the TIME_WAIT
    entries a stopped or crashed server leaves on its port for ~30 s don't
    keep it; a plain test bind failed on them, and a relaunch right after a
    crash or a quit moved to the next port: another origin, without the
    pages' autosave (the crash-recovery and "Reopen your last session"
    offers). Bind the way the server does, and ask the port whether anything
    listens (with SO_REUSEADDR a 127.0.0.1 bind succeeds next to a 0.0.0.0
    listener on macOS).
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if sys.platform != "win32":  # on Windows SO_REUSEADDR would share a live port
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return not _something_listens(port, host)


def pick_port(preferred: Sequence[int] = PREFERRED_PORTS) -> int:
    for port in preferred:
        if port_is_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def server_command(server_args: Sequence[str], port: int) -> list[str]:
    """How to start this FiberBrowser's server as a child process. The app runs
    it without the Copilot (``--no-copilot``): the pip install keeps it."""
    tail = [*server_args, "--port", str(port), "--no-open-browser"]
    if "--no-copilot" not in tail:
        tail.append("--no-copilot")
    if is_frozen():
        return [sys.executable, "--serve", *tail]  # the app binary (fiberbrowser.frozen_entry)
    return [sys.executable, "-m", "fiberbrowser", *tail]


def server_environment(token: str, parent_pid: int, environ: Optional[dict] = None) -> dict:
    env = dict(os.environ if environ is None else environ)
    env["FIBERBROWSER_TOKEN"] = token
    env["FIBERBROWSER_EXIT_WITH_PARENT"] = str(parent_pid)
    env["FIBERBROWSER_NO_OPEN"] = "1"
    env.setdefault("PYTHONUNBUFFERED", "1")
    if is_frozen():
        # Nothing may be written inside the (signed) app bundle.
        cache = user_cache_dir()
        env.setdefault("NUMBA_CACHE_DIR", str(cache / "numba"))
        env.setdefault("PYTHONPYCACHEPREFIX", str(cache / "pycache"))
        # An app started from the Finder gets a bare PATH: also find programs the
        # user installed with Homebrew (samtools, blastn, bedToBigBed, ...), after
        # the system's and the app's own (the server prepends Helpers and bin).
        path = [p for p in env.get("PATH", "").split(os.pathsep) if p]
        for extra in ("/opt/homebrew/bin", "/usr/local/bin"):
            if extra not in path and os.path.isdir(extra):
                path.append(extra)
        env["PATH"] = os.pathsep.join(path)
    return env


def is_same_server(url: str, base: str) -> bool:
    a, b = urlsplit(url), urlsplit(base)
    local = {"127.0.0.1", "localhost", "::1"}
    return (a.scheme, a.port) == (b.scheme, b.port) and a.hostname in local and b.hostname in local


def with_token(url: str, token: str) -> str:
    parts = urlsplit(url)
    from urllib.parse import parse_qsl, urlunsplit
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "token"]
    query.append(("token", token))
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", urlencode(query), parts.fragment))


class _PageApi:
    """What pages may call (window.pywebview.api): opening a window, and the open dialog."""

    def __init__(self, app: "DesktopApp") -> None:
        self._app = app

    def open_window(self, url: str) -> bool:
        return self._app.open_url(str(url))

    def pick_files(self, file_type: str = "open", multiple: bool = True) -> dict:
        return self._app.pick_files(str(file_type), bool(multiple))


def _supported_files():
    """browser/services/supported_files.py (stdlib only), loaded by path: the
    app process doesn't have the server's modules on sys.path."""
    import importlib.util
    path = browser_dir() / "services" / "supported_files.py"
    spec = importlib.util.spec_from_file_location("fiberbrowser_supported_files", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def open_dialog_file_types(file_type: str) -> Optional[tuple]:
    """pywebview ``file_types`` for a page picker ("open", "dataset"); None: no list for it."""
    try:
        module = _supported_files()
    except Exception:
        return None
    if not module.has_picker(file_type):
        return None
    return module.pywebview_file_types(file_type)


def dropped_files(event) -> list:
    """[{name, path}] for every file of a pywebview ``drop`` event, in the page's
    order (the page matches them by position); ``path`` is None for a file
    without one (dragged from a web page)."""
    transfer = (event or {}).get("dataTransfer") if isinstance(event, dict) else None
    files = (transfer or {}).get("files") or []
    out = []
    for item in files:
        if not isinstance(item, dict):
            continue
        path = item.get("pywebviewFullPath")
        out.append({"name": str(item.get("name") or (os.path.basename(path) if path else "")),
                    "path": str(path) if path else None})
    return out


def split_port(server_args: Sequence[str]) -> tuple[Optional[int], list[str]]:
    """An explicit ``-p/--port N`` from the server options, and the options without it."""
    args, port, i = list(server_args), None, 0
    rest: list[str] = []
    while i < len(args):
        arg = args[i]
        value = None
        if arg in ("-p", "--port") and i + 1 < len(args):
            value, i = args[i + 1], i + 2
        elif arg.startswith("--port="):
            value, i = arg.split("=", 1)[1], i + 1
        else:
            rest.append(arg)
            i += 1
            continue
        try:
            port = int(value)
        except ValueError:
            rest.extend([arg] if "=" in arg else [arg, value])  # let the server report it
    return port, rest


class DesktopApp:
    def __init__(self, server_args: Sequence[str] = (), port: Optional[int] = None) -> None:
        # fiberbrowser:// links given on the command line (Linux/Windows handlers).
        self.link_args = [a for a in server_args if str(a).lower().startswith("fiberbrowser:")]
        server_args = [a for a in server_args if a not in self.link_args]
        requested, self.server_args = split_port(server_args)
        # An explicit --port is used when it is free, like the preferred ports.
        self.port = port or pick_port([requested] if requested else PREFERRED_PORTS)
        self.base = f"http://127.0.0.1:{self.port}"
        self.token = secrets.token_urlsafe(32)
        self.proc: Optional[subprocess.Popen] = None
        self.log_path = log_dir() / "fiberbrowser-app-server.log"
        self.windows: list = []
        self._stopping = False
        self._api = _PageApi(self)
        self._window_count = 0
        self._ready = False
        self._queued_links: list[str] = []
        self._url_handler = None

    # --- server -----------------------------------------------------------------
    def start_server(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        log = open(self.log_path, "w", buffering=1)
        log.write(f"FiberBrowser {version()} app server on {self.base} (started {_stamp()})\n")
        cmd = server_command(self.server_args, self.port)
        self.proc = subprocess.Popen(cmd, env=server_environment(self.token, os.getpid()),
                                     stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        log.close()

    def server_ready(self) -> bool:
        request = urllib.request.Request(self.base + "/api/status",
                                         headers={"X-FiberBrowser-Token": self.token})
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status == 200
        except (urllib.error.URLError, OSError, ValueError):
            return False

    def wait_ready(self, timeout: float = READY_TIMEOUT_S) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                return False
            if self.server_ready():
                return True
            time.sleep(0.3)
        return False

    def stop_server(self, timeout: float = 8.0) -> None:
        self._stopping = True
        proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()  # uvicorn shuts down cleanly and drops its runtime-file entry
        try:
            proc.wait(timeout)
        except subprocess.TimeoutExpired:
            proc.kill()

    # --- windows ----------------------------------------------------------------
    def url(self, path: str = "/") -> str:
        return with_token(self.base + path, self.token)

    def create_window(self, url: Optional[str] = None, title: str = APP_NAME, html: Optional[str] = None):
        import webview
        self._window_count += 1
        offset = 28 * ((self._window_count - 1) % 8)
        window = webview.create_window(title, url=url, html=html, js_api=self._api, width=1440, height=900,
                                       x=None if offset == 0 else 80 + offset,
                                       y=None if offset == 0 else 60 + offset,
                                       min_size=(900, 600), text_select=True, zoomable=True)
        window.events.loaded += self._on_loaded
        window.events.closed += lambda: self.windows.remove(window) if window in self.windows else None
        self.windows.append(window)
        return window

    def _on_loaded(self, window) -> None:
        try:
            if is_same_server(window.get_current_url() or "", self.base):
                window.run_js(WINDOW_OPEN_SHIM)
                self._listen_for_drops(window)
        except Exception:
            pass

    def _listen_for_drops(self, window) -> None:
        """Files dropped on the page reach it with their real paths.

        A web page only gets a dropped file's bytes, so the browser route
        uploads a copy (a multi-GB BAM, then indexed again). pywebview knows
        the paths when a drop listener is registered from Python; this one
        sends them to the page (command ``native-drop``), which then opens
        the files where they are. ``__fiberbrowserNativeDrop`` tells the page
        to wait for them; a drop without paths still uploads."""
        try:
            from webview.dom import DOMEventHandler
            document = window.dom.document
        except Exception:
            return

        def on_drop(event):
            # Even an empty list: the page stops waiting and uploads instead.
            self.run_command(window, "native-drop", {"files": dropped_files(event)})

        try:
            document.events.drop += DOMEventHandler(on_drop, prevent_default=False, stop_propagation=False)
            window.run_js("window.__fiberbrowserNativeDrop = true;")
        except Exception:
            pass

    def pick_files(self, file_type: str, multiple: bool) -> dict:
        """The page's open dialog in the app: the app's own panel, with the
        shared filters (Supported files, one per kind, All files)."""
        window = self.front_window()
        file_types = open_dialog_file_types(file_type)
        if window is None or file_types is None:
            # The page falls back to the server's dialog.
            return {"success": False, "cancelled": False, "path": None, "paths": [],
                    "message": "The app's open dialog is not available for this picker."}
        try:
            import webview
            dialog = getattr(getattr(webview, "FileDialog", None), "OPEN", None) or getattr(webview, "OPEN_DIALOG", 10)
        except ImportError:
            dialog = 10  # pywebview's open-file dialog
        try:
            chosen = window.create_file_dialog(dialog, allow_multiple=multiple, file_types=file_types)
        except Exception as exc:
            return {"success": False, "cancelled": False, "path": None, "paths": [],
                    "message": f"The open dialog could not open: {exc}"}
        paths = [str(p) for p in (chosen or []) if p]
        if not paths:
            return {"success": False, "cancelled": True, "path": None, "paths": [], "message": "No file selected"}
        return {"success": True, "path": paths[0], "paths": paths if multiple else paths[:1]}

    def open_url(self, url: str) -> bool:
        """A page asked for a new window: this server's pages open in the app."""
        if is_same_server(url, self.base):
            query = urlsplit(url).query
            title = APP_NAME
            if "sandbox=" in query:
                title = f"{APP_NAME} tour"
            elif "workspace=" in query:
                title = f"{APP_NAME} workspace"
            self.create_window(with_token(url, self.token), title=title)
            return True
        if urlsplit(url).scheme in ("http", "https", "mailto"):
            webbrowser.open(url)
            return True
        return False

    # --- fiberbrowser:// links -------------------------------------------------------
    def handle_open_url(self, url: str) -> Optional[str]:
        """A ``fiberbrowser://open?...`` link from the OS: stage it, then ask in a window.

        Returns the confirmation page's address (None while the server starts:
        the link is queued and handled once it is ready)."""
        from .open_link import OpenLinkError, parse_open_url, review_url, stage_on_server
        if not self._ready:
            self._queued_links.append(url)
            return None
        try:
            link = parse_open_url(url)
            server = {"url": self.base, "token": self.token}
            page = review_url(server, stage_on_server(server, link))
        except OpenLinkError as exc:
            self.create_window(html=_error_html(str(exc), self.log_path).replace(
                "could not start", "could not open the link"))
            return None
        self.create_window(page, title=f"{APP_NAME}: open link")
        return page

    def _flush_links(self) -> None:
        queued, self._queued_links = self._queued_links, []
        for url in queued:
            self.handle_open_url(url)

    def _install_url_handler(self) -> None:
        """Receive fiberbrowser:// links (macOS: the kAEGetURL Apple event)."""
        if sys.platform != "darwin":
            return
        try:
            import Foundation
            import objc
        except Exception:
            return
        app = self
        event_class = event_id = int.from_bytes(b"GURL", "big")  # kInternetEventClass, kAEGetURL
        direct_object = int.from_bytes(b"----", "big")  # keyDirectObject

        class _URLEventHandler(Foundation.NSObject):
            @objc.typedSelector(b"v@:@@")
            def handleURLEvent_withReplyEvent_(self, event, _reply):
                try:
                    url = event.paramDescriptorForKeyword_(direct_object).stringValue()
                except Exception:
                    return
                if url:
                    app.handle_open_url(str(url))

        self._url_handler = _URLEventHandler.alloc().init()
        Foundation.NSAppleEventManager.sharedAppleEventManager() \
            .setEventHandler_andSelector_forEventClass_andEventID_(
                self._url_handler, "handleURLEvent:withReplyEvent:", event_class, event_id)

    # --- menu -------------------------------------------------------------------
    # The menu bar is app_menu.MENUS: a native NSMenu with keyboard shortcuts on
    # macOS (_install_native_menu), pywebview's menus elsewhere (menu()).
    def new_window(self) -> None:
        self.create_window(self.url("/"))

    def new_workspace(self) -> None:
        self.create_window(self.url("/?workspace=new"), title=f"{APP_NAME} workspace")

    def open_in_browser(self) -> None:
        webbrowser.open(self.url("/"))

    def quit(self) -> None:
        self.stop_server()
        for window in list(self.windows):
            try:
                window.destroy()
            except Exception:
                pass

    def front_window(self):
        """The window a menu command goes to: the focused one, else the newest."""
        try:
            import webview
            active = webview.active_window()
        except Exception:
            active = None
        if active is not None and active in self.windows:
            return active
        return self.windows[-1] if self.windows else None

    def menu_action(self, item) -> None:
        """A menu item was chosen (on macOS, on the main thread)."""
        from .app_menu import URLS
        if item.kind == "app":
            getattr(self, item.target)()
        elif item.kind == "url":
            webbrowser.open(URLS[item.target])
        elif item.kind == "command":
            window = self.front_window()
            if window is not None:
                # evaluate_js waits for the main thread: never call it on it.
                threading.Thread(target=self.run_command, args=(window, item.target),
                                 name="fiberbrowser-menu", daemon=True).start()
        elif item.target == "terminate:":  # pywebview menus (no AppKit)
            self.quit()

    def run_command(self, window, name: str, args: object = None):
        """Run a page command (window.fiberbrowserCommand) in ``window``; not on the main thread."""
        from .app_menu import command_script
        try:
            return window.evaluate_js(command_script(name, args))
        except Exception:
            return None

    def copy_locus(self) -> None:
        """Edit > Copy Locus: the front window's locus (chr:start-end) to the clipboard."""
        window = self.front_window()
        if window is None:
            return

        def work():
            locus = self.run_command(window, "locus")
            if isinstance(locus, str) and locus:
                self._set_clipboard(locus)

        threading.Thread(target=work, name="fiberbrowser-copy-locus", daemon=True).start()

    def _set_clipboard(self, text: str) -> None:
        # Natively: WebKit refuses page clipboard writes that don't follow a click.
        if sys.platform == "darwin":
            try:
                import AppKit
                from PyObjCTools import AppHelper

                def put():
                    board = AppKit.NSPasteboard.generalPasteboard()
                    board.clearContents()
                    board.setString_forType_(text, AppKit.NSPasteboardTypeString)
                AppHelper.callAfter(put)
                return
            except Exception:
                pass
        window = self.front_window()
        if window is not None:
            self.run_command(window, "copy-locus")

    def server_fiberhmm(self) -> Optional[dict]:
        """Which FiberHMM the server runs (its version, where, why: /api/app/info), or None when it can't say.
        The app may run a custom FiberHMM, so this window's own package metadata isn't the answer."""
        import json
        request = urllib.request.Request(self.base + "/api/app/info", headers={"X-FiberBrowser-Token": self.token})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError):
            return None
        fiberhmm = data.get("fiberhmm") if isinstance(data, dict) else None
        return fiberhmm if isinstance(fiberhmm, dict) else None

    def fiberhmm_line(self) -> str:
        """'FiberHMM 3.0.0 (bundled) at /path' from the server (and its first notice), else this package's version."""
        info = self.server_fiberhmm()
        if not info:
            return f"FiberHMM {fiberhmm_version()}"
        running = info.get("running") or {}
        ver = running.get("version") or info.get("version") or "?"
        where = running.get("path") or info.get("package_dir") or ""
        source = {"bundled": "bundled", "app": "custom", "env": "FIBERHMM_SOURCE_DIR", "settings": "browser_settings.json",
                  "installed": "installed"}.get(str(info.get("source")), str(info.get("source") or ""))
        line = f"FiberHMM {ver} ({source})" + (f" at {where}" if where else "")
        notices = [n for n in info.get("notices") or [] if isinstance(n, str)]
        return line + ("\n" + notices[0] if notices else "")

    def about_text(self) -> str:
        # The build's flavour (lab or public: plugin packs, ARCHITECTURE.md) is said with the version, then which
        # FiberHMM the server runs and where.
        return f"{APP_NAME} {version()} ({build_flavor()} build)\n{self.fiberhmm_line()}"

    def show_about(self) -> None:
        if sys.platform == "darwin":
            try:
                import AppKit
                # Shown as "Version 3.0.0 (lab build · FiberHMM 3.0.0 (bundled) at …)"; the window's
                # Settings (FiberHMM & Updates) and "Check for Updates…" say more.
                options = {"ApplicationName": APP_NAME, "ApplicationVersion": version(),
                           "Version": f"{build_flavor()} build · {self.fiberhmm_line().splitlines()[0]}"}
                icon = icons_dir() / "fiberbrowser-512.png"
                # How to cite, under the version.
                try:
                    options["Credits"] = AppKit.NSAttributedString.alloc().initWithString_(citation_text())
                except Exception:
                    pass
                if not is_frozen() and icon.is_file():  # the app bundle has its own icon
                    image = AppKit.NSImage.alloc().initWithContentsOfFile_(str(icon))
                    if image is not None:
                        options["ApplicationIcon"] = image
                AppKit.NSApp.activateIgnoringOtherApps_(True)
                AppKit.NSApp.orderFrontStandardAboutPanelWithOptions_(options)
                return
            except Exception:
                pass
        import html
        self.create_window(html=_ABOUT_HTML.replace("{text}", html.escape(self.about_text()).replace("\n", "<br>"))
                           .replace("{cite}", html.escape(citation_text())),
                           title=f"About {APP_NAME}")

    def menu(self):
        """pywebview menus (Windows/Linux; macOS gets the native menu bar)."""
        from .app_menu import pywebview_menus
        return pywebview_menus(self.menu_action)

    def _install_native_menu(self) -> None:
        """macOS: the menu bar with shortcuts (main thread, once the app runs).

        pywebview built its default menu before the run loop started, and with
        no pywebview menu it never rebuilds it, so this one stays."""
        try:
            import AppKit
            from .app_menu import build_native_menu, make_target
            # No window tabs (their "Show Tab Bar" items would join the View menu).
            AppKit.NSWindow.setAllowsAutomaticWindowTabbing_(False)
            self._menu_target = make_target(self.menu_action)  # items hold it weakly
            self._main_menu = build_native_menu(self._menu_target, AppKit.NSApp)
            AppKit.NSApp.setMainMenu_(self._main_menu)
        except Exception as exc:  # the window still works without it
            print(f"FiberBrowser: could not build the menu bar: {exc}", file=sys.stderr)

    # --- lifecycle --------------------------------------------------------------
    def _boot(self, first_window) -> None:
        """After the GUI is up: wait for the server, then show it."""
        if sys.platform == "darwin":
            try:
                from PyObjCTools import AppHelper
                AppHelper.callAfter(self._install_native_menu)
            except Exception:
                pass
        if not self.wait_ready():
            if self._stopping:
                return
            code = self.proc.poll() if self.proc else None
            message = (f"The server stopped (exit code {code})." if code is not None
                       else f"The server did not answer within {int(READY_TIMEOUT_S)} s.")
            first_window.load_html(_error_html(message, self.log_path))
            return
        first_window.load_url(self.url("/"))
        self._ready = True
        self._flush_links()
        threading.Thread(target=self._watch_server, name="fiberbrowser-server-watch", daemon=True).start()

    def _log(self, line: str) -> None:
        try:
            with open(self.log_path, "a") as log:
                log.write(f"[{_stamp()}] {line}\n")
        except OSError:
            pass

    def _watch_server(self) -> None:
        proc = self.proc
        if proc is None:
            return
        code = proc.wait()
        self._log(f"The server process exited (code {code}).")
        if self._stopping:
            return
        if exit_was_requested(code):  # the page's Quit button, or its last tab closed
            for window in list(self.windows):
                try:
                    window.destroy()
                except Exception:
                    pass
            return
        self.show_server_died(code)

    def show_server_died(self, code: Optional[int]) -> None:
        """The server crashed: say so in a window, with the end of its log, instead of vanishing."""
        page = _error_html(describe_exit(code) + " Your data files are unchanged; restart FiberBrowser to continue.",
                           self.log_path, heading="FiberBrowser's server stopped")
        windows = list(self.windows)
        if not windows:
            self.create_window(html=page)
            return
        windows[0].load_html(page)
        for window in windows[1:]:
            try:
                window.destroy()
            except Exception:
                pass

    def _stop_on_terminate(self) -> None:
        """Cmd+Q ends the process without Python's shutdown: stop the server first."""
        if sys.platform != "darwin":
            return
        try:
            import AppKit
            import Foundation
            Foundation.NSNotificationCenter.defaultCenter().addObserverForName_object_queue_usingBlock_(
                AppKit.NSApplicationWillTerminateNotification, None, None,
                lambda _note: self.stop_server(timeout=5.0))
        except Exception:
            pass

    def run(self) -> int:
        import webview
        webview.settings["ALLOW_DOWNLOADS"] = True
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        self.start_server()
        first = self.create_window(html=SPLASH_HTML)
        self._stop_on_terminate()
        # Before the GUI starts: a link that launched the app arrives right after.
        self._install_url_handler()
        for arg in self.link_args:
            self.handle_open_url(arg)
        icon = icons_dir() / "fiberbrowser-512.png"
        try:
            webview.start(self._boot, (first,), menu=[] if sys.platform == "darwin" else self.menu(),
                          private_mode=False,
                          storage_path=str(user_cache_dir() / "webview"),
                          icon=str(icon) if icon.is_file() else None)
        finally:
            self.stop_server()
        return 0


def main(argv: Sequence[str] = ()) -> int:
    try:
        import webview  # noqa: F401
    except ImportError:
        print('The app window needs pywebview: pip install "fiberbrowser[app]"\n'
              "Opening FiberBrowser in your web browser instead.", file=sys.stderr)
        from .cli import run_server
        args = [a for a in argv if a not in ("--no-open-browser", "--no-open")]
        return run_server([*args, "--open-browser"])
    return DesktopApp(argv).run()


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(sys.argv[1:]))
