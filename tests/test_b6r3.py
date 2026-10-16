"""Other-analyses review round 3 (B6)."""
from types import SimpleNamespace

import numpy as np
import pysam


def test_pairwise_correlation_uses_joint_coverage_and_keeps_undefined_as_nan():
    from services.coaccessibility import normalize_correlation
    a = np.array([[np.nan, 0], [0, 0], [np.nan, 1], [np.nan, .25], [1, .25], [.5, 0], [1, np.nan], [1, 0]])
    both = ~np.isnan(a).any(axis=1)
    want = np.corrcoef(a[both, 0], a[both, 1])[0, 1]
    assert abs(normalize_correlation(a, 1)[0, 1] - want) < 1e-5
    constant = np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 0.5]])
    assert np.isnan(normalize_correlation(constant, 1)[0, 1])  # a constant bin: undefined, not 0


def test_track_exports_have_at_most_one_row_per_base():
    from services.track_exports import clamp_export_bins, track_export_rows
    bins = clamp_export_bins(5, 102 - 100)
    rows = track_export_rows("chr1", 100, 102, bins, [1, 2, 3, 4, 5])
    assert rows == ["chr1\t100\t101\t1", "chr1\t101\t102\t2"]


def test_correlation_slice_of_a_sub_bin_region_is_empty(monkeypatch):
    import services.coaccessibility_endpoint as ce
    monkeypatch.setattr(ce, "_get_cached_normalized_matrix",
                        lambda *a, **k: (np.zeros((0, 0)), None, 3, np.zeros((1, 1)), np.zeros((1, 1))))
    scope = SimpleNamespace(region_width=20, start=100, end=120, bin_size=50, sample_seed="s")
    assert ce.get_coacc_slice_payload(None, scope, 110, "correlation", 1)["profile"] == []


def test_apa_window_at_the_partial_last_bin_stays_inside_the_chromosome():
    from services.microc_apa import CoolerWindows
    requested = []

    class Clr:
        def matrix(self, balance=False, sparse=False):
            class Sel:
                def fetch(self, rows, cols):
                    requested.append((rows, cols))
                    return np.ones((rows[2] // 1000 - rows[1] // 1000 + 1, 2))
            return Sel()

    windows = CoolerWindows(Clr(), "chr1", 1000, 11, chrom_length=10_500)
    windows[8:11, 8:11]
    assert requested[0][1] == ("chr1", 8000, 10_500)  # not 11,000 (past the end)


def test_unknown_resolution_reports_the_loaded_one():
    from services.microc_matrix import cooler_at_resolution
    state = SimpleNamespace(current_resolution=1000, resolutions=[1000], cool_file="x.cool", clr="h")
    same, res = cooler_at_resolution(state, 5000, object())
    assert same is not state and (same.clr, same.current_resolution) == ("h", 1000) and res == 1000


def test_long_accessible_reads_do_not_overflow(tmp_path):
    from services.dense_bam_loader import load_reads_from_bam
    bam = tmp_path / "long.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 100_000}]}
    with pysam.AlignmentFile(str(bam), "wb", header=header) as out:
        for name, start in (("long", 0), ("short", 10)):
            seg = pysam.AlignedSegment(out.header)
            seg.query_name = name
            seg.reference_id = 0
            seg.reference_start = start
            n = 40_000 if name == "long" else 50
            seg.query_sequence = "A" * n
            seg.cigartuples = [(0, n)]
            seg.mapping_quality = 60
            seg.query_qualities = pysam.qualitystring_to_array("I" * n)
            out.write(seg)
    pysam.index(str(bam))
    df = load_reads_from_bam(str(bam), "chr1", 0, 40_000, spanning_only=False)
    assert sorted(df["read_id"]) == ["long", "short"]
    long_row = df[df["read_id"] == "long"].drop(columns=["read_id"]).to_numpy()
    assert (long_row == -40_000).all()


def test_motif_hits_across_a_cache_tile_edge_survive_panning(monkeypatch):
    import services.orthogonal_tracks as ot
    ot.clear_custom_motif_annotation_cache()
    monkeypatch.setattr(ot, "CUSTOM_MOTIF_CACHE_TILE_BP", 100)
    genome = ["C"] * 400
    genome[98:102] = list("GAGA")  # straddles the tile edge at 100
    seq = "".join(genome)

    class Fasta:
        references = ["chr1"]

        def get_reference_length(self, _c):
            return len(seq)

        def fetch(self, _c, s, e):
            return seq[s:e]

    def scanner(chunk, _pssm, _threshold):
        i = chunk.find("GAGA")
        return [] if i < 0 else [{"start": i, "end": i + 4, "strand": "+", "rel_score": 1.0}]

    track = {"path": "motif://sequence/GAGA", "label": "GAGA", "format": "custom_motif", "motif_name": "GAGA",
             "motif_type": "sequence", "pssm": object(), "threshold": 0.8,
             "counts": {"A": [0, 1, 0, 1], "C": [0] * 4, "G": [1, 0, 1, 0], "T": [0] * 4}}
    before = ot.get_track_annotations(track, "chr1", 90, 110, fasta=Fasta(), motif_scanner=scanner)
    after = ot.get_track_annotations(track, "chr1", 100, 110, fasta=Fasta(), motif_scanner=scanner)
    assert [(i["start"], i["end"]) for i in before["intervals"]] == [(98, 102)]
    assert [(i["start"], i["end"]) for i in after["intervals"]] == [(98, 102)]


def test_a_failed_dafc_load_keeps_the_previous_map(tmp_path, monkeypatch):
    import asyncio
    import pytest
    from fastapi import HTTPException
    import routers.dafc as dafc

    cool = tmp_path / "b.cool"
    cool.write_text("x")

    class Clr:
        binsize = 1000
        chromsizes = {"chr1": 10_000}

    monkeypatch.setattr(dafc, "HAS_COOLER", True)
    monkeypatch.setattr(dafc, "_load_cooler_modules", lambda: (SimpleNamespace(Cooler=lambda _uri: Clr()), object()))
    old_cache = {("chr1", 1000, False): np.ones(3)}
    state = SimpleNamespace(clr="A", cool_file="a.cool", resolutions=[5000], current_resolution=5000, chroms=["A"],
                            bigbed_file="a.bb", bb="A-bb", chrom_expected_cache=old_cache,
                            chrom_expected_computing=set())
    with pytest.raises(HTTPException):
        asyncio.run(dafc.dafc_load(cool_file=str(cool), bigbed_file=str(tmp_path / "missing.bb"), dafc_state=state))
    assert (state.clr, state.cool_file, state.bb, state.bigbed_file) == ("A", "a.cool", "A-bb", "a.bb")
    assert state.chrom_expected_cache is old_cache


def test_region_annotations_are_kept_per_dataset():
    from models.domain import WorkingSet
    from services.annotations_endpoint import get_annotations_for_region_payload

    class State:
        dataset_order = ["a", "b"]
        max_working_reads = None

        def __init__(self):
            self.datasets = {"a": SimpleNamespace(id="a"), "b": SimpleNamespace(id="b")}
            only_a = SimpleNamespace(id="f", path="/only_a.bb", active=True, dataset_ids=["a"], annotation_types={})
            self.annotation_state = SimpleNamespace(files={"f": only_a}, confidence_thresholds={}, type_colors={},
                                                    get_cached=lambda _k: None, set_cached=lambda _k, _v: None)

        def translate_chrom(self, chrom):
            return chrom

        def resolve_dataset_id(self, dataset_id=None):
            return dataset_id or "a"

        def get_dataset(self, dataset_id):
            return self.datasets.get(dataset_id)

        def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
            return WorkingSet([{"id": "shared_read", "intervals": [[0, 10, 50]]}], 1, 1, chrom, start, end)

    def load(path, chrom, start, end, confidence_thresholds=None, read_names=None):
        return {"shared_read": [(1, 5, "x", 1.0)]}, {"x"}

    out = get_annotations_for_region_payload(State(), chrom="chr1", start=0, end=100, dataset_ids="a,b",
                                             load_annotations=load)
    by_ds = out["annotations_by_dataset"]
    assert list(by_ds["a"]) == ["shared_read"]
    assert by_ds["b"] == {}  # B's read of the same name gets none of A's file
