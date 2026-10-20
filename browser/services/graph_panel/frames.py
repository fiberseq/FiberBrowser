"""The native graph helper's framing (graphlift GRAPH_HELPER.md, protocol 1).

Every frame is a four-byte unsigned big-endian payload length followed by that
many bytes of UTF-8 JSON. The length is checked against the largest frame the
reader accepts *before* the payload is read, so a hostile or broken header
cannot make the supervisor allocate. After decoding, each frame type is held to
its own ceiling (topology 4 MiB, sequence 128 KiB, control frames 64 KiB).
"""
from __future__ import annotations

import asyncio
import struct
from dataclasses import dataclass
from typing import Any

import orjson

PROTOCOL = 1
HEADER_BYTES = 4
MAX_COMMAND_BYTES = 1 << 20          # what the helper accepts from us
MAX_TOPOLOGY_BYTES = 4 << 20         # topology replies
MAX_SEQUENCE_BYTES = 128 << 10       # sequence replies (Phase A review correction)
MAX_CONTROL_BYTES = 64 << 10         # ready/catalog/error/bye
REVISION_KEYS = ("package", "graph", "db", "maps")


class FrameError(Exception):
    """A frame the supervisor cannot accept; the worker that sent it is replaced.

    ``code`` is one of ``eof`` (clean end before a header), ``truncated``,
    ``oversized``, ``malformed`` (bad JSON/UTF-8/envelope)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class Frame:
    type: str
    job_id: str
    generation: int
    revisions: dict
    body: dict
    size: int


def type_limit(frame_type: str, topology_bytes: int = MAX_TOPOLOGY_BYTES) -> int:
    if frame_type == "topology":
        return topology_bytes
    if frame_type == "sequence":
        return MAX_SEQUENCE_BYTES
    return MAX_CONTROL_BYTES


def encode_command(obj: dict, limit: int = MAX_COMMAND_BYTES) -> bytes:
    payload = orjson.dumps(obj)
    if len(payload) > limit:
        raise FrameError("oversized", f"command of {len(payload)} bytes exceeds {limit}")
    return struct.pack(">I", len(payload)) + payload


def decode_payload(payload: bytes, topology_bytes: int = MAX_TOPOLOGY_BYTES) -> Frame:
    try:
        body = orjson.loads(payload)
    except orjson.JSONDecodeError as exc:
        raise FrameError("malformed", f"invalid JSON ({exc})") from None
    if not isinstance(body, dict):
        raise FrameError("malformed", "frame is not a JSON object")
    if body.get("protocol") != PROTOCOL:
        raise FrameError("malformed", f"protocol {body.get('protocol')!r} is not {PROTOCOL}")
    kind, job_id, generation, revisions = body.get("type"), body.get("job_id"), body.get("generation"), body.get("revisions")
    if not isinstance(kind, str) or not kind:
        raise FrameError("malformed", "frame has no type")
    if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
        raise FrameError("malformed", "frame has no valid job_id")
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
        raise FrameError("malformed", "frame has no valid generation")
    if not isinstance(revisions, dict) or any(not isinstance(revisions.get(k), str) for k in REVISION_KEYS):
        raise FrameError("malformed", "frame has no valid revisions")
    limit = type_limit(kind, topology_bytes)
    if len(payload) > limit:
        raise FrameError("oversized", f"{kind} frame of {len(payload)} bytes exceeds its {limit}-byte limit")
    return Frame(kind, job_id, generation, {k: revisions[k] for k in REVISION_KEYS}, body, len(payload))


async def read_frame(reader: asyncio.StreamReader, max_bytes: int = MAX_TOPOLOGY_BYTES,
                     topology_bytes: int = MAX_TOPOLOGY_BYTES) -> Frame:
    """The next complete frame. Raises FrameError; never reads a payload above ``max_bytes``."""
    try:
        header = await reader.readexactly(HEADER_BYTES)
    except asyncio.IncompleteReadError as exc:
        if not exc.partial:
            raise FrameError("eof", "helper closed its output") from None
        raise FrameError("truncated", f"header cut after {len(exc.partial)} bytes") from None
    (length,) = struct.unpack(">I", header)
    if length == 0:
        raise FrameError("malformed", "empty frame")
    if length > max_bytes:
        raise FrameError("oversized", f"frame header announces {length} bytes, above {max_bytes}")
    try:
        payload = await reader.readexactly(length)
    except asyncio.IncompleteReadError as exc:
        raise FrameError("truncated", f"frame cut after {len(exc.partial)} of {length} bytes") from None
    return decode_payload(payload, topology_bytes)


def command(kind: str, job_id: str, generation: int, revisions: dict, **fields: Any) -> dict:
    out = {"protocol": PROTOCOL, "type": kind, "job_id": job_id, "generation": generation,
           "revisions": {k: revisions.get(k, "") for k in REVISION_KEYS}}
    out.update(fields)
    return out
