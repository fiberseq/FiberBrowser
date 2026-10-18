"""Assembly evidence, bounded read alleles and expansion isolated from analyses.
These tests cross the real BAM decoder, graphlift reader and HTTP crop paths;
the source MD describes HG002, while the loaded FASTA describes GRCh38.
"""
import array
import gzip
import json
from copy import deepcopy
import os
from pathlib import Path
from types import SimpleNamespace

import pysam
import pytest

from live_lift_fixtures import (MAT, PAT, SSIZE, TARGET, TSIZE, make_record, write_bam,
                               write_difference_sidecar)
from services.lift import differences as diff
from services.lift import live_lift as ll
from services.lift.dataset import LiveLiftConfig
from services.lift.reads import clip_geometry, lifted_reads_for_region, lifted_coverage


def _fasta(path, entries):
    with open(path, "w") as fh:
        for chrom, seq in entries:
            fh.write(f">{chrom}\n{seq}\n")
    pysam.faidx(str(path))
    return str(path)


def _u32(values):
    return array.array("I", values)


@pytest.fixture
def evidence(tmp_path):
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    manifest = write_difference_sidecar(tmp_path / "map")
    src = list("A" * SSIZE)
    src[100] = "C"
    src[110:113] = "GGG"
    src[200:220] = "G" * 20
    src[7000:9000] = "T" * 2000
    src[8010] = "A"  # an m6A at insertion offset 10 on the '-' piece
    src = "".join(src)
    source = _fasta(tmp_path / "source.fa", [(MAT, src), (PAT, "A" * SSIZE)])
    target = _fasta(tmp_path / "target.fa", [(TARGET, "A" * TSIZE)])

    def records(h):
        tags = [("ns", _u32([90, 4900, 5010, 5060, 5200, 5800])), ("nl", _u32([100, 100, 30, 30, 100, 100])),
                ("st", "CT"), ("MM", "A+a,99;"), ("ML", array.array("B", [255]))]
        yield make_record(h, "hg", MAT, 0, "6000M", seq=src[:6000], tags=[*tags, ("MD", "6000")])
        seq = list(src[:6000])
        seq[100] = "A"
        yield make_record(h, "ref", MAT, 0, "6000M", seq="".join(seq), tags=[*tags, ("MD", "100C5899")])
        seq = list(src[:6000])
        seq[150] = "G"
        yield make_record(h, "private", MAT, 0, "6000M", seq="".join(seq), tags=[*tags, ("MD", "150A5849")])
        yield make_record(h, "partial", MAT, 4990, "60M", seq=src[4990:5050], tags=[("MD", "60")])
        yield make_record(h, "minus", MAT, 7700, "700M", seq=src[7700:8400], tags=[
            ("ns", _u32([310, 360])), ("nl", _u32([30, 30])), ("st", "GA"), ("MD", "700"),
            ("MM", "A+a,0;"), ("ML", array.array("B", [255]))])

    bam = write_bam(tmp_path / "source.bam", lambda h: list(records(h)))
    config = LiveLiftConfig(manifest, [], source_fasta=source)
    ds = SimpleNamespace(id="lift", paths=[bam], live_lift=config, data_type="bam_livelift")
    state = SimpleNamespace(fasta=pysam.FastaFile(target), datasets={ds.id: ds})
    try:
        yield state, ds, tmp_path
    finally:
        if state.fasta is not None:
            state.fasta.close()


def test_items_alleles_ids_and_uncovered(evidence):
    state, ds, _ = evidence
    payload = diff.differences_for_region(state, ds, TARGET, 1000, 20000)
    items = payload["items"]
    assert {"snv", "mnv", "aligned_bubble", "insertion", "deletion", "replacement", "inversion", "no_correspondence"} <= {i["kind"] for i in items}
    replacement = next(i for i in items if i["kind"] == "replacement")
    assert (replacement["ref_bp"], replacement["alt_bp"], replacement["reason"]) == (3, 5, "aligned_indel")
    snv = next(i for i in items if i["kind"] == "snv")
    assert snv["id"] == f"MAT:{MAT}:100-101:snv"
    assert (snv["grch38"], snv["alt"]) == ("A", "C")
    ins = next(i for i in items if i["kind"] == "insertion" and i["strand"] == "+")
    assert ins["id"] == f"MAT:{MAT}:5000-5100:insertion"
    assert (ins["t_start"], ins["t_end"], ins["t"], ins["ref"], ins["len"]) == (6010, 6010, "I", 6010, 100)
    assert ins["source"] == "assembly" and ins["reason"] == "source_insertion"
    deletion = next(i for i in items if i["kind"] == "deletion")
    assert deletion["grch38"] == "A" * 10 and deletion["alt"] == ""
    assert all(i["hap_label"] == "MAT" for i in diff.differences_for_region(state, ds, TARGET, 1000, 20000, lift_hap="MAT")["items"])
    assert all(max(i["ref_bp"], i["alt_bp"]) >= 100 for i in diff.differences_for_region(state, ds, TARGET, 1000, 20000, min_bp=100)["items"])
    ds.live_lift.source_fasta = None
    assert all(i["alt"] is None for i in diff.differences_for_region(state, ds, TARGET, 1000, 20000)["items"])


def test_bins_and_cache_identity(evidence, monkeypatch):
    state, ds, _ = evidence
    a = diff.differences_for_region(state, ds, TARGET, 1000, 20000)
    b = diff.differences_for_region(state, ds, TARGET, 1000, 20000, detail_bp=100)
    assert b["mode"] == "bins" and b["bin_bp"] >= 1000
    assert sum(v["count"] for v in b["bins"]) == len(a["items"])
    assert all(max(i["alt_bp"], i["ref_bp"]) >= 1000 for i in b["items"])
    assert any(v["kind"] == "snv" and v["bp"] == 1 for v in b["bins"])
    assert any(k[0] == ds.live_lift.key() and k[1:] == (TARGET, 0, "H#1") for k in diff._CACHE)
    old = ds.live_lift.key()
    ds.live_lift.settings = ll.LiftSettings(rejoin_bp=0)
    diff.differences_for_region(state, ds, TARGET, 1000, 20000)
    assert old != ds.live_lift.key() and any(k[0] == ds.live_lift.key() for k in diff._CACHE)
    # BAM access is forbidden even on a cold geometry cache.
    monkeypatch.setattr(pysam, "AlignmentFile", lambda *a, **k: pytest.fail("strip opened BAM"))
    diff.differences_for_region(state, ds, TARGET, 1000, 20000)


def test_insertion_calls_partial_carriers_orientation_and_crops(evidence):
    state, ds, _ = evidence
    rows = lifted_reads_for_region(ds, TARGET, 1000, 14000, dict(include_layers=True, include_methylation=True))
    plus = next(r for r in rows if r["id"] == "hg")
    key = f"MAT:{MAT}:5000-5100:insertion"
    block = plus["live_lift"]["insertions"][key]
    assert (block["length"], block["covered"], block["mol_bp"], block["pos"]) == (100, [0, 100], 100, 5010)
    assert [10, 40, 30] in block["intervals"] and [40, 60, -20] in block["intervals"]
    assert block["layers"]["tf"]["intervals"] == [[10, 40, 30], [60, 90, 30]]
    partial = next(r for r in rows if r["id"] == "partial")
    assert partial["live_lift"]["insertions"][key]["covered"] == [0, 50]
    assert partial["live_lift"]["badge_ids"] == [key]
    minus = next(r for r in rows if r["id"] == "minus")
    mkey = f"MAT:{MAT}:8000-8100:insertion"
    mb = minus["live_lift"]["insertions"][mkey]
    assert mb["orientation"] == "-" and [60, 90, 30] in mb["intervals"]
    assert mb["methyl_m6a"] == [90]
    # Source offset 10 is boundary x=90 in the mirrored call.
    assert max(iv[1] for iv in mb["intervals"] if iv[2] == 30) == 90
    cropped = clip_geometry(plus["live_lift"], 5000, 20)
    assert cropped["badge_ids"] == [key] and cropped["insertions"][key]["pos"] == 10
    assert clip_geometry(plus["live_lift"], 5100, 20)["insertions"] == {}
    from services.working_sets import project_broad_read_to_viewport
    projected, _ = project_broad_read_to_viewport(plus, viewport_offset=5000, region_width=20,
                                                include_methylation=True, layer_key=None)
    assert projected["live_lift"]["badge_ids"] == [key]


def test_hidden_payload_never_changes_coverage_or_footprint_count(evidence):
    state, ds, _ = evidence
    from services.read_selection import count_footprints
    rows = lifted_reads_for_region(ds, TARGET, 1000, 14000, dict(include_layers=True))
    without = deepcopy(rows)
    for r in without:
        r["live_lift"].pop("insertions")
    assert [count_footprints(r) for r in rows] == [count_footprints(r) for r in without]
    assert lifted_coverage(ds, TARGET, 1000, 14000, 30, rows=rows) == lifted_coverage(ds, TARGET, 1000, 14000, 30, rows=without)


def test_assembly_sv_reuses_carrier_helpers(evidence):
    state, ds, _ = evidence
    from services.sv_events import carrier_evidence, classify_allele, cluster_sv_events, sv_events_in_view, read_deletion_cuts
    rows = lifted_reads_for_region(ds, TARGET, 1000, 7000)
    row = next(r for r in rows if r["id"] == "hg")
    assert carrier_evidence(row, "I", 6010, 100, TARGET)
    assert classify_allele(row, "I", 6010, 100, chrom=TARGET) == 0
    clusters, _ = cluster_sv_events(rows, 1000, 7000, 50)
    assert any(c["t"] == "I" and c["ref"] == 6010 for c in clusters)
    assert sv_events_in_view(row["sv"], 6000, 6020, 50)[0]["source"] == "assembly"
    assert not any(ev["t"] == "D" for ev in row["sv"])
    assert read_deletion_cuts(row) == []


def test_read_inspection_md_alleles_chromatin_and_insertions(evidence):
    state, ds, _ = evidence
    # Reconstruct HG002 from MD instead of trusting a mis-phased read's SEQ.
    ds.live_lift.source_fasta = None
    result = diff.difference_reads(state, ds, TARGET, 1100, 1101, lift_hap="MAT")
    by_name = {r["id"]: r for r in result["rows"]}
    assert by_name["hg"]["allele"] == "hg002" and by_name["hg"]["read_bases"] == "C"
    assert by_name["ref"]["allele"] == "grch38" and by_name["ref"]["hg002"] == "C"
    assert by_name["hg"]["chromatin"]["state"] == "nucleosome"
    assert by_name["hg"]["chromatin"]["nearest_m6a_bp"] <= 2
    assert result["summary"]["MAT"] == {"hg002": 2, "grch38": 1}
    ins = diff.difference_reads(state, ds, TARGET, 6010, 6010, lift_hap="MAT")
    by_name = {r["id"]: r for r in ins["rows"]}
    assert by_name["hg"]["carries_insertion"] and by_name["hg"]["mol_bp"] == 100
    assert not by_name["partial"]["carries_insertion"] and by_name["partial"]["mol_bp"] == 50
    assert len(by_name["hg"]["read_bases"]) == 60 and by_name["hg"]["read_bases_length"] == 100
    assert by_name["hg"]["grch38"] == "" and by_name["hg"]["allele"] == "hg002"
    assert by_name["partial"]["allele"] == "partial" and by_name["partial"]["strand"] is None
    assert diff.difference_reads(state, ds, TARGET, 12900, 12900)["rows"][0]["chromatin"]["orientation"] == "-"


def test_view_only_x_events_sources_and_reference_allele(evidence):
    state, ds, _ = evidence
    opts = dict(include_cigar=True, target_fasta=state.fasta)
    rows = lifted_reads_for_region(ds, TARGET, 1090, 1160, opts)
    by_name = {r["id"]: r for r in rows}
    hg = [e for e in by_name["hg"]["cigar"] if e["type"] == "X"]
    assert {"type": "X", "pos": 10, "base": "C", "ref": "A", "source": "assembly", "len": 1, "seq": "C"} in hg
    ref = next(e for e in by_name["ref"]["cigar"] if e["pos"] == 10)
    assert ref["allele"] == "grch38"
    private = next(e for e in by_name["private"]["cigar"] if e["pos"] == 60)
    assert private["source"] == "reads" and private["base"] == "G"
    assert all(0 <= e["pos"] < 70 for r in rows for e in r.get("cigar", []) if e["type"] == "X")
    assert all("cigar" not in r for r in lifted_reads_for_region(ds, TARGET, 1090, 1160, dict(target_fasta=state.fasta)))
    bubble = next(r for r in lifted_reads_for_region(ds, TARGET, 1195, 1225, opts) if r["id"] == "hg")
    assert len([e for e in bubble["cigar"] if e["source"] == "assembly"]) == 20


def test_large_insertion_payload_is_size_only(monkeypatch):
    # The map authority is tested separately; isolate the expansion size guard.
    monkeypatch.setattr(diff, "source_only_gap", lambda *args: (100, 60100))
    from services.lift.compose import lift_compact_reads
    pieces = [ll.LiftPiece(0, 1000, 1100, 0, 100, "+", True, "H#1", MAT),
              ll.LiftPiece(0, 1100, 1200, 60100, 60200, "+", True, "H#1", MAT)]
    selection = ll.PieceSelection(TARGET, 0, 2000, 0, 2000, pieces)
    settings = ll.LiftSettings()
    read = dict(id="long", reference_start=0, reference_end=60200, intervals=[[110, 140, 30]],
                _fiberbrowser_source_base=0, _fiberbrowser_aligned_runs=[[0, 0, 60200]],
                _fiberbrowser_lift_record=dict(contig=MAT, reverse=False, length=60200))
    row = lift_compact_reads([read], ll.plan_fetch(selection, settings), handle=None,
                             region_start=0, region_end=2000, settings=settings, key="long-key", dataset_id="long")[0]
    assert list(row["live_lift"]["insertions"].values()) == [{"length": 60000, "too_large": True}]


def test_record_cap_and_missing_target_reference(evidence):
    state, ds, tmp = evidence
    bam = write_bam(tmp / "deep.bam", lambda h: [make_record(h, f"r{i}", MAT, 0, "200M", tags=[("MD", "200")])
                                                for i in range(501)])
    ds.paths = [bam]
    state.fasta.close()
    state.fasta = None
    result = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    assert result["capped"] and result["max_records"] == 500 and len(result["rows"]) == 500
    assert all(r["grch38"] is None and r["allele"] == "other" for r in result["rows"])


def test_read_deletion_and_missing_md(evidence):
    state, ds, tmp = evidence
    ds.paths = [write_bam(tmp / "deleted.bam", lambda h: [
        make_record(h, "deleted", MAT, 90, "10M1D10M", tags=[("MD", "10^C10")]),
        make_record(h, "unknown", MAT, 90, "21M")])]
    ds.live_lift.source_fasta = None
    rows = {r["id"]: r for r in diff.difference_reads(state, ds, TARGET, 1100, 1101)["rows"]}
    assert rows["deleted"]["read_bases"] == "" and rows["deleted"]["hg002"] == "C"
    assert rows["deleted"]["allele"] == "deleted"
    assert rows["unknown"]["hg002"] is None
    assert rows["unknown"]["allele"] == "other"


def test_reverse_record_hard_clips_and_cigar_insertion(evidence):
    state, ds, tmp = evidence
    # In BAM SEQ follows the alignment even on reverse records; molecular
    # coordinates include hard clips, while SEQ excludes them.
    with pysam.FastaFile(ds.live_lift.source_fasta) as fa:
        seq = fa.fetch(MAT, 90, 100) + "T" + fa.fetch(MAT, 100, 120)
    ds.paths = [write_bam(tmp / "hard.bam", lambda h: [make_record(
        h, "hard", MAT, 90, "5H10M1I20M5H", reverse=True, seq=seq, tags=[("MD", "30")])])]
    row = lifted_reads_for_region(ds, TARGET, 1090, 1120, dict(include_cigar=True, target_fasta=state.fasta))[0]
    assert any(e["type"] == "I" and e["source"] == "reads" for e in row["cigar"])
    assert any(e["type"] == "X" and e["pos"] == 10 and e["base"] == "C" and e["source"] == "assembly"
               for e in row["cigar"])


def test_inspection_molecular_bp_includes_read_insertion_at_gap_end(evidence):
    state, ds, tmp = evidence
    ds.paths = [write_bam(tmp / "boundary.bam", lambda h: [make_record(
        h, "boundary", MAT, 4900, "200M5I100M", seq="A" * 200 + "TTTTT" + "A" * 100, tags=[("MD", "300")])])]
    row = lifted_reads_for_region(ds, TARGET, 5900, 6200)[0]
    block = next(iter(row["live_lift"]["insertions"].values()))
    inspected = diff.difference_reads(state, ds, TARGET, 6010, 6010)["rows"][0]
    assert inspected["mol_bp"] == block["mol_bp"] == 105
    assert inspected["read_bases"] == "A" * 60 and inspected["read_bases_length"] == 105
    assert inspected["allele"] == "hg002" and inspected["identity"] == pytest.approx(10000 / 105, abs=.01)


@pytest.fixture
def two_hap_evidence(evidence):
    """PAT covers MAT's SNV without an assembly difference at that site.
    Use an actual two-parent map/BAM so inspecting a MAT panel must still
    fetch PAT's own source interval rather than classify PAT against MAT.
    """
    state, ds, tmp = evidence
    manifest = write_difference_sidecar(tmp / "two-parent-map")
    data_path = Path(manifest).parent / "toy.t0.chrT.json.gz"
    with gzip.open(data_path, "rt") as fh:
        data = json.load(fh)
    data["blocks"]["2"] = [[1000, 0, 6900]]
    with gzip.open(data_path, "wt") as fh:
        json.dump(data, fh)
    with open(manifest) as fh:
        data = json.load(fh)
    data["chains"][2].update(t_start=1000, t_end=7900, q_start=0, q_end=6900,
                             q_start_forward=0, q_end_forward=6900, aligned=6900)
    data["nets"]["H#2"] = [[0, 1000, 7900, 2, []]]
    with open(manifest, "w") as fh:
        json.dump(data, fh)
    ds.live_lift = LiveLiftConfig(manifest, [], source_fasta=ds.live_lift.source_fasta)
    ds.paths = [write_bam(tmp / "two-parent.bam", lambda h: [
        make_record(h, "mat-alt", MAT, 0, "200M", seq="A" * 100 + "C" + "A" * 99, tags=[("MD", "200")]),
        make_record(h, "mat-ref", MAT, 0, "200M", seq="A" * 200, tags=[("MD", "100C99")]),
        *[make_record(h, f"pat-{i}", PAT, 0, "200M", seq="A" * 200, tags=[("MD", "200")]) for i in range(35)]])]
    return state, ds, tmp


@pytest.mark.parametrize("source_fasta", [True, False])
@pytest.mark.parametrize("selector", ["lift_hap", "item_id"])
def test_inspection_uses_each_reads_own_haplotype(two_hap_evidence, source_fasta, selector):
    state, ds, _ = two_hap_evidence
    if not source_fasta:
        ds.live_lift.source_fasta = None
    selection = {selector: "MAT" if selector == "lift_hap" else f"MAT:{MAT}:100-101:snv"}
    result = diff.difference_reads(state, ds, TARGET, 1100, 1101, **selection)
    assert result["preferred_hap"] == "MAT"
    assert [r["hap_label"] for r in result["rows"][:2]] == ["MAT", "MAT"]
    assert result["summary"] == {"MAT": {"hg002": 1, "grch38": 1}, "PAT": {"same_as_grch38": 35}}
    pat = [r for r in result["rows"] if r["hap_label"] == "PAT"]
    assert all(r["read_bases"] == r["hg002"] == r["grch38"] == "A" and r["strand"] is None for r in pat)
    reverse = diff.difference_reads(state, ds, TARGET, 1100, 1101, lift_hap="PAT")
    assert reverse["rows"][0]["hap_label"] == "PAT" and reverse["summary"] == result["summary"]


def test_insertion_carriage_is_independent_of_sequence_identity(evidence):
    state, ds, tmp = evidence
    ds.paths = [write_bam(tmp / "insertion-alleles.bam", lambda h: [
        make_record(h, "noisy", MAT, 4900, "300M", seq="A" * 100 + "C" * 10 + "A" * 190),
        make_record(h, "indel", MAT, 4900, "150M5I2D148M", seq="A" * 150 + "TTTTT" + "A" * 148),
        make_record(h, "tolerance", MAT, 4900, "200M50I100M", seq="A" * 350),
        make_record(h, "wrong-length", MAT, 4900, "200M51I100M", seq="A" * 351),
        make_record(h, "deleted", MAT, 4900, "100M100D100M", seq="A" * 200),
        make_record(h, "skip", MAT, 4900, "100M100N100M", seq="A" * 200),
        make_record(h, "clipped-end", MAT, 4900, "150M50S", seq="A" * 200),
        make_record(h, "clipped-start", MAT, 5050, "50S150M", seq="A" * 200)])]
    result = diff.difference_reads(state, ds, TARGET, 6010, 6010, item_id=f"MAT:{MAT}:5000-5100:insertion")
    rows = {r["id"]: r for r in result["rows"]}
    for name in ("noisy", "indel", "tolerance"):
        assert rows[name]["allele"] == "hg002" and rows[name]["carries_insertion"]
    assert rows["noisy"]["identity"] == 90 and rows["indel"]["identity"] == pytest.approx(9800 / 105, abs=.01)
    assert rows["wrong-length"]["allele"] == "no_insertion" and not rows["wrong-length"]["carries_insertion"]
    assert rows["deleted"]["allele"] == "deleted" and rows["skip"]["allele"] == "no_coverage"
    for name in ("clipped-end", "clipped-start"):
        assert rows[name]["allele"] == "partial" and not rows[name]["carries_insertion"]
    assert all(len(r["read_bases"]) <= 60 and r["read_bases_length"] == r["mol_bp"] and r["strand"] is None for r in rows.values())


def test_insertion_boundary_inspects_noninserting_parent(two_hap_evidence):
    state, ds, tmp = two_hap_evidence
    ds.paths = [write_bam(tmp / "one-parent-insertion.bam", lambda h: [
        make_record(h, "mat", MAT, 4900, "300M", seq="A" * 300),
        make_record(h, "pat", PAT, 4900, "300M", seq="A" * 300)])]
    rows = {r["id"]: r for r in diff.difference_reads(state, ds, TARGET, 6010, 6010, lift_hap="MAT")["rows"]}
    assert rows["mat"]["allele"] == "hg002"
    assert rows["pat"]["allele"] == "no_insertion" and not rows["pat"]["carries_insertion"]


def test_read_evidence_helper_cluster_output(evidence):
    state, ds, _ = evidence
    from services.sv_events import cluster_sv_events
    items = diff.differences_for_region(state, ds, TARGET, 1000, 9000)["items"]
    clusters, _ = cluster_sv_events([{"id": "r", "sv": [{"t": "I", "ref": 6010, "len": 100, "source": "reads"},
                                                         {"t": "D", "ref": 7000, "len": 75, "source": "reads"}]}],
                                    1000, 9000, 50)
    novel = diff.annotate_read_evidence(items, clusters)
    ins = next(i for i in items if i["kind"] == "insertion")
    assert ins["read_support"] == {"cluster": 0, "carriers": 1}
    assert len(novel) == 1 and novel[0]["t"] == "D" and novel[0]["source"] == "reads"


def test_http_native_bam_match_flag_gate_and_detail(evidence, monkeypatch):
    import server as srv
    from plugins import init_context
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient
    state, ds, tmp = evidence
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    try:
        client = TestClient(srv.app, headers=auth_headers())
        # No reference at registration: this fixture is a display contract
        # fixture, not an anchor-validation fixture.
        result = client.post("/api/lift/datasets", json={"paths": ds.paths, "manifest": ds.live_lift.manifest}).json()
        assert result["success"], result
        did = result["dataset"]["id"]
        srv.state.fasta = state.fasta
        native = write_bam(tmp / "native.bam", lambda h: [make_record(h, "native", TARGET, 5800, "210M100I300M", tags=[("MD", "510")])],
                           contigs=((TARGET, TSIZE),))
        srv.state.add_dataset("native", native)
        query = dict(dataset_id=did, chrom=TARGET, start=1000, end=9000, native_dataset_id="native")
        response = client.get("/api/lift/differences", params=query)
        assert response.status_code == 200, response.text
        payload = response.json()
        ins = next(i for i in payload["items"] if i["kind"] == "insertion")
        assert ins["read_support"]["carriers"] == 1 and payload["novel"] == []
        assert payload["native_summary"]["min_len"] == 50
        assert payload["native_summary"]["clusters"][0]["source"] == "reads"
        assert client.get("/api/lift/differences", params={**query, "detail_bp": 100}).json()["novel"] == []
        inspected = client.get("/api/lift/difference_reads", params=dict(dataset_id=did, chrom=TARGET, pos=1100,
                               item_id=f"MAT:{MAT}:100-101:snv")).json()
        assert inspected["summary"]["MAT"]["grch38"] == 1 and inspected["preferred_hap"] == "MAT"
        detailed = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=TARGET, start=1090, end=1160,
                                                              include_cigar=True)).json()
        assert any(e.get("source") == "assembly" for r in detailed["reads"] for e in r.get("cigar", []))
        # A warm broad display cache is reused for chromatin inspection.
        client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=TARGET, start=1000, end=7000,
                                                    include_layers=True, include_methylation=True))
        import services.lift.reads as lr
        monkeypatch.setattr(lr, "lifted_reads_for_region", lambda *a, **k: pytest.fail("inspection missed broad cache"))
        cached = client.get("/api/lift/difference_reads", params=dict(dataset_id=did, chrom=TARGET, pos=1100))
        assert cached.status_code == 200 and cached.json()["rows"]
        monkeypatch.delenv("FIBERBROWSER_LIVE_LIFT")
        assert client.get("/api/lift/differences", params=query).status_code == 404
        assert client.get("/api/lift/difference_reads", params=dict(dataset_id=did, chrom=TARGET, pos=1100)).status_code == 404
    finally:
        srv.state = old
        init_context(old)


def test_real_alu_expansion_smoke():
    """The owner's hg38 AluY view, skipped on machines without handoff data."""
    import pwd
    root = Path(os.environ.get("PGLIFT_WORK", str(Path(pwd.getpwuid(os.getuid()).pw_dir) / "pglift_work")))
    manifest = root / "pglift_20261017/native/graphlift/scratch/v4/hprc.GRCh38.HG002.chain.graphlift.json"
    handoff = Path(os.environ.get("LIVE_LIFT_DEMO_DATA", str(Path(pwd.getpwuid(os.getuid()).pw_dir) /
                    "pglift_work/demo_data")))
    bam = handoff / "SAMPLE_A.alu_chr3.hg002v1.1.bam"
    if not manifest.exists() or not bam.exists():
        pytest.skip("AluY handoff BAM and whole-genome sidecar not present")
    ds = SimpleNamespace(id="real", data_type="bam_livelift", paths=[str(bam)], live_lift=LiveLiftConfig(str(manifest), []))
    state = SimpleNamespace(fasta=None)
    items = diff.differences_for_region(state, ds, "chr3", 128650000, 128670000, lift_hap="MAT")["items"]
    ins = [i for i in items if i["kind"] == "insertion" and 2300 <= i["alt_bp"] <= 2450]
    assert ins
    rows = lifted_reads_for_region(ds, "chr3", 128650000, 128670000, dict(include_layers=True))
    assert any(any(iv[2] > 0 for iv in block.get("intervals", []))
               for row in rows if row["live_lift"]["hap_label"] == "MAT"
               for key, block in row["live_lift"]["insertions"].items() if key in {i["id"] for i in ins})
    inspected = diff.difference_reads(state, ds, "chr3", 128657390, 128657390, item_id=ins[0]["id"])
    for hap in ("MAT", "PAT"):
        cohort = [r for r in inspected["rows"] if r["hap_label"] == hap]
        assert sum(r["allele"] == "hg002" for r in cohort) > len(cohort) / 2
        assert all(len(r["read_bases"]) <= 60 and r["strand"] is None for r in cohort)
        assert any(r["identity"] is not None and 0 < r["identity"] <= 100 for r in cohort)
