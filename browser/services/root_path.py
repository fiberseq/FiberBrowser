"""Serving FiberBrowser under a URL prefix (``--root-path`` / ``server.root_path``).

Behind a reverse proxy that publishes the app at a sub-path, for example Open
OnDemand's ``/rnode/<host>/<port>/`` or a lab proxy's ``/fiberbrowser/``, the
browser's URLs carry the prefix while the server's routes don't. Proxies do
this in two ways and both work:

- they strip the prefix (OnDemand ``/rnode/``, Caddy ``handle_path``): the
  request arrives as ``/api/status``;
- they forward it (OnDemand ``/node/``, nginx without a trailing slash): the
  request arrives as ``/rnode/host/8000/api/status``, and
  :class:`RootPathMiddleware` (outermost) strips it here.

Either way every route, guard and middleware inside sees prefix-free paths.
Everything that *emits* a URL adds :func:`get_root_path`: the page (asset
links and ``window.__FIBERBROWSER_ROOT__``, which the frontend's request
layer prepends to its ``/api/...`` requests, see ``frontend/src/utils/rootPath.ts``),
redirects, and cookie paths (a cookie is scoped to the prefix, so other apps
on the same proxy host never receive it).
"""
from __future__ import annotations

from typing import Optional

_root_path = ""


def set_root_path(value: Optional[str]) -> None:
    from services.server_config import normalize_root_path
    global _root_path
    _root_path = normalize_root_path(value or "")


def get_root_path() -> str:
    """The configured prefix without a trailing slash ('' when served at /)."""
    return _root_path


def cookie_path() -> str:
    """Path attribute for this server's cookies."""
    return (_root_path + "/") if _root_path else "/"


def url_for_path(path: str) -> str:
    """A server path (``/api/x``, ``/?q``) as the browser must request it."""
    if not path.startswith("/"):
        path = "/" + path
    return _root_path + path


def strip_prefix(path: str, root: str) -> Optional[str]:
    """``path`` without ``root`` ('/' for the root itself), or None when it lacks the prefix."""
    if not root:
        return path
    if path == root:
        return "/"
    if path.startswith(root + "/"):
        return path[len(root):]
    return None


class RootPathMiddleware:
    """Pure ASGI: remove the configured prefix from forwarded request paths."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        root = _root_path
        if root and scope.get("type") in ("http", "websocket"):
            stripped = strip_prefix(scope.get("path") or "/", root)
            if stripped is not None:
                scope = dict(scope)
                scope["path"] = stripped
                raw = scope.get("raw_path")
                if isinstance(raw, (bytes, bytearray)):
                    raw_root = root.encode("latin-1")
                    if raw == raw_root:
                        scope["raw_path"] = b"/"
                    elif raw.startswith(raw_root + b"/"):
                        scope["raw_path"] = bytes(raw[len(raw_root):])
        await self.app(scope, receive, send)


def install_root_path(app) -> None:
    """Add the prefix-stripping middleware. Call LAST: it must run outermost."""
    app.add_middleware(RootPathMiddleware)
