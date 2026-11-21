"""3.1.0 audit fix: the graph panel's composed-record cache and its analysis row cache follow the request's signal
read filters (hide background, ...), so turning a filter on after a load drops the reads it hides."""
from __future__ import annotations

import json

import pytest

from live_lift_fixtures import MAT, make_record, write_bam
from services.signal_evidence import STATUS_CODES, signal_filters_for_request
from test_graph_panel_reads import _add_lifted, _reads, _u32, env  # noqa: F401 - the env fixture

HIDE = {"hideBackground": True}


def _detail(code):
    return dict(schema=5, signal_status=STATUS_CODES[code], signal_reason="test_evidence", p_signal=0.0,
                background_p=None, opportunities=None, structure=dict(status="unscored", score=None, p_value=None))


def _signal_bam(env):
    def records(h):
        out = []
        for name, pos, code in (("background", 1000, 1), ("detectable", 1500, 0)):
            out.append(make_record(h, name, MAT, pos, "1000M", tags=[
                ("ns", _u32([100, 500])), ("nl", _u32([200, 200])), ("bg", code, "i"), ("me", json.dumps(_detail(code)))]))
        return out
    return write_bam(env.tmp / "signal.bam", records,
                     header_extra={"CO": ["FIBERHMM-SIGNAL:v1:" + json.dumps(dict(tag_schema=5))]})


def test_graph_reads_follow_the_signal_filters(env):
    did = _add_lifted(env, paths=[_signal_bam(env)], dataset_id="signal")
    paths = [{"binding": "mat", "windows": [{"start": 0, "end": 3000}]}]
    shown = sorted(r["q"] for r in _reads(env, [did], paths).json()["reads"])
    assert shown == ["background", "detectable"]
    body = {"registration_id": "g1", "revisions": env.reg.revisions, "request_id": "r2", "panel_id": "p",
            "generation": 2, "datasets": [{"dataset_id": did}], "paths": paths}
    hidden = env.client.post("/api/graph/reads?signal_filters=" + json.dumps(HIDE), json=body).json()
    assert sorted(r["q"] for r in hidden["reads"]) == ["detectable"]
    # and back: the unfiltered request still shows both
    assert sorted(r["q"] for r in _reads(env, [did], paths).json()["reads"]) == ["background", "detectable"]


def test_graph_analysis_rows_follow_the_signal_filters(env):
    from services.graph_panel import analysis
    did = _add_lifted(env, paths=[_signal_bam(env)], dataset_id="signal")
    analysis.clear_caches()
    source = analysis.GraphSource(did, "mat", MAT)

    def names():
        rows, _desc = analysis.graph_window_rows(env.state, source, 0, 3000)
        return sorted({(r.get("signal") or {}).get("status") for r in rows})
    assert names() == ["background", "detectable"]
    with signal_filters_for_request(HIDE):
        assert names() == ["detectable"]
    assert names() == ["background", "detectable"]


def test_observation_snapshot_follows_the_signal_filters(env):
    from services.graph_panel import analysis
    did = _add_lifted(env, paths=[_signal_bam(env)], dataset_id="signal")
    spec = {"observations": [{"id": "o1", "dataset_id": did}]}
    plain = analysis.observation_snapshot(env.state, spec)
    with signal_filters_for_request(HIDE):
        filtered = analysis.observation_snapshot(env.state, spec)
    assert plain != filtered
    with signal_filters_for_request({}):
        assert analysis.observation_snapshot(env.state, spec) == plain   # no filter on: the digest is unchanged
