"""Dense display caching must retain the exact cohort, geometry and evidence."""
import copy
import pickle
import time

import pytest

from services.packed_reads import PackedReads, ReadDisplayIndex, compact_read_bounds


def test_display_index_matches_clipped_geometry_with_holes_and_layer_only_rows():
    import random
    rng = random.Random(721)
    reads = [{'id': str(i), 'intervals': [[s, s + rng.randrange(1, 50), 7]
              for s in (rng.randrange(-100, 200) for _ in range(rng.randrange(9)))],
              'layers': {'tf': {'intervals': [[s, s + 12, 12] for s in
                  (rng.randrange(-100, 200) for _ in range(rng.randrange(4)))]}}}
             for i in range(200)]
    index = ReadDisplayIndex(reads)
    for start in range(-120, 220, 7):
        end = start + 25
        expected = {i: (max(start, b[0]), min(end, b[1])) for i, read in enumerate(reads)
                    if (b := compact_read_bounds(read, start, end)) is not None}
        actual = {i: (max(start, a), min(end, b)) for i, _, a, b in index.overlapping(start, end)}
        assert actual == expected


@pytest.mark.parametrize('cap', [0, 2])
@pytest.mark.parametrize('spanning', [False, True])
def test_packed_display_matches_raw_profiles_pins_quality_and_sv(cap, spanning):
    from test_working_sets import FakeState
    from services.working_sets import build_sampled_display_working_set, make_layer_key
    from services.read_pins import pinned_reads
    reads = [
        {'id': 'full', 'intervals': [[0, 20, 20], [20, 100, -80]],
         'reference_start': 0, 'reference_end': 100, 'sv': [{'t': 'I', 'ref': 50, 'len': 60}],
         'layers': {'tf': {'intervals': [[15, 30, 15]], 'quality_names': ['aq'], 'qualities': [[240]]}}},
        {'id': 'gap', 'intervals': [[0, 10, 10], [70, 100, 30]],
         'reference_start': 0, 'reference_end': 100},
        {'id': 'layer', 'intervals': [], 'layers': {'tf': {'intervals': [[35, 50, 15]],
          'quality_names': ['aq'], 'qualities': [[20]]}}, 'reference_start': 20, 'reference_end': 80},
        {'id': 'pin', 'intervals': [[32, 38, 6]], 'reference_start': 32, 'reference_end': 38},
        {'id': 'full', 'intervals': [[10, 90, -80]], 'reference_start': 10, 'reference_end': 90},
    ]
    outputs = []
    for packed in [False, True]:
        state = FakeState()
        cohort = copy.deepcopy(reads)
        if packed:
            cohort = pickle.loads(pickle.dumps(PackedReads(cohort)))
        state._broad_cache[('primary', 'chr1', 0, 100, False, make_layer_key(True, 'tf'), True, True, 90)] = (cohort, time.time())
        with pinned_reads(['pin']):
            ws, count = build_sampled_display_working_set(state, 'primary', 'chr1', 30, 60,
                max_reads=cap, spanning=spanning, include_methylation=False, requested_layers='tf',
                quality_filters=[{'layer': 'tf', 'quality': 'aq', 'min_value': 230}],
                profile_max_reads=cap, profile_requested_layers='tf', sv_min_len=50,
                build_bam_reads=lambda *a, **k: pytest.fail('cache missed'),
                build_bigbed_reads=lambda *a, **k: [], load_bigbed_marks=lambda *a, **k: [])
        outputs.append((ws.reads, count, ws.total_overlapping, ws.total_spanning,
                        ws.profile_metaprofile, ws.profile_read_count, ws.sv_summary))
    assert outputs[0] == outputs[1]


def test_packed_selection_expands_only_selected_frames_once(monkeypatch):
    from services import packed_reads
    reads = [{'id': str(i), 'intervals': [[0, 100, 100]]} for i in range(2048)]
    packed = PackedReads(reads)
    decoded = []
    original = packed_reads.zlib.decompress
    monkeypatch.setattr(packed_reads.zlib, 'decompress', lambda b: decoded.append(b) or original(b))
    assert len(list(packed._display_index.overlapping(20, 40))) == len(reads)
    assert not decoded
    indices = [1500, 1, 1501, 1, 0]
    assert packed.take(indices) == {i: reads[i] for i in indices}
    assert len(decoded) == 2
    # Sparse selection should not expand hundreds of unrelated molecules.
    assert sum(len(pickle.loads(original(part))) for part in decoded) <= 32
    assert packed.take(list(reversed(indices))) == {i: reads[i] for i in indices}
    assert len(decoded) == 2


@pytest.mark.parametrize('binary', [False, True])
@pytest.mark.parametrize('retain_packed', [False, True])
def test_parallel_pool_preserves_file_order_duplicate_names_and_all_evidence(tmp_path, binary, retain_packed):
    from insertion_fixtures import make_insertion_bam, SITE
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.parallel_reads import parallel_bam_files
    from services.read_binary import binary_read_context
    paths = []
    for i in range(2):
        folder = tmp_path / str(i)
        folder.mkdir()
        paths.append(make_insertion_bam(folder)['bam'])
    options = dict(spanning_only=False, include_methylation=True, include_layers=True,
                   include_cigar=True, include_sv_seq=True, hide_terminal_gaps=False)
    token = binary_read_context.set(binary)
    try:
        expected = [read for path in paths for read in build_compact_reads_from_bam(
            path, 'chrT', SITE - 2000, SITE + 2000, **options)]
        actual = parallel_bam_files(paths, 'chrT', SITE - 2000, SITE + 2000, [options] * 2, 2,
                                    retain_packed=retain_packed)
    finally:
        binary_read_context.reset(token)
    assert list(actual) == expected
    if retain_packed:
        assert isinstance(actual, PackedReads)
        assert actual[0] == expected[0] and actual[-1] == expected[-1]
        assert actual.take(range(len(actual))) == dict(enumerate(expected))


@pytest.mark.parametrize('retain_packed', [False, True])
def test_cancelled_pool_releases_workers_and_can_load_again(tmp_path, retain_packed):
    import multiprocessing
    import threading
    from insertion_fixtures import make_insertion_bam, SITE
    from services.background_work import Cancelled, cancel_scope
    from services.parallel_reads import parallel_bam_files
    path = make_insertion_bam(tmp_path)['bam']
    before = {child.pid for child in multiprocessing.active_children()}
    cancel = threading.Event()
    timer = threading.Timer(.01, cancel.set)
    timer.start()
    try:
        with cancel_scope(cancel), pytest.raises(Cancelled):
            parallel_bam_files([path] * 4, 'chrT', SITE - 2000, SITE + 2000,
                               [{'spanning_only': False}] * 4, 2, retain_packed=retain_packed)
    finally:
        timer.cancel()
        timer.join()
    assert {child.pid for child in multiprocessing.active_children()} <= before
    assert parallel_bam_files([path] * 2, 'chrT', SITE - 2000, SITE + 2000,
                              [{'spanning_only': False}] * 2, 2, retain_packed=retain_packed)


@pytest.mark.parametrize('lengths', [[], [1], [256, 3, 256, 17, 1]])
@pytest.mark.parametrize('frames', [False, True])
def test_worker_display_blocks_keep_variable_boundaries_and_exact_geometry(lengths, frames, monkeypatch):
    import zlib
    from services.byte_cache import retained_size
    from services import packed_reads
    reads, parts = [], []
    for size in lengths:
        block = [{'id': str(i), 'reference_start': i, 'reference_end': i + 100,
                  'intervals': [[i, i + 5, 5], [i + 30, i + 100, -70]],
                  'layers': {'tf': {'intervals': [[i + 10, i + 14, 4]],
                                     'quality_names': ['aq'], 'qualities': [[230]]}}}
                 for i in range(len(reads), len(reads) + size)]
        encoded = packed_reads._encode_block(block) if frames else zlib.compress(pickle.dumps(block, protocol=5), 1)
        parts.append((encoded,
                      ReadDisplayIndex(block), retained_size(block)))
        reads.extend(block)
    original = packed_reads.zlib.decompress
    monkeypatch.setattr(packed_reads.zlib, 'decompress', lambda *a: pytest.fail('expanded during assembly'))
    packed = PackedReads.from_display_blocks(parts)
    assert len(packed) == len(reads)
    compressed_bytes = sum(sum(map(len, block)) if isinstance(block, tuple) else len(block)
                           for block, _, _ in parts)
    reserve = max((size for _, _, size in parts), default=0)
    assert packed.retained_bytes >= compressed_bytes + reserve + packed._selection_budget
    for start in range(0, len(reads) + 100, 17):
        expected = {i: (max(start, b[0]), min(start + 10, b[1])) for i, r in enumerate(reads)
                    if (b := compact_read_bounds(r, start, start + 10)) is not None}
        actual = {i: (max(start, a), min(start + 10, b)) for i, _, a, b in
                  packed._display_index.overlapping(start, start + 10)}
        assert actual == expected
    monkeypatch.setattr(packed_reads.zlib, 'decompress', original)
    packed = pickle.loads(pickle.dumps(packed))
    assert list(packed) == reads
    assert packed[::-1] == reads[::-1]
    assert packed.take(range(len(reads))) == dict(enumerate(reads))
    for i in range(-len(reads), len(reads)):
        assert packed[i] == reads[i]
    with pytest.raises(IndexError):
        packed[len(reads)]


def test_frame_selection_eviction_and_cancellation_preserve_evidence(monkeypatch):
    import threading
    from services import packed_reads
    from services.background_work import Cancelled, cancel_scope
    reads = [{'id': str(i), 'intervals': [[i, i + 50, 50]],
              'layers': {'tf': {'qualities': [[0.123456789, 231]], 'intervals': [[i, i + 3, 3]]}}}
             for i in range(530)]
    packed = PackedReads(reads)
    packed._selected.resize(4000)
    assert packed.take(range(530)) == dict(enumerate(reads))
    assert packed._selected.retained_bytes <= 4000 and len(packed._selected) < 530
    assert len(packed._decoded) == 1
    assert packed.take([0, 16, 255, 256, 512, 529]) == {i: reads[i] for i in [0, 16, 255, 256, 512, 529]}
    cancelled = threading.Event()
    cancelled.set()
    with cancel_scope(cancelled), pytest.raises(Cancelled):
        packed[33]
    assert packed[33] == reads[33]
    # Foreground work must be able to take the cache lock while a speculative
    # reader is paused at its checkpoint.
    checkpoint = packed_reads.checkpoint
    def unlocked_checkpoint():
        assert not packed._lock._is_owned()
        checkpoint()
    monkeypatch.setattr(packed_reads, 'checkpoint', unlocked_checkpoint)
    assert packed[120] == reads[120]


def test_bam_topology_keeps_origin_spanning_reads_out_of_linear_worker_pool(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from test_circular_origin_spanning import write_fixture, CONTIG
    from services.read_route_helpers import display_bam_loader, build_direct_bam_reads
    from services.background_work import interactive_read
    from services.compact_read_loader import build_compact_reads_from_bam
    fixture = write_fixture(tmp_path)
    path = str(fixture['bam'])
    state = SimpleNamespace(performance={'decode_workers': 2}, chrom_map={}, circular_chroms={})
    monkeypatch.setattr('services.read_sampling.estimate_reads', lambda *a, **k: 50000)
    monkeypatch.setattr('services.parallel_reads.parallel_bam_files',
                        lambda *a, **k: pytest.fail('circular file entered linear pool'))
    monkeypatch.setattr('services.parallel_reads.parallel_bam_reads',
                        lambda *a, **k: pytest.fail('circular file entered hash partitions'))
    options = dict(spanning_only=False, hide_terminal_gaps=False, include_layers=True,
                   include_methylation=True, short_terminal_footprint_bp=0, contig_links={})
    with interactive_read():
        assert display_bam_loader(state).load_many([path, path], CONTIG, 0, 200,
                                                   retain_packed=True, **options) is None
    actual = build_direct_bam_reads(state, path, CONTIG, 0, 200, **options)
    expected = build_compact_reads_from_bam(path, CONTIG, 0, 200, **options)
    assert actual == expected and actual
