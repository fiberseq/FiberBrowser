"""Reader reuse, retirement, failure backoff and navigation under cache pressure."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Thread
import os

import pytest

from services.file_handles import HandleCache, file_stamp


class Reader:
    def __init__(self, path):
        self.file = open(path, 'rb')
        self.closed = False

    def close(self):
        self.closed = True
        self.file.close()

    def fetch(self, *args):
        self.file.seek(0)
        for line in self.file:
            assert not self.closed
            yield line

    def read(self):
        self.file.seek(0)
        return self.file.read()


def getter(cache, path, opened, kind='bam'):
    def open_reader():
        reader = Reader(path)
        opened.append(reader)
        return reader
    return lambda: cache.get(kind, str(path), open_reader, lambda: file_stamp(path))


def test_all_pools_share_one_native_reader_and_serialize_iterators(tmp_path):
    path = tmp_path / 'reads'; path.write_bytes(b'A\nB\nC\n' * 300)
    cache, opened = HandleCache(), []
    get = getter(cache, path, opened)
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda _: list(get().fetch()), range(80)))
    assert all(result == [b'A\n', b'B\n', b'C\n'] * 300 for result in results)
    assert len(opened) == 1
    cache.discard()
    assert opened[0].closed


def test_paused_prefetch_keeps_its_iterator_without_blocking_the_visible_reader(tmp_path):
    from services.background_work import speculative_read, interactive_read, checkpoint
    path = tmp_path / 'reads'; path.write_bytes(b'A\nB\nC\n')
    cache, opened = HandleCache(max_entries=1), []
    get = getter(cache, path, opened)
    started, next_record, complete = Event(), Event(), Event()
    progress = []

    def warm():
        with speculative_read():
            iterator = get().fetch()
            progress.append(next(iterator))
            started.set()
            assert next_record.wait(3)
            checkpoint()
            progress.extend(iterator)
        complete.set()

    thread = Thread(target=warm, daemon=True)
    thread.start()
    assert started.wait(3)
    try:
        with interactive_read():
            next_record.set()
            # The background iterator is paused on its own cursor. The foreground
            # can read the same BAM immediately, even with a one-reader budget.
            assert list(get().fetch()) == [b'A\n', b'B\n', b'C\n']
            assert not complete.is_set()
        assert complete.wait(3)
        thread.join(3)
        assert progress == [b'A\n', b'B\n', b'C\n']
        assert len(opened) == 2
        assert cache.diagnostics()['prefetch']['limit'] == 1
    finally:
        next_record.set()
        cache.discard()
    assert all(reader.closed for reader in opened)


def test_eviction_and_removal_wait_for_active_iterator(tmp_path):
    a = tmp_path / 'a'; a.write_bytes(b'A\nB\n')
    b = tmp_path / 'b'; b.write_bytes(b'C\n')
    cache, opened = HandleCache(max_entries=1), []
    get_a, get_b = getter(cache, a, opened), getter(cache, b, opened)
    entered, finish, done = Event(), Event(), Event()
    def reader():
        iterator = get_a().fetch()
        assert next(iterator) == b'A\n'
        entered.set()
        assert finish.wait(5)
        assert next(iterator) == b'B\n'
        iterator.close()
    t = Thread(target=reader); t.start(); assert entered.wait(5)
    cache.discard(str(a))
    other = Thread(target=lambda: (get_b().read(), done.set())); other.start()
    assert not done.wait(.05)
    assert not opened[0].closed
    finish.set(); t.join(5); other.join(5)
    assert not t.is_alive() and not other.is_alive()
    assert opened[0].closed and len(opened) == 2
    cache.discard()
    assert all(r.closed for r in opened)


def test_failed_opens_back_off_across_threads_and_detect_repairs(tmp_path, monkeypatch, caplog):
    from services import file_handles
    cache, attempts = HandleCache(), []
    path = tmp_path / 'missing'
    now = [100.]
    monkeypatch.setattr(file_handles.time, 'monotonic', lambda: now[0])
    def open_reader():
        attempts.append(1)
        return Reader(path)
    def get():
        return cache.get('bam', str(path), open_reader, lambda: file_stamp(path))
    def fail(_):
        with pytest.raises(OSError): get()
    with ThreadPoolExecutor(8) as pool: list(pool.map(fail, range(100)))
    assert len(attempts) == 1
    now[0] += 6
    fail(0)
    assert len(attempts) == 2
    assert len(caplog.records) == 1
    path.write_bytes(b'repaired')
    assert get().read() == b'repaired'
    assert len(attempts) == 3
    cache.discard()


def test_file_and_index_replacement_close_old_reader(tmp_path):
    cache, opened = HandleCache(), []
    path = tmp_path / 'a'; path.write_bytes(b'old')
    index = tmp_path / 'a.bai'; index.write_bytes(b'old index')
    def open_reader():
        r = Reader(path); opened.append(r); return r
    def get():
        return cache.get('bam', str(path), open_reader, lambda: file_stamp(path, (index,)))
    assert get().read() == b'old'
    index.write_bytes(b'repaired index')
    assert get().read() == b'old' and opened[0].closed
    replacement = tmp_path / 'new'; replacement.write_bytes(b'new'); replacement.replace(path)
    assert get().read() == b'new' and opened[1].closed
    cache.discard()


def _fd_count():
    psutil = pytest.importorskip('psutil')
    return psutil.Process().num_fds()


@pytest.mark.skipif(os.name == 'nt', reason='Descriptor counts require a POSIX process')
def test_open_navigate_remove_soak_keeps_descriptors_bounded(tmp_path):
    from services import bam_handles, bigbed_handles, fasta_handles
    from services.file_handles import handles
    from state.browser_state import BrowserState
    import pysam
    import pyBigWig

    bam_path = tmp_path / 'reads.bam'
    header = {'HD': {'VN': '1.0'}, 'SQ': [{'LN': 5000, 'SN': 'chr1'}]}
    with pysam.AlignmentFile(str(bam_path), 'wb', header=header) as bam:
        for i in range(200):
            read = pysam.AlignedSegment(); read.query_name = f'r{i}'; read.query_sequence = 'A' * 100
            read.reference_id = 0; read.reference_start = i * 10; read.cigarstring = '100M'
            bam.write(read)
    pysam.index(str(bam_path))
    wig = tmp_path / 'signal.bw'
    with pyBigWig.open(str(wig), 'w') as bw:
        bw.addHeader([('chr1', 5000)]); bw.addEntries(['chr1'], [0], ends=[5000], values=[1.0])
    fasta = tmp_path / 'ref.fa'; fasta.write_text('>chr1\n' + 'A' * 5000 + '\n'); pysam.faidx(str(fasta))
    handles.discard()
    baseline = _fd_count()
    counts = []
    state = BrowserState(None, None, None, None)
    from types import SimpleNamespace
    with ThreadPoolExecutor(8) as pool:
        for cycle in range(15):
            # Same lifecycle used by dataset DELETE, with two datasets sharing a source.
            state.datasets['a'] = SimpleNamespace(paths=[str(bam_path)], companion_layers={'signal': [str(wig)]})
            state.dataset_order.append('a')
            state.datasets['b'] = state.datasets['a']
            state.dataset_order.append('b')
            ref = fasta_handles.ThreadLocalFasta(str(fasta))
            def navigate(i):
                lo = (i * 83 + cycle * 11) % 2000
                assert list(bam_handles.get_bam_handle(str(bam_path)).fetch('chr1', lo, lo + 100))
                assert bigbed_handles.get_bigwig_handle(str(wig)).stats('chr1', lo, lo + 100) == [1.]
                assert ref.fetch('chr1', lo, lo + 100) == 'A' * 100
            list(pool.map(navigate, range(32)))
            counts.append(_fd_count())
            state.remove_dataset('a')
            assert not bam_handles.get_bam_handle(str(bam_path)).closed
            state.remove_dataset('b'); ref.close()
            assert _fd_count() <= baseline + 2
    assert max(counts) <= baseline + 8
    assert len(handles._entries) == 0


@pytest.mark.parametrize('soft,hard,expected', [(256, 4096, 4096), (256, 10000, 8192), (10000, 10000, None)])
def test_startup_raises_only_the_soft_descriptor_limit(monkeypatch, soft, hard, expected):
    resource = pytest.importorskip('resource')
    from services.server_startup import raise_file_limit
    changes = []
    monkeypatch.setattr(resource, 'getrlimit', lambda _: (soft, hard))
    monkeypatch.setattr(resource, 'setrlimit', lambda limit, value: changes.append((limit, value)))
    raise_file_limit()
    assert changes == ([] if expected is None else [(resource.RLIMIT_NOFILE, (expected, hard))])


def test_bigbed_bam_only_options_preserve_the_working_set_path():
    from services.read_endpoint import needs_direct_read_load
    from types import SimpleNamespace
    options = dict(include_cigar=True, include_methylation=True, ml_threshold=200, min_sv_len=1, include_sv_seq=True)
    assert not needs_direct_read_load(SimpleNamespace(data_type='bigbed'), **options)
    assert needs_direct_read_load(SimpleNamespace(data_type='bam'), **options)


def test_discarding_a_reader_does_not_block_on_another_files_lease(tmp_path):
    a = tmp_path / 'a'; a.write_bytes(b'one')
    b = tmp_path / 'b'; b.write_bytes(b'two')
    cache, opened = HandleCache(), []
    get_a, get_b = getter(cache, a, opened), getter(cache, b, opened)
    get_b()
    with get_a().lease():
        cache.discard(str(b))
        assert opened[0].closed
    cache.discard()


def test_replacement_and_retirement_cannot_close_nested_metadata_access(tmp_path):
    path = tmp_path / 'reads'; path.write_bytes(b'first\nsecond\n')
    cache, opened = HandleCache(), []
    get = getter(cache, path, opened)
    proxy = get()
    iterator = proxy.fetch()
    assert next(iterator) == b'first\n'
    replacement = tmp_path / 'replacement'; replacement.write_bytes(b'new'); replacement.replace(path)
    cache.discard(str(path))
    assert proxy.file is opened[0].file
    assert next(iterator) == b'second\n'
    iterator.close()
    assert opened[0].closed
    assert get().read() == b'new'
    cache.discard()


def test_nested_open_at_capacity_fails_without_deadlocking(tmp_path):
    a = tmp_path / 'a'; a.write_bytes(b'one')
    b = tmp_path / 'b'; b.write_bytes(b'two')
    cache, opened = HandleCache(max_entries=1), []
    with getter(cache, a, opened)().lease():
        with pytest.raises(OSError, match='All file readers are in use'):
            getter(cache, b, opened)()
    cache.discard()


def test_cancelled_waiter_releases_its_worker_before_the_active_reader_finishes(tmp_path):
    from services.background_work import Cancelled, cancel_scope
    path = tmp_path / 'reads'; path.write_bytes(b'reads')
    cache, opened = HandleCache(), []
    get = getter(cache, path, opened)
    entered, cancelled, done = Event(), Event(), Event()
    def wait_for_reader():
        with cancel_scope(cancelled):
            entered.set()
            try:
                get().read()
            except Cancelled:
                done.set()
    with get().lease():
        worker = Thread(target=wait_for_reader); worker.start()
        assert entered.wait(5)
        cancelled.set()
        assert done.wait(1)
        assert len(opened) == 1 and not opened[0].closed
    worker.join(5)
    cache.discard()
    assert opened[0].closed


def test_mode_resize_closes_idle_readers_and_drains_active_leases(tmp_path):
    from contextlib import ExitStack
    cache, opened = HandleCache(4), []
    with ExitStack() as leases:
        for i in range(4):
            path = tmp_path / str(i); path.write_bytes(b'read')
            handle = getter(cache, path, opened)()
            if i < 2:
                leases.enter_context(handle.lease())
        cache.resize(1)
        assert cache.diagnostics() == dict(limit=1, entries=2, open=2, active=2)
        assert [r.closed for r in opened] == [False, False, True, True]
    assert cache.diagnostics() == dict(limit=1, entries=1, open=1, active=0)
    assert sum(not r.closed for r in opened) == 1
    cache.discard()
    assert all(r.closed for r in opened)


def test_machine_modes_resize_shared_readers(tmp_path):
    from services.file_handles import handles
    from services.performance import apply_mode
    from types import SimpleNamespace
    state = SimpleNamespace(config={}, max_working_reads=0, datasets={})
    handles.discard()
    opened = []
    try:
        high = apply_mode(state, 'high')
        for i in range(40):
            path = tmp_path / str(i); path.write_bytes(b'read')
            getter(handles, path, opened, kind='bigbed')()
        assert sum(not r.closed for r in opened) == 40
        low = apply_mode(state, 'low')
        assert low['readers']['limit'] == 32 < high['readers']['limit']
        assert sum(not r.closed for r in opened) == low['readers']['open'] == 32
    finally:
        handles.discard()
        apply_mode(state, 'standard')


@pytest.mark.parametrize('failure', ['invalid', 'header'])
def test_reference_name_scan_closes_rejected_or_broken_reader(tmp_path, monkeypatch, failure):
    from types import SimpleNamespace
    import pyBigWig
    import prepare_genomes
    closed = []
    def chroms():
        raise OSError('broken header')
    reader = SimpleNamespace(isBigBed=lambda: failure != 'invalid', chroms=chroms,
                             close=lambda: closed.append(1))
    monkeypatch.setattr(pyBigWig, 'open', lambda path: reader)
    assert prepare_genomes.cache_jaspar_names('dm6', str(tmp_path)) is None
    assert closed == [1]
