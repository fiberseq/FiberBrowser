"""Server startup must survive a Copilot that can't start (Codex UI audit HIGH:
``import mlx_lm`` raising ``RuntimeError: [metal::load_device] No Metal device
available`` exited the server before it served anything)."""

import builtins
import sys
from types import SimpleNamespace

import pytest

import services.copilot_lifecycle as cl

pytestmark = pytest.mark.usefixtures("capable_mac")


def _metal_import_fails(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "mlx_lm" or name.startswith("mlx_lm.") or name == "mlx" or name.startswith("mlx."):
            raise RuntimeError("[metal::load_device] No Metal device available")
        return real_import(name, *args, **kwargs)

    for mod in [m for m in sys.modules if m == "mlx_lm" or m.startswith("mlx_lm.") or m == "mlx" or m.startswith("mlx.")]:
        monkeypatch.delitem(sys.modules, mod)
    monkeypatch.setattr(builtins, "__import__", fake_import)


def _args(mode="auto"):
    return SimpleNamespace(copilot=mode, copilot_port=8080, copilot_model=None)


def test_auto_setup_survives_mlx_runtime_error_at_import(monkeypatch):
    _metal_import_fails(monkeypatch)
    monkeypatch.setattr(cl, "_adopt_existing_server", lambda h, p, entry=None: False)
    monkeypatch.setattr(cl, "_ollama_reachable", lambda timeout=0.5: False)
    monkeypatch.setattr(cl, "_pick_model", lambda **k: {"id": "m", "label": "M", "hf_repo": "acme/m", "size_b": 3.0})
    monkeypatch.setattr(cl, "_spawn_mlx", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not spawn")))
    assert cl.setup_copilot(_args()) is False
    assert "No Metal device" in (cl.last_setup_error().get("message") or "")


def test_start_mlx_server_survives_mlx_runtime_error(monkeypatch, tmp_path):
    _metal_import_fails(monkeypatch)
    assert cl._start_mlx_server(tmp_path, host="127.0.0.1", port=8080, log_path=tmp_path / "log") is None


def test_setup_copilot_safely_turns_copilot_off_on_any_failure(monkeypatch):
    def boom(args):
        raise RuntimeError("[metal::load_device] No Metal device available")

    monkeypatch.setattr(cl, "setup_copilot", boom)
    args = _args()
    assert cl.setup_copilot_safely(args) is False
    assert args.copilot == "off"
    assert "Copilot setup failed" in cl.last_setup_error()["message"]


def test_server_startup_uses_the_safe_wrapper():
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "browser" / "server.py").read_text()
    assert "setup_copilot_safely(args)" in src
    assert "\n    setup_copilot(args)" not in src
