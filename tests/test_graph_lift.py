"""BAMs lifted through a pangenome graph (services/graph_lift.py): ex-supplementaries
of an unrepaired lift, st:Z strand, lift provenance, file diagnose and the Library
(DAF-C: test_dafc_reads_bam.py).

Every BAM is synthetic, written with pysam in the test's tmp_path.
"""
from __future__ import annotations

import os

import pysam
import pytest

from services import compact_read_loader, graph_lift
from services.bam_tags import legacy_tag_frame_report
from services.read_strand import read_strand, record_strand_fields

CHROM_LEN = 20_000

# ft pg-lift's @PG lines as vg and ft pg-pansn write them: vg's own line is bare.
VG_LIFT_PGS = [
    {"ID": "minimap2", "PN": "minimap2", "VN": "2.28", "CL": "minimap2 -ax map-hifi"},
    {"ID": "0", "PN": "vg"},
    {"ID": "ft.1", "PN": "ft", "PP": "minimap2", "CL": "ft pg-pansn --prefix asmA#1# in.bam"},
    {"ID": "ft.2", "PN": "ft", "CL": "ft pg-pansn --strip out.bam"},
]
REPAIRED_PGS = [
    {"ID": "minimap2", "PN": "minimap2", "VN": "2.28", "CL": "minimap2 -ax map-hifi"},
    {"ID": "ft.1", "PN": "ft", "PP": "minimap2", "CL": "ft pg-pansn --prefix asmA#1# in.bam"},
    {"ID": "0", "PN": "vg", "PP": "ft.1"},
    {"ID": "ft.2", "PN": "ft", "PP": "0", "CL": "ft pg-pansn --strip out.bam"},
    {"ID": "fiberhmm-lift", "PN": "fiberhmm-lift", "PP": "ft.2", "VN": "3.1.0",
     "CL": "fiberhmm-lift -i in.bam -o out.bam",
     "DS": "graph lift repair; mode=lift; source=asmA target=asmB; graph=graph.gbz; calmd=yes; "
           "st_swapped=3; coord=molecular"},
]
# Native vg alignments: not lifts.
NATIVE_VG_HEADERS = [
    [{"ID": "0", "PN": "vg"}],
    [{"ID": "vg", "PN": "vg", "CL": "vg giraffe -Z graph.gbz -f reads.fq"}],
    [{"ID": "0", "PN": "vg"}, {"ID": "samtools", "PN": "samtools", "PP": "0", "CL": "samtools sort"}],
]


@pytest.fixture(params=["fiberhmm", "mirror"])
def lift_rule(request, monkeypatch):
    """Each header test runs with FiberHMM's own rule (when importable) and with the mirror forced."""
    if request.param == "mirror":
        monkeypatch.setattr(graph_lift, "_fiberhmm_rule", None)
    elif graph_lift._fiberhmm_header_lift_state() is None:
        pytest.skip("this FiberHMM has no fiberhmm.io.graph_lift")
    return request.param


def _header(pgs, rg=()):
    return {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": CHROM_LEN}],
            **({"PG": pgs} if pgs else {}), **({"RG": [{"ID": r} for r in rg]} if rg else {})}


def _record(header, name, start, length, *, seq=None, reverse=False, mapq=60, tags=(), flag_extra=0, cigar=None):
    read = pysam.AlignedSegment(header)
    read.query_name = name
    read.reference_id = 0
    read.reference_start = start
    seq = seq or ("ACGT" * (length // 4 + 1))[:length]
    read.query_sequence = seq
    read.cigarstring = cigar or f"{len(seq)}M"
    read.flag = (16 if reverse else 0) | flag_extra
    read.mapping_quality = mapq
    read.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
    for tag, value, kind in tags:
        read.set_tag(tag, value, value_type=kind)
    return read


def _write_bam(path, pgs, specs, rg=()):
    header = pysam.AlignmentHeader.from_dict(_header(pgs, rg))
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


SEQ = ("ACGT" * 2500)[:10_000]


def _split_molecule_specs():
    """m1's primary and a supplementary as a stashed lift wrote them (Yf: the source
    FLAG; the supplementary lost 0x800), a soft-clipped supplementary of an
    unstashed lift (no evidence: shown) and a lone molecule m2."""
    ma = [("MA", "10000;nuc+Q:101-150", "Z")]
    return [
        (("m1", 1_000, 0), {"seq": SEQ, "tags": ma + [("Yf", 0, "i")]}),
        (("m1", 12_000, 0), {"seq": SEQ[:3_000], "tags": ma + [("Yf", 2048, "i"), ("Yh", "S:7000,0", "Z")]}),
        (("m1", 16_000, 0), {"seq": SEQ, "cigar": "7000S3000M", "mapq": 5}),
        (("m2", 2_000, 4_000), {}),
    ]


def _names(reads):
    return sorted((r["id"], r["reference_start"]) for r in reads)


@pytest.mark.parametrize("pgs, hidden", [
    (VG_LIFT_PGS, {("m1", 12_000)}),   # unrepaired lift: the hard-clipped ex-supplementary
    (REPAIRED_PGS, set()),             # repaired: records untouched
    ([], set()),                       # no lift
    *[(pgs, set()) for pgs in NATIVE_VG_HEADERS],
])
def test_ex_supplementaries_hidden_only_in_unrepaired_lifts(tmp_path, lift_rule, pgs, hidden):
    path = _write_bam(tmp_path / "x.bam", pgs, _split_molecule_specs())
    everything = {("m1", 1_000), ("m1", 12_000), ("m1", 16_000), ("m2", 2_000)}
    assert set(_names(_load(path))) == everything - hidden


def test_ex_supplementary_decision_is_view_independent(tmp_path):
    path = _write_bam(tmp_path / "views.bam", VG_LIFT_PGS, _split_molecule_specs())
    full = set(_names(_load(path)))
    # A view holding only the ex-supplementary hides it; one holding only the
    # soft-clipped sibling keeps it: the same answer as the full load.
    assert _names(_load(path, 11_000, 15_000)) == []
    assert _names(_load(path, 17_000, 19_000)) == [("m1", 16_000)]
    for start, end in ((0, 5_000), (500, 13_000), (10_000, CHROM_LEN)):
        assert set(_names(_load(path, start, end))) == {k for k in full if _overlaps(k, start, end)}


def _overlaps(key, start, end):
    spans = {("m1", 1_000): 11_000, ("m1", 16_000): 19_000, ("m2", 2_000): 6_000}
    return key[1] < end and spans[key] > start


def test_stash_flag_decides_and_hard_clipped_primaries_are_kept(tmp_path):
    ma = [("MA", "2500;nuc+Q:101-150", "Z")]
    specs = [
        (("s", 1_000, 2_000), {"tags": [("Yf", 0, "i")]}),             # source primary
        (("s", 5_000, 2_000), {"tags": [("Yf", 2048, "i")]}),          # source supplementary
        (("u", 7_000, 2_000), {"tags": [("Yf", 256, "i")]}),           # source secondary
        # A source primary with hard clips (100H2000M): Yf says primary, so it stays,
        # even though its MA length is longer than its SEQ.
        (("h", 9_000, 2_000), {"tags": [("Yf", 0, "i"), ("Yh", "H:100,0", "Z"), *ma]}),
        # A hard-clipped primary (500H2000M) of an unstashed lift: MA longer than SEQ
        # and an SA tag look like a supplementary's, but without Yf nothing is hidden.
        (("n", 12_000, 2_000), {"tags": [("MA", "2500;nuc+Q:101-150", "Z"),
                                          ("SA", "chr1_A,9001,+,2000S500M,60,0;", "Z")]}),
    ]
    path = _write_bam(tmp_path / "stash.bam", VG_LIFT_PGS, specs)
    assert _names(_load(path)) == [("h", 9_000), ("n", 12_000), ("s", 1_000)]
    from services import dafc_reads
    rows = dafc_reads.query_bam_for_dafc(path, "chr1", 0, CHROM_LEN)
    assert sorted((r["name"], r["start"]) for r in rows) == [("h", 9_000), ("n", 12_000), ("s", 1_000)]
    from types import SimpleNamespace
    from services.bam_handles import get_bam_handle
    from services.read_coverage import compute_binned_read_coverage
    cov = compute_binned_read_coverage([SimpleNamespace(data_type="bam", paths=[path], id="d")], "chr1",
                                       12_000, 14_000, 2, get_bam_handle, lambda _p: None)
    assert cov["reads"] == 1


def test_inference_inputs_exclude_hidden_records(tmp_path):
    from services.signal_bam_input import filtered_bam_inputs, load_signal_region_evidence
    path = _write_bam(tmp_path / "infer.bam", VG_LIFT_PGS, _split_molecule_specs())
    region = dict(chrom="chr1", start=0, end=CHROM_LEN)

    def records(bam_path, *_args, **_kw):
        with pysam.AlignmentFile(bam_path) as bam:
            return [SimpleNamespace(name=r.query_name, start=r.reference_start, library_id=bam_path)
                    for r in bam.fetch("chr1", 0, CHROM_LEN)]

    from types import SimpleNamespace
    loaded = load_signal_region_evidence(records, path, "chr1", 0, CHROM_LEN)
    assert sorted((r.name, r.start) for r in loaded) == [("m1", 1_000), ("m1", 16_000), ("m2", 2_000)]
    assert {r.library_id for r in loaded} == {str((tmp_path / "infer.bam").resolve())}
    # The payload route (all-BAM consensus) gets the same filtered inputs.
    with filtered_bam_inputs([dict(dataset_id="d", paths=[path])], region) as (inputs, replacements):
        assert replacements and len(records(inputs[0]["paths"][0])) == 3
    # A file that is not an unrepaired lift is handed over untouched.
    plain = _write_bam(tmp_path / "infer_plain.bam", REPAIRED_PGS, _split_molecule_specs())
    with filtered_bam_inputs([dict(dataset_id="d", paths=[plain])], region) as (inputs, replacements):
        assert replacements == {} and inputs[0]["paths"] == [plain]


def test_clustering_sample_skips_hidden_records(tmp_path, monkeypatch):
    from services.cluster_sample import prepare_cluster_sample
    from services.read_metrics import DEFAULT_SAMPLE_SEED
    from state.browser_state import BrowserState
    monkeypatch.setenv("FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN", "1")
    monkeypatch.setenv("FIBERBROWSER_SETTINGS", str(tmp_path / "settings.json"))
    specs = [((f"h{i}", 1_000 + 50 * i, 3_000), {"tags": [("Yf", 2048, "i")]}) for i in range(30)]
    specs += [((f"v{i}", 1_200 + 50 * i, 3_000), {"tags": [("Yf", 0, "i")]}) for i in range(3)]
    path = _write_bam(tmp_path / "cluster.bam", VG_LIFT_PGS, specs)
    state = BrowserState(None, reference_only=True)
    state.add_dataset("reads", [path])
    sample = prepare_cluster_sample(state, "reads", "chr1", 0, CHROM_LEN, 2, DEFAULT_SAMPLE_SEED)
    assert sample is not None and sample.total == 3
    assert len(sample.names) == 2 and sample.names <= {"v0", "v1", "v2"}


def test_coverage_skips_hidden_ex_supplementaries(tmp_path):
    from types import SimpleNamespace
    from services.bam_handles import get_bam_handle
    from services.read_coverage import compute_binned_read_coverage
    path = _write_bam(tmp_path / "cov.bam", VG_LIFT_PGS, _split_molecule_specs())
    dataset = SimpleNamespace(data_type="bam", paths=[path], id="d")
    assert _names(_load(path, 11_000, 15_000)) == []
    cov = compute_binned_read_coverage([dataset], "chr1", 11_000, 15_000, 4, get_bam_handle, lambda _p: None)
    assert cov["reads"] == 0 and cov["coverage"] == [0, 0, 0, 0]
    unlifted = _write_bam(tmp_path / "cov_plain.bam", [], _split_molecule_specs())
    dataset = SimpleNamespace(data_type="bam", paths=[unlifted], id="d")
    assert compute_binned_read_coverage([dataset], "chr1", 11_000, 15_000, 4, get_bam_handle,
                                        lambda _p: None)["reads"] == 1


def test_shared_qnames_in_other_read_groups_and_mates_are_kept(tmp_path):
    seq = SEQ[:4_000]
    specs = [
        (("q", 1_000, 0), {"seq": seq, "tags": [("RG", "libA", "Z")]}),
        (("q", 8_000, 0), {"seq": seq[:2_000], "tags": [("RG", "libB", "Z")]}),
        (("p", 3_000, 0), {"seq": seq, "flag_extra": 0x1 | 0x40}),
        (("p", 9_000, 0), {"seq": seq[:1_000], "flag_extra": 0x1 | 0x80}),
    ]
    path = _write_bam(tmp_path / "rg.bam", VG_LIFT_PGS, specs, rg=("libA", "libB"))
    assert len(_load(path)) == 4


def test_header_lift_state(lift_rule):
    assert graph_lift.header_lift_state(_header(VG_LIFT_PGS)) == {"lift": ["0", "ft.1", "ft.2"], "repaired": False}
    assert graph_lift.header_lift_state(_header(REPAIRED_PGS)) == {"lift": [], "repaired": True}
    assert graph_lift.header_lift_state(_header([])) == {"lift": [], "repaired": False}
    for pgs in NATIVE_VG_HEADERS:
        assert graph_lift.header_lift_state(_header(pgs)) == {"lift": [], "repaired": False}, pgs
    # A vg surject CL alone is a lift.
    assert graph_lift.is_unrepaired_lift(_header([{"ID": "vg", "PN": "vg", "CL": "vg surject -x g.gbz -b -"}]))
    # A repaired lift lifted again without repair is unrepaired again.
    relift = REPAIRED_PGS + [{"ID": "ft.3", "PN": "ft", "CL": "ft pg-pansn --prefix asmB#1# x.bam"}]
    assert graph_lift.is_unrepaired_lift(_header(relift))
    # A native vg alignment lifted: its own vg root stays history, the lift's lines are pending.
    lifted_native = [{"ID": "0", "PN": "vg"}, {"ID": "s", "PN": "samtools", "PP": "0", "CL": "samtools sort"},
                     {"ID": "ft.1", "PN": "ft", "PP": "s", "CL": "ft pg-pansn --prefix asmA#1# in.bam"}]
    assert graph_lift.header_lift_state(_header(lifted_native))["lift"] == ["ft.1"]


def test_lift_summary_reads_the_fiberhmm_lift_pg(lift_rule):
    summary = graph_lift.lift_summary(_header(REPAIRED_PGS))
    assert summary["source"] == "asmA" and summary["target"] == "asmB"
    assert summary["graph"] == "graph.gbz" and summary["calmd"] == "yes" and summary["repaired"]
    assert graph_lift.lift_summary_text(summary) == "asmA → asmB · graph graph.gbz · MD/NM recomputed"
    unrepaired = graph_lift.lift_summary(_header(VG_LIFT_PGS))
    assert unrepaired["unrepaired"] and "--repair-only" in graph_lift.lift_summary_text(unrepaired)
    assert graph_lift.lift_summary(_header([])) is None
    for pgs in NATIVE_VG_HEADERS:
        assert graph_lift.lift_summary(_header(pgs)) is None


def test_lift_summary_text_without_recorded_assemblies():
    # fiberhmm-lift --repair-only without --prefix/--target records neither assembly.
    pgs = [dict(REPAIRED_PGS[-1], DS="graph lift repair; mode=repair-only; source=unknown target=unknown; "
                                     "graph=unknown; calmd=no; coord=molecular")]
    assert graph_lift.lift_summary_text(graph_lift.lift_summary(_header(pgs))) == \
        "repaired by fiberhmm-lift · MD/NM/SA dropped"


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
        (("dot_st", 1_000, 0), {"seq": seq_ga, "tags": [("st", ".", "Z")]}),
    ]
    path = _write_bam(tmp_path / "st.bam", [], specs)
    reads = {r["id"]: r for r in _load(path, include_methylation=True)}
    assert reads["flipped"]["strand"] == "CT" and reads["flipped"]["strand_conflict"] is True
    assert read_strand(reads["flipped"]) == "CT"            # FiberHMM's rule: st decides
    assert reads["agrees"]["strand"] == "CT" and "strand_conflict" not in reads["agrees"]
    assert "strand" not in reads["no_st"] and read_strand(reads["no_st"]) == "GA"   # no st: R/Y marks decide
    # st present but neither CT nor GA: FiberHMM gives no strand, whatever the marks say.
    assert reads["dot_st"]["strand"] == "." and read_strand(reads["dot_st"]) is None
    from services.bam_handles import get_bam_handle
    by_name = {r.query_name: r for r in get_bam_handle(path).fetch("chr1")}
    assert record_strand_fields(by_name["no_st"]) == {}
    assert record_strand_fields(by_name["dot_st"]) == {"strand": "."}


def test_per_record_st_wins_over_the_name_cache(tmp_path):
    from services.read_strand import filter_reads_by_strand
    seq = "ACGTACGTAC" * 30
    specs = [((("q", 1_000 + 100 * i, 0)), {"seq": seq, "tags": [("st", st, "Z"), ("RG", rg, "Z")]})
             for i, (st, rg) in enumerate((("CT", "a"), ("GA", "b"), (".", "c")))]
    path = _write_bam(tmp_path / "st_rg.bam", [], specs, rg=("a", "b", "c"))
    reads = _load(path, include_methylation=True)
    calls: dict = {}
    assert [r["strand"] for r in filter_reads_by_strand(reads, "CT", calls)] == ["CT"]
    assert [r["strand"] for r in filter_reads_by_strand(reads, "GA", calls)] == ["GA"]


def test_lift_provenance_on_reads(tmp_path):
    specs = [(("r", 1_000, 2_000), {"tags": [("Yp", "chr1_A:1141849:-", "Z"), ("Yq", 7, "i")]}),
             (("plain", 1_000, 2_000), {})]
    path = _write_bam(tmp_path / "prov.bam", REPAIRED_PGS, specs)
    reads = {r["id"]: r for r in _load(path)}
    assert reads["r"]["lift"] == {"from": "chr1_A:1141849:-", "mapq": 7}
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
    specs.append((("dot", 1_100, 0), {"seq": seq_ga, "tags": [("st", ".", "Z")]}))
    path = _write_bam(tmp_path / "diag.bam", VG_LIFT_PGS, specs)
    result = diagnose_bam_payload(None, bam_path=path)
    assert result["st_strand_conflicts"] == 4 and result["st_strand_reads"] == 4
    text = "\n".join(result["recommendations"])
    assert "fiberhmm-lift --repair-only -i <lifted.bam>" in text
    assert "4 of 4 sampled DAF reads" in text and "repair fixes" in text

    repaired = _write_bam(tmp_path / "diag_ok.bam", REPAIRED_PGS, [(("r", 1_000, 2_000), {})])
    result = diagnose_bam_payload(None, bam_path=repaired)
    assert result["graph_lift_text"].startswith("asmA → asmB")
    assert not any("pangenome" in r or "st:Z" in r for r in result["recommendations"])

    native = _write_bam(tmp_path / "diag_vg.bam", NATIVE_VG_HEADERS[1], [(("r", 1_000, 2_000), {})])
    result = diagnose_bam_payload(None, bam_path=native)
    assert result["graph_lift"] is None and not any("pangenome" in r for r in result["recommendations"])


def test_diagnose_counts_empty_ma_groups_as_present(tmp_path):
    from services.bam_diagnostics import diagnose_bam_tags
    specs = [(("r", 1_000, 2_000), {"tags": [("Ma", "2000;nuc.:;msp.:1-2000", "Z")]}),
             (("e", 1_500, 2_000), {"tags": [("Ma", "2000;nuc.:101-150;msp.:", "Z")]})]
    path = _write_bam(tmp_path / "empty_groups.bam", [], specs)
    missing = " ".join(diagnose_bam_tags(path)["fiberseq_missing"])
    for tag in ("ns ", "nl ", "nq ", "as ", "al ", "aq "):
        assert tag not in missing, missing
    only_empty = _write_bam(tmp_path / "only_empty.bam", [], specs[:1])
    missing = " ".join(diagnose_bam_tags(only_empty)["fiberseq_missing"])
    assert "ns " not in missing and "nl " not in missing and "nq " not in missing
    # Nucleosome calling ran and found none: no "run ft add-nucleosomes" advice.
    from array import array
    from services.files_endpoint import diagnose_bam_payload
    with_m6a = _write_bam(tmp_path / "empty_m6a.bam", [], [(("r", 1_000, 2_000), {"tags": [
        ("Ma", "2000;nuc.:;msp.:1-2000", "Z"), ("MM", "A+a?,0,1;", "Z"), ("ML", array("B", [250, 250]), None)]})])
    result = diagnose_bam_payload(None, bam_path=with_m6a)
    assert result["has_ma_nucleosome_calls"] and not result["has_ma_nucleosomes"]
    assert not any("add-nucleosomes" in r for r in result["recommendations"]), result["recommendations"]


def _inspect(path):
    from services import library_inspect
    st = os.stat(path)
    return library_inspect.inspect_bam(path, {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "inode": st.st_ino})


def test_library_inspect_records_the_lift(tmp_path):
    path = _write_bam(tmp_path / "lib.bam", REPAIRED_PGS, [(("r", 1_000, 2_000), {})])
    assert _inspect(path)["graph_lift"]["text"] == "asmA → asmB · graph graph.gbz · MD/NM recomputed"
    plain = _write_bam(tmp_path / "plain.bam", [], [(("r", 1_000, 2_000), {})])
    assert _inspect(plain)["graph_lift"] is None


def test_library_entries_read_before_lift_provenance_are_read_again(tmp_path):
    from services import library_inspect
    path = _write_bam(tmp_path / "old.bam", REPAIRED_PGS, [(("r", 1_000, 2_000), {})])
    info = library_inspect.inspect_file(path)
    assert not library_inspect.extras_stale(info, path)
    info.pop("graph_lift")
    assert library_inspect.extras_stale(info, path)
    # Not lifted: recorded as None, so it is not read again on every scan.
    plain = _write_bam(tmp_path / "plain.bam", [], [(("r", 1_000, 2_000), {})])
    info = library_inspect.inspect_file(plain)
    assert info["graph_lift"] is None and not library_inspect.extras_stale(info, plain)
