"""Reading a raw JSON request body without turning bad input into a 500."""
from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException, Request


async def json_object_body(request: Request) -> dict[str, Any]:
    """The request's JSON object body; 422 when it is empty, malformed or not an object."""
    raw = await request.body()
    if not raw.strip():
        raise HTTPException(status_code=422, detail="A JSON object request body is required")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail=f"Request body is not valid JSON: {exc}") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="The request body must be a JSON object")
    return body
