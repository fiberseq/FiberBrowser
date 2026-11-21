"""3.1.0 audit fix: Differences read inspection applies the request's signal read filters to the source records it
fetches, before they join the cohort or count toward its 500-record cap."""
from __future__ import annotations

import json

from live_lift_fixtures import MAT, TARGET, make_record, write_bam
from services.lift import differences as diff
from services.signal_evidence import STATUS_CODES, signal_filters_for_request
from test_live_lift_differences import _all_reads_including_uncalled, evidence  # noqa: F401 - fixtures

HIDE = {"hideBackground": True}


def _detail(code):
    return dict(schema=5, signal_status=STATUS_CODES[code], signal_reason="test_evidence", p_signal=0.0,
                background_p=None, opportunities=None, structure=dict(status="unscored", score=None, p_value=None))


def _signal_bam(path, n_background):
    def records(h):
        out = [make_record(h, f"bg{i}", MAT, 0, "200M", tags=[("MD", "200"), ("bg", 1, "i"),
                                                             ("me", json.dumps(_detail(1)))])
               for i in range(n_background)]
        out.append(make_record(h, "kept", MAT, 0, "200M", tags=[("MD", "200"), ("bg", 0, "i"),
                                                              ("me", json.dumps(_detail(0)))]))
        return out
    return write_bam(path, records, header_extra={"CO": ["FIBERHMM-SIGNAL:v1:" + json.dumps(dict(tag_schema=5))]})


def test_inspection_leaves_out_records_the_signal_filters_hide(evidence):
    state, ds, tmp = evidence
    ds.paths = [_signal_bam(tmp / "signal.bam", 2)]
    assert sorted(r["id"] for r in diff.difference_reads(state, ds, TARGET, 1100, 1101)["rows"]) == ["bg0", "bg1", "kept"]
    with signal_filters_for_request(HIDE):
        result = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    assert [r["id"] for r in result["rows"]] == ["kept"]


def test_hidden_records_never_consume_the_inspection_cap(evidence):
    state, ds, tmp = evidence
    ds.paths = [_signal_bam(tmp / "deep_signal.bam", 500)]
    with signal_filters_for_request(HIDE):
        result = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    assert not result["capped"] and [r["id"] for r in result["rows"]] == ["kept"]
