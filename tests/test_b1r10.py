"""B1 round 10: dense BigBed decoding, companion sources, remote chromosome
discovery, merge annotations, linked-read clipping, cache races, plasmid reload."""
import sys
import threading
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


def test_dense_bigbed_long_gap_stays_negative():
    from services.bigbed_read_loader import build_rd_fast_signed

    bed = pd.DataFrame([{
        "chrom": "chr1", "start": 0, "end": 50000, "name": "r",
        "blockStarts": "40000", "blockSizes": "150",
    }])
    rd = build_rd_fast_signed(bed, "chr1", 0, 50000, spanning_only=False)
    assert int(rd.loc[0, 0]) == -40000  # int16 wrapped this to +25536
    assert int(rd.loc[0, 40000]) == 150


def test_dense_reads_skip_companion_layer_files(monkeypatch):
    import services.bigbed_read_loader as loader
    from models.domain import Dataset

    seen = {}

    def fake_load(paths, chrom, start, end, spanning_only=True):
        seen["paths"] = list(paths)
        return pd.DataFrame()

    monkeypatch.setattr(loader, "load_reads_from_bigbed", fake_load)
    ds = Dataset("d", ["/x/s.footprint.bb", "/x/s.tf.bb"], "d")
    ds.data_type = "bigbed"
    ds.companion_layers = {"tf": ["/x/s.tf.bb"]}
    ds.get_reads("chr1", 0, 100)
    assert seen["paths"] == ["/x/s.footprint.bb"]


def test_remote_bigbed_chromosomes_come_from_the_handle(monkeypatch):
    import services.bigbed_handles as handles
    from state.browser_state import BrowserState

    class BW:
        def chroms(self):
            return {"chr1": 1000}

    monkeypatch.setattr(handles, "get_bigbed_handle", lambda path: BW())
    chroms = BrowserState._detect_chroms_from_bigbed(None, "https://example.test/s.bb")
    assert [(c.name, c.size) for c in chroms] == [("chr1", 1000)]


def test_failed_registration_leaves_no_dataset(monkeypatch):
    import services.dataset_registration as reg

    state = SimpleNamespace(datasets={}, dataset_order=[], chroms=[], chrom_map={})
    monkeypatch.setattr(reg, "validate_dataset_source", lambda path: (path, False))
    monkeypatch.setattr(reg, "configure_bigbed_dataset_layers", lambda *a, **k: None)

    def boom(_path):
        raise FileNotFoundError("nope")

    with pytest.raises(FileNotFoundError):
        reg.add_dataset_to_state(state, "d", "https://example.test/s.bb", "d",
                                 detect_bam_chroms=lambda p: [], detect_bigbed_chroms=boom)
    assert state.datasets == {} and state.dataset_order == []


def test_merge_moves_annotation_associations_to_the_merged_dataset():
    from models.domain import AnnotationFile
    from services.dataset_endpoint import merge_datasets_for_request

    ann = AnnotationFile("ann_a", "/x/a.annotations.bb")
    ann.dataset_ids = ["A"]
    shared = AnnotationFile("ann_s", "/x/s.annotations.bb")  # shared by every dataset

    class State:
        def __init__(self):
            self.annotation_state = SimpleNamespace(files={"ann_a": ann, "ann_s": shared})
            self.datasets = {
                "A": SimpleNamespace(id="A", paths=["/x/a.bam"], label="A", data_type="bam"),
                "B": SimpleNamespace(id="B", paths=["/x/b.bam"], label="B", data_type="bam"),
            }
            self.dataset_order = ["A", "B"]

        def get_dataset(self, dataset_id):
            return self.datasets.get(dataset_id)

        def add_dataset(self, dataset_id, path, label=None):
            merged = SimpleNamespace(id=dataset_id, to_dict=lambda: {"id": dataset_id})
            self.datasets[dataset_id] = merged
            return merged

        def remove_dataset(self, dataset_id):
            self.datasets.pop(dataset_id, None)

    res = merge_datasets_for_request(State(), SimpleNamespace(dataset_ids=["A", "B"], label=None))
    assert res["success"], res
    merged_id = res["dataset"]["id"]
    assert ann.dataset_ids == [merged_id]
    assert shared.dataset_ids == []


def test_rediscovered_annotation_is_associated_with_the_new_dataset():
    from models.domain import AnnotationFile
    from services.dataset_registration import associate_annotation_file

    ann = AnnotationFile("ann_a", "/x/a.annotations.bb")
    ann.dataset_ids = ["A"]
    associate_annotation_file(ann, "B")
    assert ann.dataset_ids == ["A", "B"]
    shared = AnnotationFile("ann_s", "/x/s.annotations.bb")
    associate_annotation_file(shared, "B")
    assert shared.dataset_ids == []  # empty = every dataset


def test_linked_compact_intervals_are_clipped_to_the_region():
    from services.linked_read_compact import compact_intervals_from_entry

    # Footprints at [850, 950) (before the view) and [1700, 1800).
    entry = {"start": 800, "end": 2200, "blockSizes": "100,100", "blockStarts": "50,900"}
    intervals = compact_intervals_from_entry(entry, 1000, 2000)
    assert intervals is not None
    assert all(0 <= s <= e <= 1000 for s, e, _ in intervals)
    # The internal gap keeps its full size; the off-view footprint is gone.
    assert intervals == [[0, 700, -750], [700, 800, 100]]


def test_bigbed_coverage_handles_a_window_before_the_contig_start():
    from services.read_coverage import compute_binned_read_coverage

    class BB:
        def chroms(self):
            return {"chr1": 1000}

        def entries(self, chrom, start, end):
            if start < 0:
                raise RuntimeError("Invalid interval bounds!")
            return [(0, 100, "r")]

    ds = SimpleNamespace(id="d", data_type="bigbed", paths=["/x/s.bb"], companion_layers={})
    out = compute_binned_read_coverage([ds], "chr1", -500, 500, 10,
                                       bam_handle_getter=lambda p: None,
                                       bigbed_handle_getter=lambda p: BB())
    assert out["max"] >= 1


def test_meta_profile_expiry_is_race_free(monkeypatch):
    import services.read_auxiliary_endpoint as aux

    key = ("d", "chr1", 0, 100, None)
    state = SimpleNamespace(
        _meta_profile_cache=OrderedDict({key: ([1.0], [0.0], 0.0)}),
        _meta_profile_cache_timeout=60, _meta_profile_cache_max=10,
        translate_chrom=lambda c: c,
        get_reads=lambda *a, **k: pd.DataFrame(),
    )
    monkeypatch.setattr(aux, "resolve_dataset_id", lambda st, d: "d")
    errors = []
    barrier = threading.Barrier(2)

    def call():
        barrier.wait()
        try:
            aux.get_meta_payload(state, chrom="chr1", start=0, end=100, dataset_id="d")
        except Exception as exc:  # pragma: no cover - the bug
            errors.append(exc)

    threads = [threading.Thread(target=call) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert key not in state._meta_profile_cache


def test_reloading_a_plasmid_without_features_clears_its_old_ones():
    from routers.genome import _merge_gtf_data
    from services.plasmid_maps import PlasmidFeature, PlasmidMap, plasmid_features_to_gtf_data

    v1 = PlasmidMap("pX", "A" * 500, features=[PlasmidFeature("old", 10, 50)])
    other = PlasmidMap("pY", "A" * 300, features=[PlasmidFeature("keep", 5, 30)])
    v2 = PlasmidMap("pX", "C" * 600, features=[])
    gtf = _merge_gtf_data(None, plasmid_features_to_gtf_data(v1), contig="pX")
    gtf = _merge_gtf_data(gtf, plasmid_features_to_gtf_data(other), contig="pY")
    gtf = _merge_gtf_data(gtf, plasmid_features_to_gtf_data(v2), contig="pX")
    assert list(gtf["transcripts"]["gene_name"]) == ["keep"]


def test_dense_bigbed_keeps_reads_accessible_across_the_window():
    # A read whose only footprints lie outside the window is accessible across
    # it; the old "gap longer than half the window" filter dropped it.
    from services.bigbed_read_loader import load_reads_from_bigbed

    class FakeBB:
        def chroms(self):
            return {"chr1": 100000}

        def entries(self, chrom, start, end):
            # BED12 fields after start/end: name score strand thick* rgb count sizes starts
            return [(0, 50000, "r\t0\t+\t0\t50000\t0\t2\t150,150\t0,49850")]

    df = load_reads_from_bigbed(["/x/a.bb"], "chr1", 20000, 22000, spanning_only=False,
                                bigbed_handle_getter=lambda _p: FakeBB(),
                                swapped_column_detector=lambda _df: False, format_cache={})
    assert len(df) == 1
    values = df.drop(columns=["read_id"]).to_numpy()
    assert (values < 0).all()  # accessible (a gap) over the whole window
