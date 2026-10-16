"""B4 round 12: searched gene/motif names are pseudonymized in shared logs;
auto start falls back to a cached model."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))

from routers import natural_language as nl


def _share(tmp_path, monkeypatch, **fields):
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "usage_logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared_usage.jsonl")
    asyncio.run(nl.log_session(nl.SessionLogRequest(session_id="s1", started_at=1.0, share=True, **fields)))
    return (tmp_path / "shared_usage.jsonl").read_text()


def test_searched_gene_and_motif_names_never_appear_in_cleartext(tmp_path, monkeypatch):
    text = _share(tmp_path, monkeypatch, activity_log=[
        {"kind": "api", "method": "GET", "path": "/api/gene_search?query=TP53&chrom=chr17"},
        {"kind": "api", "method": "GET", "path": "/api/motifs/jaspar/search?q=Pax5%20like&limit=20"},
    ], command_history=[{"text": "find TP53"}])
    assert "TP53" not in text
    assert "Pax5" not in text
    assert "/api/gene_search?query=gene_" in text
    assert "limit=20" in text  # other parameters stay


def test_full_details_keep_the_search(tmp_path, monkeypatch):
    text = _share(tmp_path, monkeypatch, share_full_details=True, activity_log=[
        {"kind": "api", "method": "GET", "path": "/api/gene_search?query=TP53"},
    ])
    assert "query=TP53" in text


def test_auto_start_uses_a_cached_model_when_the_best_fit_is_not_cached(monkeypatch, capable_mac):
    import types
    from types import SimpleNamespace
    import services.copilot_lifecycle as cl

    registry = [
        {"id": "big", "label": "7B", "hf_repo": "o/big", "trained": True, "size_b": 7, "version": 5,
         "recommended_ram_gb": 16, "min_ram_gb": 12},
        {"id": "small", "label": "3B", "hf_repo": "o/small", "trained": True, "size_b": 3, "version": 5,
         "recommended_ram_gb": 8, "min_ram_gb": 6},
    ]
    monkeypatch.setitem(sys.modules, "mlx_lm", types.ModuleType("mlx_lm"))
    monkeypatch.setattr(cl, "_load_registry", lambda: registry)
    monkeypatch.setattr(cl, "_detect_ram_gb", lambda: 32.0)
    monkeypatch.setattr(cl, "_adopt_existing_server", lambda h, p, entry=None: False)
    monkeypatch.setattr(cl, "_ollama_reachable", lambda timeout=0.5: False)
    monkeypatch.setattr(cl, "_is_model_cached", lambda e: e["id"] == "small")
    spawned = []
    monkeypatch.setattr(cl, "_spawn_mlx",
                        lambda a, e, *, allow_download=True: spawned.append((e["id"], allow_download)) or True)

    assert cl.setup_copilot(SimpleNamespace(copilot="auto", copilot_port=8080, copilot_model=None))
    assert spawned == [("small", False)]

    # An explicit model, or --copilot mlx, keeps the chosen model (mlx may download it).
    spawned.clear()
    cl.setup_copilot(SimpleNamespace(copilot="mlx", copilot_port=8080, copilot_model=None))
    assert spawned == [("big", True)]
    spawned.clear()
    cl.setup_copilot(SimpleNamespace(copilot="auto", copilot_port=8080, copilot_model="big"))
    assert spawned == [("big", False)]
