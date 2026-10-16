"""Foreground decompression must preserve evidence and release native workers."""
from types import SimpleNamespace

import pytest

from services import bam_handles
from services.background_work import Cancelled, interactive_read, speculative_read
from services.file_handles import HandleCache


@pytest.fixture
def readers(monkeypatch):
    from services.remote_sources import opening
    cache = HandleCache()
    opened = []
    original = opening.open_alignment_file

    def open_reader(*args, **kwargs):
        reader = original(*args, **kwargs)
        opened.append((kwargs['threads'], reader))
        return reader

    monkeypatch.setattr(bam_handles, 'handles', cache)
    monkeypatch.setattr(bam_handles, '_bam_threads', 4)
    monkeypatch.setattr(opening, 'open_alignment_file', open_reader)
    yield cache, opened
    cache.discard()


@pytest.mark.parametrize('failure', [None, RuntimeError, Cancelled])
def test_transient_reader_closes_threads_after_completion_error_or_cancel(tmp_path, readers, failure):
    from insertion_fixtures import make_insertion_bam, SITE
    path = make_insertion_bam(tmp_path)['bam']
    cache, opened = readers

    def run():
        with bam_handles.transient_bam_handle(path, threads=4) as reader:
            assert list(reader.fetch('chrT', SITE - 2000, SITE + 2000))
            assert opened[-1][0] == 4 and opened[-1][1].is_open
            if failure:
                raise failure()

    if failure:
        with pytest.raises(failure):
            run()
    else:
        for _ in range(12):
            run()
    assert all(not reader.is_open for _, reader in opened)
    assert cache.diagnostics()['entries'] == 0


def test_foreground_reader_does_not_retire_paused_outward_fill(tmp_path, readers):
    from insertion_fixtures import make_insertion_bam, SITE
    path = make_insertion_bam(tmp_path)['bam']
    _, opened = readers
    with speculative_read():
        background = bam_handles.get_bam_handle(path)
        iterator = background.fetch('chrT', SITE - 2000, SITE + 2000)
        first = next(iterator)
    with interactive_read(), bam_handles.transient_bam_handle(path, threads=4) as foreground:
        expected = [r.to_string() for r in foreground.fetch('chrT', SITE - 2000, SITE + 2000)]
    assert opened[0][1].is_open and not opened[1][1].is_open
    assert [first.to_string(), *[r.to_string() for r in iterator]] == expected


@pytest.mark.parametrize('binary', [False, True])
def test_threaded_display_preserves_sample_pins_marks_layers_and_counts(tmp_path, readers, binary):
    from insertion_fixtures import make_insertion_bam, SITE
    from services.read_route_helpers import build_direct_bam_reads
    from services.read_sampling import Sampler, sampling
    from services.read_binary import binary_read_context
    from services.signal_windows import find_signal_window
    from services.signal_evidence import signal_filters_for_request
    path = make_insertion_bam(tmp_path)['bam']
    _, opened = readers
    state = SimpleNamespace(performance={'bam_threads': 4, 'decode_workers': 1}, chrom_map={})
    options = dict(spanning_only=False, hide_terminal_gaps=False, include_methylation=True,
                   include_layers=True, include_layer_qualities=True, include_cigar=True,
                   include_sv_seq=True, circular=False, contig_links={}, short_terminal_footprint_bp=50)
    token = binary_read_context.set(binary)
    results = []
    try:
        for threaded in [False, True]:
            sampler = Sampler(2, keep_ids={'ref_0'})
            with sampling(sampler), signal_filters_for_request({'hideBackground': True}):
                if threaded:
                    with interactive_read():
                        reads = build_direct_bam_reads(state, path, 'chrT', SITE - 2000, SITE + 2000, **options)
                else:
                    reads = build_direct_bam_reads(state, path, 'chrT', SITE - 2000, SITE + 2000, **options)
                counts = find_signal_window(path, 'chrT', SITE - 2000, SITE + 2000).counts(SITE - 2000, SITE + 2000)
            results.append((reads, sampler.skipped_starts, sampler.skipped_ends,
                            sampler.kept_starts, sampler.kept_ends, counts))
    finally:
        binary_read_context.reset(token)
    assert results[0] == results[1] and results[0][0]
    assert opened[-1][0] == 4 and not opened[-1][1].is_open
    assert opened[0][0] == 1 and opened[0][1].is_open


def test_low_memory_caps_transient_threads(tmp_path, readers, monkeypatch):
    from insertion_fixtures import make_insertion_bam
    path = make_insertion_bam(tmp_path)['bam']
    monkeypatch.setattr(bam_handles, '_bam_threads', 1)
    with bam_handles.transient_bam_handle(path, threads=4) as reader:
        assert reader is not None
        assert readers[1][-1][0] == 1
    assert not readers[1][-1][1].is_open


def test_cancelling_decode_with_retained_traceback_closes_native_reader(tmp_path, readers, monkeypatch):
    from insertion_fixtures import make_insertion_bam, SITE
    from services.read_route_helpers import build_direct_bam_reads
    from services import compact_read_loader
    from services.read_sampling import Sampler, sampling
    path = make_insertion_bam(tmp_path)['bam']
    state = SimpleNamespace(performance={'bam_threads': 4}, chrom_map={})

    def cancel(*args, **kwargs):
        raise Cancelled()

    monkeypatch.setattr(compact_read_loader, '_attach_sv_events', cancel)
    with interactive_read(), sampling(Sampler(1)), pytest.raises(Cancelled) as caught:
        build_direct_bam_reads(state, path, 'chrT', SITE - 2000, SITE + 2000,
            spanning_only=False, hide_terminal_gaps=False, circular=False, contig_links={},
            short_terminal_footprint_bp=0)
    assert caught.value.__traceback__ is not None
    assert readers[1] and all(not reader.is_open for _, reader in readers[1])


def test_retained_partial_iterator_cannot_keep_transient_native_pool_alive(tmp_path, readers):
    from insertion_fixtures import make_insertion_bam, SITE
    path = make_insertion_bam(tmp_path)['bam']
    with pytest.raises(Cancelled) as caught:
        with bam_handles.transient_bam_handle(path, threads=4) as reader:
            iterator = reader.fetch('chrT', SITE - 2000, SITE + 2000)
            assert next(iterator)
            raise Cancelled()
    assert iterator is not None and caught.value.__traceback__ is not None
    assert not reader.is_open and all(not raw.is_open for _, raw in readers[1])


def test_cancellation_while_waiting_for_native_pool_opens_no_reader(tmp_path, readers, monkeypatch):
    import threading
    from services.background_work import cancel_scope
    from insertion_fixtures import make_insertion_bam
    path = make_insertion_bam(tmp_path)['bam']
    slots = threading.BoundedSemaphore(1)
    slots.acquire()
    monkeypatch.setattr(bam_handles, '_transient_pools', slots)
    cancel = threading.Event()
    cancel.set()
    with cancel_scope(cancel), pytest.raises(Cancelled):
        with bam_handles.transient_bam_handle(path, threads=4):
            pytest.fail('cancelled waiter entered reader scope')
    assert readers[1] == []
    slots.release()
    with bam_handles.transient_bam_handle(path, threads=4) as reader:
        assert reader.is_open
    assert not reader.is_open
