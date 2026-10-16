"""Copilot module review (B4): shared usage logs, model lifecycle, dataset split, release guard."""
from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── shared usage logs ─────────────────────────────────────────────────────

def test_shared_log_hides_identifiers_in_free_text_and_never_exports_its_salt(tmp_path, monkeypatch):
    import routers.natural_language as nl
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared.jsonl")
    session_id = "sess-abc123"
    req = nl.SessionLogRequest(
        session_id=session_id,
        share=True,
        command_history=[{
            "text": "navigate to BRCA1 and color Patient_42 reads",
            "summary": "Go to BRCA1",
            "raw": "plan... see https://example.org/data?token=SECRET123 and /Users/me/run.bam",
            "actions": [{"type": "navigate_region", "gene": {"name": "BRCA1"}, "label": "BRCA1 TSS"}],
        }],
        snapshots=[{
            "state": {
                "relativeGene": {"name": "TP53", "start": 7661779},
                "genes": ["MYC"],
                "datasets": {"ds_patient": {"id": "ds_patient", "label": "Patient_42"}},
            },
        }],
    )
    asyncio.run(nl.log_session(req))
    line = (tmp_path / "shared.jsonl").read_text(encoding="utf-8")
    for secret in ("BRCA1", "TP53", "MYC", "Patient_42", "ds_patient", "SECRET123", "/Users/me", session_id):
        assert secret not in line, secret
    # The session id is not the salt: its hash of a gene does not appear.
    assert nl._stable_hash("BRCA1", session_id, "gene") not in line
    # Within the file, a name's pseudonym is consistent.
    shared = json.loads(line)
    action_gene = shared["command_history"][0]["actions"][0]["gene"]["name"]
    assert action_gene.startswith("gene_") and action_gene in shared["command_history"][0]["text"]


def test_full_detail_sharing_keeps_names_but_still_drops_urls(tmp_path, monkeypatch):
    import routers.natural_language as nl
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared.jsonl")
    req = nl.SessionLogRequest(session_id="s2", share=True, share_full_details=True, command_history=[{
        "text": "go to BRCA1, data at https://example.org/x?token=T0KEN",
        "url": "https://example.org/a.bw?sig=abc",
    }])
    asyncio.run(nl.log_session(req))
    line = (tmp_path / "shared.jsonl").read_text(encoding="utf-8")
    assert "BRCA1" in line and "T0KEN" not in line and "sig=abc" not in line


# ── model lifecycle ───────────────────────────────────────────────────────

def test_a_partly_downloaded_sharded_model_is_not_cached(tmp_path, monkeypatch):
    import services.copilot_lifecycle as cl
    monkeypatch.setattr(cl, "COPILOT_HOME", tmp_path)
    entry = {"id": "m", "hf_repo": "org/model-x"}
    target = tmp_path / "model-x"
    target.mkdir()
    (target / "config.json").write_text("{}")
    (target / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {
        "a": "model-00001-of-00002.safetensors", "b": "model-00002-of-00002.safetensors"}}))
    (target / "model-00001-of-00002.safetensors").write_bytes(b"x")
    assert cl._is_model_cached(entry) is False
    (target / "model-00002-of-00002.safetensors").write_bytes(b"x")
    assert cl._is_model_cached(entry) is True


def test_a_running_server_is_adopted_only_when_it_serves_the_requested_model(monkeypatch):
    import services.copilot_lifecycle as cl
    monkeypatch.setattr(cl, "_set_active_backend", lambda *a, **k: None)
    entry = {"id": "fiberbrowser-copilot-3b-v5", "hf_repo": "org/fiberbrowser-copilot-3b-v5"}
    monkeypatch.setattr(cl, "_served_model_ids", lambda url, timeout=0.8: ["/models/other-7b"])
    assert cl._adopt_existing_server("127.0.0.1", 8080, entry) is False
    assert cl._adopt_existing_server("127.0.0.1", 8080) is True
    monkeypatch.setattr(cl, "_served_model_ids", lambda url, timeout=0.8: ["/Users/x/.fiberhmm/copilot_models/fiberbrowser-copilot-3b-v5"])
    assert cl._adopt_existing_server("127.0.0.1", 8080, entry) is True
    monkeypatch.setattr(cl, "_served_model_ids", lambda url, timeout=0.8: None)
    assert cl._adopt_existing_server("127.0.0.1", 8080) is False


def test_starting_a_server_refuses_a_port_someone_else_serves(tmp_path, monkeypatch):
    import services.copilot_lifecycle as cl
    import sys
    import types
    monkeypatch.setitem(sys.modules, "mlx_lm", types.ModuleType("mlx_lm"))
    monkeypatch.setattr(cl, "_http_ok", lambda url, timeout=1.0: True)
    spawned = []
    monkeypatch.setattr(cl.subprocess, "Popen", lambda *a, **k: spawned.append(a))
    assert cl._start_mlx_server(tmp_path, host="127.0.0.1", port=8080, log_path=tmp_path / "l.log") is None
    assert spawned == []


# ── dataset split ─────────────────────────────────────────────────────────

def test_phrasing_variants_of_a_record_stay_on_one_side_of_the_split():
    prep = _load_script("prepare_copilot_dataset")
    records = [{"messages": [], "metadata": {"id": f"r{i}", "category": "c"}}
               for i in range(12) for _variant in range(3)]
    train, valid = prep._stratified_split(records, 0.1, seed=7)
    train_ids = {r["metadata"]["id"] for r in train}
    valid_ids = {r["metadata"]["id"] for r in valid}
    assert valid_ids and not (train_ids & valid_ids)
    assert len(train) + len(valid) == len(records)


# ── release guard ─────────────────────────────────────────────────────────

def test_release_does_not_retire_versions_while_the_new_ones_are_unpublished():
    rel = _load_script("release_copilot")
    reg = {"models": [
        {"id": "fiberbrowser-copilot-1.5b-v6", "version": 6, "tier": "tiny", "hf_repo": "org/a"},
        {"id": "fiberbrowser-copilot-1.5b-v6-q4", "version": 6, "tier": "tiny"},
        {"id": "fiberbrowser-copilot-1.5b-v5", "version": 5, "tier": "tiny", "hf_repo": "org/old"},
    ]}
    assert rel._unpublished(reg, 6, ["tiny"]) == ["fiberbrowser-copilot-1.5b-v6-q4"]
    assert rel._unpublished(reg, 6, ["light"]) == []


# ── round 2 ───────────────────────────────────────────────────────────────

def test_reference_loading_and_grouped_adds_are_blocked_for_copilot():
    from services.natural_language_commands import is_copilot_api_call_allowed
    assert is_copilot_api_call_allowed("POST", "/api/reference_pairs", [{"fasta": "/etc/shadow"}])[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/reference_pairs")[0] is False
    assert is_copilot_api_call_allowed("GET", "/api/reference_pairs") == (True, None)
    assert is_copilot_api_call_allowed("POST", "/api/datasets/add_grouped")[0] is False
    assert is_copilot_api_call_allowed("POST", "/api/footprint/analyze", {"annotation": "/x.gtf"})[0] is False


def test_paths_in_quotes_brackets_and_key_values_are_redacted():
    import routers.natural_language as nl
    for text in ('open "/Users/alice/private/run.bam" please', "load('/home/lab/p42.bam')",
                 "path=/Users/alice/run.bam", '{"file":"/tmp/x/secret.bed"}', "(C:\\\\data\\\\p.bam)"):
        out = nl._scrub_text(text, None, None)
        for leak in ("alice", "/home/lab", "secret.bed", "p42", "C:\\\\data"):
            assert leak not in out, (text, out)


def test_snapshot_fields_by_their_frontend_names_are_anonymized(tmp_path, monkeypatch):
    import routers.natural_language as nl
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared.jsonl")
    req = nl.SessionLogRequest(
        session_id="s3", share=True,
        snapshots=[{"state": {"sessionName": "Patient_42_trial", "selectedDatasets": ["patient_tumor_sample_42"]}}],
        command_history=[{
            "text": "load the CTCF and REST motifs",
            "actions": [{"type": "load_jaspar_motifs", "names": ["CTCF", "REST"]}],
            "debug": {"rawContent": '{"actions":[{"type":"load_jaspar_motifs","names":["CTCF"],"path":"/Users/me/x"}]}'},
        }],
    )
    asyncio.run(nl.log_session(req))
    line = (tmp_path / "shared.jsonl").read_text(encoding="utf-8")
    for leak in ("Patient_42_trial", "patient_tumor_sample_42", "CTCF", "REST", "/Users/me"):
        assert leak not in line, leak


def test_activity_changes_are_anonymized_by_their_field_and_relative_tss_is_bucketed(tmp_path, monkeypatch):
    import routers.natural_language as nl
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared.jsonl")
    req = nl.SessionLogRequest(
        session_id="s4", share=True,
        snapshots=[{"state": {"relativeTSS": 7661779}}],
        activity_log=[
            {"kind": "ui", "label": "change:sessionName", "details": {"value": "Patient_42_trial"}},
            {"kind": "ui", "label": "change:relativeTSS", "details": {"value": 7661779}},
            {"kind": "ui", "label": "change:relativeGene", "details": {"value": {"name": "TP53", "start": 7661779}}},
            {"kind": "ui", "label": "change:spanningOnly", "details": {"value": True}},
        ],
    )
    asyncio.run(nl.log_session(req))
    shared = json.loads((tmp_path / "shared.jsonl").read_text(encoding="utf-8"))
    line = json.dumps(shared)
    for leak in ("Patient_42_trial", "7661779", "TP53"):
        assert leak not in line, leak
    assert shared["snapshots"][0]["state"]["relativeTSS"] == 7661000
    values = [entry["details"]["value"] for entry in shared["activity_log"]]
    assert values[1] == 7661000 and values[3] is True


def test_a_server_listing_no_models_is_not_adopted_for_a_requested_model(monkeypatch):
    import services.copilot_lifecycle as cl
    monkeypatch.setattr(cl, "_set_active_backend", lambda *a, **k: None)
    monkeypatch.setattr(cl, "_served_model_ids", lambda url, timeout=0.8: [])
    assert cl._adopt_existing_server("127.0.0.1", 8080, {"id": "m", "hf_repo": "org/m"}) is False


def test_a_server_that_never_becomes_ready_is_stopped_not_reported_ready(tmp_path, monkeypatch):
    import sys
    import types
    import services.copilot_lifecycle as cl
    monkeypatch.setitem(sys.modules, "mlx_lm", types.ModuleType("mlx_lm"))
    monkeypatch.setattr(cl, "_http_ok", lambda url, timeout=1.0: False)

    class Proc:
        pid = 999999
        returncode = None
        killed = False

        def poll(self):
            return None

        def wait(self, timeout=None):
            return 0

    proc = Proc()
    monkeypatch.setattr(cl.subprocess, "Popen", lambda *a, **k: proc)
    clock = iter([0.0, 0.0, 100.0, 100.0, 100.0])
    monkeypatch.setattr(cl.time, "monotonic", lambda: next(clock, 100.0))
    monkeypatch.setattr(cl.time, "sleep", lambda s: None)
    killed = []
    monkeypatch.setattr(cl.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(cl.os, "killpg", lambda pgid, sig: killed.append(sig))
    assert cl._start_mlx_server(tmp_path, host="127.0.0.1", port=8080, log_path=tmp_path / "l.log") is None
    assert killed


def test_setup_reports_failure_when_no_backend_starts(monkeypatch):
    import types
    import services.copilot_lifecycle as cl
    import routers.natural_language as nl
    monkeypatch.setattr(cl, "setup_copilot", lambda args: False)
    res = asyncio.run(nl.setup_copilot_endpoint(nl.CopilotSetupRequest(model_id=None)))
    assert res["success"] is False
    monkeypatch.setattr(cl, "_adopt_existing_server", lambda h, p, entry=None: False)
    monkeypatch.setattr(cl, "_ollama_reachable", lambda timeout=0.5: False)
    monkeypatch.setattr(cl, "_pick_model", lambda override_id=None, ram_gb=None: None)
    assert cl.setup_copilot(types.SimpleNamespace(copilot="auto", copilot_model=None, copilot_port=8080)) is False


def test_starting_a_download_does_not_wait_on_the_hub(monkeypatch, capable_mac):
    import services.copilot_lifecycle as cl
    called = []
    monkeypatch.setattr(cl, "_remote_total_bytes", lambda entry: called.append(1) or 1)
    monkeypatch.setattr(cl, "_pick_model", lambda override_id=None, ram_gb=None: {"id": "m", "size_b": 1.0})
    started = []
    monkeypatch.setattr(cl.threading, "Thread", lambda target, args, daemon: type("T", (), {"start": lambda self: started.append(1)})())
    monkeypatch.setitem(cl._download_status, "state", "idle")
    status = cl.start_background_download(model_id="m")
    assert started and not called and status["bytes_total"] > 0


def test_dataset_scripts_accept_output_paths_outside_the_repo(tmp_path):
    build = _load_script("build_copilot_dataset")
    prep = _load_script("prepare_copilot_dataset")
    assert build._display_path(tmp_path / "seed.jsonl") == (tmp_path / "seed.jsonl").resolve()
    assert str(prep._display_path(REPO / "data" / "x")) == str(Path("data") / "x")


def test_fractional_accessibility_threshold_means_a_share():
    from types import SimpleNamespace
    from services.natural_language_commands import _normalize_action
    state = SimpleNamespace(datasets={}, dataset_order=[], gtf_data=None, chroms=[])
    for raw, want in ((0.6, 60), ("0.6", 60), (60, 60), ("60%", 60)):
        action, _ = _normalize_action(state, {"type": "set_accessibility_threshold", "value": raw}, context=None)
        assert action and action["value"] == want, raw
