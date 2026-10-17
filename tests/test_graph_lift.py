"""BAMs lifted through a pangenome graph (services/graph_lift.py): ex-supplementary
dedupe, st:Z strand, lift provenance and file diagnose (DAF-C: test_dafc_reads_bam.py).

Every BAM is synthetic, written with pysam in the test's tmp_path.
"""
from __future__ import annotations

import pysam
import pytest

from services import compact_read_loader, graph_lift
from services.bam_tags import legacy_tag_frame_report
from services.read_strand import read_strand, record_strand_fields

CHROM_LEN = 20_000

VG_LIFT_PGS = [
    {"ID": "minimap2", "PN": "minimap2", "VN": "2.28", "CL": "minimap2 -ax map-hifi"},
    {"ID": "ft.1", "PN": "ft", "PP": "minimap2", "CL": "ft pg-pansn --prefix HG002#1# in.bam"},
    {"ID": "0", "PN": "vg", "VN": "", "CL": "vg surject -x graph.gbz -b -"},
    {"ID": "ft.2", "PN": "ft", "CL": "ft pg-pansn --strip out.bam"},
]
REPAIRED_PGS = [
    {"ID": "minimap2", "PN": "minimap2", "VN": "2.28", "CL": "minimap2 -ax map-hifi"},
    {"ID": "ft.1", "PN": "ft", "PP": "minimap2", "CL": "ft pg-pansn --prefix HG002#1# in.bam"},
    {"ID": "0", "PN": "vg", "PP": "ft.1", "CL": "vg surject -x graph.gbz -b -"},
    {"ID": "ft.2", "PN": "ft", "PP": "0", "CL": "ft pg-pansn --strip out.bam"},
    {"ID": "fiberhmm-lift", "PN": "fiberhmm-lift", "PP": "ft.2", "VN": "3.1.0",
     "CL": "fiberhmm-lift -i in.bam -o out.bam",
     "DS": "graph lift repair; mode=lift; source=HG002 target=GRCh38; graph=graph.gbz; calmd=yes; "
           "st_swapped=3; coord=molecular"},
]


def _header(pgs):
    return {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": CHROM_LEN}],
            **({"PG": pgs} if pgs else {})}


def _record(header, name, start, length, *, seq=None, reverse=False, mapq=60, tags=(), flag_extra=0):
    read = pysam.AlignedSegment(header)
    read.query_name = name
    read.reference_id = 0
    read.reference_start = start
    seq = seq or ("ACGT" * (length // 4 + 1))[:length]
    read.query_sequence = seq
    read.cigarstring = f"{len(seq)}M"
    read.flag = (16 if reverse else 0) | flag_extra
    read.mapping_quality = mapq
    read.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
    for tag, value, kind in tags:
        read.set_tag(tag, value, value_type=kind)
    return read


def _write_bam(path, pgs, specs):
    header = pysam.AlignmentHeader.from_dict(_header(pgs))
    records = [_record(header, *spec[0], **spec[1]) for spec in specs]
    records.sort(key=lambda r: r.reference_start)
    unsorted = str(path) + ".unsorted"
    with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
        for read in records:
            out.write(read)
    pysam.sort("-o", str(path), unsorted)
    pysam.index(str(path))
    return str(path)


def _load(path, start=0, end=CHROM_LEN, **kwargs):
    from services.bam_handles import get_bam_handle
    return compact_read_loader.build_compact_reads_from_bam(
        path, "chr1", start, end, spanning_only=False, bam_handle_getter=get_bam_handle, **kwargs)


# A molecule whose 3 kb supplementary came out of an unrepaired lift as a second
# primary (soft-clipped: same SEQ, shorter alignment), plus a lone molecule.
def _split_molecule_specs():
    seq = ("ACGT" * 2500)[:10_000]
    return [
        (("m1", 1_000, 0), {"seq": seq[:7_000], "mapq": 20}),
        (("m1", 9_000, 0), {"seq": seq[:3_000], "mapq": 60}),
        (("m2", 2_000, 4_000), {}),
    ]


@pytest.mark.parametrize("pgs, expected", [
    (VG_LIFT_PGS, ["m1", "m2"]),            # unrepaired lift: m1 once
    (REPAIRED_PGS, ["m1", "m1", "m2"]),     # repaired lift: QNAMEs are not touched
    ([], ["m1", "m1", "m2"]),               # merged libraries can share QNAMEs
])
def test_ex_supplementaries_deduped_only_in_unrepaired_lifts(tmp_path, pgs, expected):
    path = _write_bam(tmp_path / "x.bam", pgs, _split_molecule_specs())
    reads = _load(path)
    assert sorted(r["id"] for r in reads) == expected
    if pgs is VG_LIFT_PGS:
        # The record with the longest SEQ (the primary carries the whole molecule) is kept.
        m1 = next(r for r in reads if r["id"] == "m1")
        assert m1["reference_start"] == 1_000


def test_dedupe_ranks_longest_alignment_then_mapq(tmp_path):
    seq = ("ACGT" * 2000)[:8_000]
    # Same SEQ length: the longer alignment wins even with the lower MAPQ.
    header = pysam.AlignmentHeader.from_dict(_header(VG_LIFT_PGS))
    longer = _record(header, "q", 100, 0, seq=seq, mapq=5)
    longer.cigarstring = "8000M"
    shorter = _record(header, "q", 9_000, 0, seq=seq, mapq=60)
    shorter.cigarstring = "5000S3000M"
    drop = graph_lift.lift_duplicate_records([shorter, longer])
    assert graph_lift.is_lift_duplicate(shorter, drop)
    assert not graph_lift.is_lift_duplicate(longer, drop)
    # Equal SEQ and alignment: the higher MAPQ wins.
    a = _record(header, "p", 100, 0, seq=seq[:3_000], mapq=10)
    b = _record(header, "p", 5_000, 0, seq=seq[:3_000], mapq=40)
    drop = graph_lift.lift_duplicate_records([a, b])
    assert graph_lift.is_lift_duplicate(a, drop) and not graph_lift.is_lift_duplicate(b, drop)
    # Identical records are not dropped against themselves.
    assert graph_lift.lift_duplicate_records([b, b]) == set()


def test_hard_clipped_ex_supplementary_hidden_without_its_primary_in_view(tmp_path):
    # The primary (10 kb SEQ) sits at 1,000; the ex-supplementary (3 kb SEQ, MA says
    # 10 kb) at 15,000. A view of 14-20 kb sees only the ex-supplementary.
    seq = ("ACGT" * 2500)[:10_000]
    specs = [
        (("m1", 1_000, 0), {"seq": seq, "tags": [("MA", "10000;nuc+Q:101-150", "Z")]}),
        (("m1", 15_000, 0), {"seq": seq[:3_000], "tags": [("MA", "10000;nuc+Q:101-150", "Z")]}),
        (("m2", 15_500, 2_000), {"tags": [("MA", "2000;nuc+Q:101-150", "Z")]}),
    ]
    path = _write_bam(tmp_path / "hc.bam", VG_LIFT_PGS, specs)
    assert sorted(r["id"] for r in _load(path, 14_000, CHROM_LEN)) == ["m2"]
    repaired = _write_bam(tmp_path / "hc_repaired.bam", REPAIRED_PGS, specs)
    assert sorted(r["id"] for r in _load(repaired, 14_000, CHROM_LEN)) == ["m1", "m2"]


def test_header_lift_state_mirrors_fiberhmm():
    assert graph_lift.header_lift_state(_header(VG_LIFT_PGS)) == {"lift": ["ft.1", "0", "ft.2"], "repaired": False}
    assert graph_lift.header_lift_state(_header(REPAIRED_PGS)) == {"lift": [], "repaired": True}
    assert graph_lift.header_lift_state(_header([])) == {"lift": [], "repaired": False}
    # The mirror alone (the FiberHMM bundled with 3.0.1 has no graph_lift module).
    pgs = VG_LIFT_PGS
    assert [pgs[i]["ID"] for i in graph_lift._pending_lift_indices(pgs)] == ["ft.1", "0", "ft.2"]
    assert graph_lift._pending_lift_indices(REPAIRED_PGS) == []
    # A repaired lift lifted again without repair is unrepaired again.
    relift = REPAIRED_PGS + [{"ID": "0", "PN": "vg", "CL": "vg surject -x g2.gbz -b -"}]
    assert graph_lift.is_unrepaired_lift(_header(relift))


def test_lift_summary_reads_the_fiberhmm_lift_pg():
    summary = graph_lift.lift_summary(_header(REPAIRED_PGS))
    assert summary["source"] == "HG002" and summary["target"] == "GRCh38"
    assert summary["graph"] == "graph.gbz" and summary["calmd"] == "yes" and summary["repaired"]
    assert graph_lift.lift_summary_text(summary) == "HG002 → GRCh38 · graph graph.gbz · MD/NM recomputed"
    unrepaired = graph_lift.lift_summary(_header(VG_LIFT_PGS))
    assert unrepaired["unrepaired"] and "--repair-only" in graph_lift.lift_summary_text(unrepaired)
    assert graph_lift.lift_summary(_header([])) is None


def test_repaired_lift_declares_molecular_legacy_frame():
    # A SEQ-frame FiberHMM v1 writer followed by the repair's coord=molecular @PG.
    pgs = [{"ID": "fiberhmm-apply", "PN": "fiberhmm-apply", "CL": "fiberhmm-apply -i x.bam"},
           dict(REPAIRED_PGS[0], PP="fiberhmm-apply"), *REPAIRED_PGS[1:]]
    assert legacy_tag_frame_report(_header(pgs))["frame"] == "molecular"


def test_st_tag_decides_strand_and_conflicts_are_flagged(tmp_path):
    # SEQ marks are R (G->A); st says CT, as on a reversed read whose st was not swapped.
    seq_ga = "ACGRACGTAR" * 30
    seq_ct = "ACGYACGTAY" * 30
    specs = [
        (("flipped", 1_000, 0), {"seq": seq_ga, "tags": [("st", "CT", "Z")]}),
        (("agrees", 1_000, 0), {"seq": seq_ct, "tags": [("st", "CT", "Z")]}),
        (("no_st", 1_000, 0), {"seq": seq_ga}),
    ]
    path = _write_bam(tmp_path / "st.bam", [], specs)
    reads = {r["id"]: r for r in _load(path, include_methylation=True)}
    assert reads["flipped"]["strand"] == "CT" and reads["flipped"]["strand_conflict"] is True
    assert read_strand(reads["flipped"]) == "CT"            # FiberHMM's rule: st decides
    assert reads["agrees"]["strand"] == "CT" and "strand_conflict" not in reads["agrees"]
    assert "strand" not in reads["no_st"] and read_strand(reads["no_st"]) == "GA"   # R/Y marks decide
    from services.bam_handles import get_bam_handle
    bam = get_bam_handle(path)
    by_name = {r.query_name: r for r in bam.fetch("chr1")}
    assert record_strand_fields(by_name["no_st"]) == {}
    # An st value FiberHMM does not read (".") leaves the marks to decide.
    other = _record(bam.header, "dot", 0, 0, seq=seq_ga, tags=[("st", ".", "Z")])
    assert record_strand_fields(other) == {}


def test_lift_provenance_on_reads(tmp_path):
    specs = [(("r", 1_000, 2_000), {"tags": [("Yp", "chr1_MATERNAL:1141849:-", "Z"), ("Yq", 7, "i")]}),
             (("plain", 1_000, 2_000), {})]
    path = _write_bam(tmp_path / "prov.bam", REPAIRED_PGS, specs)
    reads = {r["id"]: r for r in _load(path)}
    assert reads["r"]["lift"] == {"from": "chr1_MATERNAL:1141849:-", "mapq": 7}
    assert "lift" not in reads["plain"]
    # A broad-cache crop keeps it.
    from services.working_sets import project_broad_read_to_viewport
    cropped, _ = project_broad_read_to_viewport(
        reads["r"], viewport_offset=500, region_width=1_000, include_methylation=False, layer_key=None)
    assert cropped["lift"] == reads["r"]["lift"]


def test_diagnose_reports_unrepaired_lift_and_st_conflicts(tmp_path):
    from services.files_endpoint import diagnose_bam_payload
    seq_ga = "ACGRACGTAR" * 30
    specs = [((f"r{i}", 1_000 + i, 0), {"seq": seq_ga, "tags": [("st", "CT", "Z")]}) for i in range(4)]
    path = _write_bam(tmp_path / "diag.bam", VG_LIFT_PGS, specs)
    result = diagnose_bam_payload(None, bam_path=path)
    assert result["st_strand_conflicts"] == 4 and result["st_strand_reads"] == 4
    text = "\n".join(result["recommendations"])
    assert "fiberhmm-lift --repair-only -i <lifted.bam>" in text
    assert "4 of 4 sampled DAF reads" in text and "repair fixes" in text

    repaired = _write_bam(tmp_path / "diag_ok.bam", REPAIRED_PGS, [(("r", 1_000, 2_000), {})])
    result = diagnose_bam_payload(None, bam_path=repaired)
    assert result["graph_lift_text"].startswith("HG002 → GRCh38")
    assert not any("pangenome" in r or "st:Z" in r for r in result["recommendations"])


def test_library_inspect_records_the_lift(tmp_path):
    import os
    from services import library_inspect
    path = _write_bam(tmp_path / "lib.bam", REPAIRED_PGS, [(("r", 1_000, 2_000), {})])
    st = os.stat(path)
    identity = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "inode": st.st_ino}
    info = library_inspect.inspect_bam(path, identity)
    assert info["graph_lift"]["text"] == "HG002 → GRCh38 · graph graph.gbz · MD/NM recomputed"
    plain = _write_bam(tmp_path / "plain.bam", [], [(("r", 1_000, 2_000), {})])
    st = os.stat(plain)
    assert "graph_lift" not in library_inspect.inspect_bam(
        plain, {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "inode": st.st_ino})


def test_lift_summary_text_without_recorded_assemblies():
    # fiberhmm-lift --repair-only without --prefix/--target records neither assembly.
    pgs = [dict(REPAIRED_PGS[-1], DS="graph lift repair; mode=repair-only; source=unknown target=unknown; "
                                     "graph=unknown; calmd=no; coord=molecular")]
    assert graph_lift.lift_summary_text(graph_lift.lift_summary(_header(pgs))) == \
        "repaired by fiberhmm-lift · MD/NM/SA dropped"
