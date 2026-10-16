"""Auto-pick never chooses a registry entry that can't be downloaded or found locally.

A models.json entry without ``hf_repo`` (e.g. freshly trained weights not yet
uploaded) can only be served from its local ``fused_path``. On a fresh machine
that directory is absent, so ranking it first made "Download & start" fail for
every new user.
"""
from pathlib import Path

import services.copilot_lifecycle as cl

REPO_ROOT = Path(cl.__file__).resolve().parents[2]


def _registry(fused_path):
    return [
        dict(id="copilot-3b-v5-q8", hf_repo="org/copilot-3b-v5-q8", trained=True, version=5,
             size_b=3, min_ram_gb=8, recommended_ram_gb=16),
        dict(id="copilot-3b-v6-q8", hf_repo=None, fused_path=fused_path, trained=True, version=6,
             size_b=3, min_ram_gb=8, recommended_ram_gb=16),
    ]


def test_local_only_entry_without_weights_is_not_auto_picked(monkeypatch):
    monkeypatch.setattr(cl, "_load_registry", lambda: _registry("data/copilot_dataset/_no_such_fused_model_dir"))
    picked = cl._pick_model(ram_gb=64)
    assert picked["id"] == "copilot-3b-v5-q8"
    assert all(m.get("hf_repo") for m in cl._ranked_models(ram_gb=64))


def test_local_only_entry_with_weights_on_disk_is_picked(monkeypatch, tmp_path):
    fused = tmp_path / "fused_v6"
    fused.mkdir()
    # fused_path is resolved against the repo root; an absolute path joins to itself.
    monkeypatch.setattr(cl, "_load_registry", lambda: _registry(str(fused)))
    assert cl._pick_model(ram_gb=64)["id"] == "copilot-3b-v6-q8"


def test_explicit_override_still_returns_local_only_entry(monkeypatch):
    monkeypatch.setattr(cl, "_load_registry", lambda: _registry("data/copilot_dataset/_no_such_fused_model_dir"))
    assert cl._pick_model(override_id="copilot-3b-v6-q8")["id"] == "copilot-3b-v6-q8"
