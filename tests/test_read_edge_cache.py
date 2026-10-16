"""Indexed edge loads must reproduce complete fresh BAM views, not sampled rows."""
from collections import Counter
from contextlib import contextmanager
import copy

import pysam
import pytest

from services.compact_read_loader import build_compact_reads_from_bam
from services.read_binary import binary_read_context, _wire_read
from services.read_edge_cache import edge_fetch_regions, extend_direct_cohort, iter_edge_records, alignment_identity


@pytest.fixture
def evidence_bam(tmp_path):
    path = tmp_path / 'edge.bam'
    specs = [(50, 500, 'both', 0), (140, 40, 'short', 0), (170, 80, 'left', 0),
             (220, 40, 'identical', 0), (220, 40, 'identical', 0),
             (230, 120, 'right', 0), (230, 120, 'right', 16),
             (260, 80, 'flagged', 1024), (360, 60, 'new', 0), (590, 50, 'later', 0)]
    with pysam.AlignmentFile(path, 'wb', header={'HD': {'SO': 'coordinate'}, 'SQ': [{'SN': 'chr1', 'LN': 1000}]}) as out:
        for start, length, name, flag in specs:
            read = pysam.AlignedSegment(out.header)
            read.query_name = name; read.flag = flag; read.reference_id = 0
            read.reference_start = start; read.mapping_quality = 60; read.cigarstring = f'{length}M'
            read.query_sequence = 'A' * length; read.query_qualities = pysam.qualitystring_to_array('I' * length)
            read.set_tag('ns', [8, length - 18]); read.set_tag('nl', [8, 8]); read.set_tag('nq', [90, 220])
            if name in {'left', 'right', 'identical'}:
                read.set_tag('MA', f'{length};nuc+Q:9-8;tf+QQQ:{length - 17}-8')
                read.set_tag('AQ', [220, 128, 40, 80])
            read.set_tag('MM', 'A+a,0,4,4;'); read.set_tag('ML', [255, 200, 150])
            out.write(read)
    pysam.index(str(path))
    return str(path)


@contextmanager
def tracked_loader(path, include_duplicates=False):
    calls = []
    with pysam.AlignmentFile(path) as handle:
        class Tracked:
            def __getattr__(self, name):
                return getattr(handle, name)
            def fetch(self, chrom, start, end):
                calls.append((start, end))
                yield from handle.fetch(chrom, start, end)
        bam = Tracked()
        def load(start, end, *, edges=None):
            token = binary_read_context.set(True)
            try:
                return build_compact_reads_from_bam(path, 'chr1', start, end, spanning_only=False,
                    include_methylation=True, include_layers=True, requested_layers=['nuc', 'tf'],
                    hide_terminal_gaps=False, terminal_gap_threshold=0, short_terminal_footprint_bp=0,
                    include_duplicates=include_duplicates, bam_handle_getter=lambda _: bam,
                    fetch_regions=edges)
            finally:
                binary_read_context.reset(token)
        yield load, calls


def normalized(reads):
    values = {}
    for read in reads:
        item = _wire_read(read)
        if 'layers' in item:
            item = {**item, 'layers': {k: v for k, v in item['layers'].items() if v.get('intervals')}}
        values[alignment_identity(read)] = item
    assert len(values) == len(reads), 'Every physical alignment must retain its own identity'
    return values


@pytest.mark.parametrize('target,expected_edges', [((150, 400), [(300, 400)]),
    ((0, 250), [(0, 100)]), ((0, 400), [(0, 100), (300, 400)]), ((550, 650), [(600, 650)])])
@pytest.mark.parametrize('include_duplicates', [False, True])
def test_edge_load_matches_fresh_full_geometry(evidence_bam, target, expected_edges, include_duplicates):
    original = (500, 600) if target == (550, 650) else (100, 300)
    with tracked_loader(evidence_bam, include_duplicates) as (load, calls):
        old = load(*original); before = copy.deepcopy(old)
        calls.clear()
        result = extend_direct_cohort(old, *original, *target, lambda: load(*target, edges=edge_fetch_regions.get()))
        assert result is not None
        extended, ranges = result
        assert [r['reference_start'] for r in extended] == sorted(r['reference_start'] for r in extended)
        assert ranges == expected_edges
        assert calls == expected_edges, 'No indexed fetch of the overlapping middle is allowed'
        fresh = load(*target)
        assert normalized(extended) == normalized(fresh)
        assert old == before
        assert edge_fetch_regions.get() is None
        if target == (0, 400):
            assert Counter(r['id'] for r in extended)['identical'] == 2
            assert Counter(r['id'] for r in extended)['both'] == 1


def test_unsupported_or_nonoverlapping_cache_does_not_fetch(evidence_bam):
    with tracked_loader(evidence_bam) as (load, calls):
        reads = load(100, 300)
        for start, end in [(120, 250), (700, 800)]:
            calls.clear()
            assert extend_direct_cohort(reads, 100, 300, start, end, lambda: load(start, end)) is None
            assert calls == []
        broken = copy.deepcopy(reads); broken[0].pop('record_sha256')
        calls.clear()
        assert extend_direct_cohort(broken, 100, 300, 150, 400, lambda: load(150, 400)) is None
        assert calls == []


def test_indexed_read_failure_propagates_and_restores_scope(evidence_bam):
    with tracked_loader(evidence_bam) as (load, _):
        reads = load(100, 300)
        def fail():
            assert edge_fetch_regions.get() == ((300, 400),)
            raise OSError('indexed source interrupted')
        with pytest.raises(OSError, match='interrupted'):
            extend_direct_cohort(reads, 100, 300, 150, 400, fail)
        assert edge_fetch_regions.get() is None


def test_cancelled_extension_does_not_touch_the_old_cohort(evidence_bam):
    from threading import Event
    from services.background_work import Cancelled, cancel_scope
    with tracked_loader(evidence_bam) as (load, calls):
        reads = load(100, 300); original = copy.deepcopy(reads); calls.clear()
        cancelled = Event(); cancelled.set()
        with cancel_scope(cancelled), pytest.raises(Cancelled):
            extend_direct_cohort(reads, 100, 300, 150, 400, lambda: load(150, 400))
        assert reads == original and calls == []
        assert edge_fetch_regions.get() is None


def test_edge_iterator_preserves_identical_records_and_validates_ranges(evidence_bam):
    with pysam.AlignmentFile(evidence_bam) as bam:
        records = list(iter_edge_records(bam, 'chr1', 0, 400, [(0, 100), (300, 400)]))
        assert sum(r.query_name == 'both' for r in records) == 1
        duplicates = list(iter_edge_records(bam, 'chr1', 100, 300, [(100, 230), (240, 300)]))
        assert sum(r.query_name == 'identical' for r in duplicates) == 2
        with pytest.raises(ValueError):
            list(iter_edge_records(bam, 'chr1', 0, 400, [(0, 100), (90, 200)]))


def test_edge_signal_windows_join_without_refetch_or_losing_identical_records(evidence_bam, monkeypatch):
    from itertools import product
    from services import bam_handles, signal_windows
    from services.signal_counts import signal_counts
    from state.browser_state import BrowserState

    state = BrowserState(None, reference_only=True)
    state.add_dataset('edge', evidence_bam)
    with tracked_loader(evidence_bam) as (load, calls):
        load(0, 700, edges=[(0, 100), (300, 700)])
        assert calls == [(0, 100), (300, 700)]
        # A read spanning the missing middle does not prove fetch coverage.
        assert signal_windows.find_signal_window(evidence_bam, 'chr1', 90, 450) is None
        assert signal_windows.find_signal_window(evidence_bam, 'chr1', 350, 650) is not None
        load(100, 300)
    with pysam.AlignmentFile(evidence_bam) as bam:
        rows = list(bam.fetch())
    def no_reader(*args, **kwargs):
        raise AssertionError('cached edges acquired a BAM reader')
    monkeypatch.setattr(bam_handles, 'get_bam_handle', no_reader)
    for duplicates, spanning, (start, end) in product((False, True), (False, True),
            ((0, 700), (90, 450), (230, 400), (250, 310), (500, 600), (650, 700))):
        selected = [r for r in rows if r.reference_start < end and r.reference_end > start
                    and (duplicates or not r.is_duplicate)
                    and (not spanning or r.reference_start <= start and r.reference_end >= end)]
        counts = signal_counts(state, 'edge', 'chr1', start, end,
                               include_duplicates=duplicates, spanning=spanning)
        assert counts['total'] == counts['unknown'] == counts['kept'] == len(selected)
        assert counts['hidden'] == counts['structure_scored'] == 0
    combined = signal_windows.find_signal_window(evidence_bam, 'chr1', 0, 700)
    assert combined.counts(0, 700, previous=[(200, 300)], include_duplicates=True)['total'] == sum(
        not (r.reference_start < 300 and r.reference_end > 200) for r in rows)
    # Eviction invalidates only coverage supplied by the removed interval.
    for key, window in list(signal_windows._windows.items()):
        if window.path == evidence_bam and window.regions == ((100, 300),):
            del signal_windows._windows[key]
    assert signal_windows.find_signal_window(evidence_bam, 'chr1', 90, 450) is None
    assert signal_windows.find_signal_window(evidence_bam, 'chr1', 350, 650) is not None


def test_unsupported_loader_and_incoming_circular_rows_fall_back(evidence_bam):
    from services.read_edge_cache import EdgeFetchUnsupported
    with tracked_loader(evidence_bam) as (load, _):
        old = load(100, 300)
        def unsupported():
            raise EdgeFetchUnsupported('header circular')
        assert extend_direct_cohort(old, 100, 300, 150, 400, unsupported) is None
        assert edge_fetch_regions.get() is None
        incoming = load(150, 400, edges=[(300, 400)])
        incoming[0]['alignment_spans'] = [[0, 250]]
        assert extend_direct_cohort(old, 100, 300, 150, 400, lambda: incoming) is None


def test_bounded_decode_preserves_real_bam_evidence(evidence_bam):
    from services.packed_reads import PackedReads, bounded_read_analysis
    with tracked_loader(evidence_bam, True) as (load, _):
        native = load(0, 700)
        with bounded_read_analysis():
            bounded = load(0, 700)
        assert isinstance(bounded, PackedReads)
        assert list(bounded) == native


def test_edge_projection_reloads_when_clipping_enables_real_bam_mismatch_evidence(tmp_path):
    path = tmp_path / 'mark-fallback.bam'
    with pysam.AlignmentFile(path, 'wb', header={'SQ': [{'SN': 'chr1', 'LN': 1000}]}) as out:
        record = pysam.AlignedSegment(out.header)
        record.query_name = 'fallback'; record.reference_id = 0; record.reference_start = 100
        record.mapping_quality = 60; record.cigarstring = '100M'
        record.query_sequence = 'A' * 70 + 'T' + 'A' * 29
        record.set_tag('MM', 'A+a,0;'); record.set_tag('ML', [255]); record.set_tag('MD', '70C29')
        out.write(record)
    pysam.index(str(path))
    with tracked_loader(str(path)) as (load, calls):
        old = load(100, 200)
        assert old[0]['methyl_m6a'] == [0] and not old[0].get('deam')
        calls.clear()
        assert extend_direct_cohort(old, 100, 200, 120, 230,
            lambda: load(120, 230, edges=edge_fetch_regions.get())) is None
        assert calls == []
        fresh = load(120, 230)
        assert [p for p, _ in fresh[0]['deam']] == [50]


@pytest.mark.parametrize('mode', ['bounded', 'edge'])
def test_interrupted_decoder_never_returns_a_partial_cohort(evidence_bam, mode):
    from contextlib import nullcontext
    from services.packed_reads import bounded_analysis, bounded_read_analysis, packed_decode
    with pysam.AlignmentFile(evidence_bam) as handle:
        class Interrupted:
            def __getattr__(self, name):
                return getattr(handle, name)
            def fetch(self, chrom, start, end):
                # Enough records to flush a packed block before the I/O error.
                for _ in range(40):
                    yield from handle.fetch(chrom, start, end)
                raise OSError('source interrupted after a completed block')
        with pytest.raises(OSError, match='completed block'):
            with bounded_read_analysis() if mode == 'bounded' else nullcontext():
                build_compact_reads_from_bam(evidence_bam, 'chr1', 0, 700,
                    spanning_only=False, bam_handle_getter=lambda _: Interrupted(),
                    fetch_regions=[(0, 700)] if mode == 'edge' else None)
    assert not bounded_analysis.get() and not packed_decode.get()


def test_parallel_decoder_obeys_indexed_edge_regions(evidence_bam, monkeypatch):
    from types import SimpleNamespace
    from services.read_edge_cache import fetching_edges
    from services.read_route_helpers import build_direct_bam_reads
    from services import background_work, read_sampling
    monkeypatch.setattr(read_sampling, 'estimate_reads', lambda *args, **kwargs: 100_000)
    monkeypatch.setattr(background_work, 'is_interactive_read', lambda: False)
    state = SimpleNamespace(performance={'decode_workers': 2})
    token = binary_read_context.set(True)
    try:
        with fetching_edges([(300, 400)]):
            parallel = build_direct_bam_reads(state, evidence_bam, 'chr1', 150, 400,
                spanning_only=False, include_methylation=True, include_layers=True, requested_layers=['nuc', 'tf'],
                hide_terminal_gaps=False, terminal_gap_threshold=0, short_terminal_footprint_bp=0,
                include_duplicates=True)
        with tracked_loader(evidence_bam, True) as (load, _):
            native = load(150, 400, edges=[(300, 400)])
        assert normalized(parallel) == normalized(native)
        assert all(r['reference_end'] > 300 and r['reference_start'] < 400 for r in parallel)
    finally:
        binary_read_context.reset(token)


def test_indels_soft_clips_and_repeat_pans_preserve_full_evidence(tmp_path):
    path = tmp_path / 'indels.bam'
    header = {'HD': {'SO': 'coordinate'}, 'SQ': [{'SN': 'chr1', 'LN': 2000}]}
    with pysam.AlignmentFile(path, 'wb', header=header) as out:
        for index in range(60):
            record = pysam.AlignedSegment(out.header)
            record.query_name = f'geometry-{index}'
            record.reference_id = 0; record.reference_start = 20 + index * 9
            record.flag = 16 if index % 2 else 0; record.mapping_quality = 60
            record.cigarstring = ['100M60D100M', '100M70I100M', '30S200M', '200M'][index % 4]
            length = record.infer_query_length()
            record.query_sequence = 'A' * length
            record.query_qualities = pysam.qualitystring_to_array('I' * length)
            record.set_tag('ns', [10, 90, length - 30]); record.set_tag('nl', [35, 40, 20])
            record.set_tag('nq', [100, 170, 220])
            record.set_tag('MM', 'A+a,0,19,19;'); record.set_tag('ML', [250, 180, 210])
            out.write(record)
    pysam.index(str(path))
    with tracked_loader(str(path)) as (load, calls):
        old_start, old_end = 100, 500
        cohort = load(old_start, old_end)
        edge_extensions = 0
        for start, end in [(80, 550), (150, 620), (30, 600), (200, 700), (500, 850)]:
            calls.clear()
            extended = extend_direct_cohort(cohort, old_start, old_end, start, end,
                                            lambda: load(start, end, edges=edge_fetch_regions.get()))
            if extended is None:
                # Losing all visible primary marks can enable the BAM
                # loader's mismatch fallback; cached evidence is insufficient.
                assert calls == []
                cohort = load(start, end)
            else:
                edge_extensions += 1
                cohort, ranges = extended
                assert calls == ranges
            assert normalized(cohort) == normalized(load(start, end))
            old_start, old_end = start, end
        assert edge_extensions > 0


@pytest.mark.parametrize('start,end,edges', [(150, 400, [(300, 400)]), (0, 250, [(0, 100)]), (0, 400, [(0, 100), (300, 400)])])
def test_endpoint_extends_cache_using_only_indexed_edges(evidence_bam, monkeypatch, start, end, edges):
    import json
    from types import SimpleNamespace
    from services.read_endpoint import compact_reads_payload_for_request
    from services import read_route_helpers
    calls = []
    with pysam.AlignmentFile(evidence_bam) as handle:
        class Tracked:
            def __getattr__(self, name):
                return getattr(handle, name)
            def fetch(self, chrom, left, right):
                calls.append((left, right))
                yield from handle.fetch(chrom, left, right)
        monkeypatch.setattr(read_route_helpers, 'get_bam_handle', lambda _: Tracked())
        dataset = SimpleNamespace(id='sample', label='sample', color='#123456', data_type='bam',
            paths=[evidence_bam], available_layers={'footprint': True, 'tf': True, 'm6a': True},
            cluster_assignments={}, companion_layers={}, derived_layers={})
        state = SimpleNamespace(datasets={'sample': dataset}, dataset_order=['sample'], max_working_reads=0,
            performance={'effective': 'standard', 'decode_workers': 1}, quality_filters=[], short_terminal_footprint_bp=0,
            translate_chrom=lambda c: c, get_dataset=lambda d: dataset if d == 'sample' else None)
        params = dict(chrom='chr1', dataset_id='sample', include_methylation=True, include_layers=True,
            layer_names='nuc,tf', hide_terminal_gaps=False, terminal_gap_threshold=0, full_working_set=True, max_reads=0)
        token = binary_read_context.set(True)
        try:
            compact_reads_payload_for_request(state, start=100, end=300, **params)
            calls.clear()
            extended = compact_reads_payload_for_request(state, start=start, end=end, **params)
            assert calls == edges
            assert extended['server_timings']['direct_edge_bases'] == sum(b - a for a, b in edges)
            state._methylation_cache.clear(); calls.clear()
            fresh = compact_reads_payload_for_request(state, start=start, end=end, **params)
            assert calls == [(start, end)]
        finally:
            binary_read_context.reset(token)
        for field in ('count', 'display_count', 'total', 'total_in_scope', 'total_overlapping', 'total_spanning', 'working_count'):
            assert extended[field] == fresh[field]
        canonical = lambda data: Counter(json.dumps(_wire_read(r), sort_keys=True) for r in data['reads'])
        assert canonical(extended) == canonical(fresh)
