import importlib.util
from pathlib import Path

import pytest


def _load_plugin_module():
    plugin_path = Path(__file__).resolve().parents[1] / "plugins" / "fibercnn-scanner" / "plugin.py"
    spec = importlib.util.spec_from_file_location("fibercnn_scanner_plugin", plugin_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_fibercnn_plugin_expands_environment_paths(tmp_path, monkeypatch):
    module = _load_plugin_module()
    monkeypatch.setenv("FIBERCNN_CHECKPOINT_ROOT", str(tmp_path))
    state = module.ScannerState({"checkpoint": "${FIBERCNN_CHECKPOINT_ROOT}/best_model.pt"})

    assert state._required_config_path("checkpoint") == str(tmp_path / "best_model.pt")


def test_fibercnn_plugin_reports_unconfigured_placeholders():
    module = _load_plugin_module()
    state = module.ScannerState({"checkpoint": "${FIBERCNN_CHECKPOINT}"})

    with pytest.raises(RuntimeError, match="checkpoint"):
        state._required_config_path("checkpoint")
