"""Round 13: molecules sharing a read name stay distinct (consensus bundles,
footprint co-occupancy) and Read Stats reports the primary alignment."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))

from models.domain import WorkingSet
from models.requests import ReadStatsRequest


def _bigbed_row(name, strand, start, end):
    # name score strand thickStart thickEnd rgb count sizes starts
    return (start, end, f"{name}\t0\t{strand}\t{start}\t{end}\t0\t1\t20\t0")


def test_consensus_bigbed_bundles_in_two_folders_stay_separate(monkeypatch):
    import services.consensus_evidence as ev

    rows = {
        "/A/sample_tf.bb": [_bigbed_row("r", "+", 100, 300)],
        "/B/sample_tf.bb": [_bigbed_row("r", "+", 1000, 1200)],
        "/A/sample_msp.bb": [_bigbed_row("r", "+", 150, 250)],
    }

    class Handle:
        def __init__(self, path):
            self.path = path

        def chroms(self):
            return {"chr1": 10000}

        def entries(self, chrom, start, end):
            return rows[self.path]

    monkeypatch.setattr(ev, "get_bigbed_handle", lambda path: Handle(path))
    monkeypatch.setattr(ev, "detect_bigbed_autosql_sample", lambda _path: None)
    records, _ = ev._load_bigbed_rows(
        {"tf": ["/A/sample_tf.bb", "/B/sample_tf.bb"], "msp": ["/A/sample_msp.bb"]},
        chrom="chr1", start=0, end=5000)
    spans = sorted((r.ref_start, r.ref_end, sorted(r.calls), r.sample) for r in records)
    # Two molecules, not one [100,1200) hybrid; /A's msp companion joins /A's read.
    assert [(s[0], s[1]) for s in spans] == [(100, 300), (1000, 1200)]
    assert spans[0][2] == ["msp", "tf"] and spans[1][2] == ["tf"]
    assert spans[0][3] != spans[1][3]

    # One folder: the sample keeps its plain name, as before.
    records, _ = ev._load_bigbed_rows(
        {"tf": ["/A/sample_tf.bb"], "msp": ["/A/sample_msp.bb"]}, chrom="chr1", start=0, end=5000)
    assert [r.sample for r in records] == ["sample"]


class _Rec:
    def __init__(self, name, pos, mapq, secondary=False, supplementary=False):
        self.query_name = name
        self.reference_start = pos
        self.reference_end = pos + 100
        self.mapping_quality = mapq
        self.is_reverse = False
        self.is_unmapped = False
        self.is_secondary = secondary
        self.is_supplementary = supplementary
        self.query_length = 100
        self.reference_length = 100
        self.cigartuples = [(0, 100)]
        self.cigarstring = "100M"

    def get_tag(self, _tag):
        raise KeyError(_tag)


def test_read_stats_uses_the_primary_alignment(monkeypatch):
    from services import read_stats as rs

    class Bam:
        references = ("chr1",)

        def fetch(self, chrom, start, end):
            return [_Rec("m", 100, 0, secondary=True), _Rec("m", 110, 0, supplementary=True),
                    _Rec("m", 150, 60)]

    class DS:
        data_type = "bam"
        paths = ["x.bam"]

    class State:
        def translate_chrom(self, chrom):
            return chrom

        def get_dataset(self, dataset_id):
            return DS() if dataset_id == "ds1" else None

        def build_working_set(self, *args, **kwargs):
            return WorkingSet([{"id": "m", "intervals": [[0, 10, 10]]}], total_overlapping=1,
                              total_spanning=1, chrom=args[1], start=args[2], end=args[3])

    monkeypatch.setattr(rs, "get_bam_handle", lambda _path: Bam())
    result = rs.compute_read_stats(State(), chrom="chr1", start=0, end=1000, spanning=False,
                                   request=ReadStatsRequest(read_ids_by_dataset={"ds1": ["m"]}))
    assert result["found_count"] == 1
    assert result["per_read"][0]["mapq"] == 60


def test_shared_read_names_are_not_counted_as_co_occupying():
    from services.footprint_analysis import IntervalTable, compute_cooccupancy_result

    # Two distinct molecules named "same": one with footprint A [10,20), the
    # other with footprint B [40,50); a third read "x" carries both.
    table = IntervalTable(
        starts=np.array([10, 40, 10, 40]), ends=np.array([20, 50, 20, 50]),
        sizes=np.array([10, 10, 10, 10], dtype=np.int32),
        read_indices=np.array([0, 1, 2, 2], dtype=np.int32),
        read_ids=["same", "same", "x"], n_reads=3,
        family_ids=np.zeros(4, np.uint8), family_confidences=np.zeros(4, np.uint8),
        family_confidence_kinds=np.zeros(4, np.uint8),
    )
    groups = [
        {"referenceAbsStart": 10, "referenceAbsEnd": 20, "sizeMin": 0},
        {"referenceAbsStart": 40, "referenceAbsEnd": 50, "sizeMin": 0},
    ]
    result = compute_cooccupancy_result(table, groups, [], fisher_exact_func=lambda t: (1.0, 1.0))
    pair = result["pairs"][0]
    assert pair["n_both"] == 1 and pair["ids_both"] == ["x"]
    assert pair["n_i_only"] == 0 and pair["n_j_only"] == 0
    assert "same" not in pair["ids_neither"]
    for g in result["per_group"]:
        assert g["ids_with"] == ["x"] and g["ambiguous_read_ids"] == ["same"]
        assert "same" not in g["ids_without"]
