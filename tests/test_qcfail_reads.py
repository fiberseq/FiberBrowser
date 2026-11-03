"""SAM QC-fail policy, including FiberHMM strand-swap chimeras."""
from array import array

import pysam
import pytest

from models.requests import ReadStatsRequest
from services.analysis_query import AnalysisReadQuery
from services.read_auxiliary_endpoint import get_coverage_payload
from services.read_stats import compute_read_stats
from services.signal_counts import signal_counts
from services.snp_scan import keep_record
from services.sv_endpoint import classify_records
from test_circular_origin_spanning import CONTIG, L, _payload, _record, _sequence, _state


@pytest.fixture
def qc_bam(tmp_path):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"},
                                              "SQ": [{"SN": CONTIG, "LN": L}]})
    tags = {"ns": array("i", [20]), "nl": array("i", [100])}
    records = [_record(header, "unique", 100, 300, _sequence(), tags=tags),
               _record(header, "duplicate", 100, 300, _sequence(), tags=tags, flag=0x400),
               _record(header, "chimera", 100, 300, _sequence(), tags={"xc": "strand_swap"}, flag=0x200),
               _record(header, "other_qcfail", 100, 300, _sequence(), tags=tags, flag=0x200),
               _record(header, "both", 100, 300, _sequence(), tags={"xc": "strand_swap"}, flag=0x600),
               _record(header, "chimera", 150, 200, _sequence(), tags={"xc": "strand_swap"}, flag=0xA00),
               _record(header, "chimera", 200, 150, _sequence(), tags={"xc": "strand_swap"}, flag=0x300)]
    path = tmp_path / "qc.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in records:
            out.write(read)
    pysam.index(str(path))
    return str(path)


@pytest.mark.parametrize("include_qcfail", [False, True])
@pytest.mark.parametrize("include_duplicates", [False, True])
def test_panel_coverage_and_hidden_counts(qc_bam, include_qcfail, include_duplicates):
    state = _state({"bam": qc_bam})
    options = dict(include_qcfail=include_qcfail, include_duplicates=include_duplicates)
    # Exercise both the default working set and the opt-in direct path, then cache reuse.
    payload, reads = _payload(state, 0, 500, **options)
    expected = {"unique"} | ({"duplicate"} if include_duplicates else set())
    if include_qcfail:
        expected |= {"chimera", "other_qcfail"} | ({"both"} if include_duplicates else set())
    assert set(reads) == expected
    assert len(payload["reads"]) == len(expected)  # never display secondary/supplementary copies
    assert set(_payload(state, 0, 500, **options)[1]) == expected
    assert get_coverage_payload(state, chrom=CONTIG, start=0, end=500, bins=1, **options)["coverage"] == [len(expected)]
    counts = payload["signal_counts"]
    assert counts["qcfail_hidden"] == (0 if include_qcfail else 3)
    assert counts["chimera_hidden"] == (0 if include_qcfail else 2)
    assert counts["duplicate_hidden"] == (0 if include_duplicates else 2)
    assert counts["total"] == len(expected)
    if include_qcfail:
        assert reads["chimera"]["chimera"] == "strand_swap"
        assert reads["chimera"]["qcfail"] is True
        assert reads["other_qcfail"]["qcfail"] is True
        assert "chimera" not in reads["other_qcfail"]


def test_cold_and_cached_counts_match(qc_bam):
    state = _state({"bam": qc_bam})
    cold = signal_counts(state, "wrap", CONTIG, 0, 500)
    _payload(state, 0, 500)
    state._signal_counts_cache.clear()
    assert signal_counts(state, "wrap", CONTIG, 0, 500) == cold
    # A narrower view uses the sidecar with independent policy flags.
    assert signal_counts(state, "wrap", CONTIG, 50, 450)["chimera_hidden"] == 2
    assert signal_counts(state, "wrap", CONTIG, 50, 450, include_qcfail=True)["total"] == 3


def test_analysis_working_set_and_bam_analyses_exclude_qcfail(qc_bam):
    state = _state({"bam": qc_bam})
    query = AnalysisReadQuery.from_request(state, chrom=CONTIG, start=0, end=500, dataset_id="wrap")
    assert {r["id"] for r in query.build_working_set(state, "wrap").reads} == {"unique"}
    with pysam.AlignmentFile(qc_bam) as bam:
        records = [(r, CONTIG) for r in bam.fetch() if not r.is_secondary and not r.is_supplementary]
    assert {r.query_name for r, _ in records if keep_record(r, 0, False)} == {"unique"}
    assert {r.query_name for r, _ in records if keep_record(r, 0, False, True)} == {"unique", "chimera", "other_qcfail"}
    classified = classify_records(records, t="I", ref=200, length=50)
    assert set(classified) == {"unique"}
    assert set(classify_records(records, t="I", ref=200, length=50, include_qcfail=True)) == {"unique", "chimera", "other_qcfail"}


def test_read_inspector_honors_qcfail_policy(qc_bam):
    state = _state({"bam": qc_bam})
    ids = {"wrap": ["unique", "chimera", "other_qcfail"]}
    def stats(show):
        return compute_read_stats(state, CONTIG, 0, 500, False,
                                  ReadStatsRequest(read_ids_by_dataset=ids, include_qcfail=show))
    assert {r["read_id"] for r in stats(False)["per_read"]} == {"unique"}
    shown = {r["read_id"]: r for r in stats(True)["per_read"]}
    assert set(shown) == set(ids["wrap"])
    assert shown["chimera"]["chimera"] == "strand_swap"
    assert shown["other_qcfail"]["qcfail"] is True
    assert shown["other_qcfail"]["footprint_count"] == 1


def test_dense_loader_excludes_qcfail(qc_bam):
    from services.dense_bam_loader import load_reads_from_bam
    frame = load_reads_from_bam(qc_bam, CONTIG, 100, 400)
    assert set(frame["read_id"]) == {"unique", "duplicate"}


@pytest.mark.parametrize("endpoint", ["info", "image", "meta", "meta_all"])
def test_legacy_payloads_exclude_qcfail(qc_bam, endpoint):
    from services import read_auxiliary_endpoint as api
    state = _state({"bam": qc_bam})
    options = dict(chrom=CONTIG, start=100, end=400)
    if endpoint == "info":
        assert api.get_reads_info_payload(state, **options) == {"count": 2}
    elif endpoint == "image":
        payload = api.get_reads_image_payload(state, **options)
        assert payload["headers"]["X-Read-Count"] == "2"
        assert payload["content"].startswith(b"\x89PNG")
    else:
        # Both eligible reads have a 100-bp footprint at 120..220. The
        # untagged chimeras would dilute its occupancy if they entered the profile.
        if endpoint == "meta":
            profile = api.get_meta_payload(state, **options)
        else:
            profile = api.get_meta_all_payload(state, **options)["profiles"]["wrap"]
        assert profile["nucleosome_profile"][30] == 1.0


@pytest.fixture(params=[0x200, 0x400], ids=["qcfail", "duplicate"])
def competing_insertions(tmp_path, request):
    """A valid 100-bp insert outnumbered by hidden 1,000-bp carriers."""
    path = tmp_path / "insertions.bam"
    header = {"HD": {"SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 2000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i in range(6):
            length = 100 if i == 0 else 1000
            read = pysam.AlignedSegment(out.header)
            read.query_name = "valid" if i == 0 else f"hidden_{i}"
            read.reference_id = 0
            read.reference_start = 100
            read.flag = 0 if i == 0 else request.param
            read.cigartuples = [(0, 200), (1, length), (0, 200)]
            read.query_sequence = "A" * (400 + length)
            read.mapping_quality = 60
            out.write(read)
    pysam.index(str(path))
    return str(path), request.param


@pytest.mark.parametrize("show", [False, True])
def test_position_based_insertion_selects_only_visible_carriers(competing_insertions, show):
    from services.insertion_lens import classify_site
    path, flag = competing_insertions
    options = {"include_qcfail" if flag == 0x200 else "include_duplicates": show}
    site = classify_site([path], "chrT", pos=300, **options)
    assert site["success"]
    assert site["length"] == (1000 if show else 100)
    assert {read.query_name for _plan, read, _path, _bam in site["carriers"]} == (
        {f"hidden_{i}" for i in range(1, 6)} if show else {"valid"})


def test_position_based_lens_ignores_hidden_carriers(competing_insertions):
    from services.insertion_lens import build_lens
    path, _flag = competing_insertions
    lens = build_lens([path], "chrT", pos=300, flank=100)
    assert lens["success"]
    assert lens["sv"]["len"] == 100
    assert {read["id"] for read in lens["carriers"]} == {"valid"}


def test_position_based_alt_allele_ignores_hidden_carriers(competing_insertions, tmp_path):
    from services.alt_allele import build_alt_allele, normalize_definition
    path, _flag = competing_insertions
    definition = normalize_definition({"chrom": "chrT", "pos": 300, "flank": 100})
    meta = build_alt_allele([path], definition, str(tmp_path / "alt"))
    assert meta["layout"]["insert_len"] == 100
    with pysam.AlignmentFile(str(tmp_path / "alt" / "carriers.bam")) as bam:
        assert {read.query_name for read in bam.fetch()} == {"valid"}
