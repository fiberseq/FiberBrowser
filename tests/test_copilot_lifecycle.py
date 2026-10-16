"""Copilot lifecycle: auto-mode must never download; in-app download flow."""

import sys
import threading
import types
from types import SimpleNamespace

import services.copilot_lifecycle as cl

import pytest

# Run as an Apple Silicon Mac with mlx-lm and disk room, on any machine.
pytestmark = pytest.mark.usefixtures("capable_mac")

# A worker that does not finish within this long is hung (with the network
# stubbed out it finishes in milliseconds); the wait is only a hang guard.
WORKER_DEADLINE = 30.0


@pytest.fixture(autouse=True)
def _hub_reachable(monkeypatch):
    """The download worker first checks that the Hugging Face Hub answers (a real
    HTTPS request with a 5 s timeout). These tests are about the lifecycle, not
    the network: the Hub is reachable here. (test_copilot_first_run covers the
    offline paths.)"""
    monkeypatch.setattr(cl, "hub_offline_problem", lambda timeout=5.0: None)


def _join_worker():
    cl._download_thread.join(timeout=WORKER_DEADLINE)
    assert not cl._download_thread.is_alive(), f"download worker still running: {cl.get_download_status()}"


def _entry(**kw):
    base = {"id": "m", "label": "M", "hf_repo": "acme/model", "size_b": 7.0}
    base.update(kw)
    return base


def test_is_model_cached_requires_config_and_weights(monkeypatch, tmp_path):
    monkeypatch.setattr(cl, "COPILOT_HOME", tmp_path)
    entry = _entry()
    assert cl._is_model_cached(entry) is False  # nothing on disk

    d = tmp_path / "model"  # last path component of hf_repo
    d.mkdir()
    (d / "config.json").write_text("{}")
    assert cl._is_model_cached(entry) is False  # config but no weight shards

    (d / "model-00001-of-00001.safetensors").write_bytes(b"x")
    assert cl._is_model_cached(entry) is True


def test_download_model_without_download_flag_never_pulls(monkeypatch, tmp_path):
    monkeypatch.setattr(cl, "COPILOT_HOME", tmp_path)
    # Guard: snapshot_download must never be reached on the no-download path.
    monkeypatch.setattr(cl, "_is_model_cached", lambda e: False)
    assert cl._download_model(_entry(), download=False) is None


def test_spawn_mlx_no_download_skips_uncached(monkeypatch, tmp_path):
    monkeypatch.setattr(cl, "COPILOT_HOME", tmp_path)
    monkeypatch.setattr(cl, "_is_model_cached", lambda e: False)
    # If it tried to start a server we'd notice; uncached + no-download => False.
    monkeypatch.setattr(cl, "_start_mlx_server",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not start")))
    assert cl._spawn_mlx(SimpleNamespace(copilot_port=8080), _entry(), allow_download=False) is False


def test_setup_copilot_auto_gates_download_off(monkeypatch):
    # mlx importable so the spawn branch is reached regardless of host.
    monkeypatch.setitem(sys.modules, "mlx_lm", types.ModuleType("mlx_lm"))
    monkeypatch.setattr(cl, "_adopt_existing_server", lambda h, p, entry=None: False)
    monkeypatch.setattr(cl, "_ollama_reachable", lambda timeout=0.5: False)
    monkeypatch.setattr(cl, "_pick_model", lambda **k: _entry())
    seen = {}

    def fake_spawn(args, entry, *, allow_download=True):
        seen["allow_download"] = allow_download
        return False  # fall through; we only care about the flag

    monkeypatch.setattr(cl, "_spawn_mlx", fake_spawn)

    cl.setup_copilot(SimpleNamespace(copilot="auto", copilot_port=8080, copilot_model=None))
    assert seen["allow_download"] is False  # auto NEVER downloads

    cl.setup_copilot(SimpleNamespace(copilot="mlx", copilot_port=8080, copilot_model=None))
    assert seen["allow_download"] is True   # explicit mlx may download


def test_background_download_reaches_ready(monkeypatch, tmp_path):
    monkeypatch.setattr(cl, "COPILOT_HOME", tmp_path)
    monkeypatch.setattr(cl, "_pick_model", lambda **k: _entry())
    monkeypatch.setattr(cl, "_remote_total_bytes", lambda e: 1000)
    monkeypatch.setattr(cl, "_download_model", lambda e, download=True: tmp_path / "model")
    monkeypatch.setattr(cl, "_spawn_mlx", lambda a, e, *, allow_download=True: True)
    monkeypatch.setattr(cl, "_adopt_or_free_port", lambda h, p, e: False)
    cl._download_status.update(state="idle", model_id=None)

    started = cl.start_background_download("m")
    assert started["state"] in ("downloading", "spawning", "ready")
    # An estimate at once; the exact size is looked up in the worker (network).
    assert started["bytes_total"] > 0
    _join_worker()

    final = cl.get_download_status()
    assert final["state"] == "ready"
    assert final["bytes_total"] == 1000
    assert "pct" in final and "bytes_done" in final


def test_background_download_idempotent_while_running(monkeypatch, tmp_path):
    monkeypatch.setattr(cl, "COPILOT_HOME", tmp_path)
    monkeypatch.setattr(cl, "_pick_model", lambda **k: _entry())
    monkeypatch.setattr(cl, "_remote_total_bytes", lambda e: 1000)
    gate = threading.Event()
    # The worker holds in "downloading" until the test has made its second call
    # (a short gate timeout let a slow test thread find the download finished).
    monkeypatch.setattr(cl, "_download_model",
                        lambda e, download=True: (gate.wait(WORKER_DEADLINE), tmp_path / "model")[1])
    monkeypatch.setattr(cl, "_spawn_mlx", lambda a, e, *, allow_download=True: True)
    monkeypatch.setattr(cl, "_adopt_or_free_port", lambda h, p, e: False)  # no probe of the real :8080
    cl._download_status.update(state="idle", model_id=None)

    cl.start_background_download("m")
    first_thread = cl._download_thread
    try:
        second = cl.start_background_download("m")  # must not launch a 2nd download
        assert second["state"] in ("downloading", "spawning")
        assert cl._download_thread is first_thread
    finally:
        gate.set()
    _join_worker()


def test_estimate_download_bytes_q4_smaller_than_fp16():
    fp16 = cl.estimate_download_bytes(_entry(quantized=False))
    q4 = cl.estimate_download_bytes(_entry(quantized=True))
    assert q4 < fp16
    assert fp16 / cl._GB > 10  # 7B fp16 ≈ 13 GB
