"""Record keys (DESIGN_GRAPH_PRIMARY §3.1, graph primary G0/G3): derived from any row's own identity, so a graph row
and the linear rows of the same record match across views, on the client and in every backend matcher."""
import json
from pathlib import Path
from types import SimpleNamespace

from services.lift.cohort import _encode_identity, raw_qnames, record_key, record_qname
from services.read_selection import read_id_keys, read_matches_id_filter

FIXTURE = Path(__file__).resolve().parents[1] / "browser/frontend/src/features/graphPanel/fixtures/recordKeys.json"


def test_the_shared_fixture_matches_the_python_derivation():
    cases = json.loads(FIXTURE.read_text())["cases"]
    assert len(cases) >= 10
    for case in cases:
        assert record_key(case["id"]) == case["record_key"], case["note"]


def _row(record="abc:0", row_index=0, placement="primary", qname="m1/ccs", group="lib#0"):
    aid = _encode_identity([f"{group}|{qname}", qname, record, row_index, placement])
    return {"id": qname, "analysis_id": aid, "live_lift": {"molecule": f"{group}|{qname}", "record": record}}


def test_a_record_key_names_every_row_of_its_record_and_no_other():
    graph = _row(row_index=0)
    split = _row(row_index=1, placement="alt:2")
    other = _row(record="def:0")
    key = record_key(graph["analysis_id"])
    assert key in read_id_keys(split)
    assert read_matches_id_filter(split, {key})
    assert not read_matches_id_filter(other, {key})
    # Exact identities stay exact: a split row's own analysis_id never names its sibling row.
    assert not read_matches_id_filter(graph, {split["analysis_id"]})


def test_folded_rows_answer_to_each_members_record_key():
    supp = _row(record="sup:1")
    folded = {"id": "m1/ccs", "analysis_id": _row()["analysis_id"],
              "live_lift": {"folded": {"analysis_ids": [_row()["analysis_id"], supp["analysis_id"]]}}}
    assert record_key(supp["analysis_id"]) in read_id_keys(folded)


def test_raw_qnames_decodes_record_keys_of_the_datasets_own_provenance():
    from services.lift.live_lift import LiftSettings
    settings = LiftSettings()
    dataset = SimpleNamespace(id="d", paths=["/x/a.bam"], live_lift=SimpleNamespace(settings=settings))
    own = record_key(_row(group="d#0")["analysis_id"])
    foreign = record_key(_row(group="elsewhere", qname="q9")["analysis_id"])
    out = raw_qnames([own, foreign], dataset)
    assert "m1/ccs" in out
    assert foreign in out and "q9" not in out   # another provenance group passes verbatim (never its QNAME)
    assert record_qname(own) == "m1/ccs" and record_qname("m1/ccs") is None


def test_string_identities_answer_to_their_record_key():
    """agy G0 r1: assignment keys and packed identities are strings; a record key in the set still names them."""
    linear = _row(row_index=1)["analysis_id"]
    assert read_matches_id_filter(linear, {record_key(_row()["analysis_id"])})
    assert not read_matches_id_filter(linear, {_row()["analysis_id"]})
