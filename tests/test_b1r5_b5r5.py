"""Round-5 review fixes: data access (B1) and sessions/rendering (B5)."""
import sys
import threading
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


# ── B1 #1: BigBed fetches are clamped to the contig ─────────────────────────
class _BoundedBigBed:
    """pyBigWig-like: entries() past either contig end raises, as pyBigWig does."""

    def __init__(self, size, rows):
        self.size = size
        self.rows = rows
        self.calls = []

    def chroms(self):
        return {"chr1": self.size}

    def entries(self, chrom, start, end):
        self.calls.append((start, end))
        if start < 0 or end > self.size:
            raise RuntimeError("Invalid interval bounds!")
        return [r for r in self.rows if r[0] < end and r[1] > start] or None


def test_bigbed_fetch_past_the_contig_end_keeps_its_reads():
    from services.compact_read_loader import bigbed_entries_in_bounds

    row = (860, 940, "r1\t0\t+\t860\t940\t0,0,0\t1\t80\t0")
    bw = _BoundedBigBed(1000, [row])
    assert bigbed_entries_in_bounds(bw, "chr1", 400, 1400) == [row]
    assert bw.calls == [(400, 1000)]
    assert bigbed_entries_in_bounds(bw, "chr1", -50, 100) is None
    assert bw.calls[-1] == (0, 100)
    # Entirely past the end: nothing to ask for.
    assert bigbed_entries_in_bounds(bw, "chr1", 1200, 1400) is None
    assert len(bw.calls) == 2


@pytest.mark.parametrize("with_companion", [False, True])
def test_compact_loader_keeps_reads_when_view_exceeds_contig(with_companion):
    from services.compact_read_loader import build_compact_reads_from_bigbed

    row = (860, 940, "r1\t0\t+\t860\t940\t0,0,0\t1\t80\t0")
    bw = _BoundedBigBed(1000, [row])
    paths = ["https://example.test/sample_footprints.bb"]
    if with_companion:
        paths.append("https://example.test/sample_tf.bb")
    reads = build_compact_reads_from_bigbed(
        paths, "chr1", 400, 1400, spanning_only=False,
        bigbed_handle_getter=lambda _: bw,
        overlay_type_detector=lambda path: "tf" if path.endswith("_tf.bb") else "footprint",
        duplicate_field_detector=lambda _: False,
        swapped_column_detector=lambda _: False,
        format_cache={},
    )

    assert len(reads) == 1
    assert reads[0]["id"] == "r1"
    assert reads[0]["intervals"] == [[460, 540, 80]]
    assert bw.calls and all(0 <= start < end <= 1000 for start, end in bw.calls)


def test_legacy_loader_uses_the_bounded_fetch():
    import inspect

    import services.bigbed_read_loader as bbl
    assert inspect.getsource(bbl).count("bigbed_entries_in_bounds(") == 2


# ── B1 #2: a merge mixing local and remote BigBeds keeps the remote ones ────
def test_mixed_local_remote_bigbed_merge_keeps_remote_sources(tmp_path, monkeypatch):
    import services.dataset_registration as dr

    a = tmp_path / "a_footprints.bb"
    b = tmp_path / "b_footprints.bb"
    for p in (a, b):
        p.write_bytes(b"x")
    remote = "https://example.org/data/c_footprints.bb"
    monkeypatch.setattr(dr, "detect_overlay_type", lambda path: "footprint")
    monkeypatch.setattr(dr, "is_annotation_bigbed", lambda path: False)
    monkeypatch.setattr(dr, "is_derived_layer_bigbed", lambda path: False)
    monkeypatch.setattr(dr, "_bigbed_has_circular_groups", lambda files: False)
    monkeypatch.setattr(dr, "discover_annotation_bigbeds", lambda *a, **k: None)
    monkeypatch.setattr(dr, "discover_derived_layer_files", lambda *a, **k: None)
    assert dr._remote_bigbed_urls([str(a), remote, "https://x.org/y.bam"]) == [remote]
    assert dr._remote_bigbed_urls([str(a), remote + "?token=1"]) == [remote + "?token=1"]
    assert dr._remote_bigbed_urls(remote) == []

    from models.domain import Dataset

    dataset = Dataset("m", [str(a), str(b), remote], label="merged")
    state = SimpleNamespace(annotation_state=SimpleNamespace(files={}))
    dr.configure_bigbed_dataset_layers(state, "m", dataset, str(a))
    assert sorted(dataset.paths) == sorted([str(a), str(b), remote])


# ── B1 #3: a reused dataset id never serves the old file's metaprofile ──────
def test_invalidate_drops_the_datasets_metaprofiles():
    from services.dataset_registration import invalidate_dataset_caches

    state = SimpleNamespace(
        _broad_cache={}, _working_set_cache={}, _methylation_cache={},
        _meta_profile_cache=OrderedDict({
            ("sample", "chr1", 0, 100, None): ([1], [2], 0.0),
            ("other", "chr1", 0, 100, None): ([3], [4], 0.0),
        }),
    )
    invalidate_dataset_caches(state, "sample")
    assert list(state._meta_profile_cache) == [("other", "chr1", 0, 100, None)]


# ── B5 #1: session import cancels runs and detaches the active consensus ────
def test_session_import_detaches_consensus(tmp_path):
    import services.consensus_workflow as cw

    state = SimpleNamespace()
    jobs, _ = cw._session(state)
    cancel = threading.Event()
    jobs["j"] = dict(job_id="j", status="running", _cancel=cancel)
    state.consensus_workflow_active = "j"
    cache = tmp_path / "fit-cache"
    cache.mkdir()
    state.consensus_family_cache_dir = str(cache)
    cw.dispose_session(state, keep_fit_cache=True)
    assert cancel.is_set() and jobs == {} and state.consensus_workflow_active is None
    assert state.consensus_family_cache_dir == str(cache) and cache.exists()


def test_session_import_calls_consensus_disposal():
    import inspect

    import services.sessions_endpoint as se

    src = inspect.getsource(se)
    # Runs the session itself carries are kept (keep_job_ids); every other run is disposed, before the datasets go.
    assert "dispose_consensus(state, keep_fit_cache=True, keep_job_ids=session_run_ids(session))" in src
    assert src.index("dispose_consensus(state") < src.index("state.datasets.clear()")


# ── B5 #2: an empty one-strand panel doesn't scan the other strand ──────────
def test_empty_strand_panel_scans_nothing(monkeypatch):
    from dataclasses import replace

    import services.clustering_endpoint as ce
    import services.figure.tracks.reads as reads_mod
    from services.figure.tracks.peaks import _scan_rule
    from test_figure_tracks import _ctx

    ctx = _ctx({})
    ct = replace(ctx.panel, strand="CT")
    ctx = replace(ctx, spec=replace(ctx.spec, panels=[ct]), panel=ct)
    monkeypatch.setattr(reads_mod, "display_read_ids", lambda c: [])
    called = []
    monkeypatch.setattr(ce, "run_scan_peaks_endpoint", lambda **kw: called.append(kw) or {"peaks": [{"start": 1, "end": 2}]})
    assert _scan_rule(ctx, {"id": "default-accessibility", "source": "accessibility"}) == []
    assert called == []


def test_empty_unstranded_panel_still_scans(monkeypatch):
    import services.clustering_endpoint as ce
    import services.figure.tracks.reads as reads_mod
    from services.figure.tracks.peaks import _scan_rule
    from test_figure_tracks import _ctx

    ctx = _ctx({})
    monkeypatch.setattr(reads_mod, "display_read_ids", lambda c: [])
    called = []
    monkeypatch.setattr(ce, "run_scan_peaks_endpoint", lambda **kw: called.append(kw) or {"peaks": []})
    _scan_rule(ctx, {"id": "default-accessibility", "source": "accessibility"})
    assert len(called) == 1


# ── B5 #3: Playwright rendering refuses a dataset that isn't loaded ─────────
def test_playwright_render_rejects_missing_dataset():
    from models.domain import Dataset
    from services.playwright_render import UnknownRenderDatasets, _state_for_request
    from state.browser_state import BrowserState

    state = BrowserState(None)
    state.datasets["A"] = Dataset("A", "A.bam", label="A")
    state.dataset_order.append("A")
    req = SimpleNamespace(dataset_ids=None, dataset_id="missing", tracks=["axis", "reads"])
    with pytest.raises(UnknownRenderDatasets):
        _state_for_request(req, state)


def test_playwright_render_returns_404_for_missing_dataset():
    import json

    from models.domain import Dataset
    from services.playwright_render import render_with_playwright
    from state.browser_state import BrowserState

    state = BrowserState(None)
    state.datasets["A"] = Dataset("A", "A.bam", label="A")
    state.dataset_order.append("A")
    req = SimpleNamespace(dataset_ids=None, dataset_id="missing", tracks=["axis", "reads"],
                          width=800, dpi=96, timeout_ms=None, show_nudges=False, tf_overlay=None)
    res = render_with_playwright(req, state)
    assert res.status_code == 404
    assert "missing" in json.loads(res.body)["error"]


def test_viewport_bigbed_queries_are_contig_bounded():
    import inspect
    from services import (annotation_bigbed, consensus_evidence, dafc_reads,
                          orthogonal_tracks, overlays_endpoint)
    for mod in (annotation_bigbed, consensus_evidence, dafc_reads, orthogonal_tracks, overlays_endpoint):
        assert "bigbed_entries_in_bounds(" in inspect.getsource(mod), mod.__name__

    class BB:
        def chroms(self):
            return {"chr1": 1000}

        def entries(self, chrom, start, end):
            if end > 1000:
                raise RuntimeError("Invalid interval bounds!")
            return [(900, 950, "r")]

    rows = dafc_reads.query_bigbed_for_dafc(BB(), "chr1", 850, 1200)
    assert len(rows) == 1
