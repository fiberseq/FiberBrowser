"""First-time Copilot setup: host checks (Apple Silicon only; Rosetta, old macOS,
Intel Mac, Linux, Windows), plain-language errors, disk fallback, port
conflicts, offline failure, and the setup doctor."""
import asyncio
import os
import subprocess
import sys
import types
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import pytest

import services.copilot_doctor as doctor
import services.copilot_lifecycle as cl

REPO = Path(__file__).resolve().parents[1]


def _host(**kw):
    base = {"system": "Darwin", "machine": "arm64", "python": "3.12.4", "python_executable": "/x/python",
            "apple_silicon": True, "rosetta": False, "macos_version": "14.5"}
    base.update(kw)
    return base


LINUX = _host(system="Linux", machine="x86_64", apple_silicon=False, macos_version=None)
WINDOWS = _host(system="Windows", machine="AMD64", apple_silicon=False, macos_version=None)
INTEL_MAC = _host(machine="x86_64", apple_silicon=False)
ROSETTA = _host(machine="x86_64", rosetta=True)


# ── host checks ─────────────────────────────────────────────────────────────

def test_an_apple_silicon_mac_with_arm64_python_can_run_the_model():
    assert cl.mlx_host_problem(_host()) is None


@pytest.mark.parametrize("info, words", [
    (LINUX, "Linux"), (WINDOWS, "Windows"), (INTEL_MAC, "Intel Mac"),
])
def test_other_machines_are_told_plainly_it_needs_apple_silicon(info, words):
    problem = cl.mlx_host_problem(info)
    assert "needs an Apple Silicon Mac" in problem and "arm64 Python" in problem and words in problem
    assert "works normally" in problem  # the browser itself is fine


def test_rosetta_python_is_named_with_the_way_to_the_fix():
    problem = cl.mlx_host_problem(ROSETTA)
    assert "Rosetta" in problem and "arm64 Python" in problem and "--copilot-doctor" in problem


@pytest.mark.parametrize("version, ok", [("12.7.4", False), ("13.4", False), ("13.5", True), ("15.1", True),
                                         ("26.0", True)])
def test_macos_older_than_mlx_supports_is_reported(version, ok):
    problem = cl.mlx_host_problem(_host(macos_version=version))
    assert (problem is None) is ok
    if not ok:
        assert "macOS 13.5 or later" in problem and version in problem


def test_host_info_detects_an_intel_python_under_rosetta(monkeypatch):
    monkeypatch.setattr(cl.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(cl.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(cl.platform, "mac_ver", lambda: ("14.5", ("", "", ""), "x86_64"))
    monkeypatch.setattr(cl, "_sysctl", lambda name: {"hw.optional.arm64": "1", "sysctl.proc_translated": "1"}.get(name))
    info = cl.host_info()
    assert info["apple_silicon"] and info["rosetta"]
    assert "Rosetta" in cl.mlx_host_problem(info)


def test_host_info_on_a_native_apple_silicon_python(monkeypatch):
    monkeypatch.setattr(cl.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(cl.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(cl.platform, "mac_ver", lambda: ("15.2", ("", "", ""), "arm64"))
    monkeypatch.setattr(cl, "_sysctl", lambda name: {"hw.optional.arm64": "1", "sysctl.proc_translated": "0"}.get(name))
    info = cl.host_info()
    assert info["apple_silicon"] and not info["rosetta"]
    assert cl.mlx_host_problem(info) is None


def test_missing_mlx_lm_gives_the_exact_pip_command(monkeypatch):
    monkeypatch.setitem(sys.modules, "mlx_lm", None)  # import raises ImportError
    problem = cl.mlx_import_problem()
    assert "-m pip install 'mlx-lm>=0.19' huggingface_hub" in problem
    assert sys.executable.split("/")[-1] in problem


# ── unsupported machines: nothing spawns, downloads or waits ───────────────

def _no_network(*a, **k):
    raise AssertionError("must not touch the network")


def test_unsupported_host_auto_start_never_spawns_or_downloads(monkeypatch):
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: "needs an Apple Silicon Mac")
    monkeypatch.setattr(cl, "_adopt_existing_server", lambda h, p, entry=None: False)
    monkeypatch.setattr(cl, "_ollama_reachable", lambda timeout=0.5: False)
    monkeypatch.setitem(sys.modules, "mlx_lm", types.ModuleType("mlx_lm"))
    monkeypatch.setattr(cl, "_spawn_mlx", lambda *a, **k: pytest.fail("spawned on an unsupported host"))
    monkeypatch.setattr(cl, "hub_offline_problem", _no_network)
    assert cl.setup_copilot(SimpleNamespace(copilot="auto", copilot_port=8080, copilot_model=None)) is False


def test_unsupported_host_keeps_a_running_ollama(monkeypatch):
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: "needs an Apple Silicon Mac")
    monkeypatch.setattr(cl, "_adopt_existing_server", lambda h, p, entry=None: False)
    monkeypatch.setattr(cl, "_ollama_reachable", lambda timeout=0.5: True)
    assert cl.setup_copilot(SimpleNamespace(copilot="auto", copilot_port=8080, copilot_model=None)) is True
    assert os.environ["FIBERBROWSER_COPILOT_BACKEND"] == "ollama"


def test_forced_mlx_on_an_unsupported_host_fails_with_the_reason(monkeypatch):
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: "The local Copilot currently needs an Apple Silicon Mac")
    monkeypatch.setattr(cl, "_adopt_existing_server", lambda h, p, entry=None: False)
    monkeypatch.setattr(cl, "_spawn_mlx", lambda *a, **k: pytest.fail("spawned"))
    assert cl.setup_copilot(SimpleNamespace(copilot="mlx", copilot_port=8080, copilot_model=None)) is False
    assert "Apple Silicon" in cl.last_setup_error()["message"]


def test_download_button_on_an_unsupported_host_errors_at_once(monkeypatch):
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: "The local Copilot currently needs an Apple Silicon Mac")
    monkeypatch.setattr(cl.threading, "Thread", lambda *a, **k: pytest.fail("started a download thread"))
    monkeypatch.setitem(cl._download_status, "state", "idle")
    status = cl.start_background_download()
    assert status["state"] == "error" and "Apple Silicon" in status["message"]


def test_download_without_mlx_lm_names_the_pip_command(monkeypatch):
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: None)
    monkeypatch.setitem(sys.modules, "mlx_lm", None)
    monkeypatch.setattr(cl.threading, "Thread", lambda *a, **k: pytest.fail("started a download thread"))
    monkeypatch.setitem(cl._download_status, "state", "idle")
    status = cl.start_background_download()
    assert status["state"] == "error" and "pip install 'mlx-lm>=0.19'" in status["message"]


# ── network: fail fast and say why ──────────────────────────────────────────

def test_hf_offline_is_reported_without_a_request(monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setattr(cl.urllib.request, "urlopen", _no_network)
    assert "HF_HUB_OFFLINE" in cl.hub_offline_problem()


def test_unreachable_hub_and_ssl_interception_have_plain_fixes(monkeypatch):
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    seen = {}

    def refuse(url, timeout):
        seen["timeout"] = timeout
        raise urllib.error.URLError(OSError("nodename nor servname provided"))

    monkeypatch.setattr(cl.urllib.request, "urlopen", refuse)
    msg = cl.hub_offline_problem()
    assert "Can't reach" in msg and "HTTPS_PROXY" in msg
    assert seen["timeout"] <= 5  # an offline machine fails in seconds

    def bad_cert(url, timeout):
        raise urllib.error.URLError(Exception("[SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate"))

    monkeypatch.setattr(cl.urllib.request, "urlopen", bad_cert)
    assert "SSL_CERT_FILE" in cl.hub_offline_problem()


def test_hub_timeouts_are_set_so_downloads_cannot_hang():
    assert float(os.environ["HF_HUB_ETAG_TIMEOUT"]) > 0
    assert float(os.environ["HF_HUB_DOWNLOAD_TIMEOUT"]) > 0


def test_offline_download_reports_the_reason(monkeypatch, capable_mac, tmp_path):
    monkeypatch.setattr(cl, "COPILOT_HOME", tmp_path)
    monkeypatch.setattr(cl, "hub_offline_problem", lambda timeout=5.0: "Can't reach https://huggingface.co")
    monkeypatch.setattr(cl, "_remote_total_bytes", lambda e: pytest.fail("looked up sizes while offline"))
    entry = {"id": "m", "label": "M", "hf_repo": "acme/m", "size_b": 1.5, "quantized": True}
    cl._run_download(SimpleNamespace(copilot="mlx", copilot_model="m", copilot_port=8080), entry)
    status = cl.get_download_status()
    assert status["state"] == "error" and "Can't reach" in status["message"]


# ── disk space: fall back to a smaller model ────────────────────────────────

REGISTRY = [
    {"id": "big", "label": "7B", "hf_repo": "o/big", "trained": True, "size_b": 7, "version": 5,
     "recommended_ram_gb": 16, "min_ram_gb": 12},
    {"id": "big-q4", "label": "7B q4", "hf_repo": "o/big-q4", "trained": True, "size_b": 7, "version": 5,
     "quantized": True, "recommended_ram_gb": 8, "min_ram_gb": 6},
    {"id": "tiny-q4", "label": "1.5B q4", "hf_repo": "o/tiny-q4", "trained": True, "size_b": 1.5, "version": 5,
     "quantized": True, "recommended_ram_gb": 4, "min_ram_gb": 3},
]


def test_too_little_disk_falls_back_to_a_smaller_model(monkeypatch):
    monkeypatch.setattr(cl, "_load_registry", lambda: REGISTRY)
    monkeypatch.setattr(cl, "_detect_ram_gb", lambda: 32.0)
    monkeypatch.setattr(cl, "_is_model_cached", lambda e: False)
    monkeypatch.setattr(cl, "free_disk_bytes", lambda path: 3 * cl._GB)
    entry, note = cl.choose_entry_for_disk(REGISTRY[0])
    assert entry["id"] in ("big-q4", "tiny-q4") and "instead" in note

    monkeypatch.setattr(cl, "free_disk_bytes", lambda path: int(1.8 * cl._GB))
    entry, note = cl.choose_entry_for_disk(REGISTRY[0])
    assert entry["id"] == "tiny-q4"

    monkeypatch.setattr(cl, "free_disk_bytes", lambda path: 200 * 1024 ** 2)
    entry, note = cl.choose_entry_for_disk(REGISTRY[0])
    assert entry is None and "FIBERBROWSER_COPILOT_HOME" in note


def test_enough_disk_keeps_the_chosen_model(monkeypatch):
    monkeypatch.setattr(cl, "_is_model_cached", lambda e: False)
    monkeypatch.setattr(cl, "free_disk_bytes", lambda path: 500 * cl._GB)
    assert cl.choose_entry_for_disk(REGISTRY[0]) == (REGISTRY[0], None)


# ── the model server: port, interpreter, timeouts ──────────────────────────

def test_a_port_held_by_another_program_moves_the_server(monkeypatch):
    monkeypatch.setattr(cl, "port_in_use", lambda host, port: port == 8080)
    monkeypatch.setattr(cl, "_served_model_ids", lambda url, timeout=0.8: None)
    monkeypatch.delenv("FIBERBROWSER_COPILOT_MLX_PORT", raising=False)
    assert cl._claim_port("127.0.0.1", 8080) == 8081
    assert os.environ["FIBERBROWSER_COPILOT_MLX_PORT"] == "8081"


def test_a_free_port_is_kept(monkeypatch):
    monkeypatch.setattr(cl, "port_in_use", lambda host, port: False)
    assert cl._claim_port("127.0.0.1", 8080) == 8080


def test_the_server_runs_with_this_python_not_a_path_lookup(monkeypatch, tmp_path):
    import importlib.util
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object())
    cmd = cl._mlx_server_command(tmp_path, "127.0.0.1", 8080)
    assert cmd[:4] == [sys.executable, "-m", "mlx_lm", "server"]
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)  # older mlx-lm
    cmd = cl._mlx_server_command(tmp_path, "127.0.0.1", 8080)
    assert cmd[:3] == [sys.executable, "-m", "mlx_lm.server"]
    assert cmd[cmd.index("--port") + 1] == "8080"


def test_start_timeout_grows_with_the_model(tmp_path):
    small = tmp_path / "s"
    small.mkdir()
    (small / "model.safetensors").write_bytes(b"x")
    assert cl._server_start_timeout(small) == pytest.approx(60.0)
    assert cl._server_start_timeout(tmp_path / "missing") == 60.0
    big = tmp_path / "b"
    big.mkdir()
    with open(big / "model.safetensors", "wb") as fh:  # sparse: 14 GB on paper, nothing on disk
        fh.truncate(14 * 1024 ** 3)
    assert 300 < cl._server_start_timeout(big) <= 600


def test_a_server_that_dies_while_starting_reports_its_log(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "mlx_lm", types.ModuleType("mlx_lm"))
    monkeypatch.setattr(cl, "_http_ok", lambda url, timeout=1.0: False)
    log = tmp_path / "copilot.log"
    log.write_text("Traceback...\nValueError: Model type qwen3 not supported.\n")
    proc = SimpleNamespace(poll=lambda: 1, returncode=1, pid=1)
    monkeypatch.setattr(cl.subprocess, "Popen", lambda *a, **k: proc)
    assert cl._start_mlx_server(tmp_path, host="127.0.0.1", port=8080, log_path=log) is None
    err = cl.last_setup_error()
    assert "exited while starting" in err["message"] and "not supported" in err["log_tail"]


def test_shutdown_handlers_are_set_on_the_main_thread_only(monkeypatch):
    import threading
    installed = []
    monkeypatch.setattr(cl, "_signal_handlers_installed", False)
    monkeypatch.setattr(cl, "_atexit_registered", True)
    monkeypatch.setattr(cl.signal, "signal", lambda sig, handler: installed.append(sig))
    # The panel's download starts the server from a worker thread: no handlers there...
    worker = threading.Thread(target=cl.install_shutdown_handlers)
    worker.start()
    worker.join()
    assert installed == []
    # ...so startup (main thread) installs them, before uvicorn.
    cl.install_shutdown_handlers()
    assert set(installed) == {cl.signal.SIGTERM, cl.signal.SIGINT}
    cl.install_shutdown_handlers()  # idempotent
    assert len(installed) == 2


def test_startup_installs_the_shutdown_handlers_even_before_a_server_exists(monkeypatch):
    calls = []
    monkeypatch.setattr(cl, "install_shutdown_handlers", lambda: calls.append(1))
    cl.setup_copilot(SimpleNamespace(copilot="ollama", copilot_port=8080, copilot_model=None))
    assert calls


def test_logs_go_beside_the_models_not_the_launch_folder():
    assert cl.COPILOT_LOG_DIR != Path("logs")
    assert cl.COPILOT_LOG_DIR.is_absolute()


# ── what the panel says ─────────────────────────────────────────────────────

def test_setup_message_on_a_capable_mac_points_at_set_up_copilot(monkeypatch, capable_mac):
    monkeypatch.setattr(cl, "cached_models", lambda: [])
    monkeypatch.setattr(cl, "_last_error", {"message": None, "log_tail": None, "at": 0.0})
    monkeypatch.setitem(cl._download_status, "state", "idle")
    assert "Set up Copilot" in cl.copilot_setup_message("mlx")
    monkeypatch.setattr(cl, "cached_models", lambda: [{"id": "m"}])
    assert "without downloading again" in cl.copilot_setup_message("mlx")


def test_setup_message_off_apple_silicon_says_so(monkeypatch):
    monkeypatch.setattr(cl, "host_info", lambda: LINUX)
    message = cl.copilot_setup_message("ollama")
    assert "Apple Silicon" in message and "Ollama" in message


def test_capabilities_carry_the_host_problem(monkeypatch):
    import services.natural_language_commands as nlc
    monkeypatch.setattr(nlc, "_LOCAL_COPILOT_PROBLEM", [])
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: "needs an Apple Silicon Mac")
    assert nlc.local_copilot_problem() == "needs an Apple Silicon Mac"
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: None)
    assert nlc.local_copilot_problem() == "needs an Apple Silicon Mac"  # computed once per process


def test_plan_reports_setup_needed(monkeypatch):
    import services.natural_language_commands as nlc

    def stream(*a, **k):
        yield '{"event": "error", "message": "Copilot isn\'t set up yet.", "setup_needed": true}\n'
        yield '{"event": "done"}\n'

    monkeypatch.setattr(nlc, "stream_natural_language_command", stream)
    state = SimpleNamespace(datasets={}, dataset_order=[], gtf_data=None, chroms=[])
    result = nlc.plan_natural_language_command(state, "cluster reads", None, app=None)
    assert result["success"] is False and result["setup_needed"] is True


# ── the setup doctor ────────────────────────────────────────────────────────

def _doctor_env(monkeypatch, info, *, served=None, ollama=(), cached=()):
    monkeypatch.setattr(cl, "host_info", lambda: info)
    monkeypatch.setattr(doctor, "core_dependency_problems", lambda: [])
    monkeypatch.setattr(cl, "_served_model_ids", lambda url, timeout=0.8: served)
    monkeypatch.setattr(cl, "port_in_use", lambda host, port: False)
    monkeypatch.setattr(cl, "cached_models", lambda: list(cached))
    monkeypatch.setattr(cl, "_last_error", {"message": None, "log_tail": None, "at": 0.0})
    import services.natural_language_commands as nlc
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=0.5: list(ollama))


@pytest.mark.parametrize("info", [LINUX, WINDOWS, INTEL_MAC])
def test_doctor_on_other_machines_is_clear_and_offline(monkeypatch, info):
    _doctor_env(monkeypatch, info)
    monkeypatch.setattr(cl, "hub_offline_problem", _no_network)
    report = doctor.run_doctor(network=True)
    assert report["verdict"] == "unsupported"
    assert "Apple Silicon Mac with a native arm64 Python" in report["summary"]
    assert "works normally" in report["summary"]
    assert not any(c["status"] == "fail" for c in report["checks"])


def test_doctor_gives_the_rosetta_fix(monkeypatch):
    _doctor_env(monkeypatch, ROSETTA)
    report = doctor.run_doctor(network=False)
    assert report["verdict"] == "needs_fix"
    platform_check = next(c for c in report["checks"] if c["id"] == "platform")
    assert platform_check["status"] == "fail"
    assert "Miniforge3-MacOSX-arm64.sh" in platform_check["fix"] and "arm64" in platform_check["fix"]


def test_doctor_on_a_ready_to_download_mac(monkeypatch, capable_mac):
    _doctor_env(monkeypatch, _host())
    monkeypatch.setattr(cl, "_load_registry", lambda: REGISTRY)
    monkeypatch.setattr(cl, "_detect_ram_gb", lambda: 16.0)
    monkeypatch.setattr(cl, "hub_offline_problem", lambda timeout=5.0: None)
    monkeypatch.setattr(doctor, "_version", lambda m: "1.0")
    report = doctor.run_doctor(network=True)
    assert report["verdict"] == "needs_download"
    ids = {c["id"]: c["status"] for c in report["checks"]}
    assert ids["platform"] == "ok" and ids["mlx"] == "ok" and ids["network"] == "ok" and ids["disk"] == "ok"
    assert "Result:" in doctor.format_report(report)


def test_doctor_on_an_offline_mac_says_the_network_is_the_problem(monkeypatch, capable_mac):
    _doctor_env(monkeypatch, _host())
    monkeypatch.setattr(cl, "_load_registry", lambda: REGISTRY)
    monkeypatch.setattr(cl, "_detect_ram_gb", lambda: 16.0)
    monkeypatch.setattr(cl, "hub_offline_problem", lambda timeout=5.0: "Can't reach https://huggingface.co")
    monkeypatch.setattr(doctor, "_version", lambda m: "1.0")
    report = doctor.run_doctor(network=True)
    assert report["verdict"] == "needs_fix"
    assert next(c for c in report["checks"] if c["id"] == "network")["status"] == "fail"


def test_doctor_is_ready_when_the_server_answers(monkeypatch, capable_mac):
    _doctor_env(monkeypatch, _host(), served=["/models/fiberbrowser-copilot-1.5b-v5-q4"], cached=[{"id": "m"}])
    monkeypatch.setattr(cl, "_load_registry", lambda: REGISTRY)
    monkeypatch.setattr(doctor, "_version", lambda m: "1.0")
    report = doctor.run_doctor(network=True)
    assert report["verdict"] == "ready"


def test_doctor_names_a_pybigwig_built_against_conda_libraries(monkeypatch):
    real = doctor.importlib.import_module

    def fake_import(name, *args, **kwargs):
        if name == "pyBigWig":
            raise ImportError("dlopen(pyBigWig.so): Library not loaded: @rpath/libz.1.dylib")
        return real(name, *args, **kwargs)

    monkeypatch.setattr(doctor.importlib, "import_module", fake_import)
    problems = doctor.core_dependency_problems()
    assert [p["package"] for p in problems] == ["pyBigWig"]
    fix = problems[0]["fix"]
    assert "conda's" in problems[0]["detail"]
    assert ("--force-reinstall" in fix and "PATH=/usr/bin" in fix) or "bioconda" in fix


def test_doctor_endpoint(monkeypatch):
    import routers.natural_language as nl
    _doctor_env(monkeypatch, LINUX)
    report = asyncio.run(nl.copilot_doctor_endpoint(network=False))
    assert report["verdict"] == "unsupported" and report["checks"]


def test_browser_py_copilot_doctor_runs_before_the_server_imports():
    out = subprocess.run([sys.executable, str(REPO / "browser.py"), "--copilot-doctor", "--offline"],
                         capture_output=True, text=True, timeout=120, cwd=REPO,
                         env={**os.environ, "FIBERBROWSER_COPILOT_MLX_PORT": "8999"})
    assert "FiberBrowser Copilot setup check" in out.stdout and "Result:" in out.stdout
    assert out.returncode in (0, 1)


# ── the launchers pick a Python that can run FiberBrowser ──────────────────

def _fake_python(path, exit_code):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\ncase \"$2\" in *platform.machine*) echo arm64;; esac\nexit %d\n" % exit_code)
    path.chmod(0o755)
    return path


def _pick(env):
    script = f'. "{REPO}/scripts/pick_python.sh"; pick_python && echo "PICKED=$PYTHON_BIN" || {{ no_python_help; exit 1; }}'
    return subprocess.run(["sh", "-c", script], capture_output=True, text=True, timeout=60, cwd=REPO,
                          env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", **env})


def test_launcher_prefers_the_installer_venv(tmp_path):
    good = _fake_python(tmp_path / "venv" / "bin" / "python", 0)
    out = _pick({"HOME": str(tmp_path), "FIBERBROWSER_VENV": str(tmp_path / "venv")})
    assert f"PICKED={good}" in out.stdout


def test_launcher_honours_fiberbrowser_python(tmp_path):
    out = _pick({"HOME": str(tmp_path), "FIBERBROWSER_PYTHON": "/some/python"})
    assert "PICKED=/some/python" in out.stdout


def test_launcher_skips_a_python_without_the_packages(tmp_path):
    _fake_python(tmp_path / "venv" / "bin" / "python", 4)  # 3.10+ but no FiberBrowser packages
    out = _pick({"HOME": str(tmp_path), "FIBERBROWSER_VENV": str(tmp_path / "venv")})
    assert f"PICKED={tmp_path}" not in out.stdout
    if out.returncode:
        assert "scripts/install.sh" in out.stdout


def test_installer_and_launchers_parse():
    import shutil
    for shell, name in (("bash", "scripts/install.sh"), ("sh", "scripts/pick_python.sh"),
                        ("sh", "Launch Browser.sh"), ("zsh", "Launch Browser.command"),
                        ("zsh", "Install FiberBrowser.command")):
        if shutil.which(shell):
            assert subprocess.run([shell, "-n", str(REPO / name)]).returncode == 0, name


def test_mlx_requests_name_the_served_model_not_the_first_listed(monkeypatch):
    # /v1/models lists the whole HF cache; naming its first entry makes
    # mlx_lm.server load an unrelated model instead of the trained Copilot.
    from services import natural_language_commands as nlc
    sent = {}

    def fake_stream(messages, *, model, timeout):
        sent["model"] = model
        yield {"message": {"content": '<think>x</think>{"summary":"s","actions":[],"warnings":[]}'}}
        yield {"done": True}

    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "mlx")
    monkeypatch.setattr(nlc, "_cached_probe_mlx_server", lambda timeout=4.0: {
        "reachable": True, "models": ["mlx-community/Qwen3-Coder-Next-4bit", "/path/fused_copilot"]})
    monkeypatch.setattr(nlc, "_mlx_chat_stream", fake_stream)
    from types import SimpleNamespace
    app = SimpleNamespace(routes=[])
    from data.copilot_dataset.mock_state import make_mock_state
    list(nlc.stream_natural_language_command(make_mock_state(), "how do I cluster?", {}, app=app))
    assert sent["model"] == nlc.MLX_SERVED_MODEL
