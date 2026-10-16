"""Tests for the LLM-only Copilot planner."""
from types import SimpleNamespace

import json

import pandas as pd
import pytest

import services.natural_language_commands as nlc
from services.natural_language_commands import (
    _extract_json_object,
    _normalize_action,
    _split_think_chunk,
    _user_message,
    _validate_plan,
    is_copilot_api_call_allowed,
    plan_natural_language_command,
    resolve_ollama_model,
    stream_natural_language_command,
)


@pytest.fixture(autouse=True)
def _pin_backend_to_ollama(monkeypatch):
    """Pin every test to the Ollama backend.

    The module-level autodetect probes a running mlx_lm.server on :8080; if
    one is up during dev (common), the backend silently flips to MLX and
    breaks Ollama-specific assertions. Tests that need MLX should override
    this fixture explicitly.
    """
    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "ollama")
    nlc._clear_mlx_probe_cache()
    yield
    nlc._clear_mlx_probe_cache()


def _state():
    return SimpleNamespace(
        dataset_order=[],
        datasets={},
        gtf_data={
            "transcripts": pd.DataFrame([
                {
                    "gene_id": "FBgn0000606",
                    "gene_name": "eve",
                    "chrom": "2R",
                    "start": 9_974_000,
                    "end": 9_978_000,
                    "strand": "+",
                },
                {
                    "gene_id": "FBgn0003448",
                    "gene_name": "sna",
                    "chrom": "2L",
                    "start": 15_000,
                    "end": 17_000,
                    "strand": "-",
                },
            ])
        }
    )


def _fake_app(routes=()):
    """Build a stand-in for FastAPI app whose .routes mimics what the planner reads."""
    fake_routes = []
    for path, methods, doc in routes:
        endpoint = lambda: None  # noqa: E731
        endpoint.__doc__ = doc
        fake_routes.append(SimpleNamespace(
            path=path,
            methods=set(methods),
            endpoint=endpoint,
            name=path,
            summary=None,
        ))
    return SimpleNamespace(routes=fake_routes)


# ─────────────────────────────────────────────────────────────────────
# Safety
# ─────────────────────────────────────────────────────────────────────

def test_copilot_api_allowlist_blocks_server_lifecycle_and_file_routes():
    assert is_copilot_api_call_allowed("GET", "/api/jupyter/region") == (True, None)
    assert is_copilot_api_call_allowed("POST", "/api/shutdown")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/datasets/add")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/overlays/add")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/footprint/derived_layers/export")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/tracks/add_motif_file")[0] is False
    assert is_copilot_api_call_allowed("GET", "/api/diagnose_bam?bam_path=/tmp/x.bam")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/jupyter/settings", {"output_dir": "/tmp"})[0] is False
    assert is_copilot_api_call_allowed("PUT", "/api/jupyter/region")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/nl/stream")[0] is False


def test_ollama_model_resolution_accepts_installed_tag_variants():
    resolved, warning = resolve_ollama_model("qwen2.5", ["llava:latest", "qwen2.5:14b"])
    assert resolved == "qwen2.5:14b"
    assert warning and "Resolved" in warning

    resolved, warning = resolve_ollama_model("qwen2.5", ["qwen2.5:latest"])
    assert resolved == "qwen2.5:latest"

    resolved, warning = resolve_ollama_model("qwen2.5:14b", ["qwen2.5:14b"])
    assert resolved == "qwen2.5:14b"
    assert warning is None


# ─────────────────────────────────────────────────────────────────────
# Action normalization
# ─────────────────────────────────────────────────────────────────────

def test_normalize_navigate_gene_resolves_against_gtf():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {"type": "navigate_gene", "gene": "eve", "padding_bp": 100},
        context=None,
    )
    assert action is not None
    assert action["type"] == "navigate_region"
    assert action["chrom"] == "2R"
    assert action["start"] == 9_973_900
    assert action["end"] == 9_978_100
    assert action["gene"]["tss"] == 9_974_000
    assert warnings == []


def test_normalize_navigate_gene_rejects_unknown_gene():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {"type": "navigate_gene", "gene": "notagene"},
        context=None,
    )
    assert action is None
    assert any("not found" in w.lower() for w in warnings)


def test_normalize_strand_aware_tss_clustering():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {"type": "cluster_peak_at_gene_tss", "gene": "sna"},
        context=None,
    )
    assert action is not None
    # sna is on the - strand, so the TSS base is end - 1 (ends are exclusive)
    assert action["chrom"] == "2L"
    assert action["tss"] == 16_999
    assert warnings == []


def test_normalize_api_call_blocks_unsafe_routes():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {"type": "api_call", "method": "POST", "path": "/api/load_fasta",
         "body": {"path": "/Users/me/private.fa"}},
        context=None,
    )
    assert action is not None
    assert action["allowed"] is False
    assert action["blocked_reason"]
    assert any("blocked" in w.lower() for w in warnings)


def test_normalize_api_call_allows_safe_routes():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {"type": "api_call", "method": "GET", "path": "/api/jupyter/region"},
        context=None,
    )
    assert action is not None
    assert action["allowed"] is True
    assert warnings == []


def test_normalize_add_track_from_url_allows_remote_tracks_only():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {"type": "add_track_from_url", "url": "https://example.org/signal.bw", "track_label": "Signal"},
        context=None,
    )
    assert action is not None
    assert action["type"] == "add_track_from_url"
    assert action["path"] == "https://example.org/signal.bw"
    assert warnings == []

    blocked, blocked_warnings = _normalize_action(
        state,
        {"type": "add_track_from_url", "path": "/Users/me/private.bw"},
        context=None,
    )
    assert blocked is None
    assert any("remote" in w.lower() for w in blocked_warnings)


def test_normalize_label_rule_resolves_tss_relative_offset():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {
            "type": "add_region_label_rule",
            "relative_to_gene": "eve",
            "offset_bp": -100,
            "width_bp": 80,
            "layer": "tf",
            "color": "#FFA500",
            "size_min": 1,
            "size_max": 89,
        },
        context=None,
    )
    assert action is not None
    # eve TSS = 9_974_000 on + strand → -100 bp upstream = 9_973_900
    assert action["chrom"] == "2R"
    assert action["position"] == 9_973_900
    assert action["start"] == 9_973_860
    assert action["end"] == 9_973_940
    assert action["color"] == "#FFA500"
    assert "TSS -100" in action["region_label"]
    assert warnings == []


def test_normalize_label_rule_strand_aware_offset():
    state = _state()
    # sna is on - strand, TSS base = end - 1 (16999), so +200 from TSS
    # in transcription orientation = upstream = TSS - 200 = 16799
    action, warnings = _normalize_action(
        state,
        {
            "type": "add_region_label_rule",
            "relative_to_gene": "sna",
            "offset_bp": 200,
            "width_bp": 80,
            "color": "#22c55e",
        },
        context=None,
    )
    assert action is not None
    assert action["chrom"] == "2L"
    assert action["position"] == 16_799


def test_normalize_label_rule_rejects_negative_explicit_coords():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {
            "type": "add_region_label_rule",
            "chrom": "2R",
            "start": -100,
            "end": -1,
            "layer": "tf",
            "color": "#FFA500",
        },
        context=None,
    )
    assert action is None
    assert any("non-negative" in w.lower() for w in warnings)


def test_normalize_label_rule_rejects_inverted_explicit_coords():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {
            "type": "add_region_label_rule",
            "chrom": "2R",
            "start": 1000,
            "end": 500,
        },
        context=None,
    )
    assert action is None
    assert any("greater than start" in w.lower() for w in warnings)


def test_normalize_select_peak_at_resolves_tss_relative():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {"type": "select_peak_at", "relative_to_gene": "eve", "offset_bp": 0, "tolerance_bp": 250},
        context=None,
    )
    assert action is not None
    assert action["chrom"] == "2R"
    assert action["position"] == 9_974_000
    assert action["tolerance_bp"] == 250


def test_normalize_query_motif_overlaps_resolves_tss_relative():
    state = _state()
    action, warnings = _normalize_action(
        state,
        {"type": "query_motif_overlaps", "relative_to_gene": "eve", "offset_bp": -100, "width_bp": 80},
        context=None,
    )
    assert action is not None
    assert action["chrom"] == "2R"
    assert action["start"] == 9_973_860
    assert action["end"] == 9_973_940


def test_normalize_aliases_legacy_action_names():
    state = _state()
    for legacy in ("goto_gene", "go_to_gene"):
        action, _ = _normalize_action(
            state,
            {"type": legacy, "gene": "eve"},
            context=None,
        )
        assert action is not None
        assert action["type"] == "navigate_region"


def test_validate_plan_aggregates_actions_and_warnings():
    state = _state()
    plan = _validate_plan(
        state,
        {
            "summary": "test",
            "actions": [
                {"type": "navigate_gene", "gene": "eve", "padding_bp": 100},
                {"type": "navigate_gene", "gene": "notagene"},
                {"type": "scan_peaks"},
            ],
        },
        context=None,
    )
    assert [a["type"] for a in plan["actions"]] == ["navigate_region", "scan_peaks"]
    assert any("notagene" in w for w in plan["warnings"])


# ─────────────────────────────────────────────────────────────────────
# Thinking parser
# ─────────────────────────────────────────────────────────────────────

def test_split_think_chunk_separates_thinking_and_text():
    # The splitter holds back up to len("<think>")-1 trailing chars in case a
    # tag is just starting; the stream loop flushes the residue at EOS.
    pieces, residue, in_thinking = _split_think_chunk("hello <think>reason</think>{\"a\":1}", False)
    text = "".join(v for k, v in pieces if k == "text")
    thinking = "".join(v for k, v in pieces if k == "thinking")
    assert text + residue == "hello {\"a\":1}"
    assert thinking == "reason"
    assert in_thinking is False


def test_split_think_chunk_holds_partial_close_tag():
    # When inside <think>, the splitter holds back up to len("</think>")-1 chars
    # so a partial close tag at the buffer end is not emitted as content.
    pieces, residue, in_thinking = _split_think_chunk("<think>part</thi", False)
    thinking = "".join(v for k, v in pieces if k == "thinking")
    assert thinking + residue.split("</thi", 1)[0] == "part"
    assert "</thi" in residue
    assert in_thinking is True


def test_split_think_chunk_continues_open_thinking_across_chunks():
    pieces1, residue1, in_thinking = _split_think_chunk("<think>aaa", False)
    assert in_thinking is True
    # Feed a second chunk picking up the residue
    buffer = residue1 + "bbb</think>after"
    pieces2, residue2, in_thinking2 = _split_think_chunk(buffer, in_thinking)
    thinking_total = "".join(v for k, v in pieces1 + pieces2 if k == "thinking")
    text_total = "".join(v for k, v in pieces1 + pieces2 if k == "text")
    assert thinking_total == "aaabbb"
    # `after` may sit in residue2 because <think>=7 chars triggers tail hold.
    assert text_total + residue2 == "after"
    assert in_thinking2 is False


def test_extract_json_object_strips_think_blocks():
    parsed = _extract_json_object("<think>I should navigate</think>{\"actions\": []}")
    assert parsed == {"actions": []}

    parsed_array = _extract_json_object("noise [{\"type\": \"scan_peaks\"}] trailing")
    assert parsed_array == [{"type": "scan_peaks"}]


# ─────────────────────────────────────────────────────────────────────
# User message + system prompt
# ─────────────────────────────────────────────────────────────────────

def test_user_message_includes_viewport_datasets_and_command():
    state = _state()
    state.dataset_order = ["d1"]
    state.datasets = {
        "d1": SimpleNamespace(
            label="2-4hr embryo",
            layer_type="bam",
            available_layers={"tf": True, "nuc": True},
        )
    }
    msg = _user_message(state, "navigate to eve", {"chrom": "2R", "start": 100, "end": 200, "currentGenome": "dm6"})
    assert "2R:100-200" in msg
    assert "dm6" in msg
    assert "d1 (bam)" in msg
    assert "2-4hr embryo" in msg
    assert "GTF loaded: yes" in msg
    assert "User request: navigate to eve" in msg


def test_build_system_prompt_lists_safe_routes_and_caches():
    app = _fake_app([
        ("/api/jupyter/region", ("GET",), "Get current region."),
        ("/api/shutdown", ("POST",), "Stop the server."),
        ("/api/scan_peaks", ("POST",), "Rescan peaks."),
    ])
    # The operator prompt (legacy corpus) lists the safe routes; Copilot itself teaches.
    prompt1 = nlc.build_copilot_system_prompt(app, teach_only=False)
    prompt2 = nlc.build_copilot_system_prompt(app, teach_only=False)
    assert prompt1 is prompt2  # cached
    assert "/api/jupyter/region" in prompt1
    assert "/api/scan_peaks" in prompt1
    assert "/api/shutdown" not in prompt1  # blocked
    assert "FiberBrowser Copilot" in prompt1
    assert "<think>" in prompt1


def test_build_capabilities_returns_route_table_and_models(monkeypatch):
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: ["qwen2.5:7b"])
    app = _fake_app([
        ("/api/jupyter/region", ("GET",), "Get current region."),
        ("/api/shutdown", ("POST",), "Stop the server."),
    ])
    caps = nlc.build_copilot_api_capabilities(app)
    assert caps["allowed_count"] >= 1
    assert caps["blocked_count"] >= 1
    assert caps["available_models"] == ["qwen2.5:7b"]
    assert caps["default_model"].startswith("qwen2.5")
    assert caps["system_prompt"]


def test_probe_mlx_server_distinguishes_reachable_from_loaded_models(monkeypatch):
    nlc._reset_probe_cache_for_tests()

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"data":[]}'

    monkeypatch.setattr(nlc.urllib.request, "urlopen", lambda *args, **kwargs: FakeResponse())

    probe = nlc.probe_mlx_server(timeout=0.1)

    assert probe["reachable"] is True
    assert probe["models"] == []
    assert probe["error"] is None


def test_probe_mlx_server_reports_unreachable_when_connection_refused(monkeypatch):
    nlc._reset_probe_cache_for_tests()
    import urllib.error

    def _refuse(*_args, **_kwargs):
        raise urllib.error.URLError("Connection refused")

    monkeypatch.setattr(nlc.urllib.request, "urlopen", _refuse)
    probe = nlc.probe_mlx_server(timeout=0.1)

    assert probe["reachable"] is False
    assert probe["models"] == []
    assert "URLError" in (probe["error"] or "")


def test_probe_mlx_server_reports_unreachable_on_socket_timeout(monkeypatch):
    nlc._reset_probe_cache_for_tests()
    import socket

    def _timeout(*_args, **_kwargs):
        raise socket.timeout("timed out")

    monkeypatch.setattr(nlc.urllib.request, "urlopen", _timeout)
    probe = nlc.probe_mlx_server(timeout=0.1)

    assert probe["reachable"] is False
    # The exception class name surfaces in the error string so callers can
    # diagnose whether the server is down vs slow.
    assert "timeout" in (probe["error"] or "").lower()


def test_probe_mlx_server_reports_reachable_but_malformed_when_body_is_not_json(monkeypatch):
    nlc._reset_probe_cache_for_tests()

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            # Simulate a misconfigured proxy returning an HTML error page
            # on the /v1/models route — the connection succeeds, so the
            # server IS reachable, but the body can't be parsed.
            return b"<html><body>404 Not Found</body></html>"

    monkeypatch.setattr(nlc.urllib.request, "urlopen", lambda *args, **kwargs: FakeResponse())

    probe = nlc.probe_mlx_server(timeout=0.1)
    assert probe["reachable"] is True
    assert probe["models"] == []
    assert "invalid JSON" in (probe["error"] or "")


def test_probe_mlx_server_caches_repeat_calls(monkeypatch):
    nlc._reset_probe_cache_for_tests()

    calls = {"n": 0}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"data":[{"id":"cached-model"}]}'

    def counting_urlopen(*_args, **_kwargs):
        calls["n"] += 1
        return FakeResponse()

    monkeypatch.setattr(nlc.urllib.request, "urlopen", counting_urlopen)

    # Three rapid probes — only the first should hit the network. The
    # other two should be served from the in-memory cache so capabilities
    # polls don't multiply backend load.
    nlc.probe_mlx_server(timeout=0.1)
    nlc.probe_mlx_server(timeout=0.1)
    result = nlc.probe_mlx_server(timeout=0.1)

    assert calls["n"] == 1
    assert result["models"] == ["cached-model"]


def test_probe_mlx_server_parses_common_model_payload_shapes(monkeypatch):
    payloads = [
        b'{"data":[{"id":"model-a"},{"model":"model-b"}]}',
        b'{"models":[{"name":"model-c"},"model-d"]}',
        b'{"id":"model-e"}',
    ]

    class FakeResponse:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return self.body

    for body, expected in zip(payloads, [{"model-a", "model-b"}, {"model-c", "model-d"}, {"model-e"}]):
        # Reset between iterations because probe_mlx_server caches results
        # for ~2s — without this the second/third assertions would see the
        # first body's parsed models served from cache.
        nlc._reset_probe_cache_for_tests()
        monkeypatch.setattr(nlc.urllib.request, "urlopen", lambda *args, _body=body, **kwargs: FakeResponse(_body))
        assert set(nlc.list_mlx_models(timeout=0.1)) == expected


def test_mlx_capabilities_do_not_call_reachable_empty_server_unreachable(monkeypatch):
    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "mlx")
    monkeypatch.setattr(
        nlc,
        "probe_mlx_server",
        lambda timeout=1.0: {"reachable": True, "models": [], "error": None},
    )
    app = _fake_app([
        ("/api/jupyter/region", ("GET",), "Get current region."),
    ])

    caps = nlc.build_copilot_api_capabilities(app)

    assert caps["mlx_reachable"] is True
    assert caps["available_models"] == []
    assert caps["copilot_ready"] is False
    assert "not reachable" not in (caps["model_warning"] or "")


def test_capabilities_cache_refreshes_runtime_mlx_backend_and_urls(monkeypatch):
    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "ollama")
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: ["qwen2.5:7b"])
    app = _fake_app([
        ("/api/jupyter/region", ("GET",), "Get current region."),
    ])

    first = nlc.build_copilot_api_capabilities(app)
    assert first["backend"] == "ollama"

    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "mlx")
    monkeypatch.setenv("FIBERBROWSER_COPILOT_MLX_URL", "http://127.0.0.1:18080/v1/chat/completions")
    monkeypatch.setenv("FIBERBROWSER_COPILOT_MLX_MODELS_URL", "http://127.0.0.1:18080/v1/models")
    monkeypatch.setattr(
        nlc,
        "probe_mlx_server",
        lambda timeout=1.0: {"reachable": True, "models": ["loaded-mlx-model"], "error": None},
    )

    second = nlc.build_copilot_api_capabilities(app)

    assert second["backend"] == "mlx"
    assert second["available_models"] == ["loaded-mlx-model"]
    assert second["mlx_url"] == "http://127.0.0.1:18080/v1/chat/completions"
    assert second["mlx_models_url"] == "http://127.0.0.1:18080/v1/models"


def test_mlx_capabilities_probe_is_briefly_memoized(monkeypatch):
    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "mlx")
    nlc._clear_mlx_probe_cache()
    calls = []

    def fake_probe(timeout=1.0):
        calls.append(timeout)
        return {"reachable": True, "models": ["loaded-mlx-model"], "error": None}

    monkeypatch.setattr(nlc, "probe_mlx_server", fake_probe)
    app = _fake_app([
        ("/api/jupyter/region", ("GET",), "Get current region."),
    ])

    first = nlc.build_copilot_api_capabilities(app)
    second = nlc.build_copilot_api_capabilities(app)

    assert first["available_models"] == ["loaded-mlx-model"]
    assert second["available_models"] == ["loaded-mlx-model"]
    assert calls == [4.0]


def test_lifecycle_backend_update_syncs_imported_planner_state(monkeypatch):
    import services.copilot_lifecycle as lifecycle

    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "ollama")
    monkeypatch.setenv("FIBERBROWSER_COPILOT_BACKEND", "ollama")
    monkeypatch.delenv("FIBERBROWSER_COPILOT_MLX_URL", raising=False)
    monkeypatch.delenv("FIBERBROWSER_COPILOT_MLX_MODELS_URL", raising=False)

    lifecycle._set_active_backend("mlx", mlx_base_url="http://127.0.0.1:18080")

    assert nlc.COPILOT_BACKEND == "mlx"
    assert nlc._mlx_chat_url() == "http://127.0.0.1:18080/v1/chat/completions"
    assert nlc._mlx_models_url() == "http://127.0.0.1:18080/v1/models"


def test_agent_step_uses_runtime_mlx_backend_and_url(monkeypatch):
    import services.copilot_agent as agent

    calls = []

    def fake_post(url, payload, *, timeout):
        calls.append((url, payload, timeout))
        return {"choices": [{"message": {"content": "ok"}}]}

    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "mlx")
    monkeypatch.setenv("FIBERBROWSER_COPILOT_MLX_URL", "http://127.0.0.1:18080/v1/chat/completions")
    monkeypatch.setattr(agent, "_post", fake_post)

    result = agent.agent_step(model="loaded-mlx-model", messages=[{"role": "user", "content": "hi"}], timeout=3.0)

    assert result == {"content": "ok"}
    assert calls[0][0] == "http://127.0.0.1:18080/v1/chat/completions"
    # mlx_lm.server loads whatever a request names; ask for the served model.
    assert calls[0][1]["model"] == nlc.MLX_SERVED_MODEL


# ─────────────────────────────────────────────────────────────────────
# Streaming end-to-end (mocked Ollama)
# ─────────────────────────────────────────────────────────────────────

def _stream_chunks(content: str, *, error: str = ""):
    """Build an iterator of Ollama chat-stream chunks for a given final content string."""
    midpoint = len(content) // 2
    parts = [content[:midpoint], content[midpoint:]]
    chunks = []
    for piece in parts:
        if piece:
            chunks.append({"message": {"content": piece}})
    final = {"message": {"content": ""}, "done": True,
             "total_duration": 1, "eval_count": 8}
    if error:
        final["error"] = error
    chunks.append(final)
    return chunks


def _collect_events(generator):
    return [json.loads(line) for line in generator]


def test_stream_yields_thinking_token_plan_done(monkeypatch):
    state = _state()
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: ["qwen2.5:7b"])
    monkeypatch.setattr(nlc, "resolve_ollama_model",
                        lambda requested, available=None: ("qwen2.5:7b", None))
    monkeypatch.setattr(
        nlc, "_ollama_chat_stream",
        lambda messages, *, model, timeout: iter(_stream_chunks(
            '<think>navigate to eve</think>{"summary":"go","actions":[{"type":"navigate_gene","gene":"eve","padding_bp":100}]}'
        )),
    )

    events = _collect_events(stream_natural_language_command(
        state, "navigate to eve", {"chrom": "2R", "start": 1, "end": 2}, app=_fake_app(), model="qwen2.5",
    ))
    kinds = [e["event"] for e in events]
    assert kinds[0] == "start"
    assert "thinking" in kinds
    assert "token" in kinds
    plans = [e for e in events if e["event"] == "plan"]
    assert len(plans) == 1
    plan = plans[0]
    assert plan["success"] is True
    assert plan["actions"][0]["type"] == "navigate_region"
    assert plan["actions"][0]["gene"]["name"] == "eve"
    assert kinds[-1] == "done"


def test_stream_reports_when_ollama_not_running(monkeypatch):
    import services.copilot_lifecycle as cl
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: [])
    # A machine that can't run the local model: says so, plus the Ollama hint.
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: "The local Copilot currently needs an Apple Silicon Mac.")
    events = _collect_events(stream_natural_language_command(
        _state(), "navigate to eve", None, app=_fake_app(), model="qwen2.5",
    ))
    errors = [e for e in events if e["event"] == "error"]
    assert errors and "Apple Silicon" in errors[0]["message"] and "Ollama" in errors[0]["message"]
    assert errors[0]["setup_needed"] is True
    assert events[-1]["event"] == "done"


def test_stream_offers_the_mlx_setup_on_a_capable_mac(monkeypatch):
    import services.copilot_lifecycle as cl
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: [])
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: None)
    monkeypatch.setattr(cl, "mlx_import_problem", lambda: None)
    monkeypatch.setattr(cl, "cached_models", lambda: [])
    monkeypatch.setattr(cl, "_last_error", {"message": None, "log_tail": None, "at": 0.0})
    events = _collect_events(stream_natural_language_command(
        _state(), "navigate to eve", None, app=_fake_app(), model="qwen2.5",
    ))
    errors = [e for e in events if e["event"] == "error"]
    assert errors and "Set up Copilot" in errors[0]["message"]
    assert "Ollama" not in errors[0]["message"]
    assert errors[0]["setup_needed"] is True


def test_stream_propagates_ollama_errors(monkeypatch):
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: ["qwen2.5:7b"])
    monkeypatch.setattr(nlc, "resolve_ollama_model",
                        lambda requested, available=None: ("qwen2.5:7b", None))

    def bomb(messages, *, model, timeout):
        raise TimeoutError("model timed out")

    monkeypatch.setattr(nlc, "_ollama_chat_stream", bomb)
    events = _collect_events(stream_natural_language_command(
        _state(), "navigate to eve", None, app=_fake_app(), model="qwen2.5",
    ))
    errors = [e for e in events if e["event"] == "error"]
    assert errors and "timed out" in errors[0]["message"]


def test_plan_natural_language_command_runs_streaming_to_completion(monkeypatch):
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: ["qwen2.5:7b"])
    monkeypatch.setattr(nlc, "resolve_ollama_model",
                        lambda requested, available=None: ("qwen2.5:7b", None))
    monkeypatch.setattr(
        nlc, "_ollama_chat_stream",
        lambda messages, *, model, timeout: iter(_stream_chunks(
            '<think>plan</think>{"summary":"navigate","actions":[{"type":"navigate_gene","gene":"eve","padding_bp":100}]}'
        )),
    )
    result = plan_natural_language_command(
        _state(), "navigate to eve", {"chrom": "2R", "start": 1, "end": 2},
        app=_fake_app(), model="qwen2.5",
    )
    assert result["success"] is True
    assert result["actions"][0]["type"] == "navigate_region"
    assert result["debug"]["thinking"] == "plan"
    assert "raw_content" in result["debug"]


def test_rewrite_raw_http_action_verb_then_path():
    """type: 'POST', path: '/api/foo' → typed api_call shape."""
    out = nlc._rewrite_raw_http_action({"type": "POST", "path": "/api/jupyter/region", "body": {"x": 1}})
    assert out == {
        "type": "api_call",
        "method": "POST",
        "path": "/api/jupyter/region",
        "body": {"x": 1},
        "label": "POST /api/jupyter/region",
    }


def test_rewrite_raw_http_action_combined_verb_and_path():
    """type: 'POST /api/foo' (single string) → typed api_call shape."""
    out = nlc._rewrite_raw_http_action({"type": "POST /api/scan_peaks", "body": {"threshold": 0.5}})
    assert out is not None
    assert out["method"] == "POST"
    assert out["path"] == "/api/scan_peaks"
    assert out["body"] == {"threshold": 0.5}


def test_rewrite_raw_http_action_get_no_body():
    out = nlc._rewrite_raw_http_action({"action": "GET /api/status"})
    assert out is not None
    assert out["method"] == "GET"
    assert out["path"] == "/api/status"


def test_rewrite_raw_http_action_ignores_typed_actions():
    """Real typed actions pass through untouched so we don't rewrite api_call."""
    assert nlc._rewrite_raw_http_action({"type": "navigate_region", "chrom": "2R"}) is None
    assert nlc._rewrite_raw_http_action({"type": "api_call", "method": "GET", "path": "/api/foo"}) is None


def test_normalize_action_routes_raw_post_through_api_call_validator():
    """End-to-end: a raw POST step from the model becomes a typed api_call
    that the rest of the validator (and the safe-route allowlist) can
    handle. Previously these were dropped with 'unsupported action type'."""
    normalized, warnings = nlc._normalize_action(
        _state(),
        {"type": "POST /api/scan_peaks", "body": {"threshold": 0.3}},
        context=None,
    )
    assert normalized is not None
    assert normalized["type"] == "api_call"
    assert normalized["method"] == "POST"
    assert normalized["path"] == "/api/scan_peaks"
    # The api_call validator decides allowed-ness via the safe catalog;
    # the warning (if any) comes from there, not from "unsupported".
    assert not any("unsupported action type" in w for w in warnings)


def test_plan_returns_failure_if_actions_empty(monkeypatch):
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: ["qwen2.5:7b"])
    monkeypatch.setattr(nlc, "resolve_ollama_model",
                        lambda requested, available=None: ("qwen2.5:7b", None))
    monkeypatch.setattr(
        nlc, "_ollama_chat_stream",
        lambda messages, *, model, timeout: iter(_stream_chunks('{"summary":"none","actions":[]}')),
    )
    result = plan_natural_language_command(
        _state(), "do nothing useful", None, app=_fake_app(), model="qwen2.5",
    )
    assert result["success"] is False
    assert result["actions"] == []


# ── v2.11 merge: API parity + new typed actions ──────────────────────

def test_copilot_api_allowlist_v211_routes():
    # PWM + sequence motif routes are safe (no file_path); add_motif_file is not.
    assert is_copilot_api_call_allowed("POST", "/api/tracks/add_motif_pwm") == (True, None)
    assert is_copilot_api_call_allowed("POST", "/api/tracks/add_motif_sequence") == (True, None)
    assert is_copilot_api_call_allowed("POST", "/api/tracks/add_motif_file")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/add_track")[0] is False
    # Dataset merge/unmerge are safe view ops on already-loaded data.
    assert is_copilot_api_call_allowed("POST", "/api/datasets/merge") == (True, None)
    assert is_copilot_api_call_allowed("POST", "/api/datasets/unmerge") == (True, None)
    # File-picker hyphen variant must stay blocked (parity with the frontend mirror).
    assert is_copilot_api_call_allowed("POST", "/api/pick-file")[0] is False
    # The whole NL surface is blocked, not just /plan.
    assert is_copilot_api_call_allowed("POST", "/api/nl/setup")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/nl/agent_step")[0] is False


def test_normalize_dataset_layout_actions():
    state = _state()
    a, _ = _normalize_action(state, {"type": "set_dataset_label", "dataset_id": "ds1", "label_text": "WT"}, context=None)
    assert a is not None and a["dataset_id"] == "ds1" and a["label_text"] == "WT"
    # missing label rejects
    a2, _ = _normalize_action(state, {"type": "set_dataset_label", "dataset_id": "ds1"}, context=None)
    assert a2 is None
    # link needs >= 2 panel ids
    a3, _ = _normalize_action(state, {"type": "link_datasets", "panel_ids": ["only"]}, context=None)
    assert a3 is None
    a4, _ = _normalize_action(state, {"type": "link_datasets", "panel_ids": ["a", "b"]}, context=None)
    assert a4 is not None and a4["panel_ids"] == ["a", "b"]
    a5, _ = _normalize_action(state, {"type": "merge_datasets"}, context=None)
    assert a5 is not None


def test_normalize_cluster_selection_and_merge():
    state = _state()
    a, _ = _normalize_action(state, {"type": "toggle_cluster_selection", "cluster_id": 2}, context=None)
    assert a is not None and a["cluster_id"] == 2
    a2, _ = _normalize_action(state, {"type": "set_cluster_selection", "cluster_ids": [1, 3]}, context=None)
    assert a2 is not None and a2["cluster_ids"] == [1, 3]
    a3, _ = _normalize_action(state, {"type": "merge_clusters"}, context=None)
    assert a3 is not None
    a4, _ = _normalize_action(state, {"type": "set_cluster_order_lock", "locked": True}, context=None)
    assert a4 is not None and a4["locked"] is True
    # non-numeric cluster id rejects
    bad, _ = _normalize_action(state, {"type": "toggle_cluster_selection", "cluster_id": "x"}, context=None)
    assert bad is None


def test_normalize_read_display_controls():
    state = _state()
    # row height accepts an int and the literal "auto"
    a, _ = _normalize_action(state, {"type": "set_read_row_height", "value": 8}, context=None)
    assert a is not None and a["value"] == 8
    a2, _ = _normalize_action(state, {"type": "set_read_row_height", "value": "auto"}, context=None)
    assert a2 is not None and a2["value"] == "auto"
    bad, _ = _normalize_action(state, {"type": "set_read_row_height", "value": 9999}, context=None)
    assert bad is None
    # separator mode is an enum
    a3, _ = _normalize_action(state, {"type": "set_read_separator_mode", "mode": "off"}, context=None)
    assert a3 is not None and a3["mode"] == "off"
    badmode, _ = _normalize_action(state, {"type": "set_read_separator_mode", "mode": "nope"}, context=None)
    assert badmode is None
    a4, _ = _normalize_action(state, {"type": "set_fill_read_height", "enabled": True}, context=None)
    assert a4 is not None and a4["enabled"] is True
    # layer background opacity clamps to [0,1] and requires a layer
    a5, _ = _normalize_action(state, {"type": "set_layer_background_opacity", "layer": "nuc", "opacity": 2.0}, context=None)
    assert a5 is not None and a5["opacity"] == 1.0
    nolayer, _ = _normalize_action(state, {"type": "set_layer_background_opacity", "opacity": 0.5}, context=None)
    assert nolayer is None


def test_normalize_motif_actions():
    state = _state()
    a, _ = _normalize_action(state, {"type": "set_motif_threshold", "value": 0.95}, context=None)
    assert a is not None and a["value"] == 0.95
    # clamps below 0.5
    a2, _ = _normalize_action(state, {"type": "set_motif_threshold", "value": 0.1}, context=None)
    assert a2 is not None and a2["value"] == 0.5
    # JASPAR names accept a list or a comma-separated string
    a3, _ = _normalize_action(state, {"type": "load_jaspar_motifs", "names": ["CTCF", "GATA1"]}, context=None)
    assert a3 is not None and a3["names"] == ["CTCF", "GATA1"]
    a4, _ = _normalize_action(state, {"type": "load_jaspar_motifs", "names": "CTCF, GATA1"}, context=None)
    assert a4 is not None and a4["names"] == ["CTCF", "GATA1"]
    empty, _ = _normalize_action(state, {"type": "load_jaspar_motifs", "names": []}, context=None)
    assert empty is None


# ── v2.12 merge: cluster trees / branches + dynamic reassignment ─────

def test_normalize_subcluster_and_dynamic():
    state = _state()
    a, _ = _normalize_action(state, {"type": "subcluster_clusters", "cluster_ids": [2]}, context=None)
    assert a is not None and a["cluster_ids"] == [2]
    # bare int coerces to a list
    a2, _ = _normalize_action(state, {"type": "subcluster_clusters", "cluster_ids": 3}, context=None)
    assert a2 is not None and a2["cluster_ids"] == [3]
    empty, _ = _normalize_action(state, {"type": "subcluster_clusters", "cluster_ids": []}, context=None)
    assert empty is None
    a3, _ = _normalize_action(state, {"type": "set_dynamic_clustering", "enabled": True}, context=None)
    assert a3 is not None and a3["enabled"] is True
    a4, _ = _normalize_action(state, {"type": "set_dynamic_overlap_mode", "mode": "aggressive"}, context=None)
    assert a4 is not None and a4["mode"] == "aggressive"
    bad, _ = _normalize_action(state, {"type": "set_dynamic_overlap_mode", "mode": "nope"}, context=None)
    assert bad is None


def test_normalize_cluster_branches():
    state = _state()
    a, _ = _normalize_action(state, {"type": "capture_cluster_branch", "name": "baseline"}, context=None)
    assert a is not None and a["name"] == "baseline"
    # capture with no name is allowed (auto-named)
    a2, _ = _normalize_action(state, {"type": "capture_cluster_branch"}, context=None)
    assert a2 is not None and a2["name"] is None
    a3, _ = _normalize_action(state, {"type": "switch_cluster_branch", "name": "C2"}, context=None)
    assert a3 is not None and a3["name"] == "C2"
    noname, _ = _normalize_action(state, {"type": "switch_cluster_branch"}, context=None)
    assert noname is None
    # rename targets the active branch when no name given, but needs new_name
    a4, _ = _normalize_action(state, {"type": "rename_cluster_branch", "new_name": "paused"}, context=None)
    assert a4 is not None and a4["new_name"] == "paused" and a4["name"] is None
    nonew, _ = _normalize_action(state, {"type": "rename_cluster_branch", "name": "C2"}, context=None)
    assert nonew is None
    a5, _ = _normalize_action(state, {"type": "delete_cluster_branch", "name": "old"}, context=None)
    assert a5 is not None and a5["name"] == "old"
    nodel, _ = _normalize_action(state, {"type": "delete_cluster_branch"}, context=None)
    assert nodel is None


def test_normalize_panel_strand_copy_link_and_top_locus_actions():
    state = _state()
    act = lambda a: _normalize_action(state, a, context=None)[0]
    assert act({"type": "set_panel_strand", "strand": "ct"})["strand"] == "CT"
    assert act({"type": "show_strand", "strand": "both"})["strand"] == "both"
    assert act({"type": "set_panel_strand", "strand": "sideways"}) is None
    assert act({"type": "split_by_strand"})["type"] == "split_panel_by_strand"
    linked = act({"type": "copy_panel"})
    assert linked["type"] == "open_panel_copy" and "chrom" not in linked
    at_gene = act({"type": "open_panel_copy", "gene": "eve", "padding_bp": 100})
    assert (at_gene["chrom"], at_gene["start"], at_gene["end"]) == ("2R", 9_973_900, 9_978_100)
    assert act({"type": "open_panel_copy", "gene": "nosuchgene"}) is None
    assert act({"type": "open_panel_copy", "chrom": "2L", "start": 900, "end": 100}) is None
    assert act({"type": "unlink_panel"})["linked"] is False
    assert act({"type": "link_panel"})["linked"] is True
    assert act({"type": "set_panel_linked", "linked": False})["linked"] is False
    assert act({"type": "go_to_reads"})["type"] == "go_to_top_locus"
    assert act({"type": "cluster_by_saved_footprints"})["type"] == "cluster_by_saved_footprints"


def test_merge_clusters_keeps_the_browsers_settings_unless_asked():
    state = _state()
    plain, _ = _normalize_action(state, {"type": "auto_cull_clusters"}, context=None)
    assert "min_fraction" not in plain and "max_cosine_similarity" not in plain
    asked, _ = _normalize_action(state, {"type": "auto_cull_clusters", "min_fraction": 0.9, "maxCosineSimilarity": 0.97}, context=None)
    assert asked["min_fraction"] == 0.5 and asked["max_cosine_similarity"] == 0.97


@pytest.mark.parametrize("path", [
    "/api/x/../quit",
    "/api/./diagnose_bam",
    "/api/../api/cancel_shutdown",
    "/api/%2e%2e/quit",
    "/api/quit#frag",
    "/api//quit",
    "/api\\quit",
    "/api/genes/%2F..%2Fquit",
])
def test_copilot_api_paths_the_server_could_rewrite_are_refused(path):
    allowed, reason = is_copilot_api_call_allowed("POST", path)
    assert allowed is False and reason


def test_copilot_api_blocks_file_routes_and_path_like_keys():
    for method, path in [("POST", "/api/dafc/load?cool_file=x.cool"), ("GET", "/api/files/list"),
                         ("DELETE", "/api/gtf"), ("POST", "/api/jupyter/motifs/load_file"),
                         ("GET", "/api/session/read?name=x"), ("POST", "/api/primer_config?blast_db_path=/db"),
                         ("POST", "/api/primer_config?fasta_path=/ref.fa")]:
        assert is_copilot_api_call_allowed(method, path)[0] is False, path
    assert is_copilot_api_call_allowed("POST", "/api/footprint/analyze", {"x": {"cool_file": "a"}})[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/footprint/analyze", {"session_dir": "a"})[0] is False
    # Plain routes and settings still pass.
    assert is_copilot_api_call_allowed("GET", "/api/jupyter/region") == (True, None)
    assert is_copilot_api_call_allowed("POST", "/api/primer_config", {"target_tm": 60}) == (True, None)
    assert is_copilot_api_call_allowed("GET", "/api/genes?chrom=chr2L&start=1.5&end=9") == (True, None)


def test_label_rule_keeps_its_gene_for_the_next_turn():
    action, _ = _normalize_action(_state(), {
        "type": "add_region_label_rule", "relative_to_gene": "eve", "offset_bp": 80, "width_bp": 80,
    }, context=None)
    assert action["relative_to_gene"] == "eve" and action["offset_bp"] == 80


def test_plan_json_followed_by_a_note_still_parses():
    text = '<think>ok</think>{"summary": "Go", "actions": []}\n\n[Reference: gene eve]'
    assert _extract_json_object(text) == {"summary": "Go", "actions": []}


def test_mlx_stream_waits_for_the_usage_chunk(monkeypatch):
    lines = [
        b'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":null}]}\n',
        b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        b'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n',
        b'data: [DONE]\n',
    ]

    class FakeResponse:
        def __enter__(self):
            return iter(lines)

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(nlc.urllib.request, "urlopen", lambda *a, **k: FakeResponse())
    chunks = list(nlc._mlx_chat_stream([{"role": "user", "content": "x"}], model="m", timeout=1))
    done = [c for c in chunks if c.get("done")]
    assert len(done) == 1 and done[0]["prompt_eval_count"] == 11 and done[0]["eval_count"] == 3
    assert "".join(c.get("message", {}).get("content", "") for c in chunks) == "{}"


def test_recommended_model_is_the_one_the_browser_starts():
    from services.copilot_lifecycle import _pick_model
    for ram in (8.0, 16.0, 32.0, 64.0):
        picked = _pick_model(ram_gb=ram)
        recommended = nlc.recommend_models_for_host(ram_gb=ram)["recommended_id"]
        assert recommended == (picked or {}).get("id"), ram
