"""The session-link document: ``fiberbrowser.session-link.v1``.

A small JSON document another web page (a portal, a sample dashboard, a
notebook) hands to FiberBrowser to open a set of remote files at a locus::

    {
      "schema": "fiberbrowser.session-link.v1",
      "title": "Sample 12, chr7 locus",
      "genome": "hg38",
      "locus": "chr7:5,527,000-5,531,000",
      "tracks": [
        {"url": "https://data.example.org/s12.bam",
         "index_url": "https://data.example.org/s12.bam.bai",
         "type": "bam", "name": "Sample 12", "sample": "S12", "group": "Donor A",
         "color": "#1f77b4"},
        {"url": "https://data.example.org/s12.fire.bw", "type": "bigwig", "name": "FIRE coverage"}
      ]
    }

``genome`` is a genome FiberBrowser knows by name (``hg38``, ``mm10``, ...)
or ``{"fasta": <URL>, "fai": <URL>, "name": <label>}``. Track ``type`` is
``bam``, ``bigbed``, ``bigwig``, ``bed`` or ``plasmid`` (a GenBank/SnapGene
plasmid map), inferred from the file extension when missing. Optional track
fields: ``index_url`` (needed for pre-signed BAMs, whose ``.bai`` can't be
derived from the URL), ``name``, ``sample``, ``group``, ``color``,
``as`` (``reads`` or ``annotation``, for a bigBed), ``size`` (bytes, shown
before loading) and ``visible`` (false: listed, unticked). Track URLs are
``https://``, ``http://`` (local servers only) or ``s3://`` (local servers
only); relative URLs resolve against the document's own URL. ``ssh://``
cluster references are listed but opened only after the user connected to
that cluster themselves (FiberBrowser never connects from a link).

This module validates and normalises the document; it never touches the
network. See docs/workflows/open-from-links.md.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any, Optional
from urllib.parse import unquote, urljoin, urlsplit

from services import signed_urls

SCHEMA = "fiberbrowser.session-link.v1"
MAX_DOCUMENT_BYTES = 1024 * 1024
MAX_INLINE_BYTES = 256 * 1024
MAX_LISTED_TRACKS = 1000
MAX_TEXT = 300
MAX_JSON_DEPTH = 64

TRACK_TYPES = ("bam", "bigbed", "bigwig", "bed", "plasmid")
_TYPE_ALIASES = {
    "bam": "bam", "alignment": "bam", "alignments": "bam", "reads": "bam",
    "bigbed": "bigbed", "bb": "bigbed", "bigBed": "bigbed",
    "bigwig": "bigwig", "bw": "bigwig", "bigWig": "bigwig", "wig": "bigwig",
    "bed": "bed", "annotation": "bed",
    "plasmid": "plasmid", "plasmid map": "plasmid", "plasmid_map": "plasmid", "plasmidmap": "plasmid",
    "genbank": "plasmid", "gb": "plasmid", "snapgene": "plasmid",
}
_EXTENSIONS = (
    (".bam", "bam"), (".bb", "bigbed"), (".bigbed", "bigbed"), (".bw", "bigwig"), (".bigwig", "bigwig"),
    (".bed.gz", "bed"), (".bed", "bed"), (".gb", "plasmid"), (".gbk", "plasmid"), (".genbank", "plasmid"),
    (".gbff", "plasmid"), (".dna", "plasmid"),
)
_UNSUPPORTED_EXTENSIONS = {".cram": "CRAM files are not supported (convert to BAM)",
                           ".vcf.gz": "VCF tracks are not supported",
                           ".hic": ".hic contact maps can't be opened from a link"}
_AS_VALUES = {"reads": "reads", "dataset": "reads", "annotation": "annotation", "track": "annotation",
              "signal": "signal"}


class SessionLinkError(ValueError):
    """The document is not a usable session link; the message is for the user."""


# ---------------------------------------------------------------------------- inline documents

def decode_inline(value: str) -> str:
    """The JSON text of an inline link: ``data:application/json[;base64],...``,
    base64/base64url of the JSON, or the JSON itself."""
    value = (value or "").strip()
    if len(value) > MAX_INLINE_BYTES * 2:
        raise SessionLinkError("The inline session is too large; host it as a JSON file and link to that.")
    if value.startswith("data:"):
        header, sep, payload = value[5:].partition(",")
        if not sep:
            raise SessionLinkError("The data: link has no content.")
        params = [p.strip().lower() for p in header.split(";")]
        if params[0] and params[0] not in ("application/json", "text/json", "text/plain"):
            raise SessionLinkError(f"The data: link must be application/json (got {params[0]}).")
        if "base64" in params:
            return _b64decode(payload)
        return unquote(payload)
    if value.startswith("{"):
        return value
    return _b64decode(value)


def _b64decode(payload: str) -> str:
    payload = payload.strip().replace(" ", "+")
    padded = payload + "=" * (-len(payload) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.replace("+", "-").replace("/", "_"))
    except (binascii.Error, ValueError) as exc:
        raise SessionLinkError("The inline session is not valid base64.") from exc
    if len(raw) > MAX_INLINE_BYTES:
        raise SessionLinkError("The inline session is too large; host it as a JSON file and link to that.")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SessionLinkError("The inline session is not UTF-8 JSON.") from exc


def is_inline(value: str) -> bool:
    value = (value or "").strip()
    return value.startswith(("data:", "{")) or ("://" not in value and bool(re.fullmatch(r"[A-Za-z0-9_\-+/=\s]+", value)))


def _json_depth(text: str) -> int:
    """How deeply ``[``/``{`` nest in JSON text (brackets inside strings don't count)."""
    depth = deepest = 0
    in_string = escaped = False
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif char in "]}":
            depth -= 1
    return deepest


def parse_json_text(text: str) -> dict:
    if len(text.encode("utf-8", errors="ignore")) > MAX_DOCUMENT_BYTES:
        raise SessionLinkError("The session document is too large (limit 1 MB).")
    # json.loads recurses once per level: a small document nested thousands deep
    # would end in RecursionError, not a message.
    if _json_depth(text) > MAX_JSON_DEPTH:
        raise SessionLinkError(f"The session document nests more than {MAX_JSON_DEPTH} levels deep.")
    try:
        doc = json.loads(text)
    except RecursionError as exc:
        raise SessionLinkError(f"The session document nests more than {MAX_JSON_DEPTH} levels deep.") from exc
    except ValueError as exc:
        msg = getattr(exc, "msg", None) or str(exc)
        where = f", line {exc.lineno}" if getattr(exc, "lineno", None) else ""
        raise SessionLinkError(f"The session document is not valid JSON ({msg}{where}).") from exc
    if not isinstance(doc, dict):
        raise SessionLinkError("The session document must be a JSON object.")
    return doc


# ---------------------------------------------------------------------------- fields

def _text(value: Any, field_name: str, *, limit: int = MAX_TEXT) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, (str, int, float)):
        raise SessionLinkError(f"`{field_name}` must be text.")
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value)).strip()
    return text[:limit] or None


def normalize_color(value: Any) -> Optional[str]:
    """``#rgb``, ``#rrggbb``, ``r,g,b`` or ``rgb(r,g,b)`` as ``#rrggbb`` (None if absent or invalid)."""
    if value is None or value == "":
        return None
    text = str(value).strip().lower()
    match = re.fullmatch(r"#([0-9a-f]{3})", text)
    if match:
        return "#" + "".join(c * 2 for c in match.group(1))
    if re.fullmatch(r"#[0-9a-f]{6}", text):
        return text
    match = re.fullmatch(r"(?:rgb\()?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)?", text)
    if match:
        rgb = [int(x) for x in match.groups()]
        if all(0 <= x <= 255 for x in rgb):
            return "#" + "".join(f"{x:02x}" for x in rgb)
    return None


def infer_type(url: str) -> Optional[str]:
    path = urlsplit(signed_urls.display_url(url)).path.lower() if "://" in url else url.lower()
    for ext, kind in _EXTENSIONS:
        if path.endswith(ext):
            return kind
    return None


def unsupported_reason(url: str) -> Optional[str]:
    path = urlsplit(signed_urls.display_url(url)).path.lower() if "://" in url else url.lower()
    for ext, reason in _UNSUPPORTED_EXTENSIONS.items():
        if path.endswith(ext):
            return reason
    return None


def resolve_url(value: Any, base_url: Optional[str], field_name: str) -> str:
    """An absolute track URL: https/http/s3, or relative to the document's URL."""
    url = _text(value, field_name, limit=8192)
    if not url:
        raise SessionLinkError(f"`{field_name}` is missing.")
    try:
        parts = urlsplit(url)
        if not parts.scheme and base_url and urlsplit(base_url).scheme in ("http", "https"):
            url = urljoin(base_url, url)
            parts = urlsplit(url)
        parts.port  # an out-of-range or non-numeric port raises here, not later
    except ValueError as exc:
        raise SessionLinkError(f"`{field_name}` is not a valid URL ({signed_urls.display_url(url)!r}).") from exc
    if not parts.scheme:
        raise SessionLinkError(f"`{field_name}` must be an absolute https:// or s3:// URL "
                               f"(got {signed_urls.display_url(url)!r}).")
    if parts.scheme.lower() not in ("http", "https", "s3", "ssh"):
        raise SessionLinkError(f"`{field_name}` must be an https:// or s3:// URL "
                               f"(local files and {parts.scheme}: links can't be opened from a link).")
    if not parts.netloc:
        raise SessionLinkError(f"`{field_name}` has no host.")
    return url


def parse_locus(value: Any) -> Optional[dict]:
    """``{"text": ..., "chrom", "start", "end"}`` (coordinates when the text is ``chr:start-end``)."""
    text = _text(value, "locus", limit=200)
    if not text:
        return None
    clean = text.replace(",", "").replace(" ", "")
    match = re.fullmatch(r"([^:\s]+):(\d+)(?:-(\d+))?", clean)
    if match:
        start = int(match.group(2))
        end = int(match.group(3)) if match.group(3) else start + 1
        if match.group(3) is None:
            start, end = max(0, start - 500), start + 500
        if end <= start:
            raise SessionLinkError(f"The locus {text!r} ends before it starts.")
        return {"text": text, "chrom": match.group(1), "start": start, "end": end}
    if re.fullmatch(r"[A-Za-z0-9_.\-]+", text):
        return {"text": text}  # a gene or feature name, found by the browser's search
    raise SessionLinkError(f"The locus {text!r} is not chr:start-end or a gene name.")


def parse_genome(value: Any, base_url: Optional[str]) -> Optional[dict]:
    if value is None or value == "":
        return None
    from services.genome_registry import GENOME_REGISTRY
    known = {k.lower(): k for k in GENOME_REGISTRY}
    if isinstance(value, str):
        text = value.strip()
        if "://" in text:
            value = {"fasta": text}
        elif text.lower() in known:
            return {"kind": "catalog", "id": known[text.lower()], "label": known[text.lower()]}
        else:
            raise SessionLinkError(f"Unknown genome {text!r}. Use one of {', '.join(GENOME_REGISTRY)} "
                                   "or {\"fasta\": <URL>, \"fai\": <URL>}.")
    if not isinstance(value, dict):
        raise SessionLinkError("`genome` must be a genome name or an object with a `fasta` URL.")
    name = _text(value.get("name") or value.get("id"), "genome.name")
    fasta = value.get("fasta") or value.get("url")
    if fasta:
        url = resolve_url(fasta, base_url, "genome.fasta")
        if url.startswith("s3://"):
            raise SessionLinkError("`genome.fasta` must be an https URL.")
        fai = value.get("fai") or value.get("index_url") or value.get("fasta_index")
        fai_url = resolve_url(fai, base_url, "genome.fai") if fai else None
        return {"kind": "fasta", "url": url, "fai": fai_url,
                "label": name or signed_urls.display_url(url).rsplit("/", 1)[-1]}
    if name and name.lower() in known:
        return {"kind": "catalog", "id": known[name.lower()], "label": known[name.lower()]}
    raise SessionLinkError(f"Unknown genome {name!r}." if name else "`genome` needs a name or a `fasta` URL.")


def parse_track(raw: Any, index: int, base_url: Optional[str]) -> dict:
    if isinstance(raw, str):
        raw = {"url": raw}
    if not isinstance(raw, dict):
        raise SessionLinkError(f"Track {index + 1} must be an object with a `url`.")
    url = resolve_url(raw.get("url") or raw.get("bigDataUrl"), base_url, f"tracks[{index}].url")
    index_raw = raw.get("index_url") or raw.get("indexURL") or raw.get("index")
    index_url = resolve_url(index_raw, base_url, f"tracks[{index}].index_url") if index_raw else None
    declared = raw.get("type") or raw.get("format")
    kind = None
    if declared:
        kind = _TYPE_ALIASES.get(str(declared).strip()) or _TYPE_ALIASES.get(str(declared).strip().lower())
        if kind is None:
            raise SessionLinkError(f"Track {index + 1}: unknown type {declared!r} "
                                   f"(use {', '.join(TRACK_TYPES)}).")
    else:
        reason = unsupported_reason(url)
        if reason:
            raise SessionLinkError(f"Track {index + 1}: {reason}.")
        kind = infer_type(url)
        if kind is None:
            raise SessionLinkError(f"Track {index + 1}: can't tell the file type of "
                                   f"{signed_urls.display_url(url)}; add \"type\".")
    as_value = raw.get("as") or raw.get("display")
    as_kind = _AS_VALUES.get(str(as_value).strip().lower()) if as_value else None
    if as_value and as_kind is None:
        raise SessionLinkError(f"Track {index + 1}: `as` must be reads or annotation.")
    if kind == "bam":
        as_kind = "reads"
    elif kind == "bigwig":
        as_kind = "signal"
    elif kind == "bed":
        as_kind = "annotation"
    elif kind == "plasmid":
        as_kind = "plasmid"
    size = raw.get("size")
    try:
        size = int(size) if size is not None and int(size) >= 0 else None
    except (TypeError, ValueError):
        size = None
    display = signed_urls.display_url(url)
    name = _text(raw.get("name") or raw.get("label"), f"tracks[{index}].name")
    return {
        "index": index,
        "url": url,
        "index_url": index_url,
        "type": kind,
        "as": as_kind,
        "name": name or display.rsplit("/", 1)[-1] or f"Track {index + 1}",
        "sample": _text(raw.get("sample"), f"tracks[{index}].sample"),
        "group": _text(raw.get("group"), f"tracks[{index}].group"),
        "color": normalize_color(raw.get("color")),
        "size": size,
        "visible": raw.get("visible") is not False,
        "display_url": display,
        "host": signed_urls.host_of(url),
        "signed": signed_urls.looks_signed(url) or bool(index_url and signed_urls.looks_signed(index_url)),
        # A file on a cluster (ssh://[user@]host/path): opened only once the user
        # has connected to that cluster themselves (Connect to cluster...).
        "cluster": cluster_target(url),
    }


def cluster_target(url: str) -> Optional[str]:
    """``[user@]host`` of an ``ssh://`` reference (None for other URLs)."""
    if not isinstance(url, str) or not url.lower().startswith("ssh://"):
        return None
    return url.split("://", 1)[1].split("/", 1)[0] or None


def normalize_session(doc: dict, *, base_url: Optional[str] = None) -> dict:
    """Validate a session-link document; returns the normalised form (raises SessionLinkError)."""
    if not isinstance(doc, dict):
        raise SessionLinkError("The session document must be a JSON object.")
    schema = doc.get("schema")
    warnings: list[str] = []
    if schema is None:
        warnings.append(f"The document does not say `\"schema\": \"{SCHEMA}\"`; reading it as that version.")
    elif schema != SCHEMA:
        raise SessionLinkError(f"Unsupported session schema {schema!r} (this FiberBrowser reads {SCHEMA}).")
    raw_tracks = doc.get("tracks") or []
    if not isinstance(raw_tracks, list):
        raise SessionLinkError("`tracks` must be a list.")
    if len(raw_tracks) > MAX_LISTED_TRACKS:
        raise SessionLinkError(f"The session lists {len(raw_tracks)} tracks; the limit is {MAX_LISTED_TRACKS}.")
    tracks = [parse_track(raw, i, base_url) for i, raw in enumerate(raw_tracks)]
    genome = parse_genome(doc.get("genome"), base_url)
    locus = parse_locus(doc.get("locus"))
    if not tracks and genome is None:
        raise SessionLinkError("The session has no tracks and no genome.")
    return {
        "schema": SCHEMA,
        "title": _text(doc.get("title"), "title"),
        "genome": genome,
        "locus": locus,
        "tracks": tracks,
        "warnings": warnings,
    }
