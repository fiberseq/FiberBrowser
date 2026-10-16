"""B1 round 7: cache generations, explicit-layer precedence, profile filters/cap, Read Stats aliases."""
import time
from types import SimpleNamespace

from services import compact_read_loader, read_stats as read_stats_service, working_sets
from services.dataset_generation import dataset_generation
from services.dataset_registration import invalidate_dataset_caches
from services.working_sets import build_sampled_display_working_set, make_layer_key
from test_compact_read_loader import FakeBigBed, bed12_rest
from test_working_sets import FakeState, _bam_loader_factory, _unused_bigbed_loader, _unused_mark_loader


def test_a_load_for_a_replaced_source_is_not_cached(monkeypatch):
    state = FakeState()
    state._methylation_cache = {}

    def slow_load(**kwargs):
        # The dataset is removed and its ID reused while this load runs.
        invalidate_dataset_caches(state, "primary")
        return [{"id": "old", "intervals": [[0, 10, 10]]}]

    monkeypatch.setattr(working_sets, "_load_broad_reads", slow_load)
    before = dataset_generation(state, "primary")
    reads, _key = working_sets._load_and_cache_broad_reads_singleflight(
        state, dataset=state.dataset, dataset_id="primary", chrom="chr1",
        viewport_start=0, viewport_end=100, broad_start=0, broad_end=1000, broad_width=1000,
        include_methylation=False, layer_key=None, include_layer_qualities=False,
        build_bam_reads=None, build_bigbed_reads=None, load_bigbed_marks=None,
        infer_legacy_layers=True, legacy_nuc_min_size=90, min_footprints=0,
    )
    assert reads[0]["id"] == "old"            # the request that asked still gets its answer
    assert dataset_generation(state, "primary") == before + 1
    assert not state._broad_cache             # but the replaced source is not cached


def _bb_reads(order):
    handles = {
        # Footprint file: a 20-bp footprint at 150, inferred as TF.
        "s.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [20], [50], "80,"))]}),
        # TF companion: the explicit TF call at 100.
        "s_tf.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [20], [0], "200,", "3,", "4,"))]}),
    }
    return compact_read_loader.build_compact_reads_from_bigbed(
        order, "2L", 100, 300, spanning_only=False,
        include_layers=True, requested_layers=["tf", "nuc"],
        bigbed_handle_getter=lambda p: handles[p],
        overlay_type_detector=lambda p: "tf" if p == "s_tf.bb" else "footprint",
        format_cache={},
    )


def test_explicit_tf_calls_win_over_inferred_ones_in_either_file_order():
    tf_first = _bb_reads(["s_tf.bb", "s.bb"])[0]["layers"]["tf"]
    fp_first = _bb_reads(["s.bb", "s_tf.bb"])[0]["layers"]["tf"]
    assert tf_first == fp_first
    assert tf_first["intervals"] == [[0, 20, 20]]
    assert "_explicit_layers" not in _bb_reads(["s_tf.bb", "s.bb"])[0]


def _profile_state():
    state = FakeState()
    layer_key = make_layer_key(True, ["tf"])
    broad_key = ("primary", "chr1", 0, 100, False, layer_key, True, True, 90)

    def tf(q):
        return {"intervals": [[10, 20, 10]], "qualities": [[q]], "quality_names": ["tq"]}

    state._broad_cache[broad_key] = ([
        {"id": "a", "intervals": [[0, 100, 100]], "layers": {"tf": tf(10)}},
        {"id": "b", "intervals": [[0, 100, 100]], "layers": {"tf": tf(10)}},
    ], time.time())
    return state


def _profile(state, **kw):
    return build_sampled_display_working_set(
        state, "primary", "chr1", 0, 100, max_reads=10, include_methylation=False,
        include_layers=True, requested_layers=["tf"], include_layer_qualities=True,
        build_bam_reads=_bam_loader_factory([]), build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader, profile_requested_layers=["tf"], **kw,
    )[0]


def test_profile_counts_only_calls_passing_the_quality_filters():
    ws = _profile(_profile_state(), profile_max_reads=10,
                  quality_filters=[{"layer": "tf", "quality_name": "tq", "min_value": 100}])
    assert ws.profile_metaprofile is not None
    # The tq=10 calls are filtered out of the profile, as they are from the display.
    assert max(ws.profile_metaprofile["layers"].get("tf") or [0.0]) == 0.0


def test_profile_cap_zero_means_every_read():
    ws = _profile(_profile_state(), profile_max_reads=0, quality_filters=[])
    assert ws.profile_metaprofile is not None
    assert ws.profile_read_count == 2


class _AliasBam:
    references = ("1",)

    def fetch(self, chrom, start, end):
        assert chrom == "1"
        return [SimpleNamespace(query_name="r1", mapping_quality=60, is_reverse=False,
                                query_length=100, reference_length=100, get_tag=lambda _t: 0)]


def test_read_stats_uses_the_bams_own_chromosome_name(monkeypatch):
    monkeypatch.setattr(read_stats_service, "get_bam_handle", lambda _p: _AliasBam())
    wanted = {"r1"}
    per_read = []
    ws = SimpleNamespace(read_by_id={})
    read_stats_service._collect_bam_read_stats(
        dataset=SimpleNamespace(paths=["a.bam"]), dataset_id="d", wanted=wanted, read_ids=["r1"], ws=ws,
        chrom="chr1", start=0, end=100, per_read=per_read, all_fp_sizes=[], all_acc_pcts=[],
        all_lengths=[], all_mapqs=[], all_methyl_pcts=[], strand_counts={"+": 0, "-": 0},
    )
    # Fetched under the BAM's "1" (a "chr1" fetch would fail and leave r1 missing).
    assert not wanted
