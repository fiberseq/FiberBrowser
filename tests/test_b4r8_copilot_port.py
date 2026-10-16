"""B4 round 8: the configured --copilot-port reaches the panel's setup endpoints."""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'browser'))

from services import copilot_lifecycle


def test_setup_copilot_records_the_configured_port_even_when_off(monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_COPILOT_MLX_PORT", raising=False)
    assert copilot_lifecycle.setup_copilot(SimpleNamespace(copilot="off", copilot_port=8099)) is False
    import os
    assert os.environ["FIBERBROWSER_COPILOT_MLX_PORT"] == "8099"
