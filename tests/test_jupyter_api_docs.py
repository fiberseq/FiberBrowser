"""docs/jupyter-api.md lists every public BrowserClient method, so a new API surface is documented when it lands."""
from __future__ import annotations

import re
from pathlib import Path

from browser_client import BrowserClient

DOC = Path(__file__).resolve().parents[1] / "docs" / "jupyter-api.md"


def test_every_public_client_method_is_in_the_method_reference():
    text = DOC.read_text(encoding="utf-8")
    names = [name for name, value in vars(BrowserClient).items()
             if not name.startswith("_") and (callable(value) or isinstance(value, (staticmethod, classmethod)))]
    missing = [name for name in names if not re.search(r"`" + re.escape(name) + r"[(`]", text)]
    assert missing == [], "document these in docs/jupyter-api.md: " + ", ".join(missing)
