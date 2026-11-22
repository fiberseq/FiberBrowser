"""Read rows take footprints and accessibility from the MA call groups; legacy ns/nl and as/al are read only when
the record has no MA call group. FiberHMM 3.2 can write MA without the legacy tags, and such records must draw the
same rows as records carrying both."""
from array import array
from pathlib import Path

import pysam
import pytest

from services import bam_tags, compact_read_loader

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
LEGACY = ("ns", "nl", "nq", "lq", "rq", "as", "al", "aq")
ROW_KEYS = ("intervals", "fire", "layers")


def _demo_window():
    with pysam.AlignmentFile(str(DEMO)) as bam:
        read = next(r for r in bam.fetch() if r.has_tag("MA"))
        return read.reference_name, read.reference_start, read.reference_start + 4000


def _rewrite(tmp_path, name, edit):
    out = tmp_path / name
    with pysam.AlignmentFile(str(DEMO)) as src, pysam.AlignmentFile(str(out), "wb", template=src) as dst:
        for read in src:
            edit(read)
            dst.write(read)
    pysam.index(str(out))
    return out


def _rows(path):
    chrom, start, end = _demo_window()
    reads = compact_read_loader.build_compact_reads_from_bam(str(path), chrom, start, end, spanning_only=False)
    return {r["id"]: {k: r.get(k) for k in ROW_KEYS} for r in reads}


def _strip(read):
    # Only records with MA lose their legacy tags (a few demo records carry legacy tags alone).
    if not read.has_tag("MA"):
        return
    for tag in LEGACY:
        if read.has_tag(tag):
            read.set_tag(tag, None)


def _stale(read):
    # Legacy arrays that disagree with MA: one bogus footprint and one bogus accessible run.
    if read.has_tag("MA"):
        read.set_tag("ns", array("I", [5]))
        read.set_tag("nl", array("I", [40]))
        read.set_tag("nq", array("B", [1]))
        read.set_tag("as", array("I", [100]))
        read.set_tag("al", array("I", [9]))


@pytest.fixture(scope="module")
def reference_rows():
    if not DEMO.exists():
        pytest.skip("demo BAM not present")
    return _rows(DEMO)


def test_demo_window_has_forward_and_reverse_reads_with_calls(reference_rows):
    assert len(reference_rows) >= 20
    assert any(len(r["intervals"]) > 3 for r in reference_rows.values())
    assert any(r["fire"] for r in reference_rows.values())


def test_ma_only_records_draw_the_same_rows_as_ma_plus_legacy(tmp_path, reference_rows):
    stripped = _rows(_rewrite(tmp_path, "ma_only.bam", _strip))
    assert stripped.keys() == reference_rows.keys()
    differing = [rid for rid in reference_rows if stripped[rid] != reference_rows[rid]]
    assert differing == []


def test_stale_legacy_tags_beside_ma_are_ignored(tmp_path, reference_rows):
    stale = _rows(_rewrite(tmp_path, "stale.bam", _stale))
    differing = [rid for rid in reference_rows if stale[rid] != reference_rows[rid]]
    assert differing == []


def test_legacy_only_records_still_draw_from_legacy(tmp_path, reference_rows):
    def drop_ma(read):
        for tag in ("MA", "AQ"):
            if read.has_tag(tag):
                read.set_tag(tag, None)

    legacy = _rows(_rewrite(tmp_path, "legacy_only.bam", drop_ma))
    shared = [rid for rid in reference_rows if rid in legacy]
    assert len(shared) > 0.95 * len(reference_rows)
    # Without MA the rows come from ns/nl and as/al, which FiberHMM wrote from the same calls.
    assert any(len(legacy[rid]["intervals"]) > 3 for rid in shared)
    assert [rid for rid in shared
            if sorted(legacy[rid]["fire"] or []) != sorted(reference_rows[rid]["fire"] or [])] == []


class _Read:
    is_unmapped = is_secondary = is_supplementary = is_duplicate = is_qcfail = False
    query_sequence = "A" * 200
    query_length = 200
    query_name = "r"
    reference_start, reference_end = 100, 300
    cigartuples = [(0, 200)]

    def __init__(self, tags, is_reverse):
        self.tags = tags
        self.is_reverse = is_reverse

    def get_tag(self, tag):
        if tag not in self.tags:
            raise KeyError(tag)
        return self.tags[tag]

    def has_tag(self, tag):
        return tag in self.tags

    def get_tags(self):
        return list(self.tags.items())


class _MolecularBam:
    header = {"CO": ["fiberhmm:coord=molecular"]}
    references = ("chr2L",)

    def __init__(self, reads):
        self.reads = reads

    def fetch(self, *_args, **_kwargs):
        return self.reads


@pytest.mark.parametrize("is_reverse, expected, edges", [(False, [[10, 130, 120]], [[80], [5], [6]]),
                                                         (True, [[70, 190, 120]], [[80], [6], [5]])])
def test_stale_legacy_beside_molecular_ma_uses_ma_on_both_strands(is_reverse, expected, edges):
    tags = {"MA": "200;nuc+QQQ:11-120", "AQ": [80, 5, 6],
            "ns": [40], "nl": [100], "nq": [1], "lq": [2], "rq": [3]}
    rows = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 300, spanning_only=False,
        bam_handle_getter=lambda _p: _MolecularBam([_Read(tags, is_reverse)]), chrom_map={"2L": "chr2L"})
    assert rows[0]["intervals"] == expected
    assert rows[0]["layers"]["nuc"]["qualities"] == edges


def test_legacy_footprints_fill_a_family_ma_does_not_carry():
    # A legacy-tagged record given an MA TF group by a later tool: MA has no nuc or msp group, so ns/nl are read.
    tags = {"MA": "200;tf+Q:161-10", "AQ": [200], "ns": [10], "nl": [120], "nq": [80], "lq": [5], "rq": [6]}
    rows = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 300, spanning_only=False,
        bam_handle_getter=lambda _p: _MolecularBam([_Read(tags, False)]), chrom_map={"2L": "chr2L"})
    assert rows[0]["intervals"][0] == [10, 130, 120]


# --- ma_call_arrays -------------------------------------------------------------------------------------------

def test_ma_call_arrays_returns_none_without_call_groups():
    assert bam_tags.ma_call_arrays(None, None) is None
    assert bam_tags.ma_call_arrays("", []) is None
    assert bam_tags.ma_call_arrays("200", []) is None


def test_ma_call_arrays_maps_nuc_and_msp_with_quality_bytes():
    out = bam_tags.ma_call_arrays("200;nuc+QQQ:11-120;msp+Q:131-20,1-10", [80, 5, 6, 9, 7], read_length=200)
    starts, lengths, nq, lq, rq = out["nuc"]
    assert (starts, lengths, nq, lq, rq) == ([10], [120], [80], [5], [6])
    a_starts, a_lengths, aq = out["msp"]
    # Sorted by start; AQ bytes follow MA order (131-20 -> 9, 1-10 -> 7).
    assert (a_starts, a_lengths, aq) == ([0, 130], [10, 20], [7, 9])


def test_ma_call_arrays_msp_only_record_has_no_nuc_group():
    out = bam_tags.ma_call_arrays("200;msp+Q:51-30", [200], read_length=200)
    assert "nuc" not in out
    assert out["msp"][:2] == ([50], [30])


def test_ma_call_arrays_flips_molecular_reverse_reads_and_swaps_edges():
    out = bam_tags.ma_call_arrays("200;nuc+QQQ:11-120", [80, 5, 6], tags_are_molecular=True,
                                  read_length=200, is_reverse=True)
    starts, lengths, nq, lq, rq = out["nuc"]
    assert (starts, lengths, nq, lq, rq) == ([70], [120], [80], [6], [5])


def test_ma_call_arrays_steps_over_unnamed_and_other_group_bytes():
    out = bam_tags.ma_call_arrays("200;tf+Q:1-5;nuc+QQQ:11-120", [3, 80, 5, 6], read_length=200)
    assert out["nuc"][2:] == ([80], [5], [6])


# --- the other row builders: dense loader, DAF-C reads, Min footprints count ------------------------------------

@pytest.fixture(scope="module")
def variant_bams(tmp_path_factory):
    if not DEMO.exists():
        pytest.skip("demo BAM not present")
    tmp = tmp_path_factory.mktemp("ma_first")
    return {"ma_only": _rewrite(tmp, "ma_only.bam", _strip), "stale": _rewrite(tmp, "stale.bam", _stale)}


def _dense(path):
    from services.dense_bam_loader import load_reads_from_bam
    chrom, start, end = _demo_window()
    frame = load_reads_from_bam(str(path), chrom, start, end, spanning_only=False)
    return frame.set_index("read_id").sort_index()


@pytest.mark.parametrize("variant", ["ma_only", "stale"])
def test_dense_loader_reads_ma_first(variant_bams, variant):
    import pandas as pd
    reference = _dense(DEMO)
    assert len(reference) >= 20
    pd.testing.assert_frame_equal(_dense(variant_bams[variant]), reference)


def _dafc(path):
    from services.dafc_reads import query_bam_for_dafc
    chrom, start, end = _demo_window()
    entries = query_bam_for_dafc(str(path), chrom, start, end, hide_uncalled=False)
    return sorted(entries, key=lambda e: (e["name"], e["start"]))


@pytest.mark.parametrize("variant", ["ma_only", "stale"])
def test_dafc_reads_take_footprints_from_ma_first(variant_bams, variant):
    reference = _dafc(DEMO)
    assert any(e["blockCount"] > 3 for e in reference)
    assert _dafc(variant_bams[variant]) == reference


def test_min_footprints_count_ignores_stale_legacy_beside_ma(variant_bams):
    from services.bam_tags import footprint_call_count
    with pysam.AlignmentFile(str(DEMO)) as a, pysam.AlignmentFile(str(variant_bams["stale"])) as b:
        pairs = [(x, y) for x, y in zip(a, b) if x.has_tag("MA")][:300]
    assert pairs
    assert [footprint_call_count(x) for x, _ in pairs] == [footprint_call_count(y) for _, y in pairs]
    assert any(footprint_call_count(y) > 1 for _, y in pairs)


# --- end to end: a real FiberHMM run written without legacy tags ------------------------------------------------

def _fiberhmm_call(src, out, *extra):
    import subprocess
    import sys
    code = ("import sys; from fiberhmm.cli._entry import call_main; sys.argv = ['fiberhmm-call'] + sys.argv[1:]; "
            "sys.exit(call_main())")
    proc = subprocess.run([sys.executable, "-c", code, "-i", str(src), "-o", str(out), "--enzyme", "ddda",
                           "--seq", "pacbio", "-c", "2", "--no-qc", *extra],
                          capture_output=True, text=True, timeout=900)
    assert proc.returncode == 0, proc.stderr[-2000:]
    return out


def test_fiberhmm_no_legacy_tags_output_draws_the_same_rows(tmp_path):
    fiberhmm = pytest.importorskip("fiberhmm")
    from fiberhmm.cli import call as call_cli
    if "--no-legacy-tags" not in open(call_cli.__file__).read():
        pytest.skip(f"FiberHMM {fiberhmm.__version__} cannot write MA without legacy tags")
    if not DEMO.exists():
        pytest.skip("demo BAM not present")
    # The demo's reads with every annotation removed, called twice: with and without the legacy tags.
    src = tmp_path / "input.bam"
    with pysam.AlignmentFile(str(DEMO)) as bam, pysam.AlignmentFile(str(src), "wb", template=bam) as out:
        for n, read in enumerate(bam):
            if n >= 400:
                break
            for tag in (*LEGACY, "MA", "AQ", "AN"):
                if read.has_tag(tag):
                    read.set_tag(tag, None)
            out.write(read)
    pysam.index(str(src))
    with_legacy = _fiberhmm_call(src, tmp_path / "with_legacy.bam")
    ma_only = _fiberhmm_call(src, tmp_path / "ma_only.bam", "--no-legacy-tags")
    with pysam.AlignmentFile(str(ma_only)) as bam:
        records = list(bam)
    assert records and not any(r.has_tag("ns") or r.has_tag("as") for r in records)
    assert sum(r.has_tag("MA") for r in records) > 0.9 * len(records)

    reference = _rows(with_legacy)
    assert sum(len(r["intervals"]) > 3 for r in reference.values()) > 0.5 * len(reference)
    assert _rows(ma_only) == reference
    import pandas as pd
    pd.testing.assert_frame_equal(_dense(ma_only), _dense(with_legacy))


@pytest.mark.parametrize("variant", ["ma_only", "stale"])
def test_run_summary_and_fire_verdict_read_ma_first(variant_bams, variant):
    from services import fire_quality
    from services.pipeline_jobs import _count_bam
    assert _count_bam(str(variant_bams[variant]), 10_000) == _count_bam(str(DEMO), 10_000)
    assert fire_quality.file_fire_status(variant_bams[variant]) == fire_quality.file_fire_status(DEMO)


def _scored_bam(path, legacy, legacy_span=(140, 20)):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 100_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for k in range(60):
            r = pysam.AlignedSegment(out.header)
            r.query_name, r.reference_id, r.reference_start, r.mapping_quality = f"r{k}", 0, 1000 + 10 * k, 60
            r.query_sequence = "ACGT" * 50
            r.cigarstring = "200M"
            r.set_tag("MA", "200;nuc+QQQ:11-110;msp+Q:131-70")
            r.set_tag("AQ", array("B", [200, 255, 255, 220]))
            if legacy:
                r.set_tag("as", array("I", [legacy_span[0]]))
                r.set_tag("al", array("I", [legacy_span[1]]))
                r.set_tag("aq", array("B", [0]))
            out.write(r)
    pysam.index(str(path))
    return path


def test_stale_legacy_scores_beside_ma_never_make_a_file_fire(tmp_path):
    # Codex R15: stale legacy as/al/aq (other stretches, aq 0) beside an MA msp group decided the FIRE verdict,
    # which then let the loader read those stale stretches.
    from services import fire_quality
    clean = fire_quality.file_fire_status(_scored_bam(tmp_path / "clean.bam", False))
    # [140, 160): other stretches; [0, 70): the MA stretch [130, 200) mirrored, on forward reads (Codex R16).
    for name, span in (("stale", (140, 20)), ("mirrored", (0, 70))):
        stale = fire_quality.file_fire_status(_scored_bam(tmp_path / f"{name}.bam", True, span))
        assert stale == clean and stale["fire"] is False, name
        rows = {r["id"]: r for r in compact_read_loader.build_compact_reads_from_bam(
            str(tmp_path / f"{name}.bam"), "chrT", 1000, 2000, spanning_only=False)}
        assert rows["r0"]["fire"] == [[130, 200, 128]], name


def test_fire_verdict_reads_molecular_ma_on_reverse_reads_in_its_header_frame(tmp_path):
    # Codex R17: the verdict decoded MA without the header's frame, so on reverse molecular reads MA and matching
    # legacy stretches were compared in different frames.
    from services import fire_quality
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 100_000}],
              "CO": ["fiberhmm:coord=molecular"]}

    def write(path, legacy_start):
        with pysam.AlignmentFile(str(path), "wb", header=header) as out:
            for k in range(60):
                r = pysam.AlignedSegment(out.header)
                r.query_name, r.reference_id, r.reference_start, r.mapping_quality = f"r{k}", 0, 1000 + 10 * k, 60
                r.query_sequence = "ACGT" * 50
                r.cigarstring = "200M"
                r.flag = 16
                r.set_tag("MA", "200;msp+Q:131-70")
                r.set_tag("AQ", array("B", [220]))
                r.set_tag("as", array("I", [legacy_start]))
                r.set_tag("al", array("I", [70]))
                r.set_tag("aq", array("B", [0]))
                out.write(r)
        pysam.index(str(path))
        return path

    fire_quality._CACHE.clear()
    # The same stretch in both forms (molecular [130, 200)): the legacy aq are rescores of the MA's stretches.
    same = fire_quality.file_fire_status(write(tmp_path / "same.bam", 130))
    # A stale stretch that only equals the MA one if the frames are mixed up.
    stale = fire_quality.file_fire_status(write(tmp_path / "stale.bam", 0))
    assert same["basis"] == "score pattern" and same["fire"] is True
    assert stale["fire"] is False
