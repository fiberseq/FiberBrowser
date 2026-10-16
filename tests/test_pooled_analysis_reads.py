"""First analyses share a bounded pool without changing their read evidence."""
import pytest


@pytest.mark.parametrize('scoped', [False, True])
def test_analysis_working_set_preserves_pooled_physical_reads(tmp_path, monkeypatch, scoped):
    from insertion_fixtures import make_insertion_bam, SITE
    from state.browser_state import BrowserState
    from services import parallel_reads
    from services.packed_reads import PackedReads
    monkeypatch.setenv('FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN', '1')
    monkeypatch.setenv('FIBERBROWSER_SETTINGS', str(tmp_path / 'settings.json'))
    paths = []
    for i in range(2):
        folder = tmp_path / str(i)
        folder.mkdir()
        paths.append(make_insertion_bam(folder)['bam'])
    monkeypatch.setattr('services.read_sampling.estimate_reads', lambda *a, **k: 50000)
    calls = []
    original = parallel_reads.parallel_bam_files

    def pooled(*args, **kwargs):
        result = original(*args, **kwargs)
        calls.append((args[0], kwargs['retain_packed'], isinstance(result, PackedReads)))
        return result

    monkeypatch.setattr(parallel_reads, 'parallel_bam_files', pooled)
    results = []
    for workers in (1, 2):
        state = BrowserState(None, reference_only=True)
        state.add_dataset('reads', paths)
        state.performance = {'decode_workers': workers, 'sample_target': 4000, 'effective': 'high'}
        state.config['prefetch_multiplier'] = 1
        state.max_working_reads = 0
        result = state.build_working_set('reads', 'chrT', SITE - 2000, SITE + 2000,
            read_ids=['reference_00_rev'] if scoped else None, include_methylation=True,
            include_layers=True, include_layer_qualities=True)
        results.append((result.reads, result.total_overlapping, result.total_spanning))
    assert results[0] == results[1] and results[0][0]
    assert calls == [(paths, True, True)]


def test_bounded_analysis_keeps_streaming_path(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from services.read_route_helpers import display_bam_loader
    from services.packed_reads import bounded_read_analysis
    path = tmp_path / 'reads.bam'
    path.write_bytes(b'not opened')
    state = SimpleNamespace(performance={'decode_workers': 2})
    monkeypatch.setattr('services.parallel_reads.parallel_bam_files',
                        lambda *a, **k: pytest.fail('bounded analysis entered pooled path'))
    with bounded_read_analysis():
        assert display_bam_loader(state).load_many([str(path)] * 2, 'chr1', 0, 100) is None


def test_few_large_analysis_files_keep_within_file_parallelism(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from services.read_route_helpers import display_bam_loader
    path = tmp_path / 'reads.bam'
    path.write_bytes(b'not opened')
    state = SimpleNamespace(performance={'decode_workers': 8}, chrom_map={})
    monkeypatch.setattr('services.read_sampling.estimate_reads', lambda *a, **k: 50000)
    monkeypatch.setattr('services.parallel_reads.parallel_bam_files',
                        lambda *a, **k: pytest.fail('large file lost its parallel partitions'))
    assert display_bam_loader(state).load_many([str(path)] * 2, 'chr1', 0, 100,
                                              contig_links={}, circular=False) is None
