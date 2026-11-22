"""First paint (services/first_paint.py) follows the read track's duplicate / QC-fail toggles (3.1.1 deferred MED).

The alignment-extent pass that ranks candidate reads and estimates the view's depth read every mapped,
non-secondary record, so hidden duplicate (0x400) and QC-fail (0x200) reads were ranked, decoded only to be
dropped, and counted in the partial response's ``total_estimate``. The pass now applies the same read policy
the loader applies to the request.
"""
from __future__ import annotations

from types import SimpleNamespace

import pysam
import pytest

from services import first_paint as FP


def _bam(path):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 100_000}]}
    rows = [("ok_short", 1000, 200, 0), ("dup_long", 900, 2000, 0x400), ("qcfail_long", 900, 2000, 0x200),
            ("ok_long", 950, 1500, 0)]
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, start, length, flag in sorted(rows, key=lambda r: r[1]):
            seg = pysam.AlignedSegment(out.header)
            seg.query_name = name
            seg.flag = flag
            seg.reference_id = 0
            seg.reference_start = start
            seg.mapping_quality = 60
            seg.cigartuples = [(0, length)]
            seg.query_sequence = "A" * length
            seg.query_qualities = pysam.qualitystring_to_array("I" * length)
            out.write(seg)
    pysam.index(str(path))
    return str(path)


@pytest.fixture
def setup(tmp_path):
    path = _bam(tmp_path / "policy.bam")
    state = SimpleNamespace(performance={}, chrom_map={})
    dataset = SimpleNamespace(id="d", paths=[path], data_type="bam")
    return state, dataset


def test_hidden_duplicate_and_qcfail_reads_are_not_candidates(setup):
    state, dataset = setup
    # (default: as the request asks, hidden)
    assert set(FP.alignment_extents(state, dataset, "chrT", 1000, 1200)) == {"ok_short", "ok_long"}
    assert set(FP.alignment_extents(state, dataset, "chrT", 1000, 1200, include_duplicates=False,
                                    include_qcfail=False)) == {"ok_short", "ok_long"}


def test_shown_duplicate_and_qcfail_reads_are_candidates(setup):
    state, dataset = setup
    assert set(FP.alignment_extents(state, dataset, "chrT", 1000, 1200, include_duplicates=True,
                                    include_qcfail=False)) == {"ok_short", "ok_long", "dup_long"}
    assert set(FP.alignment_extents(state, dataset, "chrT", 1000, 1200, include_duplicates=False,
                                    include_qcfail=True)) == {"ok_short", "ok_long", "qcfail_long"}


def test_the_plan_ranks_and_counts_only_shown_reads(setup, monkeypatch, client):
    """The decoded names and the response's estimate leave hidden reads out (they used to rank first here: the
    hidden duplicate and QC-fail reads cover the most of the view). (``client``: the server is imported first, as
    on every real path; run before it, this plan leaves test_first_paint's window comparisons order-dependent.)"""
    state, dataset = setup
    state.get_dataset = lambda _id: dataset
    monkeypatch.setattr(FP, "MIN_DEPTH_FACTOR", 1.0)
    monkeypatch.setattr(FP, "MIN_MARGIN", 1)
    monkeypatch.setattr(FP, "MARGIN_FRACTION", 0.0)
    monkeypatch.setattr(FP, "FULL_DECODE_FRACTION", 10.0)
    asked = []

    class Query:
        def build_working_set(self, state, dataset_id, read_ids=(), **_kw):
            asked.append(list(read_ids))
            # Each decoded read covers its alignment (body == extent).
            spans = {"ok_short": (0, 200), "ok_long": (0, 200)}
            return SimpleNamespace(reads=[{"id": n, "footprints": [], "start": 0, "end": 0} for n in read_ids if n in spans])

    import services.read_selection as rs
    monkeypatch.setattr(rs, "body_overlap", lambda read, a, b: 200)
    plan = FP.plan_first_paint(state, Query(), "d", chrom="chrT", start=1000, end=1200, max_reads=1,
                               build_options={})
    assert plan is not None and plan.complete  # (both shown reads decoded: nothing hidden took their place)
    assert plan.total_overlapping == 2
    assert all(n in ("ok_short", "ok_long") for names in asked for n in names)
