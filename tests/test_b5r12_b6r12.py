"""B5/B6 round 12: empty read selections in renders, circular legacy sequence and
genes, all-collapsed panels, the co-accessibility size budget, per-run primer aborts."""
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


def _state():
    from models.domain import Dataset
    from state.browser_state import BrowserState
    state = BrowserState(None)
    state.datasets["A"] = Dataset("A", "A.bam", label="A")
    state.dataset_order.append("A")
    return state


# ── B5 #1: an empty read selection draws no reads ─────────────────────────────
def test_headless_empty_read_selection_is_a_filter_matching_nothing():
    from services.figure.spec import resolve_spec
    state = SimpleNamespace(
        datasets={"a": {"id": "a", "label": "a", "available_layers": {}}},
        dataset_order=["a"],
        live_figure_state={"viewport": {"chrom": "chr1", "start": 100, "end": 200}, "frontend_state": {}},
    )
    spec = resolve_spec(state, read_ids=[])
    assert spec.fe["filteredReadIds"] == {spec.panels[0].state_key: []}
    unfiltered = resolve_spec(state)
    assert not (unfiltered.fe.get("filteredReadIds") or {})


def test_headless_api_passes_an_empty_read_selection_through(monkeypatch):
    from models.requests import RenderRequest
    from services.figure import api
    seen = {}

    def fake_resolve(state, **kwargs):
        seen["read_ids"] = kwargs["read_ids"]
        raise ValueError("stop")

    monkeypatch.setattr(api, "resolve_spec", fake_resolve)
    api.render_request(RenderRequest(chrom="c", start=0, end=10, engine="headless", read_ids=[]), SimpleNamespace())
    assert seen["read_ids"] == []


def test_playwright_empty_read_selection_is_sent():
    from models.requests import RenderRequest
    from services.playwright_render import _state_for_request
    payload = _state_for_request(RenderRequest(chrom="c", start=0, end=10, engine="playwright", read_ids=[]), _state())
    assert payload["filteredReadIds"] == {"A": []}
    assert "filteredReadIds" not in _state_for_request(
        RenderRequest(chrom="c", start=0, end=10, engine="playwright"), _state())


# ── B5 #2: the legacy renderer wraps sequence and genes across a circular origin ──
class _Fasta:
    references = ["chrM"]

    def __init__(self, seq):
        self.seq = seq

    def get_reference_length(self, _ref):
        return len(self.seq)

    def fetch(self, _ref, start, end):
        return self.seq[start:end]


def test_legacy_view_sequence_wraps_a_circular_origin():
    from services.render_endpoint import _view_sequence
    seq = "ACGT" * 25  # 100 bp
    state = SimpleNamespace(fasta=_Fasta(seq), chrom_map={}, plasmid_sequences={},
                            circular_chroms={"chrM": {"size": 100}}, translate_chrom=lambda c: c)
    assert _view_sequence(state, "chrM", 95, 105) == (seq[95:] + seq[:5]).upper()
    linear = SimpleNamespace(fasta=_Fasta(seq), chrom_map={}, plasmid_sequences={},
                             circular_chroms={}, translate_chrom=lambda c: c)
    # Off a linear contig's end stays blank, so the bases keep their positions.
    assert _view_sequence(linear, "chrM", 95, 105) == seq[95:].upper() + " " * 5


def test_legacy_genes_across_a_circular_origin(monkeypatch):
    from models.requests import RenderRequest
    from services import render_endpoint
    drawn = {}

    def fake_genes(genes, width, start, end):
        drawn["genes"] = genes
        from PIL import Image
        return Image.new("RGB", (width, 10))

    monkeypatch.setattr("render.render_genes_track", fake_genes)
    transcripts = pd.DataFrame([
        {"chrom": "chrM", "start": 2, "end": 8, "strand": "+", "gene_name": "near_origin", "transcript_id": "t1"},
        {"chrom": "chrM", "start": 90, "end": 99, "strand": "+", "gene_name": "near_end", "transcript_id": "t2"},
    ])
    state = _state()
    state.gtf_data = {"transcripts": transcripts, "exons": pd.DataFrame(columns=["transcript_id", "start", "end"])}
    state.circular_chroms = {"chrM": {"size": 100}}
    req = RenderRequest(chrom="chrM", start=85, end=115, width=300, tracks=["genes"], engine="numpy")
    try:
        render_endpoint._render_sync(req, state)
    except Exception:
        pass
    names = {g["name"]: (g["start"], g["end"]) for g in drawn.get("genes", [])}
    assert names.get("near_end") == (90, 99)
    assert names.get("near_origin") == (102, 108)


# ── B5 #3: all dataset panels collapsed draws none ───────────────────────────
def test_all_collapsed_panels_do_not_come_back_as_defaults():
    from services.figure.spec import _merge_defaults, build_panels
    state = SimpleNamespace(datasets={"A": {"id": "A", "label": "A"}}, dataset_order=["A"])
    fe = _merge_defaults({"panels": [{"id": "p", "datasetId": "A", "collapsed": True}]})
    assert build_panels(state, fe) == []
    # An explicitly named dataset is still drawn.
    assert [p.dataset_id for p in build_panels(state, fe, dataset_ids=["A"])] == ["A"]


# ── B6 #1: co-accessibility refuses a matrix past its bin budget ─────────────
def test_coaccessibility_bin_budget():
    from fastapi import HTTPException
    from services.coaccessibility_endpoint import MAX_COACC_BINS, _coacc_scope

    class State:
        dataset_order = ["ds1"]
        datasets = {"ds1": object()}

        def translate_chrom(self, chrom):
            return chrom

        def get_dataset(self, dsid):
            return self.datasets.get(dsid)

    with pytest.raises(HTTPException) as err:
        _coacc_scope(State(), chrom="chr1", start=0, end=1_000_000, bin_size=1)
    assert err.value.status_code == 413
    auto = _coacc_scope(State(), chrom="chr1", start=0, end=100_000_000)
    assert 100_000_000 // auto.bin_size <= MAX_COACC_BINS
    fine = _coacc_scope(State(), chrom="chr1", start=0, end=10_000, bin_size=50)
    assert fine.bin_size == 50


# ── B6 #2: a new primer run doesn't undo another run's abort ─────────────────
def test_starting_a_primer_run_keeps_another_runs_abort():
    import services.primer_blast_runtime as rt

    started = threading.Event()
    go_on = threading.Event()
    outcome = {}

    def run_a():
        with rt.primer_design_run():
            started.set()
            go_on.wait(5)
            try:
                rt.check_abort()
                outcome["a"] = "continued"
            except rt.PrimerDesignAborted:
                outcome["a"] = "aborted"

    thread = threading.Thread(target=run_a)
    thread.start()
    started.wait(5)
    rt.request_primer_design_abort()
    with rt.primer_design_run():  # B starts before A reaches its next check
        rt.check_abort()          # and is not aborted itself
    go_on.set()
    thread.join(5)
    assert outcome["a"] == "aborted"


def test_design_context_reaches_worker_threads_and_does_not_linger():
    from concurrent.futures import ThreadPoolExecutor
    import services.primer_blast_runtime as rt

    with rt.primer_design_run():
        rt.request_primer_design_abort()
        with ThreadPoolExecutor(max_workers=1) as pool:
            fut = rt.run_in_design_context(pool, rt.check_abort)
            with pytest.raises(rt.PrimerDesignAborted):
                fut.result()
    # The run has ended: no aborted token is left in this thread.
    rt.check_abort()
    rt.request_primer_design_abort()
    rt.check_abort()
