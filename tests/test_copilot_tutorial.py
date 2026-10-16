"""Teach-only Copilot: UI anchor catalog, tutorial actions, gating and the plan filter."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import services.natural_language_commands as nlc  # noqa: E402
from services import copilot_tutorial as ct  # noqa: E402
from test_natural_language_commands import (  # noqa: E402
    _collect_events, _fake_app, _state, _stream_chunks,
)

# The ids the troubleshooting diagnostics point at (copilotDiagnostics.ts).
DIAGNOSTIC_FIX_ANCHORS = (
    "search-bar genome-selector load-dataset load-gtf load-fasta zoom-out read-window-setting clear-filter "
    "cluster-focus-bar panel-expand layout-rows quality-filters spanning-toggle strand-chip layer-toggles "
    "scan-peaks-button cluster-button"
).split()


def _plan(actions):
    return nlc._validate_plan(_state(), {"summary": "t", "actions": actions}, context={"chrom": "2R", "start": 1, "end": 2})


def test_anchor_catalog_is_complete_and_consistent():
    anchors = ct.load_anchor_catalog()
    assert 80 <= len(anchors) <= 320
    missing = [a for a in DIAGNOSTIC_FIX_ANCHORS if a not in anchors]
    assert not missing
    panel_types = set(ct.load_milestone_catalog()["panel_types"])
    for anchor in anchors.values():
        assert anchor["label"] and anchor["selector"] and anchor["where"] and anchor["description"]
        reveal = anchor["reveal"]
        assert set(reveal) <= {"panel", "tab", "sidebar", "subsection", "expand"}, anchor["id"]
        if "panel" in reveal:
            assert reveal["panel"] in panel_types, anchor["id"]
        if "sidebar" in reveal:
            assert reveal["sidebar"] in ct.SIDEBAR_SECTIONS, anchor["id"]
        if "expand" in reveal:
            # The toggle is itself a catalog anchor.
            assert reveal["expand"] in anchors, anchor["id"]
        if "needs" in anchor:
            assert ct.valid_condition(anchor["needs"]), anchor["id"]
    for group in ("reads", "layers", "peaks", "cluster", "sort", "filter", "quality"):
        assert f"{group}-controls-expand" in anchors


def test_milestone_and_condition_ids():
    assert ct.valid_milestone("clustered")
    assert ct.valid_milestone("panel_opened:footprint-analysis")
    assert not ct.valid_milestone("panel_opened:nope")
    assert not ct.valid_milestone("clustered:extra")
    assert not ct.valid_milestone("teleported")
    assert ct.valid_condition("has_saved_footprints")
    assert ct.valid_condition("panel_open:cluster-detail")
    assert not ct.valid_condition("clustered")  # a milestone, not a condition


def test_explain_keeps_known_anchors_and_drops_unknown_ones():
    plan = _plan([
        {"type": "explain", "text": "This runs clustering.", "anchor": "cluster-button"},
        {"type": "explain", "text": "Kept without a pointer.", "anchor": "made-up-button"},
    ])
    assert plan["actions"][0]["anchor"] == "cluster-button"
    assert plan["actions"][1]["anchor"] is None
    assert plan["actions"][1]["text"] == "Kept without a pointer."
    assert any("Unknown UI anchor 'made-up-button'" in w for w in plan["warnings"])


def test_try_it_validates_its_milestone_and_timeout():
    plan = _plan([
        {"type": "try_it", "text": "Click Cluster.", "anchor": "cluster-button", "wait_for": "clustered", "timeout_s": 5000},
        {"type": "try_it", "text": "Do a thing.", "anchor": "cluster-button", "wait_for": "teleported"},
    ])
    first, second = plan["actions"]
    assert first == {**first, "type": "try_it", "wait_for": "clustered", "timeout_s": 900}
    assert second["type"] == "explain"  # unknown milestone: a plain explanation
    assert any("Unknown milestone 'teleported'" in w for w in plan["warnings"])


def test_view_actions_normalize():
    plan = _plan([
        {"type": "open_sidebar", "section": "genome", "subsection": "genome.reference"},
        {"type": "open_sidebar", "section": "genome", "subsection": "nowhere"},
        {"type": "close_panel", "panel_type": "cluster-detail"},
        {"type": "zoom_view", "direction": "out", "steps": 40},
        {"type": "pan_view", "direction": "left"},
        {"type": "zoom", "direction": "in"},
    ])
    types = [a["type"] for a in plan["actions"]]
    assert types == ["open_sidebar", "open_sidebar", "close_panel", "zoom_view", "pan_view", "zoom_view"]
    assert plan["actions"][1]["subsection"] is None
    assert plan["actions"][3]["steps"] == 10


def test_gating_is_validated_on_tutorial_steps_only():
    plan = _plan([
        {"type": "try_it", "text": "Cmd+click a footprint.", "anchor": "reads-track",
         "wait_for": "footprint_selected", "skip_if": "has_selected_footprint"},
        {"type": "explain", "text": "x", "requires": "has_nothing"},
        {"type": "scan_peaks", "skip_if": "has_peaks"},
    ])
    assert plan["actions"][0]["skip_if"] == "has_selected_footprint"
    assert "requires" not in plan["actions"][1]
    assert any("Unknown condition 'has_nothing'" in w for w in plan["warnings"])
    assert "skip_if" not in plan["actions"][2]  # not a tutorial step


def test_teach_only_plan_drops_operations_and_says_where():
    plan = ct.teach_only_plan(_plan([
        {"type": "explain", "text": "Scan finds peaks.", "anchor": "scan-peaks-button"},
        {"type": "scan_peaks"},
        {"type": "navigate_gene", "gene": "eve"},
    ]))
    assert [a["type"] for a in plan["actions"]] == ["explain", "navigate_region"]
    assert any("Copilot teaches; do 'scan_peaks' from Scan" in w for w in plan["warnings"])


def test_stream_plan_is_teach_only(monkeypatch):
    # Pinned to the (stubbed) Ollama backend: the module autodetects MLX when an mlx_lm.server is up on
    # :8080 (the owner's Copilot), and this test then asked the real model ("open_panel", or no plan).
    monkeypatch.setattr(nlc, "COPILOT_BACKEND", "ollama")
    monkeypatch.setattr(nlc, "list_ollama_models", lambda timeout=1.0: ["qwen2.5:7b"])
    monkeypatch.setattr(nlc, "resolve_ollama_model", lambda requested, available=None: ("qwen2.5:7b", None))
    monkeypatch.setattr(
        nlc, "_ollama_chat_stream",
        lambda messages, *, model, timeout: iter(_stream_chunks(
            '<think>teach</think>{"summary":"how to cluster","actions":['
            '{"type":"explain","text":"Cluster groups reads.","anchor":"cluster-button"},'
            '{"type":"cluster_selected_peaks"}]}'
        )),
    )
    events = _collect_events(nlc.stream_natural_language_command(
        _state(), "how do I cluster?", {"chrom": "2R", "start": 1, "end": 2}, app=_fake_app(), model="qwen2.5",
    ))
    plan = next(e for e in events if e["event"] == "plan")
    assert [a["type"] for a in plan["actions"]] == ["explain"]
    assert any("Copilot teaches" in w for w in plan["warnings"])


def test_teach_prompt_lists_catalogs_not_routes():
    prompt = nlc.build_copilot_system_prompt(_fake_app([("/api/jupyter/region", ("GET",), "Get region.")]))
    assert prompt == ct.build_teach_system_prompt()  # stable across requests (KV cache)
    assert "/api/jupyter/region" not in prompt
    # The compact catalog (ids only) is what the tiers are trained and served with.
    for needle in ("cluster-controls-expand", "genome-selector", "try_it", "skip_if",
                   "clustered", "has_saved_footprints", "panel_opened:<panel>",
                   "cluster-details-button[needs has_clusters]"):
        assert needle in prompt
    full = ct.build_teach_system_prompt(compact=False)
    for needle in ("cluster-controls-expand — ", "genome-selector — ", "clustered — ", "has_saved_footprints — "):
        assert needle in full
    assert len(prompt) < len(full)


def test_named_gene_out_of_view_gets_navigation():
    from data.copilot_dataset.mock_state import make_mock_state
    state = make_mock_state()
    walk = {"actions": [{"type": "explain", "anchor": "cluster-button", "text": "Click Cluster."}]}
    far = {"chrom": "2L", "start": 14000, "end": 20000}
    out = nlc.ensure_named_gene_navigation(state, "how do I cluster reads at eve?", far, walk)
    assert out["actions"][0] == {"type": "navigate_gene", "gene": "eve", "padding_bp": 5000}
    # Already in view, not a place ("run"), or the plan already navigates: unchanged.
    at_eve = {"chrom": "2R", "start": 9970000, "end": 9980000}
    assert nlc.ensure_named_gene_navigation(state, "how do I cluster reads at eve?", at_eve, walk) == walk
    assert nlc.ensure_named_gene_navigation(state, "how do I run clustering?", far, walk) == walk
    nav = {"actions": [{"type": "navigate_region", "chrom": "2R", "start": 1, "end": 2}]}
    assert nlc.ensure_named_gene_navigation(state, "zoom to eve", far, nav) == nav
