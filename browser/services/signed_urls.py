"""Pre-signed URLs: kept in memory only, never shown, saved or logged in full.

A portal or a session link often hands out *pre-signed* URLs: the query
string (``X-Amz-Signature=...``, ``sig=...``, ``token=...``) is a short-lived
credential. FiberBrowser needs the full URL to read the file, but nothing
else should ever see it:

- the full URL is registered here (this process's memory, never written to
  disk) under its *display form*, the URL without its query string
  (``https://host/path/reads.bam``); a BAM with a separately signed index
  (htslib's ``<bam>##idx##<index>`` form) has the BAM's display form;
- JSON responses carry the display form (``install_signed_url_redaction``),
  and so do printed output and log records (``install_log_redaction``), so
  the browser, saved sessions, autosaves, history and the recent-tracks list
  only ever hold the display form;
- when a display form comes back (a restored session, a re-registered track)
  it is resolved to the full URL again while this server runs
  (``resolve``); after a restart the vault is empty, the file is read without
  its signature, the host refuses it (401/403), and the user is told the link
  expired and must be reopened from its source;
- expiry is known in advance when the URL says so (``X-Amz-Date`` +
  ``X-Amz-Expires``, ``X-Goog-Date`` + ``X-Goog-Expires``, ``Expires=``,
  ``se=``), and otherwise found by a one-byte range read that gets 401/403
  (``probe_expired``).
"""
from __future__ import annotations

import calendar
import logging
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Iterable, Optional
from urllib.parse import parse_qsl, urlsplit, urlunsplit

IDX_MARK = "##idx##"

# Query parameters that make a URL a credential. Lower-case.
SIGNATURE_PARAMS = frozenset({
    "x-amz-signature", "x-amz-credential", "x-amz-security-token",
    "x-goog-signature", "x-goog-credential",
    "signature", "sig", "token", "access_token", "key-pair-id", "policy",
    "awsaccesskeyid", "googleaccessid",
})
# Query parameters stripped from logged request lines (they carry a link URL).
LINK_QUERY_PARAMS = ("session", "sessionURL", "hub", "url", "path", "token", "index_url")

EXPIRING_SOON_S = 10 * 60
PROBE_INTERVAL_S = 120.0

_lock = threading.RLock()


@dataclass
class _Entry:
    display: str
    real: str
    secrets: tuple[str, ...]
    host: str
    expires_at: Optional[float] = None
    expired: bool = False
    last_probe: float = 0.0
    labels: set = field(default_factory=set)


_by_display: dict[str, _Entry] = {}
_secret_to_display: dict[str, str] = {}
# name -> (text regex, bytes regex, display): credentials that vary per use
# (one per file) but share a recognisable shape, e.g. a cluster connection's
# http://127.0.0.1:<port>/<per-file key>/f prefix.
_patterns: dict[str, tuple[re.Pattern, re.Pattern, str]] = {}
# Credentials that are not URLs (a connection token): replaced in any text,
# with or without "://" in it.
_plain_secrets: dict[str, str] = {}


# ---------------------------------------------------------------------------- forms

def split_index(url: str) -> tuple[str, Optional[str]]:
    """``(data_url, index_url)`` of htslib's ``data##idx##index`` form."""
    if isinstance(url, str) and IDX_MARK in url:
        data, _, index = url.partition(IDX_MARK)
        return data, index or None
    return url, None


def has_query(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.query)


def looks_signed(url) -> bool:
    """A URL (or either half of ``data##idx##index``) whose query is a credential."""
    if not isinstance(url, str) or "?" not in url:
        return False
    for part in split_index(url):
        if not part or "?" not in part:
            continue
        try:
            query = urlsplit(part).query
        except ValueError:
            continue
        if any(key.lower() in SIGNATURE_PARAMS for key, _ in parse_qsl(query, keep_blank_values=True)):
            return True
    return False


def display_url(url: str) -> str:
    """The URL without query string, fragment or separate index (safe to show and save)."""
    if not isinstance(url, str):
        return url
    data, _ = split_index(url)
    try:
        parts = urlsplit(data)
    except ValueError:
        return data.split("?", 1)[0].split("#", 1)[0]
    if not parts.scheme or not parts.netloc:
        return data
    netloc = parts.netloc.rsplit("@", 1)[-1]  # never user:password@
    return urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def source_identity(url):
    """What may be written to disk to name where a file came from (cache metadata,
    file names derived from a URL): the display form for a held or signed URL,
    else the URL itself (an ordinary query such as ``?id=2`` still tells files apart)."""
    if not isinstance(url, str):
        return url
    held = _secret_to_display.get(url)
    if held is not None:
        return held  # a held URL (signed, or a relay address) names its original file
    if is_registered(url) or looks_signed(url):
        return display_url(url)
    return url


def redact_structure(value):
    """``value`` (nested dicts/lists/strings) with every held or signed URL in
    its display form: for metadata about to be written to disk."""
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {k: redact_structure(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_structure(v) for v in value]
    if isinstance(value, tuple):
        return tuple(redact_structure(v) for v in value)
    return value


def host_of(url: str) -> str:
    try:
        return (urlsplit(split_index(url)[0]).hostname or "").lower()
    except ValueError:
        return ""


def _parse_amz_date(value: str) -> Optional[float]:
    try:
        return float(calendar.timegm(time.strptime(value, "%Y%m%dT%H%M%SZ")))
    except (TypeError, ValueError):
        return None


def _parse_iso(value: str) -> Optional[float]:
    value = (value or "").strip()
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%MZ", "%Y-%m-%d"):
        try:
            return float(calendar.timegm(time.strptime(value, fmt)))
        except ValueError:
            continue
    return None


def expiry_of(url: str) -> Optional[float]:
    """When a pre-signed URL stops working (epoch seconds), if the URL says so."""
    times = []
    for part in split_index(url):
        if not part or "?" not in part:
            continue
        try:
            query = {k.lower(): v for k, v in parse_qsl(urlsplit(part).query, keep_blank_values=True)}
        except ValueError:
            continue
        for date_key, expires_key in (("x-amz-date", "x-amz-expires"), ("x-goog-date", "x-goog-expires")):
            if date_key in query and expires_key in query:
                start = _parse_amz_date(query[date_key])
                try:
                    if start is not None:
                        times.append(start + float(query[expires_key]))
                except ValueError:
                    pass
        if "expires" in query:
            try:
                times.append(float(query["expires"]))
            except ValueError:
                pass
        if "se" in query:
            parsed = _parse_iso(query["se"])
            if parsed is not None:
                times.append(parsed)
    return min(times) if times else None


# ---------------------------------------------------------------------------- vault

def register(url: str, index_url: Optional[str] = None, *, label: Optional[str] = None,
             open_url: Optional[str] = None) -> str:
    """Keep a (possibly signed) URL in memory; returns what the rest of FiberBrowser opens.

    The return value is the URL to open (``url`` or ``url##idx##index_url``);
    its display form is what anyone sees. URLs without a query string need no
    vault and are returned as they are.

    ``open_url``: what the readers open instead of ``url`` (the pinned relay of
    services.link_proxy); it is held like a signed URL, so everything shown or
    saved carries ``url``'s display form, never the relay address.
    """
    target = open_url or url
    real = f"{target}{IDX_MARK}{index_url}" if index_url else target
    if open_url is None and not has_query(url) and not (index_url and has_query(index_url)):
        return real
    display = display_url(url)
    # What to replace wherever it appears, and with what.
    replacements = {real: display, url: display}
    if open_url:
        replacements[open_url] = display
    if index_url:
        replacements[index_url] = display_url(index_url)
    replacements = {k: v for k, v in replacements.items() if k and k != v}
    with _lock:
        entry = _by_display.get(display)
        if entry is None:
            entry = _Entry(display=display, real=real, secrets=tuple(replacements), host=host_of(url))
            _by_display[display] = entry
        else:
            # The same file reopened with a fresh link: the new signature wins.
            entry.real, entry.expired, entry.last_probe = real, False, 0.0
            entry.secrets = tuple(dict.fromkeys(entry.secrets + tuple(replacements)))
        entry.expires_at = expiry_of(real)
        if label:
            entry.labels.add(str(label))
        _secret_to_display.update(replacements)
    _ensure_stream_redaction()
    return real


def register_secret(secret: str, display: str) -> None:
    """Show ``display`` wherever ``secret`` would be printed, logged or returned.

    For credentials that are not pre-signed query strings, such as the
    per-connection part of a cluster connection's loopback URLs
    (``services/remote_sources/ssh_source.py``). Kept in memory for the
    life of the process; nothing is resolved back.
    """
    if not isinstance(secret, str) or not secret or secret == display:
        return
    with _lock:
        if "://" in secret:
            _secret_to_display[secret] = display
        else:
            _plain_secrets[secret] = display
    _ensure_stream_redaction()


def register_pattern(name: str, regex: str, display: str) -> None:
    """Show ``display`` wherever ``regex`` matches in printed, logged or returned text.

    One entry per ``name`` (re-registering replaces it), so the vault does
    not grow with every file a connection opens.
    """
    compiled = re.compile(regex)
    compiled_bytes = re.compile(regex.encode("utf-8"))
    with _lock:
        _patterns[name] = (compiled, compiled_bytes, display)
    _ensure_stream_redaction()


def resolve(path):
    """The full URL for a display form this server holds (else ``path`` unchanged)."""
    if not isinstance(path, str) or not _by_display:
        return path
    with _lock:
        entry = _by_display.get(path)
        return entry.real if entry is not None else path


def is_registered(path) -> bool:
    return isinstance(path, str) and (path in _by_display or path in _secret_to_display)


def clear() -> None:
    """Forget every URL (tests)."""
    with _lock:
        _by_display.clear()
        _secret_to_display.clear()
        _patterns.clear()
        _plain_secrets.clear()


def _ordered_secrets() -> list[tuple[str, str]]:
    # Longest first: ``bam##idx##bai`` before its ``bam`` half.
    return sorted(_secret_to_display.items(), key=lambda item: -len(item[0]))


_SIGNED_URL_RE = re.compile(r"(?P<url>(?:https?)://[^\s'\"<>]+?)\?(?P<query>[^\s'\"<>#]*)")


def _plain_items() -> list[tuple[str, str]]:
    return sorted(_plain_secrets.items(), key=lambda item: -len(item[0]))


def redact_text(text):
    """``text`` with every held URL, and any URL with a credential-like query, shortened."""
    if not isinstance(text, str):
        return text
    if _plain_secrets:
        for secret, display in _plain_items():
            if secret in text:
                text = text.replace(secret, display)
    if "://" not in text:
        return text
    if _secret_to_display:
        for secret, display in _ordered_secrets():
            if secret in text:
                text = text.replace(secret, display)
    for regex, _regex_bytes, display in list(_patterns.values()):
        text = regex.sub(display, text)

    def _strip(match: re.Match) -> str:
        whole = match.group(0)
        return match.group("url") if looks_signed(whole) else whole
    return _SIGNED_URL_RE.sub(_strip, text)


def redact_bytes(body: bytes) -> bytes:
    if _plain_secrets:
        for secret, display in _plain_items():
            raw = secret.encode("utf-8")
            if raw in body:
                body = body.replace(raw, display.encode("utf-8"))
    if not (_secret_to_display or _patterns) or b"://" not in body:
        return body
    for secret, display in _ordered_secrets():
        raw = secret.encode("utf-8")
        if raw in body:
            body = body.replace(raw, display.encode("utf-8"))
    for _regex, regex_bytes, display in list(_patterns.values()):
        body = regex_bytes.sub(display.encode("utf-8"), body)
    return body


# ---------------------------------------------------------------------------- expiry

def status(now: Optional[float] = None) -> list[dict]:
    """Held links: display form, host, when it expires, whether it is known to have expired."""
    now = time.time() if now is None else now
    out = []
    with _lock:
        for entry in _by_display.values():
            expired = entry.expired or (entry.expires_at is not None and entry.expires_at <= now)
            out.append({
                "url": entry.display,
                "host": entry.host,
                "labels": sorted(entry.labels),
                "expires_at": entry.expires_at,
                "expired": expired,
                "expiring_soon": (not expired and entry.expires_at is not None
                                  and entry.expires_at - now <= EXPIRING_SOON_S),
            })
    return out


def mark_expired(url: str) -> None:
    display = _secret_to_display.get(url) or (url if url in _by_display else display_url(url))
    with _lock:
        entry = _by_display.get(display)
        if entry is not None:
            entry.expired = True


def probe_status(url: str, timeout: float = 5.0) -> Optional[int]:
    """HTTP status of a one-byte range read of ``url`` (None: no answer)."""
    import urllib.error
    import urllib.request

    data_url, _ = split_index(url)
    if not data_url.startswith(("http://", "https://")):
        return None
    request = urllib.request.Request(data_url, headers={"Range": "bytes=0-0", "User-Agent": "FiberBrowser"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except Exception:
        return None


def probe_expired(url: str, *, force: bool = False) -> bool:
    """Whether a held link now gets 401/403 (a one-byte range read, at most every 2 min)."""
    display = _secret_to_display.get(url) or (url if url in _by_display else display_url(url))
    with _lock:
        entry = _by_display.get(display)
        if entry is None:
            return False
        if entry.expired:
            return True
        if not force and time.time() - entry.last_probe < PROBE_INTERVAL_S:
            return False
        entry.last_probe = time.time()
        real = entry.real
    code = probe_status(real)
    if code in (401, 403):
        mark_expired(display)
        return True
    return False


def expired_message(url: str) -> str:
    return (f"The link to {display_url(url)} has expired or was refused (HTTP 403). "
            "Reopen it from the source (the portal or page that gave you the link).")


def access_error_hint(url: str) -> Optional[str]:
    """For a remote file that failed to open: 'link expired' when the host refuses it."""
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return None
    code = probe_status(resolve(url))
    if code in (401, 403):
        if is_registered(url) or looks_signed(url):
            mark_expired(url)
            return expired_message(url)
        return (f"{display_url(url)}: access denied (HTTP {code}). If this came from a pre-signed "
                "or session link, the link has expired: reopen it from the source.")
    return None


# ---------------------------------------------------------------------------- output redaction

class _RedactingStream:
    """sys.stdout / sys.stderr that shortens held URLs in everything printed."""

    def __init__(self, stream):
        self._stream = stream

    def write(self, text):
        return self._stream.write(redact_text(text) if isinstance(text, str) else text)

    def __getattr__(self, name):
        return getattr(self._stream, name)


def _ensure_stream_redaction() -> None:
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is not None and not isinstance(stream, _RedactingStream):
            setattr(sys, name, _RedactingStream(stream))


def strip_link_params(text: str) -> str:
    """A request line with the values of link-carrying query parameters removed."""
    if not isinstance(text, str) or "?" not in text:
        return text

    def _one(match: re.Match) -> str:
        return f"{match.group(1)}=…"
    pattern = r"(?<=[?&])(" + "|".join(re.escape(p) for p in LINK_QUERY_PARAMS) + r")=[^&\s\"]*"
    return re.sub(pattern, _one, text)


class LinkRedactionFilter(logging.Filter):
    """Log records: held URLs shortened, link-carrying query values removed."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if record.args:
                args = record.args if isinstance(record.args, tuple) else (record.args,)
                record.args = tuple(strip_link_params(redact_text(a)) if isinstance(a, str) else a for a in args)
            if isinstance(record.msg, str):
                record.msg = strip_link_params(redact_text(record.msg))
        except Exception:
            pass
        return True


def install_log_redaction(logger_names: Iterable[str] = ("uvicorn.access", "uvicorn.error", "fiberbrowser", "")) -> None:
    """Add the redaction filter to these loggers and their handlers (idempotent)."""
    for name in logger_names:
        logger = logging.getLogger(name)
        targets = [logger, *logger.handlers]
        for target in targets:
            if not any(isinstance(f, LinkRedactionFilter) for f in target.filters):
                target.addFilter(LinkRedactionFilter())


def install_signed_url_redaction(app) -> None:
    """JSON responses carry display forms only (install inside the gzip middleware)."""
    from starlette.responses import Response

    max_bytes = 16 * 1024 * 1024

    @app.middleware("http")
    async def signed_url_redaction(request, call_next):
        response = await call_next(request)
        content_type = (response.headers.get("content-type") or "").lower()
        if not (_secret_to_display or _patterns or _plain_secrets) or not content_type.startswith("application/json"):
            return response  # NDJSON and other streams pass untouched
        length = response.headers.get("content-length")
        if length is None or not length.isdigit() or int(length) > max_bytes:
            return response  # a stream (no length) or a very large body
        body = b"".join([chunk async for chunk in response.body_iterator])
        body = redact_bytes(body)
        headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
        return Response(content=body, status_code=response.status_code, headers=headers,
                        media_type=response.headers.get("content-type"))
