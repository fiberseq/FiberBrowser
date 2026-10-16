"""B1 round 12: per-sample companion marks, terminal-gap filtering of merged
companion rows, and index discovery for uppercase .BAM paths."""
from types import SimpleNamespace

from services import compact_read_loader
from services.bam_handles import bam_index_candidates, local_bam_index_exists
from services.dataset_endpoint import ensure_local_bam_indexes
from services.compact_read_loader import bigbed_sample_key
from services.working_sets import _load_broad_reads, companion_mark_targets
from test_compact_read_loader import FakeBigBed, bed12_rest


def test_merged_samples_keep_their_own_marks():
    sample_a, sample_b = bigbed_sample_key("/a/sampleA.bb"), bigbed_sample_key("/b/sampleB.bb")
    reads = [
        {"id": "r", "intervals": [[0, 100, 100]], "bigbed_sample": sample_a},
        {"id": "r", "intervals": [[500, 600, 100]], "bigbed_sample": sample_b},
    ]
    marks = {
        "/a/sampleA.m6a.bb": {"r": [110]},
        "/b/sampleB.m6a.bb": {"r": [220]},
    }
    dataset = SimpleNamespace(
        data_type="bigbed",
        paths=["/a/sampleA.bb", "/b/sampleB.bb", "/a/sampleA.m6a.bb", "/b/sampleB.m6a.bb"],
        companion_layers={"m6a": ["/a/sampleA.m6a.bb", "/b/sampleB.m6a.bb"]},
    )
    out = _load_broad_reads(
        dataset=dataset, dataset_id="d", chrom="chr1", broad_start=0, broad_end=1000, broad_width=1000,
        include_methylation=True, layer_key=(), include_layer_qualities=False,
        build_bam_reads=None,
        build_bigbed_reads=lambda *a, **k: [dict(r) for r in reads],
        load_bigbed_marks=lambda path, *a, **k: marks[path],
    )
    by_sample = {read["bigbed_sample"]: read for read in out}
    assert by_sample[sample_a]["methyl_m6a"] == [110]
    assert by_sample[sample_b]["methyl_m6a"] == [220]


def test_companion_mark_targets():
    a = {"id": "r", "bigbed_sample": "/a/s"}
    b = {"id": "r", "bigbed_sample": "/b/s"}
    plain = {"id": "r"}
    assert companion_mark_targets([plain], "/x/anything") == [plain]
    assert companion_mark_targets([a, b], "/b/s") == [b]
    # A mark file named for no loaded sample: only an unambiguous read takes it.
    assert companion_mark_targets([a], "/z/other") == [a]
    assert companion_mark_targets([a, b], "/z/other") == []


def test_multi_sample_merge_stamps_each_molecule_with_its_sample():
    handles = {
        "/a/sampleA.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [100], [0]))]}),
        "/b/sampleB.bb": FakeBigBed({"chr2L": [(500, 800, bed12_rest("r", [100], [100]))]}),
    }
    types = {"/a/sampleA.bb": "footprint", "/b/sampleB.bb": "footprint"}
    reads = compact_read_loader.build_compact_reads_from_bigbed(
        list(handles), "2L", 100, 900, spanning_only=False,
        bigbed_handle_getter=lambda p: handles[p], overlay_type_detector=lambda p: types[p],
        format_cache={},
    )
    assert sorted(read["bigbed_sample"] for read in reads) == sorted(
        bigbed_sample_key(path) for path in handles)


def test_one_sample_merge_adds_no_sample_field():
    handles = {
        "/a/s.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [100], [0]))]}),
        "/a/s_tf.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [20], [150]))]}),
    }
    types = {"/a/s.bb": "footprint", "/a/s_tf.bb": "tf"}
    reads = compact_read_loader.build_compact_reads_from_bigbed(
        list(handles), "2L", 100, 900, spanning_only=False,
        include_layers=True, requested_layers=["tf", "nuc"],
        bigbed_handle_getter=lambda p: handles[p], overlay_type_detector=lambda p: types[p],
        format_cache={},
    )
    assert len(reads) == 1 and "bigbed_sample" not in reads[0]


def _merged_with_terminal_gaps(tf_rest, fp_rest):
    handles = {
        "/a/s.bb": FakeBigBed({"chr2L": [(0, 2000, fp_rest)]}),
        "/a/s_tf.bb": FakeBigBed({"chr2L": [(0, 2000, tf_rest)]}),
    }
    types = {"/a/s.bb": "footprint", "/a/s_tf.bb": "tf"}
    return compact_read_loader.build_compact_reads_from_bigbed(
        list(handles), "2L", 0, 2000, spanning_only=False,
        include_layers=True, requested_layers=["tf", "nuc"],
        hide_terminal_gaps=True, terminal_gap_threshold=500,
        bigbed_handle_getter=lambda p: handles[p], overlay_type_detector=lambda p: types[p],
        format_cache={},
    )


def test_terminal_gap_filter_keeps_a_passing_molecules_tf_calls():
    # Footprints near both ends pass; the one TF call in the middle is not the read's edge.
    reads = _merged_with_terminal_gaps(
        tf_rest=bed12_rest("r", [20], [1000]),
        fp_rest=bed12_rest("r", [100, 100], [50, 1850]),
    )
    assert len(reads) == 1
    assert reads[0]["layers"]["tf"]["intervals"] == [[1000, 1020, 20]]


def test_terminal_gap_filter_drops_a_failing_molecules_companion_rows():
    reads = _merged_with_terminal_gaps(
        tf_rest=bed12_rest("r", [20], [1000]),
        fp_rest=bed12_rest("r", [100], [900]),  # 900 bp leading gap
    )
    assert reads == []


def test_uppercase_bam_index_candidates_never_name_the_bam_itself(tmp_path):
    folder = tmp_path / "data.bam.dir"
    folder.mkdir()
    bam = folder / "sample.BAM"
    bam.write_bytes(b"x")
    candidates = bam_index_candidates(str(bam))
    assert str(bam) not in candidates
    assert str(folder / "sample.bai") in candidates
    assert not local_bam_index_exists(str(bam))
    (folder / "sample.bai").write_bytes(b"")
    assert local_bam_index_exists(str(bam))


def test_uppercase_bam_without_index_is_indexed(tmp_path, monkeypatch):
    bam = tmp_path / "sample.BAM"
    bam.write_bytes(b"x")
    calls = []
    monkeypatch.setattr("shutil.which", lambda _name, **_kw: None)
    monkeypatch.setattr("services.external_tools.tool_path", lambda _name, **_kw: None)
    import pysam
    monkeypatch.setattr(pysam, "index", lambda path: calls.append(path))
    assert ensure_local_bam_indexes([str(bam)]) is None
    assert calls == [str(bam)]
