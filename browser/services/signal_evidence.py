"""Read producer-supplied, whole-alignment signal evidence without scoring it."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import json
import math
from urllib.parse import parse_qs

STATUS_CODES = {1: "background", 0: "detectable", -1: "unclassified", -2: "unscored"}
FILTER_KEYS = ("hideBackground", "excludeUnscored", "requireDetectable", "requireStructure")
_filters = ContextVar("signal_filters", default=None)
# Reads without footprint calls (bam_tags.read_has_footprint_calls): the request's
# ``hide_uncalled`` query parameter (false: Min footprints' "All reads, including
# uncalled"); None: not given (hidden).
_hide_uncalled = ContextVar("hide_uncalled", default=None)
# The read track's read policy for paths that read BAM records themselves (dense loader, DAF-C, autozoom, lift
# difference reads): the request's ``include_duplicates`` / ``include_qcfail`` query parameters (true: the
# toolbar's Show duplicates / Show QC-fail reads); None: not given (hidden).
_include_duplicates = ContextVar("include_duplicates", default=None)
_include_qcfail = ContextVar("include_qcfail", default=None)
_ABSENT = object()
_CLASSES = {
    "no detectable DddB signal (consistent with untreated/failed)": "background",
    "converted normally": "detectable",
    "low but genuine DddB signal (consistent with quiet chromatin)": "detectable",
    "unclassified": "unclassified",
}


def normalize_filters(value=None):
    value = value if isinstance(value, dict) else {}
    return {key: value.get(key) is True for key in FILTER_KEYS}


def active_signal_filters(state=None):
    value = _filters.get()
    return normalize_filters(value if value is not None else getattr(state, "signal_filters", None))


def signal_filter_key(state=None):
    values = active_signal_filters(state)
    return tuple(values[key] for key in FILTER_KEYS)


@contextmanager
def signal_filters_for_request(value):
    token = _filters.set(normalize_filters(value))
    try:
        yield
    finally:
        _filters.reset(token)


def parse_hide_uncalled(value):
    """A ``hide_uncalled`` request value as a bool; None when absent or unreadable."""
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return None


def request_hide_uncalled(default: bool = True) -> bool:
    """Whether this request hides reads without footprint calls. Every analysis
    that builds a working set without an explicit setting uses this, so the
    reads it sees are the ones the read track shows (default: hidden)."""
    value = _hide_uncalled.get()
    return default if value is None else bool(value)


def body_hide_uncalled(body=None) -> bool:
    """Min footprints' uncalled-read rule for a JSON request: the body's ``hide_uncalled``, else hidden unless
    its ``min_footprints`` is -1 ("All reads, including uncalled"), else the query's (default hide)."""
    body = body if isinstance(body, dict) else {}
    hide = parse_hide_uncalled(body.get("hide_uncalled"))
    if hide is None:
        try:
            hide = False if int(body.get("min_footprints") or 0) < 0 else None
        except (TypeError, ValueError):
            hide = None
    return request_hide_uncalled() if hide is None else bool(hide)


def request_include_duplicates(default: bool = False) -> bool:
    """Whether this request shows duplicate reads (0x400), as the read track's toggle (default: hidden)."""
    value = _include_duplicates.get()
    return default if value is None else bool(value)


def request_include_qcfail(default: bool = False) -> bool:
    """Whether this request shows QC-fail reads (0x200), as the read track's toggle (default: hidden)."""
    value = _include_qcfail.get()
    return default if value is None else bool(value)


def read_policy_key() -> tuple:
    """The request's read policy for cache and job keys: () at the default (both hidden)."""
    dups, qcfail = request_include_duplicates(), request_include_qcfail()
    return (("duplicates", "shown") if dups else ()) + (("qcfail", "shown") if qcfail else ())


@contextmanager
def read_policy_for_request(include_duplicates=None, include_qcfail=None):
    """Set the read policy (bool or a query-string value; None: not given) for code run inside."""
    dup_token = _include_duplicates.set(parse_hide_uncalled(include_duplicates))
    qc_token = _include_qcfail.set(parse_hide_uncalled(include_qcfail))
    try:
        yield
    finally:
        _include_qcfail.reset(qc_token)
        _include_duplicates.reset(dup_token)


@contextmanager
def hide_uncalled_for_request(value):
    token = _hide_uncalled.set(parse_hide_uncalled(value))
    try:
        yield
    finally:
        _hide_uncalled.reset(token)


class SignalFilterMiddleware:
    """Keep each request's predicate through worker jobs and streaming responses."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        query = parse_qs(scope.get("query_string", b"").decode("utf-8", "replace"))
        raw = query.get("signal_filters", ["{}"])[0]
        try:
            value = json.loads(raw)
        except (ValueError, TypeError):
            value = {}
        with signal_filters_for_request(value), hide_uncalled_for_request(query.get("hide_uncalled", [None])[0]), \
                read_policy_for_request(query.get("include_duplicates", [None])[0],
                                        query.get("include_qcfail", [None])[0]):
            await self.app(scope, receive, send)


def _object(value):
    try:
        def reject_constant(value):
            raise ValueError(f"Invalid JSON number: {value}")
        result = json.loads(value, parse_constant=reject_constant) if isinstance(value, str) else value
        return result if isinstance(result, dict) else None
    except (ValueError, TypeError):
        return None


def signal_header(header):
    """Recognize signal provenance; a malformed comment never prevents loading."""
    header = header.to_dict() if hasattr(header, "to_dict") else header
    header = header if isinstance(header, dict) else {}
    comments = header.get("CO", [])
    programs = header.get("PG", [])
    for comment in reversed(comments if isinstance(comments, list) else []):
        for prefix, schema in (("FIBERHMM-SIGNAL:v1:", 5), ("FIBERHMM-DDDB-SIGNAL:v1:", 4)):
            if not isinstance(comment, str) or not comment.startswith(prefix):
                continue
            detail = _object(comment[len(prefix):])
            if not detail or detail.get("tag_schema") != schema:
                return {}
            codes = detail.get("codes")
            if codes is not None and codes != {v: k for k, v in STATUS_CODES.items()}:
                return {}
            return {**detail, "annotation_program": next((p for p in (programs if isinstance(programs, list) else [])
                    if isinstance(p, dict) and p.get("ID") == detail.get("pg")
                    and p.get("PN") == "fiberhmm-tag-signal"), None)}
    return {}


def _number(value, probability=False):
    try:
        finite = type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        return None
    return value if not probability or 0 <= value <= 1 else None


def _text(value):
    return value if isinstance(value, str) else None


def parse_signal_tags(bg=_ABSENT, me=_ABSENT, db=_ABSENT, *, header=None):
    """Normalize schema 5, legacy schema 4 and explicit schema 3 signal fields."""
    result = dict(status="unknown", reason="annotation_unavailable", p_signal=None,
                  background_p=None, opportunities=None,
                  structure=dict(status="unscored", reason="not_assessed", method=None, score=None, p_value=None))
    provenance = header or {}
    detail = {} if me is _ABSENT else _object(me)
    if detail is None:
        return {**result, "reason": "malformed_annotation"}
    schema = detail.get("schema") if me is not _ABSENT else provenance.get("tag_schema")
    if type(schema) is not int or schema not in (3, 4, 5):
        return {**result, "reason": "unknown_schema" if schema is not None else "annotation_unavailable"}
    result["schema"] = schema
    for key in ("assay", "enzyme", "platform", "model_id", "method", "calibration_status", "pg",
                "quality_policy", "opportunity_definition", "exclusion_reason"):
        result[key] = _text(detail.get(key, provenance.get(key)))
    if schema < 5:
        result["enzyme"] = "dddb"
    status = detail.get("signal_status")
    reason = detail.get("signal_reason", detail.get("reason"))
    if schema == 3:
        status = _CLASSES.get(_text(detail.get("signal_class")))
        if status == "unclassified" and reason == "not_sampled":
            status = "unscored"
    else:
        code = bg if schema == 5 else db
        if code is not _ABSENT:
            if type(code) is not int or code not in STATUS_CODES:
                return {**result, "reason": "invalid_signal_code"}
            coded = STATUS_CODES[code]
            if status is not None and status != coded:
                return {**result, "reason": "inconsistent_annotation"}
            status = coded
        elif status is not None and status not in STATUS_CODES.values():
            return {**result, "reason": "invalid_signal_status"}
    if status not in STATUS_CODES.values():
        return result
    # A leftover tag must not silently disagree with the recognized evidence.
    for code in (bg, db):
        if code is not _ABSENT and (type(code) is not int or STATUS_CODES.get(code) != status):
            return {**result, "reason": "inconsistent_annotation"}
    result.update(status=status, reason=_text(reason))
    result["p_signal"] = _number(detail.get("p_signal" if schema == 5 else "p_dddb"), True)
    result["background_p"] = _number(detail.get("background_p" if schema == 5 else "floor_p"), True)
    opportunities = detail.get("opportunities" if schema == 5 else "sites")
    result["opportunities"] = opportunities if type(opportunities) is int and opportunities >= 0 else None
    structure = detail.get("structure")
    if schema == 5 and isinstance(structure, dict):
        score, p_value = _number(structure.get("score")), _number(structure.get("p_value"), True)
        structure_status = structure.get("status")
        if structure_status not in ("supported", "not_detected", "unclassified", "unscored") or score is None:
            structure_status = "unscored"
        result["structure"] = dict(status=structure_status, score=score, p_value=p_value,
                                   method=_text(structure.get("method")), reason=_text(structure.get("reason")))
    return result


# The record tags signal evidence is read from (schema 5 bg/me, legacy schema 4 db).
SIGNAL_RECORD_TAGS = ("bg", "me", "db")


def state_carries_signal(state) -> bool:
    """Whether a loaded dataset carries signal evidence (the layer probe's ``has_signal_tags``): the signal
    filters are offered and applied only then (the frontend's datasetsCarrySignal)."""
    datasets = getattr(state, "datasets", None) or {}
    return any(getattr(d, "has_signal_tags", False) for d in datasets.values())


def record_signal(read, header=None):
    """Evidence from this record only; never joined by query name or read group."""
    def tag(name):
        try:
            return read.get_tag(name)
        except (KeyError, AttributeError):
            return _ABSENT
    return parse_signal_tags(tag("bg"), tag("me"), tag("db"), header=header)


def signal_keeps(evidence, filters=None):
    filters = active_signal_filters() if filters is None else normalize_filters(filters)
    status = (evidence or {}).get("status", "unknown")
    return not (
        (filters["hideBackground"] and status == "background")
        or (filters["excludeUnscored"] and status in ("unscored", "unknown"))
        or (filters["requireDetectable"] and status != "detectable")
        or (filters["requireStructure"] and (evidence or {}).get("structure", {}).get("status") != "supported")
    )


def record_keeps_signal(read, header=None):
    return not any(signal_filter_key()) or signal_keeps(record_signal(read, header))
