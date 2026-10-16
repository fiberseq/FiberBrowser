"""Readable request-validation errors.

FastAPI answers a request body it can't parse with a 422 whose ``detail`` is a
list of pydantic errors. The app showed that list as raw JSON. The response
keeps ``detail`` unchanged (callers and tests read it) and adds ``message``,
one line per field naming where it is (``peak_regions[0].end: ...``), which
the frontend shows instead (api/sharedFetch.ts prefers ``message``).
"""
from __future__ import annotations

import math
from typing import Any, Iterable

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

MAX_ERRORS_SHOWN = 3
MAX_INPUT_CHARS = 60


def field_path(loc: Iterable[Any]) -> str:
    """``("body", "peak_regions", 0, "end")`` -> ``peak_regions[0].end``."""
    parts = list(loc)
    if parts and parts[0] in ("body", "query", "path", "header", "cookie"):
        where, parts = parts[0], parts[1:]
    else:
        where = None
    text = ""
    for part in parts:
        if isinstance(part, int):
            text += f"[{part}]"
        else:
            text += ("." if text else "") + str(part)
    if not text:
        return "request body" if where == "body" else (where or "request")
    return f"{text} (query)" if where == "query" else text


def _shown_input(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= MAX_INPUT_CHARS else text[:MAX_INPUT_CHARS - 1] + "…"


def validation_message(errors: list[dict]) -> str:
    """One readable line per invalid field (at most a few, then a count)."""
    lines = []
    for error in errors[:MAX_ERRORS_SHOWN]:
        msg = str(error.get("msg") or "invalid value")
        line = f"{field_path(error.get('loc') or ())}: {msg}"
        if "input" in error and error.get("type") not in ("missing",) and not isinstance(error["input"], (dict, list)):
            line += f" (got {_shown_input(error['input'])})"
        lines.append(line)
    more = len(errors) - MAX_ERRORS_SHOWN
    if more > 0:
        lines.append(f"and {more} more")
    return "Invalid request: " + "; ".join(lines)


def _json_safe(value: Any) -> Any:
    """NaN and infinities (a rejected coordinate's own value) as text: JSON has no numbers for them."""
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value)
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


async def _handle_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = list(exc.errors())
    return JSONResponse(
        status_code=422,
        content={"detail": _json_safe(jsonable_encoder(errors)), "message": validation_message(errors)},
    )


def install_validation_error_handler(app: FastAPI) -> None:
    app.add_exception_handler(RequestValidationError, _handle_validation_error)
