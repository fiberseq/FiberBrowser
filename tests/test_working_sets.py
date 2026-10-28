"""Regression tests for working-set cache and payload modes."""

import time
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

from services.working_sets import (
    BROAD_CACHE_SCHEMA_VERSION,
    build_working_set,
    build_sampled_display_working_set,
    ensure_broad_cache_schema,
    find_broad_cache_entry,
    iter_broad_reads_overlapping_viewport,
    layer_key_covers,
    layer_key_for_quality_filters,
    layer_key_includes,
    make_layer_key,
    make_working_cache_key,
    project_broad_read_to_viewport,
)


class FakeDataset:
    data_type = "bam"
    paths = ["fake.bam"]
    available_layers = {"footprint": True}
    companion_layers = {}


class FakeBigBedDataset:
    data_type = "bigbed"
    paths = ["primary.bb"]
    available_layers = {"footprint": True, "tf": True, "msp": True}
    companion_layers = {"tf": "primary_tf.bb", "msp": "primary_msp.bb"}


class FakeBigBedGroupDataset:
    data_type = "bigbed"
    paths = ["primary.bb", "primary_tf.bb", "primary_msp.bb", "primary_deam.bb"]
    available_layers = {"footprint": True, "tf": True, "msp": True, "deam": True}
    companion_layers = {
        "tf": "primary_tf.bb",
        "msp": "primary_msp.bb",
        "deam": "primary_deam.bb",
    }


class FakeDerivedBamDataset(FakeDataset):
    available_layers = {"footprint": True, "short_tf": True}
    derived_layers = {
        "short_tf": {
            "bundle_path": "primary.fiberlayers.bb",
            "label": "Short TF",
            "source_layer": "tf",
        },
    }


class FakeState:
    def __init__(self):
        self.dataset = FakeDataset()
        self.circular_chroms = {}
        self._broad_cache = OrderedDict()
        self._broad_cache_schema_version = BROAD_CACHE_SCHEMA_VERSION
        self._broad_cache_max = 20
        self._broad_cache_timeout = 300
        self._working_set_cache = OrderedDict()
        self._working_set_cache_max = 12
        self._working_set_cache_timeout = 60
        self.max_working_reads = 0
        self.quality_filters = []
        self.filter_calls = 0

    def get_dataset(self, dataset_id):
        return self.dataset if dataset_id == "primary" else None

    def _apply_quality_filters(self, read):
        self.filter_calls += 1
        return read


def test_exact_viewport_defers_spatial_index_without_changing_reads(monkeypatch):
    from services import working_sets
    state = FakeState()
    reads = [
        {"id": "spanning", "intervals": [[0, 100, 100]], "qualities": [30]},
        {"id": "gap", "intervals": [[0, 10, 10], [95, 100, 5]]},
        {"id": "layer-only", "intervals": [], "layers": {
            "tf": {"intervals": [[20, 40, 20]], "qualities": [[220]], "quality_names": ["aq"]}}},
        {"id": "offscreen", "intervals": [[101, 110, 9]]},
    ]
    index_calls = []
    original = working_sets._get_broad_read_index
    def indexed(*args):
        index_calls.append(True)
        return original(*args)
    monkeypatch.setattr(working_sets, "_get_broad_read_index", indexed)
    options = dict(state=state, all_reads=reads, dataset=state.dataset, region_width=100,
        bc_start=1000, start=1000, end=1100, spanning=False, min_footprints=0,
        read_ids=None, include_methylation=True, layer_key=make_layer_key(True, None))
    exact = working_sets._viewport_reads_from_broad(**options, bc_end=1100)
    assert not index_calls
    assert all("_fiberbrowser_interval_index" not in read for read in reads)
    assert all("_fiberbrowser_interval_index" not in layer
               for read in reads for layer in read.get("layers", {}).values())
    indexed_result = working_sets._viewport_reads_from_broad(**options, bc_end=1200)
    assert len(index_calls) == 1
    assert exact == indexed_result
    assert [read["id"] for read in exact[0]] == ["spanning", "gap", "layer-only"]


def _bam_loader_factory(calls):
    def _load_bam(path, chrom, start, end, **kwargs):
        calls.append(dict(kwargs))
        reads = [
            {"id": "r1", "intervals": [[900, 1100, 100]], "qualities": [30]},
            {"id": "r2", "intervals": [[920, 1080, 80]], "qualities": [30]},
        ]
        if kwargs.get("include_methylation"):
            for read in reads:
                read["methyl"] = [950]
                read["methyl_m6a"] = [950]
                read["deam"] = [[960, 1]]
        if kwargs.get("include_layers"):
            for read in reads:
                read["fire"] = [[930, 940, 128]]
                read["layers"] = {
                    "nuc": {
                        "intervals": [[900, 1100, 100]],
                        "qualities": [[30]],
                        "quality_names": ["nq"],
                    }
                }
        return reads

    return _load_bam


def _unused_bigbed_loader(*args, **kwargs):
    raise AssertionError("bigBed loader should not be used by these tests")


def _unused_mark_loader(*args, **kwargs):
    raise AssertionError("mark loader should not be used by these tests")


def _stable_sampler(reads, max_reads, seed):
    return reads[:max_reads]


def test_cached_working_set_does_not_refetch_scan_tables(monkeypatch):
    from services.scan import overlay
    state = FakeState()
    state.scan_registry = object()
    signature = [('scan', 'revision-1')]
    prepared = []
    monkeypatch.setattr(overlay, 'overlay_signature', lambda *a: tuple(signature))
    monkeypatch.setattr(overlay, 'prepare_scan_overlay',
                        lambda *a: prepared.append(True) or (lambda row: row))
    options = dict(state=state, dataset_id='primary', chrom='chr1', start=1000, end=1100,
                   build_bam_reads=_bam_loader_factory([]), build_bigbed_reads=_unused_bigbed_loader,
                   load_bigbed_marks=_unused_mark_loader, stable_sampler=_stable_sampler)
    first = build_working_set(**options)
    assert len(prepared) == 1
    assert build_working_set(**options) is first
    assert len(prepared) == 1
    # A changed scan still invalidates the working set and fetches new tables.
    signature[:] = [('scan', 'revision-2')]
    assert build_working_set(**options) is not first
    assert len(prepared) == 2


def test_bounded_analysis_keeps_broad_and_projected_evidence_in_blocks():
    from services.packed_reads import PackedReadBuilder, PackedReads, bounded_read_analysis, packed_decode
    from services.read_metrics import sample_stable_by_id
    calls = []
    def load(*args, **kwargs):
        assert packed_decode.get()
        calls.append(args)
        builder = PackedReadBuilder()
        for index in range(1100):
            builder.append({'id': f'r{index}', 'intervals': [[900, 1100, 100]], 'qualities': [30]})
        return builder.finish()
    state = FakeState()
    options = dict(build_bam_reads=load, build_bigbed_reads=_unused_bigbed_loader,
                   load_bigbed_marks=_unused_mark_loader, stable_sampler=sample_stable_by_id,
                   include_methylation=False, include_layers=False)
    with bounded_read_analysis():
        result = build_working_set(state, 'primary', 'chr1', 1000, 1200, **options)
    assert isinstance(result.reads, PackedReads)
    assert len(result.reads) == result.total_overlapping == 1100
    assert all(isinstance(value[0], PackedReads) for value in state._broad_cache.values())
    assert len(calls) == 1
    # Ordinary consumers transparently reuse the exact completed cohort.
    warm = build_working_set(state, 'primary', 'chr1', 1000, 1200, **options)
    assert list(warm.reads) == list(result.reads)
    assert len(calls) == 1


def test_working_cache_key_tracks_payload_modes_filters_and_caps():
    base = make_working_cache_key(
        "primary", "chr1", 1000, 1200, False, 0, 0, False, make_layer_key(False), []
    )
    with_marks = make_working_cache_key(
        "primary", "chr1", 1000, 1200, False, 0, 0, True, make_layer_key(False), []
    )
    with_layers = make_working_cache_key(
        "primary", "chr1", 1000, 1200, False, 0, 0, False, make_layer_key(True), []
    )
    with_tf = make_working_cache_key(
        "primary", "chr1", 1000, 1200, False, 0, 0, False, make_layer_key(False, ["tf"]), []
    )
    with_cap = make_working_cache_key(
        "primary", "chr1", 1000, 1200, False, 0, 5000, False, make_layer_key(False), []
    )
    with_filter = make_working_cache_key(
        "primary",
        "chr1",
        1000,
        1200,
        False,
        0,
        0,
        False,
        make_layer_key(False),
        [{"layer": "nuc", "quality_name": "nq", "min_value": 20}],
    )
    with_seed = make_working_cache_key(
        "primary", "chr1", 1000, 1200, False, 0, 5000, False, make_layer_key(False), [], "seed-2"
    )

    assert base != with_marks
    assert base != with_layers
    assert base != with_tf
    assert with_tf != with_layers
    assert base != with_cap
    assert base != with_filter
    assert with_cap != with_seed


def test_byte_budgeted_navigation_caches_survive_time_and_local_pans(monkeypatch):
    from services.byte_cache import ByteCache
    state = FakeState()
    state._broad_cache = ByteCache(1024 ** 2)
    state._working_set_cache = ByteCache(1024 ** 2)
    state._broad_cache_timeout = state._working_set_cache_timeout = None
    calls = []
    options = dict(build_bam_reads=_bam_loader_factory(calls), build_bigbed_reads=_unused_bigbed_loader,
                   load_bigbed_marks=_unused_mark_loader, stable_sampler=_stable_sampler,
                   include_methylation=False, include_layers=False)
    first = build_working_set(state, 'primary', 'chr1', 1000, 1200, **options)
    future = time.time() + 3600
    monkeypatch.setattr('services.working_sets.time.time', lambda: future)
    pan = build_working_set(state, 'primary', 'chr1', 1010, 1210, **options)
    assert pan.reads
    assert build_working_set(state, 'primary', 'chr1', 1000, 1200, **options) is first
    assert len(calls) == 1
    state._broad_cache.resize(0)
    state._working_set_cache.resize(0)
    assert not state._broad_cache and not state._working_set_cache


def test_broad_cache_lookup_expires_entries_and_updates_lru_order():
    state = FakeState()
    layer_key = make_layer_key(False)
    expired_key = ("primary", "chr1", 0, 1000, False, layer_key)
    state._broad_cache[expired_key] = ([{"id": "old"}], 0)

    reads, key = find_broad_cache_entry(
        state,
        "primary",
        "chr1",
        100,
        200,
        False,
        layer_key,
        now=state._broad_cache_timeout + 1,
    )

    assert reads is None
    assert key is None
    assert expired_key not in state._broad_cache

    first_key = ("primary", "chr1", 0, 1000, False, layer_key)
    second_key = ("primary", "chr1", 0, 1200, False, layer_key)
    state._broad_cache[first_key] = ([{"id": "first"}], 10)
    state._broad_cache[second_key] = ([{"id": "second"}], 10)

    reads, key = find_broad_cache_entry(
        state,
        "primary",
        "chr1",
        100,
        200,
        False,
        layer_key,
        now=10,
    )

    assert reads == [{"id": "first"}]
    assert key == first_key
    assert list(state._broad_cache.keys())[-1] == first_key


def test_broad_cache_schema_mismatch_clears_process_local_entries():
    state = FakeState()
    state._broad_cache_schema_version = 1
    state._broad_cache[("primary", "chr1", 0, 1000, False, make_layer_key(False))] = ([{"id": "stale"}], 10)
    state._working_set_cache[("stale",)] = (object(), 10)

    ensure_broad_cache_schema(state)

    assert state._broad_cache_schema_version == BROAD_CACHE_SCHEMA_VERSION
    assert state._broad_cache == {}
    assert state._working_set_cache == {}


def test_broad_cache_lookup_prefers_smallest_covering_entry():
    state = FakeState()
    layer_key = make_layer_key(False)
    large_key = ("primary", "chr1", 0, 5000, False, layer_key)
    small_key = ("primary", "chr1", 50, 250, False, layer_key)
    state._broad_cache[large_key] = ([{"id": "large"}], 10)
    state._broad_cache[small_key] = ([{"id": "small"}], 10)

    reads, key = find_broad_cache_entry(
        state,
        "primary",
        "chr1",
        100,
        200,
        False,
        layer_key,
        now=10,
    )

    assert reads == [{"id": "small"}]
    assert key == small_key
    assert list(state._broad_cache.keys())[-1] == small_key


def test_sampled_display_working_set_counts_all_candidates_but_projects_sample():
    state = FakeState()
    layer_key = make_layer_key(False)
    broad_key = ("primary", "chr1", 0, 100, False, layer_key, False, True, 90)
    state._broad_cache[broad_key] = ([
        {"id": "short-left", "intervals": [[0, 20, 20]]},
        {"id": "full", "intervals": [[0, 100, 100]]},
        {"id": "middle", "intervals": [[20, 80, 60]]},
        {"id": "short-mid", "intervals": [[40, 60, 20]]},
        {"id": "short-right", "intervals": [[90, 110, 20]]},
    ], time.time())

    ws, working_count = build_sampled_display_working_set(
        state,
        "primary",
        "chr1",
        0,
        100,
        max_reads=2,
        include_methylation=False,
        include_layers=False,
        include_layer_qualities=False,
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
    )

    assert working_count == 5
    assert ws.total_overlapping == 5
    assert ws.total_spanning == 1
    assert {read["id"] for read in ws.reads} == {"full", "middle"}
    assert all("_fiberbrowser_interval_index" not in read for read in ws.reads)


def test_sampled_display_working_set_zero_max_reads_means_uncapped():
    state = FakeState()
    layer_key = make_layer_key(False)
    broad_key = ("primary", "chr1", 0, 100, False, layer_key, False, True, 90)
    state._broad_cache[broad_key] = ([
        {"id": "left", "intervals": [[0, 20, 20]]},
        {"id": "right", "intervals": [[80, 100, 20]]},
    ], time.time())

    ws, working_count = build_sampled_display_working_set(
        state,
        "primary",
        "chr1",
        0,
        100,
        max_reads=0,
        include_methylation=False,
        include_layers=False,
        include_layer_qualities=False,
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
    )

    assert working_count == 2
    assert {read["id"] for read in ws.reads} == {"left", "right"}


def test_identical_concurrent_broad_cache_misses_share_one_decode():
    state = FakeState()
    barrier = threading.Barrier(2)
    calls_lock = threading.Lock()
    loader_calls = 0

    def slow_loader(path, chrom, start, end, **kwargs):
        nonlocal loader_calls
        with calls_lock:
            loader_calls += 1
        time.sleep(0.1)
        return [{"id": "shared", "intervals": [[900, 1100, 200]]}]

    def load_once():
        barrier.wait()
        return build_sampled_display_working_set(
            state,
            "primary",
            "chr1",
            1000,
            1200,
            max_reads=10,
            include_methylation=False,
            include_layers=False,
            include_layer_qualities=False,
            build_bam_reads=slow_loader,
            build_bigbed_reads=_unused_bigbed_loader,
            load_bigbed_marks=_unused_mark_loader,
        )[0]

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: load_once(), range(2)))

    assert loader_calls == 1
    assert [[read["id"] for read in result.reads] for result in results] == [
        ["shared"],
        ["shared"],
    ]


def test_sampled_display_working_set_computes_profile_from_raw_broad_reads():
    state = FakeState()
    layer_key = make_layer_key(True, ["tf"])
    broad_key = ("primary", "chr1", 0, 100, False, layer_key, False, True, 90)
    state._broad_cache[broad_key] = ([
        {
            "id": "a",
            "intervals": [[0, 100, 100]],
            "layers": {"tf": {"intervals": [[10, 20, 10]]}},
        },
        {
            "id": "b",
            "intervals": [[0, 100, 100]],
            "layers": {"tf": {"intervals": [[10, 20, 10]]}},
        },
    ], time.time())

    ws, working_count = build_sampled_display_working_set(
        state,
        "primary",
        "chr1",
        0,
        100,
        max_reads=1,
        include_methylation=False,
        include_layers=True,
        requested_layers=["tf"],
        include_layer_qualities=False,
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        profile_max_reads=2,
        profile_requested_layers=["tf"],
    )

    assert working_count == 2
    assert len(ws.reads) == 1
    assert ws.profile_read_count == 2
    assert ws.profile_metaprofile["layers"]["tf"][10:20] == [1.0] * 10
    assert ws.profile_metaprofile["layers"]["tf"][20] == 0


def test_working_set_diagnostics_are_quiet_by_default(capsys, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_WORKING_SET_DIAGNOSTICS", raising=False)
    state = FakeState()
    calls = []

    result = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        spanning=False,
        min_footprints=0,
        include_methylation=False,
        include_layers=False,
        build_bam_reads=_bam_loader_factory(calls),
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert len(result.reads) == 2
    assert capsys.readouterr().out == ""


def test_quality_filter_layer_keys_are_narrow_and_alias_fire():
    assert layer_key_for_quality_filters(
        make_layer_key(False),
        [{"layer": "fire", "quality_name": "aq", "min_value": 230}],
    ) == ("fire", "msp")
    assert layer_key_for_quality_filters(
        make_layer_key(False, ["tf"]),
        [{"layer": "fire", "quality_name": "aq", "min_value": 230}],
    ) == ("fire", "msp", "tf")
    assert layer_key_for_quality_filters(
        make_layer_key(False, ["tf"]),
        [{"layer": "*", "quality_name": "aq", "min_value": 230}],
    ) is None


def test_project_broad_read_to_viewport_offsets_marks_and_requested_layers():
    read = {
        "id": "r1",
        "intervals": [[900, 1100, 200]],
        "qualities": [30],
        "methyl": [950],
        "methyl_m6a": [960],
        "methyl_m5c": [970],
        "deam": [[980, 1]],
        "fire": [[920, 930, 128]],
        "layers": {
            "nuc": {
                "intervals": [[900, 950, 50]],
                "qualities": [[30]],
                "quality_names": ["nq"],
            },
            "tf": {
                "intervals": [[980, 1000, 20]],
                "qualities": [[200]],
                "quality_names": ["tq"],
            },
        },
    }

    projected, is_spanning = project_broad_read_to_viewport(
        read,
        viewport_offset=900,
        region_width=100,
        include_methylation=True,
        layer_key=make_layer_key(False, ["tf"]),
    )

    assert is_spanning
    assert projected["intervals"] == ((0, 100, 200),)
    assert projected["qualities"] == [30]
    assert projected["methyl"] == [50]
    assert projected["methyl_m6a"] == [60]
    assert projected["methyl_m5c"] == [70]
    assert projected["deam"] == [[80, 1]]
    assert "fire" not in projected
    assert list(projected["layers"]) == ["tf"]
    assert projected["layers"]["tf"]["intervals"] == [[80, 100, 20]]


def test_fire_layer_key_alias_keeps_internal_msp_payload():
    layer_key = make_layer_key(False, ["fire"])
    read = {
        "id": "r1",
        "intervals": [[100, 180, 80]],
        "layers": {
            "msp": {
                "intervals": [[120, 150, 30]],
                "qualities": [[245]],
                "quality_names": ["aq"],
            },
        },
    }

    projected, _ = project_broad_read_to_viewport(
        read,
        viewport_offset=100,
        region_width=100,
        include_methylation=False,
        layer_key=layer_key,
    )

    assert layer_key_includes(layer_key, "msp")
    assert layer_key_covers(make_layer_key(False, ["msp"]), make_layer_key(False, ["fire"]))
    assert projected["layers"]["msp"]["intervals"] == [[20, 50, 30]]


def test_project_broad_read_to_viewport_clips_layers_and_parallel_qualities():
    read = {
        "id": "r1",
        "intervals": [[50, 90, 40], [90, 110, -20], [110, 170, 60], [170, 210, -40]],
        "qualities": [11, 22],
        "layers": {
            "tf": {
                "intervals": [[60, 80, 20], [120, 150, 30], [220, 240, 20]],
                "qualities": [[10, 20, 30], [110, 120, 130]],
                "quality_names": ["tq", "rq"],
            },
        },
    }

    projected, is_spanning = project_broad_read_to_viewport(
        read,
        viewport_offset=100,
        region_width=100,
        include_methylation=False,
        layer_key=make_layer_key(False, ["tf"]),
    )

    assert is_spanning
    assert projected["intervals"] == ((0, 10, -20), (10, 70, 60), (70, 100, -40))
    assert projected["qualities"] == [22]
    assert projected["layers"]["tf"]["intervals"] == [[20, 50, 30]]
    assert projected["layers"]["tf"]["qualities"] == [[20], [120]]
    assert projected["layers"]["tf"]["quality_names"] == ["tq", "rq"]


def test_project_broad_read_to_viewport_marks_duplicated_nuc_as_derived():
    read = {
        "id": "r1",
        "intervals": [[100, 140, 40], [140, 160, -20], [160, 220, 60]],
        "layers": {
            "nuc": {"intervals": [[100, 140, 40], [160, 220, 60]]},
            "tf": {"intervals": [[170, 190, 20]]},
        },
    }

    projected, _ = project_broad_read_to_viewport(
        read,
        viewport_offset=100,
        region_width=120,
        include_methylation=False,
        layer_key=make_layer_key(False, ["nuc", "tf"]),
        include_layer_qualities=False,
    )

    assert projected["intervals"] == ((0, 40, 40), (40, 60, -20), (60, 120, 60))
    assert projected["layers"] == {"tf": {"intervals": [[70, 90, 20]]}}
    assert projected["derived_layers"] == ["nuc"]


def test_project_broad_read_to_viewport_keeps_nuc_layer_with_qualities():
    read = {
        "id": "r1",
        "intervals": [[100, 140, 40], [140, 160, -20], [160, 220, 60]],
        "layers": {
            "nuc": {
                "intervals": [[100, 140, 40], [160, 220, 60]],
                "qualities": [[30, 40]],
                "quality_names": ["nq"],
            },
        },
    }

    projected, _ = project_broad_read_to_viewport(
        read,
        viewport_offset=100,
        region_width=120,
        include_methylation=False,
        layer_key=make_layer_key(False, ["nuc"]),
        include_layer_qualities=True,
    )

    assert projected["layers"]["nuc"]["intervals"] == [[0, 40, 40], [60, 120, 60]]
    assert projected["layers"]["nuc"]["qualities"] == [[30, 40]]
    assert "derived_layers" not in projected


def test_project_broad_read_to_viewport_omits_layer_payload_when_unrequested():
    projected, is_spanning = project_broad_read_to_viewport(
        {
            "id": "r1",
            "intervals": [[100, 150, 50]],
            "layers": {"tf": {"intervals": [[110, 120, 10]]}},
            "fire": [[115, 125, 128]],
        },
        viewport_offset=100,
        region_width=100,
        include_methylation=False,
        layer_key=make_layer_key(False),
    )

    assert not is_spanning
    assert projected["intervals"] == ((0, 50, 50),)
    assert "layers" not in projected
    assert "fire" not in projected


def test_project_broad_read_to_viewport_rejects_offscreen_reads_early():
    projected, is_spanning = project_broad_read_to_viewport(
        {
            "id": "r1",
            "intervals": [[100, 150, 50]],
            "layers": {"tf": {"intervals": [[110, 120, 10]]}},
        },
        viewport_offset=200,
        region_width=100,
        include_methylation=False,
        layer_key=make_layer_key(True),
    )

    assert projected is None
    assert is_spanning is False


def test_project_broad_read_to_viewport_keeps_visible_layer_outside_primary_envelope():
    projected, is_spanning = project_broad_read_to_viewport(
        {
            "id": "r1",
            # The legacy primary footprint is outside this viewport.
            "intervals": [[200, 250, 50]],
            # An explicit rescue layer remains inside it.
            "layers": {
                "tf_sr": {
                    "intervals": [[110, 120, 10]],
                    "qualities": [[240], [180], [200]],
                    "quality_names": ["q0", "q1", "q2"],
                },
            },
            "possible_deam_ct": [105, 112, 170],
            "possible_deam_ga": [109, 144, 180],
        },
        viewport_offset=100,
        region_width=50,
        include_methylation=True,
        layer_key=make_layer_key(False, ["tf_sr"]),
    )

    assert is_spanning is False
    assert projected["intervals"] == [[10, 20, 0]]
    assert projected["layers"]["tf_sr"] == {
        "intervals": [[10, 20, 10]],
        "qualities": [[240], [180], [200]],
        "quality_names": ["q0", "q1", "q2"],
    }
    assert projected["possible_deam_ct"] == [5, 12]
    assert projected["possible_deam_ga"] == [9, 44]


def test_outside_annotation_does_not_make_cached_read_span_the_viewport():
    read = {"id": "edge", "intervals": [[90, 180, 90]],
            "layers": {"tf": {"intervals": [[230, 250, 20]]}}}
    projected, spanning = project_broad_read_to_viewport(
        read, viewport_offset=100, region_width=100,
        include_methylation=False, layer_key=make_layer_key(True),
    )
    assert projected["intervals"] == ((0, 80, 90),)
    assert not spanning
    assert "layers" not in projected
    # Bounds straddle the view but both annotations are outside it.
    projected, spanning = project_broad_read_to_viewport(
        read, viewport_offset=190, region_width=20,
        include_methylation=False, layer_key=make_layer_key(True),
    )
    assert projected is None and not spanning


def test_cached_deletion_at_view_edge_does_not_count_as_spanning():
    # A deletion separates the offscreen left segment from the visible right
    # segment. Overall alignment bounds cross the view; drawn geometry does not.
    projected, spanning = project_broad_read_to_viewport(
        {"id": "deletion", "intervals": [[0, 80, 80], [180, 250, 70]]},
        viewport_offset=100, region_width=100,
        include_methylation=False, layer_key=make_layer_key(False),
    )
    assert projected["intervals"] == ((80, 100, 70),)
    assert not spanning


def test_broad_read_overlap_index_limits_viewport_candidates():
    state = FakeState()
    reads = [
        {"id": "left", "intervals": [[0, 40, 40]]},
        {"id": "touch-left", "intervals": [[40, 100, 60]]},
        {"id": "inside", "intervals": [[120, 180, 60]]},
        {
            "id": "layer-inside",
            "intervals": [[260, 320, 60]],
            "layers": {"tf_sr": {"intervals": [[130, 145, 15]]}},
        },
        {"id": "spanning", "intervals": [[80, 220, 140]]},
        {"id": "touch-right", "intervals": [[200, 260, 60]]},
        {"id": "right", "intervals": [[260, 320, 60]]},
    ]

    candidates = list(iter_broad_reads_overlapping_viewport(state, reads, 100, 200))

    assert [read["id"] for read in candidates] == ["inside", "layer-inside", "spanning"]
    assert len(state._broad_read_index_cache) == 1
    assert list(iter_broad_reads_overlapping_viewport(state, reads, 100, 200)) == candidates


def test_working_set_broad_index_uses_cache_relative_viewport_offsets():
    state = FakeState()
    layer_key = make_layer_key(False)
    broad_key = ("primary", "chr1", 900, 1300, False, layer_key, True, 90)
    state._broad_cache[broad_key] = ([
        {"id": "left", "intervals": [[0, 40, 40]]},
        {"id": "visible", "intervals": [[110, 180, 70]]},
        {"id": "right", "intervals": [[260, 320, 60]]},
    ], time.time())

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1100,
        include_methylation=False,
        include_layers=False,
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert [read["id"] for read in ws.reads] == ["visible"]
    assert ws.reads[0]["intervals"] == ((10, 80, 70),)
    assert ws.total_overlapping == 1


def test_circular_working_set_wraps_and_merges_segmented_reads():
    state = FakeState()
    state.circular_chroms = {"plasmid": {"source": "test", "size": 1000}}

    def circular_loader(_path, _chrom, broad_start, broad_end, **_kwargs):
        pieces = [
            ("wrap", 970, 1000),
            ("wrap", 0, 30),
            ("left-only", 960, 980),
            ("right-only", 10, 35),
        ]
        reads = []
        for read_id, abs_start, abs_end in pieces:
            if abs_end <= broad_start or abs_start >= broad_end:
                continue
            reads.append({
                "id": read_id,
                "intervals": [[
                    max(abs_start, broad_start) - broad_start,
                    min(abs_end, broad_end) - broad_start,
                    abs_end - abs_start,
                ]],
            })
        return reads

    ws = build_working_set(
        state,
        "primary",
        "plasmid",
        950,
        1050,
        spanning=False,
        min_footprints=0,
        include_methylation=False,
        include_layers=False,
        build_bam_reads=circular_loader,
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    by_id = {read["id"]: read for read in ws.reads}
    assert by_id["wrap"]["intervals"] == [[20, 50, 30], [50, 80, 30]]
    assert by_id["left-only"]["intervals"] == [[10, 30, 20]]
    assert by_id["right-only"]["intervals"] == [[60, 85, 25]]
    assert ws.total_overlapping == 3
    assert ws.total_spanning == 0


def test_min_footprint_filter_counts_full_cached_read_not_zoomed_viewport():
    state = FakeState()
    layer_key = make_layer_key(False)
    broad_key = ("primary", "chr1", 0, 1000, False, layer_key, True, True, 90, 2)
    state._broad_cache[broad_key] = ([
        {"id": "whole-read-pass", "intervals": [[100, 120, 20], [500, 520, 20]]},
    ], time.time())

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        100,
        140,
        min_footprints=2,
        include_methylation=False,
        include_layers=False,
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert [read["id"] for read in ws.reads] == ["whole-read-pass"]
    assert ws.reads[0]["intervals"] == ((0, 20, 20),)


def test_bigbed_first_load_keeps_the_full_context_for_whole_read_filtering():
    def load_bigbed(_paths, _chrom, start, end, **_kwargs):
        footprints = [(600, 620), (1050, 1070), (1500, 1520)]
        return [{"id": "long-read", "intervals": [
            [a - start, b - start, b - a] for a, b in footprints if a < end and b > start
        ]}]

    options = dict(min_footprints=3, include_methylation=False, include_layers=False,
                   build_bam_reads=_bam_loader_factory([]), build_bigbed_reads=load_bigbed,
                   load_bigbed_marks=_unused_mark_loader)
    state = FakeState()
    state.dataset = FakeBigBedDataset()
    full = build_working_set(state, "primary", "chr1", 1000, 1200,
                            stable_sampler=_stable_sampler, **options)
    assert [read['id'] for read in full.reads] == ['long-read']
    state._broad_cache.clear()
    display, count = build_sampled_display_working_set(state, "primary", "chr1", 1000, 1200,
                                                      max_reads=100, **options)
    assert count == 1
    assert [read['id'] for read in display.reads] == ['long-read']


def test_broad_cache_footprint_thresholds_are_not_reused_across_filters():
    state = FakeState()
    layer_key = make_layer_key(False)
    unfiltered_key = ("primary", "chr1", 0, 1000, False, layer_key, True, True, 90, 0)
    filtered_key = ("primary", "chr1", 0, 1000, False, layer_key, True, True, 90, 5)
    state._broad_cache[unfiltered_key] = ([{"id": "unfiltered"}], 10)
    state._broad_cache[filtered_key] = ([{"id": "filtered"}], 10)

    reads, key = find_broad_cache_entry(
        state,
        "primary",
        "chr1",
        100,
        200,
        False,
        layer_key,
        now=10,
        min_footprints=5,
    )

    assert reads == [{"id": "filtered"}]
    assert key == filtered_key


def test_build_working_set_keeps_modes_in_separate_broad_caches():
    state = FakeState()
    calls = []
    load_bam = _bam_loader_factory(calls)

    lean = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        include_methylation=False,
        include_layers=False,
        build_bam_reads=load_bam,
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )
    assert len(calls) == 1
    assert calls[-1]["include_methylation"] is False
    assert calls[-1]["include_layers"] is False
    assert "layers" not in lean.reads[0]
    assert "methyl" not in lean.reads[0]

    rich = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        include_methylation=True,
        include_layers=True,
        build_bam_reads=load_bam,
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )
    assert len(calls) == 2
    assert calls[-1]["include_methylation"] is True
    assert calls[-1]["include_layers"] is True
    assert rich.reads[0]["methyl"] == [50]
    assert rich.reads[0]["methyl_m6a"] == [50]
    assert rich.reads[0]["deam"] == [[60, 1]]
    assert rich.reads[0]["layers"]["nuc"]["intervals"] == [[0, 200, 100]]
    assert rich.reads[0]["fire"] == [[30, 40, 128]]


def test_read_id_filtered_working_sets_are_not_cached():
    state = FakeState()
    calls = []
    load_bam = _bam_loader_factory(calls)

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        read_ids=["r2"],
        include_methylation=False,
        include_layers=False,
        build_bam_reads=load_bam,
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert [read["id"] for read in ws.reads] == ["r2"]
    assert ws.total_overlapping == 2
    assert ws.total_spanning == 1
    assert len(state._working_set_cache) == 0


def test_read_id_filtered_working_sets_bypass_backend_cap():
    state = FakeState()
    state.max_working_reads = 1
    calls = []
    sampler_calls = []
    load_bam = _bam_loader_factory(calls)

    def sampler(reads, max_reads, seed):
        sampler_calls.append((len(reads), max_reads, seed))
        return reads[:max_reads]

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        read_ids=["r1", "r2"],
        include_methylation=False,
        include_layers=False,
        build_bam_reads=load_bam,
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=sampler,
    )

    assert [read["id"] for read in ws.reads] == ["r1", "r2"]
    assert sampler_calls == []


def test_read_id_filtered_working_set_matches_split_rows_by_base_id():
    state = FakeState()

    def load_split_bam(_path, _chrom, _start, _end, **_kwargs):
        return [
            {"id": "r1_0", "intervals": [[900, 1100, 100]]},
            {"id": "r2_0", "intervals": [[920, 1080, 80]]},
        ]

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        read_ids=["r1"],
        include_methylation=True,
        include_layers=False,
        build_bam_reads=load_split_bam,
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert [read["id"] for read in ws.reads] == ["r1_0"]


def test_spanning_working_set_reports_overlapping_reads_when_no_reads_span():
    state = FakeState()
    calls = []
    load_bam = _bam_loader_factory(calls)

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1300,
        spanning=True,
        include_methylation=False,
        include_layers=False,
        build_bam_reads=load_bam,
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert ws.reads == []
    assert ws.total_overlapping == 2
    assert ws.total_spanning == 0


def test_quality_filters_force_layers_and_caps_use_sampler():
    state = FakeState()
    state.quality_filters = [{"layer": "nuc", "quality_name": "nq", "min_value": 20}]
    state.max_working_reads = 1
    calls = []
    load_bam = _bam_loader_factory(calls)

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        include_methylation=False,
        include_layers=False,
        build_bam_reads=load_bam,
        build_bigbed_reads=_unused_bigbed_loader,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert calls[-1]["include_layers"] is True
    assert calls[-1]["requested_layers"] == ("nuc",)
    assert state.filter_calls == 2
    assert len(ws.reads) == 1


def test_bigbed_working_set_loads_only_requested_companion_layers():
    state = FakeState()
    state.dataset = FakeBigBedDataset()
    calls = []

    def _load_bigbed(paths, chrom, start, end, **kwargs):
        calls.append({"paths": paths, **kwargs})
        return [
            {
                "id": "r1",
                "intervals": [[1000 - start, 1200 - start, 100]],
                "layers": {
                    "tf": {
                        "intervals": [[1030 - start, 1060 - start, 30]],
                        "qualities": [[200]],
                        "quality_names": ["tq"],
                    }
                },
            }
        ]

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        include_methylation=False,
        include_layers=True,
        requested_layers=["tf"],
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_load_bigbed,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert calls[-1]["paths"] == ["primary.bb", "primary_tf.bb"]
    assert calls[-1]["requested_layers"] == ("tf",)
    assert "tf" in ws.reads[0]["layers"]


def test_bigbed_working_set_recovers_declared_msp_sidecar_after_empty_combined_layer():
    state = FakeState()
    state.dataset = FakeBigBedDataset()
    calls = []

    def _load_bigbed(paths, chrom, start, end, **kwargs):
        calls.append({"paths": list(paths), **kwargs})
        if list(paths) == ["primary_msp.bb"]:
            return [
                {
                    "id": "r1",
                    "intervals": [[1000 - start, 1400 - start, 400]],
                    "layers": {
                        "msp": {
                            "intervals": [[1120 - start, 1150 - start, 30]],
                            "qualities": None,
                            "quality_names": [],
                        }
                    },
                },
                {
                    "id": "msp-only",
                    "intervals": [[1105 - start, 1200 - start, 95]],
                    "layers": {
                        "msp": {
                            "intervals": [[1110 - start, 1190 - start, 80]],
                            "qualities": None,
                            "quality_names": [],
                        }
                    },
                },
            ]
        # Simulate the reported regression: the combined loader returns TF
        # geometry even though its explicitly requested MSP sidecar vanished.
        return [
            {
                "id": "r1",
                "intervals": [[1000 - start, 1400 - start, 400]],
                "layers": {
                    "tf": {
                        "intervals": [[1130 - start, 1160 - start, 30]],
                        "qualities": None,
                        "quality_names": [],
                    }
                },
            }
        ]

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        include_methylation=False,
        include_layers=True,
        requested_layers=["tf", "fire"],
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_load_bigbed,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert calls[0]["paths"] == ["primary.bb", "primary_tf.bb", "primary_msp.bb"]
    assert calls[1]["paths"] == ["primary_msp.bb"]
    assert calls[1]["requested_layers"] == ("msp", "fire")
    reads_by_id = {read["id"]: read for read in ws.reads}
    assert reads_by_id["r1"]["layers"]["msp"]["intervals"] == [[120, 150, 30]]
    assert reads_by_id["msp-only"]["layers"]["msp"]["intervals"] == [[110, 190, 80]]


def test_bigbed_group_working_set_deduplicates_loaded_layer_paths():
    state = FakeState()
    state.dataset = FakeBigBedGroupDataset()
    calls = []

    def _load_bigbed(paths, chrom, start, end, **kwargs):
        calls.append({"paths": paths, **kwargs})
        return [{"id": "r1", "intervals": [[900, 1100, 100]]}]

    build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        include_methylation=False,
        include_layers=True,
        requested_layers=["tf"],
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_load_bigbed,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert calls[-1]["paths"] == ["primary.bb", "primary_tf.bb"]


def test_bam_working_set_merges_requested_derived_layer_sidecars():
    state = FakeState()
    state.dataset = FakeDerivedBamDataset()
    bam_calls = []
    bigbed_calls = []
    loader = _bam_loader_factory(bam_calls)

    def pooled(paths, chrom, start, end, *, retain_packed, **kwargs):
        # Sidecar merging mutates the loaded rows. A pooled fast path must keep
        # ordinary dictionaries until those requested layers have been merged.
        assert retain_packed is False
        return loader(paths[0], chrom, start, end, **kwargs)

    loader.load_many = pooled

    def _load_bigbed(paths, chrom, start, end, **kwargs):
        bigbed_calls.append({"paths": paths, **kwargs})
        return [{
            "id": "r1",
            "intervals": [],
            "layers": {
                "short_tf": {
                    "intervals": [[940, 955, 15]],
                    "qualities": [[220]],
                    "quality_names": ["confidence"],
                },
            },
        }]

    ws = build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        include_methylation=False,
        include_layers=True,
        requested_layers=["short_tf"],
        build_bam_reads=loader,
        build_bigbed_reads=_load_bigbed,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert bigbed_calls[-1]["paths"] == ["primary.fiberlayers.bb"]
    assert bigbed_calls[-1]["requested_layers"] == ("short_tf",)
    assert ws.reads[0]["layers"] == {
        "short_tf": {
            "intervals": [[40, 55, 15]],
            "qualities": [[220]],
            "quality_names": ["confidence"],
        }
    }


def test_bigbed_working_set_includes_requested_derived_layer_paths():
    state = FakeState()
    state.dataset = FakeBigBedDataset()
    state.dataset.available_layers = {"footprint": True, "tf": True, "short_tf": True}
    state.dataset.derived_layers = {
        "short_tf": {"bundle_path": "primary.fiberlayers.bb", "label": "Short TF"},
    }
    calls = []

    def _load_bigbed(paths, chrom, start, end, **kwargs):
        calls.append({"paths": paths, **kwargs})
        return [{"id": "r1", "intervals": [[900, 1100, 100]]}]

    build_working_set(
        state,
        "primary",
        "chr1",
        1000,
        1200,
        include_methylation=False,
        include_layers=True,
        requested_layers=["short_tf"],
        build_bam_reads=_bam_loader_factory([]),
        build_bigbed_reads=_load_bigbed,
        load_bigbed_marks=_unused_mark_loader,
        stable_sampler=_stable_sampler,
    )

    assert calls[-1]["paths"] == ["primary.bb", "primary.fiberlayers.bb"]


class FakeDddaBigBedDataset:
    data_type = "bigbed"
    paths = ["primary.bb"]
    available_layers = {"footprint": True, "m5c": True, "ddda_mcg": True}
    companion_layers = {"m5c": ["primary_m5c.bb"]}


def test_bigbed_working_set_loads_ddda_mcg_spans_from_the_m5c_companion():
    state = FakeState()
    state.dataset = FakeDddaBigBedDataset()
    calls = []

    def _load_bigbed(paths, chrom, start, end, **kwargs):
        calls.append({"paths": list(paths), **kwargs})
        if list(paths) == ["primary_m5c.bb"]:
            return [{"id": "r1", "intervals": [[1000 - start, 1400 - start, 0]], "methyl_m5c": [5],
                     "layers": {"ddda_mcg": {"intervals": [[1110 - start, 1130 - start, 20]], "qualities": None, "quality_names": []}}}]
        return [{"id": "r1", "intervals": [[1000 - start, 1400 - start, 400]], "layers": {}}]

    ws = build_working_set(
        state, "primary", "chr1", 1000, 1200,
        include_methylation=False, include_layers=True, requested_layers=["ddda_mcg"],
        build_bam_reads=_bam_loader_factory([]), build_bigbed_reads=_load_bigbed,
        load_bigbed_marks=_unused_mark_loader, stable_sampler=_stable_sampler,
    )

    span_call = [call for call in calls if call["paths"] == ["primary_m5c.bb"]]
    assert span_call and span_call[0]["requested_layers"] == ("ddda_mcg",)
    assert "ddda_mcg" in ws.reads[0]["layers"]
    # Only the layer is taken from the m5c file: no 5mC marks without a mark request.
    assert "methyl_m5c" not in ws.reads[0]

    calls.clear()
    build_working_set(
        state, "primary", "chr1", 1000, 1200,
        include_methylation=False, include_layers=True, requested_layers=["tf"],
        build_bam_reads=_bam_loader_factory([]), build_bigbed_reads=_load_bigbed,
        load_bigbed_marks=_unused_mark_loader, stable_sampler=_stable_sampler, force_reload=True,
    )
    assert all(call["paths"] != ["primary_m5c.bb"] for call in calls)
