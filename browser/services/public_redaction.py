"""Public mode: no server filesystem paths in responses, plus browser security headers.

A ``--public`` server is used by anonymous visitors. Dataset, track and session
payloads carry the absolute paths of the files the host loaded (``path``,
``paths``, ``chemistry_metadata.files[].path``, track and overlay paths), and
error messages can quote them. In public mode those responses are rewritten:
every local path becomes its file name (``/srv/lab/runs/a.bam`` -> ``a.bam``),
which keeps what the UI needs (labels, the extension) and hides the host's
directory layout. Remote URLs (https://, s3://) are the published sources and
stay as they are.

Security headers are added to every response in every mode: ``nosniff``, a
same-origin referrer policy and framing limits. Local servers may be framed
by pages of the same origin only (``frame-ancestors 'self'``); public servers
not at all (``X-Frame-Options: DENY``). A public server also sends a full
Content-Security-Policy (scripts from this origin only; the page's own inline
scripts carry a per-response nonce, see frontend_mount.py) and, when the
request arrived over https (directly or from a trusted proxy),
Strict-Transport-Security. Static assets with content-hashed names are cached
by browsers for a year (``immutable``); other assets for an hour.

Ported by hand from the unmerged hardening branch (f48699de, f1d1830b).
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI

# Route templates whose JSON responses carry host paths (small payloads).
REDACTED_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("GET", "/api/datasets"), ("GET", "/api/datasets/with_contig"),
    ("GET", "/api/datasets/{dataset_id}/assembly"), ("GET", "/api/genome/check"), ("GET", "/api/panel_genomes"),
    ("POST", "/api/datasets/{dataset_id}/refresh_capabilities"),
    ("POST", "/api/datasets/{dataset_id}/chemistry"),
    ("POST", "/api/datasets/merge"), ("POST", "/api/datasets/unmerge"),
    ("GET", "/api/catalog"), ("POST", "/api/catalog/load"), ("POST", "/api/catalog/tracks/load"),
    ("GET", "/api/tracks"), ("GET", "/api/tracks/{track_idx}"), ("POST", "/api/tracks/batch"),
    ("GET", "/api/overlays"), ("GET", "/api/annotations/files"),
    ("POST", "/api/session/export"), ("GET", "/api/status"), ("POST", "/api/load_genome"),
    ("POST", "/api/add_track"), ("GET", "/api/genomes"),
})

_PATH_KEYS = frozenset({"path", "paths", "file", "files", "fasta", "gtf", "source", "sources",
                        "filename", "directory", "dir", "folder"})
_PATH_SUFFIXES = ("_path", "_paths", "_file", "_files", "_dir", "_fasta", "_gtf")
_TEXT_KEYS = frozenset({"message", "error", "detail", "warning", "warnings", "reason", "errors"})
_LOCAL_ABS_RE = re.compile(r"^(?:~|[A-Za-z]:)?[/\\][^/\\]+[/\\]")
_URL_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
# An absolute POSIX or Windows path, or a ~ path, inside free text.
_TEXT_PATH_RE = re.compile(r"(?:(?<=[\s'\"(\[=:,])|^)(?:~|[A-Za-z]:)?[/\\](?:[^/\\\s'\"()\[\],;]+[/\\])+([^/\\\s'\"()\[\],;]*)")


def _is_path_key(key: str) -> bool:
    lower = key.lower()
    return lower in _PATH_KEYS or lower.endswith(_PATH_SUFFIXES)


def redact_path(value: Any) -> Any:
    """A local path's file name; URLs and non-strings unchanged."""
    if not isinstance(value, str) or not value:
        return value
    if _URL_RE.match(value):
        return os.path.basename(value.split("?", 1)[0].rstrip("/")) if value.lower().startswith("file://") else value
    if "/" in value or "\\" in value or value.startswith("~"):
        return re.split(r"[/\\]", value.rstrip("/\\"))[-1]
    return value


def redact_text(value: Any) -> Any:
    """Free text with any local path shortened to its file name."""
    if not isinstance(value, str) or ("/" not in value and "\\" not in value):
        return value
    return _TEXT_PATH_RE.sub(lambda m: m.group(1) or "<path>", value)


def redact_paths(payload: Any, *, key: str = "") -> Any:
    """Recursively shorten local paths under path-like keys and in messages."""
    if isinstance(payload, dict):
        # Keys can be paths too (e.g. a session's file_fingerprints).
        return {(redact_path(k) if _LOCAL_ABS_RE.match(str(k)) else k): redact_paths(v, key=str(k))
                for k, v in payload.items()}
    if isinstance(payload, (list, tuple)):
        return [redact_paths(v, key=key) for v in payload]
    if isinstance(payload, str):
        if _is_path_key(key):
            return redact_path(payload)
        if key.lower() in _TEXT_KEYS:
            return redact_text(payload)
    return payload


# Keys of free-text fields that can carry an error or warning (any route).
_MESSAGE_KEY_SUFFIXES = ("_warning", "_warnings", "_error", "_errors", "_message")


def redact_messages(payload: Any, *, key: str = "") -> Any:
    """Shorten local paths in every error/warning/message field, and nothing else."""
    if isinstance(payload, dict):
        return {k: redact_messages(v, key=str(k)) for k, v in payload.items()}
    if isinstance(payload, list):
        return [redact_messages(v, key=key) for v in payload]
    if isinstance(payload, str):
        lower = key.lower()
        if lower in _TEXT_KEYS or lower.endswith(_MESSAGE_KEY_SUFFIXES):
            return redact_text(payload)
    return payload


_prefix_cache: tuple[Any, tuple[bytes, ...]] = (None, ())


def host_path_prefixes() -> tuple[bytes, ...]:
    """Folders of this host a response must not reveal: the catalog's folder and
    its files' folders, the reference files' folders, home, temp, the working
    folder and the installation. Longest first."""
    global _prefix_cache
    import sys
    import tempfile

    from services import catalog_endpoint
    catalog = catalog_endpoint._catalog
    state = None
    try:
        from state.runtime_state import get_browser_state
        state = get_browser_state()
    except Exception:
        pass
    reference = tuple(getattr(state, name, None) or "" for name in ("fasta_path", "gtf_path")) if state else ()
    key = (id(catalog), reference)
    if _prefix_cache[0] == key:
        return _prefix_cache[1]
    folders = {os.path.expanduser("~"), tempfile.gettempdir(), os.getcwd(), sys.prefix, sys.exec_prefix,
               os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}
    if catalog:
        if catalog.get("_base_dir"):
            folders.add(catalog["_base_dir"])
        entries = list(catalog.get("tracks") or [])
        for group in catalog.get("groups") or []:
            entries += list(group.get("datasets") or [])
        for entry in entries:
            path = entry.get("path") if isinstance(entry, dict) and not entry.get("url") else None
            if path:
                try:
                    folders.add(os.path.dirname(catalog_endpoint._resolve_catalog_path(path)))
                except Exception:
                    pass
    for path in reference:
        for one in str(path).split(","):
            if one.startswith("/"):
                folders.add(os.path.dirname(one))
    expanded = set()
    for folder in folders:
        for variant in (folder, os.path.realpath(folder)):
            variant = variant.rstrip("/\\")
            if len(variant) > 1:
                expanded.add(variant.encode("utf-8") + b"/")
    prefixes = tuple(sorted(expanded, key=len, reverse=True))
    _prefix_cache = (key, prefixes)
    return prefixes


# A host folder counts only where a local path starts: at the start of a JSON
# string or after a space, quote or bracket; never inside a URL
# (https://example.org/data/..., s3://bucket/data/..., ?file=/data/...), where
# it follows a host name, a slash, a colon or a query character.
_NOT_A_PATH_START = rb"(?<![A-Za-z0-9_.:/=?&%~+@-])"
_strip_cache: tuple[tuple, Any] = ((), None)


def strip_host_prefixes(body: bytes) -> bytes:
    """Remove this host's folders from the local paths in a (JSON) body: a full
    path becomes its file name or its catalog-relative path. URLs are left
    as they are."""
    global _strip_cache
    prefixes = tuple(p for p in host_path_prefixes() if p in body)
    if not prefixes:
        return body
    if _strip_cache[0] != prefixes:
        pattern = re.compile(_NOT_A_PATH_START + b"(?:" + b"|".join(re.escape(p) for p in prefixes) + b")")
        _strip_cache = (prefixes, pattern)
    return _strip_cache[1].sub(b"", body)


# Bodies up to this size also have their message fields path-redacted.
_MESSAGE_REDACTION_MAX = 256 * 1024


SECURITY_HEADERS_LOCAL = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "frame-ancestors 'self'",
}
def public_csp(nonce: str | None = None) -> str:
    """The public server's Content-Security-Policy (``nonce`` for the page's inline scripts)."""
    script = "'self'" + (f" 'nonce-{nonce}'" if nonce else "")
    return "; ".join((
        "default-src 'self'",
        f"script-src {script}",
        # React sets styles through the CSSOM (allowed); html2canvas/jsPDF
        # inject <style> elements for figure export.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ))


SECURITY_HEADERS_PUBLIC = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": public_csp(),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}
HSTS = "max-age=31536000"
# Vite's content-hashed build names: index-C02NOe2T.js, vendor-CVDnmApk.js, ...
_HASHED_ASSET_RE = re.compile(r"^/assets/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|png|svg|wasm)$")


def static_cache_control(path: str) -> str | None:
    if not path.startswith("/assets/"):
        return None
    if _HASHED_ASSET_RE.match(path):
        return "public, max-age=31536000, immutable"
    return "public, max-age=3600"


def _set_headers(response, headers: dict[str, str]) -> None:
    for name, value in headers.items():
        if name not in response.headers:
            response.headers[name] = value


def install_public_redaction(app: FastAPI, is_host_public: Callable[[], bool]) -> None:
    """Rewrite host paths out of the JSON responses of a --public server (and a lab
    server's anonymous visitors): REDACTED_ROUTES get every path-like field
    shortened; every other JSON answer loses this host's folders and has the
    paths in its message fields shortened (errors are often reported with 200).

    Install INSIDE the gzip middleware (before ``app.add_middleware(GZipMiddleware)``)
    so it sees uncompressed bodies. Sandbox tabs of a local server are the
    owner's own session and are not redacted.
    """
    from starlette.responses import Response

    from services.public_mode_guard import route_template

    @app.middleware("http")
    async def public_redaction(request, call_next):
        public = is_host_public()
        redact = False
        if public:
            method = "GET" if request.method == "HEAD" else request.method
            redact = (method, route_template(app, request.scope)) in REDACTED_ROUTES
        response = await call_next(request)
        if not public or "json" not in (response.headers.get("content-type") or ""):
            return response
        body = b"".join([chunk async for chunk in response.body_iterator])
        # Every JSON answer, whatever its status (a route may report a failure
        # with 200): no folder of this host, and no path in a message field.
        body = strip_host_prefixes(body)
        payload = None
        if redact or len(body) <= _MESSAGE_REDACTION_MAX:
            try:
                payload = json.loads(body)
            except ValueError:
                payload = None
        if payload is not None:
            cleaned = redact_paths(payload) if redact else redact_messages(payload)
            if redact or cleaned != payload:
                body = json.dumps(cleaned).encode("utf-8")
        headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
        return Response(content=body, status_code=response.status_code, headers=headers,
                        media_type="application/json")


def install_security_headers(app: FastAPI, is_host_public: Callable[[], bool]) -> None:
    """Security headers on every response. Install LAST (outermost) so the
    guards' own 401/403 responses get them too."""

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        public = is_host_public()
        _set_headers(response, SECURITY_HEADERS_PUBLIC if public else SECURITY_HEADERS_LOCAL)
        if public:
            from services.public_protection import request_is_https
            if request_is_https(request.scope):
                _set_headers(response, {"Strict-Transport-Security": HSTS})
        if response.status_code == 200:
            cache_control = static_cache_control(request.url.path)
            if cache_control:
                response.headers["Cache-Control"] = cache_control
        return response
