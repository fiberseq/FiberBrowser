"""Regenerate golden_defaults.json: the default headless renders of the synthetic session.

Run with a FiberBrowser tree's tests/ and browser/ on the path, from that tree's root:

    python tests/fixtures/headless_figure/make_golden.py [out.json]

The committed golden was written from 81bfce04c (before the scripted-figure options existed), so
tests/test_headless_figure_defaults.py checks that a session renders exactly as it did then.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path.cwd()
sys.path[:0] = [str(ROOT / "tests"), str(ROOT / "browser")]
os.environ.setdefault("FIBERBROWSER_NO_OPEN", "1")

# Cases: (name, session options, RenderRequest fields). Only options that existed at 81bfce04c.
CASES = [
    ("session_old_rows", {"sv_row": False}, {}),
    ("session_sv_row", {"sv_row": True}, {}),
    ("session_caps", {"sv_row": False}, {"max_reads": 25, "row_height": 4, "width": 900}),
]

_STREAM = re.compile(rb"(\d+) 0 obj\n<<(.*?)>>\nstream\n", re.S)


def pdf_digest(data: bytes) -> dict:
    """The page box and the sha256 of every decompressed stream, in object order."""
    streams, pos = [], 0
    while True:
        m = _STREAM.search(data, pos)
        if not m:
            break
        length = int(re.search(rb"/Length (\d+)", m.group(2)).group(1))
        body = data[m.end():m.end() + length]
        streams.append(hashlib.sha256(zlib.decompress(body)).hexdigest())
        pos = m.end() + length
    box = re.search(rb"/MediaBox \[([^\]]+)\]", data).group(1).decode()
    return {"media_box": box, "streams": streams}


def render_cases(tmp: Path) -> dict:
    import server as srv
    from headless_figure_data import session, write_datasets
    from models.requests import RenderRequest
    from realpath_helpers import state_client
    from services.figure import api

    paths = write_datasets(tmp)
    out = {}
    for name, sopts, fields in CASES:
        with state_client(srv.app, {}) as (_client, state):
            req = RenderRequest(session=session(paths, **sopts), load_session=True, source="session",
                                format="pdf", scale=2.0, engine="headless", **fields)
            resp = api.render_request(req, state, None)
            assert resp.status_code == 200, resp.body[:300]
            out[name] = pdf_digest(resp.body)
    return out


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        result = render_cases(Path(tmp))
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("golden_defaults.json")
    target.write_text(json.dumps(result, indent=1) + "\n")
    print("wrote", target, {k: len(v["streams"]) for k, v in result.items()})
