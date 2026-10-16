"""H4 (UI audit): when "Min footprints" hides every read in view, the read
payloads say how many it hid, so the read track can say a filter is
responsible instead of looking empty (short-read DAF data: DddB amplicons
carry < 5 footprints per read, and the default filter hid all 4,873)."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason="demo BAM not present")

REGION = "chrom=chr19&start=47514000&end=47518000"


@pytest.fixture(params=["auto", "low"])
def demo(request, client, standalone_app):
    """The demo, on this machine's tier and in Low memory (which samples the view's
    reads: compact_all's total_overlapping is then the whole view's)."""
    import server as srv
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    # Both the server module's state and the runtime one come back as they
    # were (a session fixture like loaded_app relies on the runtime one being unset).
    previous, previous_runtime = srv.state, runtime_state._state
    fresh = BrowserState(None, None, None, None)
    if request.param != "auto":
        from services.performance import apply_mode
        apply_mode(fresh, request.param)
    srv.state = fresh
    set_browser_state(fresh)
    try:
        loaded = client.post("/api/demo/load").json()
        assert loaded["success"], loaded
        yield loaded["dataset_id"]
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)


def _compact(client, dataset_id, min_footprints, route="compact", extra=""):
    ids = "dataset_id" if route == "compact" else "dataset_ids"
    body = client.get(f"/api/reads/{route}?{REGION}&{ids}={dataset_id}&min_footprints={min_footprints}&max_reads=50"
                      f"{extra}").json()
    return body["datasets"][dataset_id] if route == "compact_all" else body


@pytest.mark.parametrize("route,extra", [("compact", ""), ("compact_all", ""),
                                         ("compact", "&include_cigar=true")])  # the direct load path
def test_an_emptying_min_footprints_filter_reports_what_it_hid(client, demo, route, extra):
    everything = _compact(client, demo, 0, route, extra)
    assert everything["total_overlapping"] > 0
    assert "hidden_by_min_footprints" not in everything

    hidden = _compact(client, demo, 100_000, route, extra)  # no read has that many
    assert hidden["total"] == 0 and hidden["reads"] == []
    assert hidden["hidden_by_min_footprints"] == everything["total_overlapping"]


@pytest.mark.parametrize("route", ["compact", "compact_all"])
def test_a_filter_that_keeps_reads_reports_nothing_extra(client, demo, route):
    kept = _compact(client, demo, 1, route)
    assert kept["total_overlapping"] > 0
    assert "hidden_by_min_footprints" not in kept


def test_the_recount_keeps_every_other_request_option(monkeypatch):
    """Only Min footprints changes in the recount, so quality gates and layer
    filters judge the same reads (a read the quality gate hides is not blamed
    on Min footprints)."""
    import services.read_endpoint as read_endpoint
    calls = []

    def fake(state, **kwargs):
        calls.append(kwargs)
        return {"total_overlapping": 0 if kwargs["min_footprints"] else 7, "reads": []}

    monkeypatch.setattr(read_endpoint, "_compact_reads_payload", fake)
    payload = read_endpoint.compact_reads_payload_for_request(
        SimpleNamespace(get_dataset=lambda _: None), chrom="chr1", start=0, end=10, dataset_id="d", min_footprints=5,
        include_layers=True, include_layer_qualities=True, include_methylation=True, strand="CT")
    assert payload["hidden_by_min_footprints"] == 7
    recount = calls[1]
    assert recount["min_footprints"] == 0
    for key in ("include_layers", "include_layer_qualities", "include_methylation", "strand"):
        assert recount[key] == calls[0][key], key


@pytest.mark.parametrize("route", ["compact", "compact_all"])
def test_no_read_in_scope_without_the_filter_is_not_blamed_on_it(client, demo, route):
    """Spanning only, a view no read spans: empty with or without Min footprints."""
    ids = "dataset_id" if route == "compact" else "dataset_ids"
    url = (f"/api/reads/{route}?chrom=chr19&start=47400000&end=47600000&{ids}={demo}"
           f"&spanning=true&min_footprints=5&max_reads=50")
    body = client.get(url).json()
    data = body["datasets"][demo] if route == "compact_all" else body
    assert data["reads"] == [] and "hidden_by_min_footprints" not in data


@pytest.mark.parametrize("route", ["compact", "compact_all"])
def test_a_spanning_view_counts_the_spanning_reads_it_hid(client, demo, route):
    ids = "dataset_id" if route == "compact" else "dataset_ids"

    def get(min_footprints):
        body = client.get(f"/api/reads/{route}?chrom=chr19&start=47516000&end=47516500&{ids}={demo}&spanning=true"
                          f"&min_footprints={min_footprints}&max_reads=50").json()
        return body["datasets"][demo] if route == "compact_all" else body
    everything = get(0)
    assert 0 < everything["total_spanning"] < everything["total_overlapping"]
    hidden = get(100_000)
    assert hidden["reads"] == [] and hidden["hidden_by_min_footprints"] == everything["total_spanning"]


def test_the_direct_path_counts_a_view_like_the_working_set_path(client, demo):
    """/api/reads/compact counts the same reads whichever path loads them, sampled
    (Low memory: the loaded reads, with the view's in working_sampling) or not."""
    keys = ("total_in_scope", "total_overlapping", "total_spanning", "working_count")
    plain = _compact(client, demo, 5, "compact")
    direct = _compact(client, demo, 5, "compact", "&include_cigar=true")
    assert {k: direct[k] for k in keys} == {k: plain[k] for k in keys}
    assert direct.get("working_sampling") == plain.get("working_sampling")
