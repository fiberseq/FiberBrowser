"""Stabilize 3, item 1: a supplementary graph row carries its primary record's haplotype (``ph``).

A graph row is drawn on its own record's path, so its ``hap`` is that path's haplotype; a lifted row of the same
record takes its molecule's primary record's haplotype. A MAT supplementary of a PAT molecule is in the MAT band of
the graph but in the PAT lifted panel. The graph row now names the primary's haplotype too, found in the same batch or
through the SA locus (the primary is on another contig's plan when it is on the other haplotype), so a pop-out can
route the label the MAT path's run gave it to the PAT panel that shows its row.
"""
from __future__ import annotations

from live_lift_fixtures import MAT, PAT, make_record, write_bam
from test_graph_panel_reads import _add_lifted, _reads, _u32, env  # noqa: F401  (the fixture)
from services.graph_panel import reads as gr
from services.lift import live_lift as ll

TAGS = [("ns", _u32([30])), ("nl", _u32([50]))]


def _split_bam(env, name="xhap.bam", sa=True):
    return write_bam(env.tmp / name, lambda h: [
        make_record(h, "split", MAT, 2000, "20S100M", flag=2048,
                    tags=[*TAGS, *([("SA", f"{PAT},2001,+,100M20S,60,0;")] if sa else [])]),
        make_record(h, "split", PAT, 2000, "100M20S", tags=TAGS),
        make_record(h, "plain", MAT, 2500, "100M", tags=TAGS)])


def _rows(out, q="split"):
    return {(r["b"], r["sup"]): r for r in out["reads"] if r["q"] == q}


def test_a_cross_haplotype_supplementary_names_its_primarys_haplotype(env):  # noqa: F811
    did = _add_lifted(env, paths=[_split_bam(env)], dataset_id="xhap")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 10_000}]},
                              {"binding": "pat", "windows": [{"start": 0, "end": 10_000}]}]).json()
    rows = _rows(out)
    sup, prim = rows[("mat", True)], rows[("pat", False)]
    # Its band stays its own path's; the primary's haplotype is beside it, as the lifted rows label it.
    assert sup["hap"].upper() == "MAT"
    assert sup["ph"].upper() == "PAT" == prim["hap"].upper()
    # Only supplementaries carry it.
    assert "ph" not in prim
    assert all("ph" not in r for r in out["reads"] if r["q"] == "plain")


def test_the_primary_is_found_through_its_sa_locus_when_only_the_other_path_is_loaded(env):  # noqa: F811
    did = _add_lifted(env, paths=[_split_bam(env)], dataset_id="xhap")
    ll.clear_primary_cache()
    gr.clear_cache()
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 10_000}]}]).json()
    (sup,) = [r for r in out["reads"] if r["q"] == "split"]
    assert sup["sup"] and sup["hap"].upper() == "MAT" and sup["ph"].upper() == "PAT"


def test_the_lifted_row_of_the_supplementary_has_the_same_haplotype_and_record_key(env):  # noqa: F811
    """The pop-out routes by the graph row's record key and ``ph``: the linear lifted row of the same record has the
    same record key and the primary's haplotype label."""
    from services.lift.cohort import record_key
    did = _add_lifted(env, paths=[_split_bam(env)], dataset_id="xhap")
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 10_000}]}]).json()
    (sup,) = [r for r in out["reads"] if r["q"] == "split"]
    linear = env.client.get("/api/reads/compact", params={"chrom": "chrT", "start": 0, "end": 20_000,
                                                          "dataset_id": did}).json()
    rows = [r for r in linear.get("reads", []) if r.get("id") == "split" and (r.get("live_lift") or {}).get("source", {}).get("supplementary")]
    assert rows
    ll_row = rows[0]["live_lift"]
    assert ll_row["hap_source"] == "primary"
    assert ll_row["hap_label"].upper() == sup["ph"].upper()
    assert record_key(rows[0]["analysis_id"]) == sup["rk"]


def test_no_primary_found_means_no_ph(env):  # noqa: F811
    """No SA tag and the primary outside the batch: nothing is guessed (the row keeps its own path's haplotype)."""
    did = _add_lifted(env, paths=[_split_bam(env, "nosa.bam", sa=False)], dataset_id="nosa")
    ll.clear_primary_cache()
    gr.clear_cache()
    out = _reads(env, [did], [{"binding": "mat", "windows": [{"start": 0, "end": 10_000}]}]).json()
    (sup,) = [r for r in out["reads"] if r["q"] == "split"]
    assert "ph" not in sup
