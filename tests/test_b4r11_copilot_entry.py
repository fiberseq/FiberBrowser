"""B4 round 11: a local-only Copilot model entry may carry "hf_repo": null."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


def test_local_model_path_with_null_hf_repo():
    from services import copilot_lifecycle as lc

    entry = {"id": "fiberbrowser-copilot-local", "hf_repo": None}
    assert lc._local_model_path(entry).name == "fiberbrowser-copilot-local"
    assert lc._local_model_path({"id": "x", "hf_repo": "org/fiberbrowser-copilot-7b"}).name == "fiberbrowser-copilot-7b"
