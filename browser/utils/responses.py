"""Shared FastAPI response classes."""
from __future__ import annotations

from fastapi.responses import JSONResponse, Response

try:
    import orjson as _orjson

    class ORJSONResponse(Response):
        """Fast JSON response using orjson for large payloads."""
        media_type = "application/json"

        def render(self, content) -> bytes:
            return _orjson.dumps(
                content,
                option=_orjson.OPT_NON_STR_KEYS | _orjson.OPT_SERIALIZE_NUMPY,
            )
except ImportError:
    ORJSONResponse = JSONResponse  # type: ignore[misc,assignment]


def content_disposition(filename: str, disposition: str = "attachment") -> str:
    """A Content-Disposition value safe for any filename.

    HTTP headers are Latin-1, so a label such as "beta-catenin" in Greek can't be sent
    as-is: an ASCII ``filename`` fallback goes first, then the exact name as
    RFC 5987 ``filename*`` (UTF-8, percent-encoded), which browsers prefer.
    """
    from urllib.parse import quote
    name = str(filename or "download")
    fallback = "".join(ch if 32 <= ord(ch) < 127 and ch not in '"\\' else "_" for ch in name) or "download"
    value = f'{disposition}; filename="{fallback}"'
    if fallback != name:
        value += f"; filename*=UTF-8''{quote(name, safe='')}"
    return value
