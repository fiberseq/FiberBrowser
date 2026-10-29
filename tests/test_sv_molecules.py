"""Supplementary-only local molecules and reciprocal segment consolidation."""
import pysam
import pytest

from services.compact_read_loader import build_compact_reads_from_bam
from services.insertion_lens import build_lens
from services.sv_endpoint import _compact_record, classify_records
from services.sv_events import classify_molecules, sv_summary_for_reads
from services.sv_molecules import consolidate_evidence, unique_segments
from test_sv_events import _seg


@pytest.fixture(params=[False, True], ids=['forward', 'reverse'])
def regional_bam(tmp_path, request):
    reverse = request.param
    strand = '-' if reverse else '+'
    left = _seg([(0, 1000), (4, 500)], start=0, reverse=reverse,
                sa=f'chrT,2001,{strand},1000H500M,60,0;')
    right = _seg([(5, 1000), (0, 500)], start=2000, reverse=reverse, supplementary=True,
                 sa=f'chrT,1,{strand},1000M500S,60,0;')
    left.query_name = right.query_name = 'joined'
    only = _seg([(5, 100), (0, 100), (1, 100), (0, 500)], start=900,
                reverse=reverse, supplementary=True, sa=f'chrT,9001,{strand},100M700H,60,0;')
    only.query_name = 'supp-only'
    outside = _seg([(0, 100), (5, 700)], start=9000, reverse=reverse)
    outside.query_name = 'supp-only'
    path = str(tmp_path / 'molecules.bam')
    with pysam.AlignmentFile(path + '.unsorted', 'wb', header=left.header) as bam:
        for rec in [left, right, only, outside]:
            bam.write(rec)
    pysam.sort('-o', path, path + '.unsorted')
    pysam.index(path)
    return path


def test_public_loader_recovers_supplementary_only_and_keeps_one_row_per_molecule(regional_bam):
    rows = build_compact_reads_from_bam(regional_bam, 'chrT', 0, 3000, spanning_only=False,
                                        hide_terminal_gaps=False)
    assert {r['id'] for r in rows} == {'joined', 'supp-only'}
    assert len(rows) == 2
    joined = next(r for r in rows if r['id'] == 'joined')
    assert len(joined['sv_alignments']) == 2 and len(joined['sv_segments']) == 2
    assert len({(s['pos'], s['q_start'], s['q_end']) for s in joined['sv_segments']}) == 2
    summary = sv_summary_for_reads(rows, 0, 3000, 50, chrom='chrT')
    assert summary['n_reads'] == 2
    insertion = next(c for c in summary['clusters'] if c['t'] == 'I')
    assert insertion['support'] == 1


def test_reciprocal_sa_and_merged_file_records_are_counted_once(regional_bam):
    with pysam.AlignmentFile(regional_bam) as bam:
        records = [(r, 'chrT') for r in bam.fetch('chrT', 0, 3000)]
    for order in [records, list(reversed(records)), records + records]:
        calls = classify_records(order, t='D', ref=1000, length=1000)
        assert set(calls) == {'joined', 'supp-only'}
        assert calls['joined']['evidence']['level'] == 'confirmed'
        assert calls['joined']['allele'] == 0
        assert len(calls['joined']['evidence_bundle']) in (2, 4)
        assert len(calls['joined']['read']['sv_segments']) == 2


def test_bundle_joins_actual_segments_even_without_sa_and_preserves_raw_evidence():
    left = _seg([(0, 1000), (4, 500)], start=0)
    right = _seg([(5, 1000), (0, 500)], start=2000, supplementary=True)
    parts = [_compact_record(r, 'chrT', 10) for r in [left, right]]
    merged = consolidate_evidence(parts)
    calls = classify_molecules([(merged, None)], t='D', ref=1000, length=1000, chrom='chrT')
    assert calls['r']['allele'] == 0 and len(calls['r']['evidence_bundle']) == 2
    assert merged['sv_alignments'][1]['sequence_span'] == [1000, 1500]
    # A fetched low-MAPQ segment cannot be promoted by a high-MAPQ reciprocal SA description.
    right.mapping_quality = 0
    low = _compact_record(right, 'chrT', 10)
    fake_sa = {**low['sv_segments'][0], 't': 'SA', 'mapq': 60}
    segments = unique_segments([low, {'sv_segments': [fake_sa]}])
    assert len(segments) == 1 and segments[0]['mapq'] == 0


def test_lens_can_use_a_supplementary_only_cigar_insertion(regional_bam):
    lens = build_lens([regional_bam, regional_bam], 'chrT', pos=1000, ref=1000, length=100,
                      consensus=False, flank=50)
    assert lens['cluster']['carriers'] == 1
    confirmed = [r for r in lens['carriers'] if r['evidence_level'] == 'confirmed']
    assert [r['id'] for r in confirmed] == ['supp-only']
    assert confirmed[0]['len'] == 100 and len(confirmed[0]['evidence_bundle']) == 2


@pytest.mark.parametrize('reverse', [False, True])
def test_supplementary_only_with_annotations_outside_local_alignment_keeps_a_neutral_row(tmp_path, reverse):
    import array
    rec = _seg([(0, 100), (4, 900)], start=1000, reverse=reverse, supplementary=True)
    rec.set_tag('ns', array.array('i', [500]))
    rec.set_tag('nl', array.array('i', [50]))
    path = str(tmp_path / 'evidence-only.bam')
    with pysam.AlignmentFile(path, 'wb', header=rec.header) as bam:
        bam.write(rec)
    pysam.index(path)
    rows = build_compact_reads_from_bam(path, 'chrT', 900, 1200, spanning_only=False)
    assert len(rows) == 1 and rows[0]['supplementary'] is True
    assert rows[0]['intervals'] == [[100, 200, 0]]
    assert any(event['t'] == 'S' for event in rows[0]['sv'])


@pytest.mark.parametrize('reverse', [False, True])
def test_annotated_hard_clipped_recovery_is_neutral_on_both_strands(tmp_path, reverse):
    import array
    rec = _seg([(5, 100), (0, 200), (1, 50), (0, 200), (5, 100)], start=1000,
               reverse=reverse, supplementary=True)
    rec.set_tag('ns', array.array('i', [150]))
    rec.set_tag('nl', array.array('i', [50]))
    rec.set_tag('MA', 'nuc.:150+50;')
    path = str(tmp_path / 'hard-clipped.bam')
    header = rec.header.to_dict()
    header['CO'] = ['FIBERHMM-TAG-FRAME:v1:coord=molecular']
    with pysam.AlignmentFile(path, 'wb', header=header) as bam:
        bam.write(rec)
    pysam.index(path)
    kwargs = dict(spanning_only=False, include_layers=True, include_methylation=True,
                  hide_terminal_gaps=False, short_terminal_footprint_bp=0)
    row, = build_compact_reads_from_bam(path, 'chrT', 900, 1500, **kwargs)
    assert row['intervals'] == [[100, 500, 0]] and row['no_calls']
    assert not row.get('layers') and not row.get('methyl')
    assert any(e['t'] == 'I' for e in row['sv']) and row['sequence_span'] == [100, 550]
    assert build_compact_reads_from_bam(path, 'chrT', 900, 1500, min_footprints=1, **kwargs) == []


def test_circular_clipping_preserves_supplementary_bundles():
    from services.compact_read_loader import _clip_part_before
    read = dict(id='wrapped', intervals=[[0, 100, 0]], reference_start=0, reference_end=100,
                supplementary=True, sv_alignments=[dict(id='wrapped', sv=[])], sv_evidence=[])
    clipped = _clip_part_before(read, 50)
    assert clipped['supplementary'] and clipped['sv_alignments'] == read['sv_alignments']
    assert clipped['sv_evidence'] == []


def test_collection_bounds_live_raw_records_before_the_first_bundle():
    import weakref
    from services.sv_molecules import molecule_bundles
    class Tracked(pysam.AlignedSegment):
        pass
    live = weakref.WeakSet()
    peak = 0
    header = _seg([(0, 100)]).header
    def records():
        nonlocal peak
        for i in range(600):
            read = Tracked(header)
            read.query_name = f'molecule-{i}'
            read.query_sequence = 'A' * 100
            read.reference_id = 0
            read.reference_start = i
            read.cigartuples = [(0, 100)]
            live.add(read)
            peak = max(peak, len(live))
            yield read
    bundles = molecule_bundles(records(), lambda _: True)
    assert next(bundles)[0].query_name == 'molecule-0'
    assert peak <= 2  # raw records are serialized immediately, never a regional list
    bundles.close()


@pytest.mark.parametrize('memory_budget', [0, 10000, 64 * 1024 * 1024])
def test_collection_checks_cancellation_before_consuming_the_region(memory_budget):
    import threading
    from services.background_work import Cancelled, cancel_scope
    from services.sv_molecules import molecule_bundles
    token = threading.Event()
    consumed = 0
    def records():
        nonlocal consumed
        for i in range(1000):
            consumed += 1
            if i == 10:
                token.set()
            yield _seg([(0, 100)])
    with cancel_scope(token), pytest.raises(Cancelled):
        next(molecule_bundles(records(), lambda _: True, memory_budget_bytes=memory_budget))
    assert 10 < consumed <= 257


def test_selection_and_molecule_budgets_apply_during_collection():
    from services.sv_molecules import molecule_bundles, MoleculeBudgetError
    read = _seg([(0, 10000)])
    # A rejected molecule cannot consume even one byte of the raw-record budget.
    skipped = []
    assert list(molecule_bundles([read], lambda _: True, keep=lambda _: False,
                                on_skipped=lambda _name, *extent: skipped.append(extent), raw_budget_bytes=1)) == []
    assert skipped == [(read.reference_start, read.reference_end)]
    with pytest.raises(MoleculeBudgetError):
        list(molecule_bundles([read], lambda _: True, raw_budget_bytes=1))
    with pytest.raises(MoleculeBudgetError):
        list(molecule_bundles([read], lambda _: True, max_groups=0))


@pytest.mark.parametrize('supplementary_first', [False, True])
def test_a_filtered_local_primary_never_reaches_sampling_through_a_supplementary(supplementary_first):
    from services.sv_molecules import molecule_bundles
    primary = _seg([(0, 100)], start=0)
    supplementary = _seg([(0, 100)], start=1000, supplementary=True)
    records = [supplementary, primary] if supplementary_first else [primary, supplementary]
    sampled = []
    assert list(molecule_bundles(records, lambda r: r.is_supplementary,
                                keep=lambda name: sampled.append(name) or True)) == []
    assert sampled == []


def test_decode_partitions_count_only_their_own_sampling_extents(regional_bam):
    from services.read_sampling import Sampler, sampling
    from services.packed_reads import decode_partition
    def load(partition):
        sampler = Sampler(1, only_ids={'joined'})
        token = decode_partition.set(partition)
        try:
            with sampling(sampler):
                rows = build_compact_reads_from_bam(regional_bam, 'chrT', 0, 3000, spanning_only=False,
                                                    hide_terminal_gaps=False)
            return rows, sampler
        finally:
            decode_partition.reset(token)
    serial, expected = load(None)
    parts = [load((i, 2)) for i in range(2)]
    assert sorted(r['id'] for rows, _ in parts for r in rows) == sorted(r['id'] for r in serial)
    for field in ('kept_starts', 'kept_ends', 'skipped_starts', 'skipped_ends'):
        assert sorted(v for _, sampler in parts for v in getattr(sampler, field)) == sorted(getattr(expected, field))


@pytest.mark.parametrize('memory_budget', [0, 32 * 1024 * 1024])
def test_spooling_preserves_exact_scalar_and_array_float_tags(memory_budget):
    import array
    from services.sv_molecules import molecule_bundles
    source = _seg([(0, 100)])
    source.set_tag('rq', 0.123456789, value_type='f')
    source.set_tag('vf', array.array('f', [0.123456789, 0.99999994]))
    bundle, = molecule_bundles([source], lambda _: True, memory_budget_bytes=memory_budget)
    assert bundle[0].get_tags(with_value_type=True) == source.get_tags(with_value_type=True)
    assert bundle[0].query_sequence == source.query_sequence and bundle[0].cigartuples == source.cigartuples


@pytest.mark.parametrize('interleaved', [False, True])
def test_spool_cursor_skips_redundant_seeks_and_recovers_interleaved_bundles(monkeypatch, interleaved):
    from services.sv_molecules import molecule_bundles

    # Several BGZF blocks, with selected molecules on both sides of skipped
    # records. An out-of-order supplementary forces a seek and a return.
    records = []
    for i in range(12):
        read = _seg([(0, 12000)], start=i * 13000)
        read.query_name = f'molecule-{i}'
        read.set_tag('ZZ', 'payload' * 2000)
        records.append(read)
    if interleaved:
        supplementary = _seg([(0, 12000)], start=200000, supplementary=True)
        supplementary.query_name = records[0].query_name
        records.append(supplementary)
    expected = [r for r in records if r.query_name != 'molecule-5']
    original = pysam.AlignmentFile
    seeks = []

    class Reader:
        def __init__(self, reader):
            self.reader = reader

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.reader.close()

        def tell(self):
            return self.reader.tell()

        def seek(self, offset):
            seeks.append(offset)
            return self.reader.seek(offset)

        def __next__(self):
            return next(self.reader)

    def opened(path, mode, **kwargs):
        file = original(path, mode, **kwargs)
        return Reader(file) if mode == 'rb' else file

    monkeypatch.setattr(pysam, 'AlignmentFile', opened)
    bundles = list(molecule_bundles(records, lambda _: True, keep=lambda name: name != 'molecule-5',
                                   memory_budget_bytes=0))
    actual = [r for bundle in bundles for r in bundle]
    key = lambda r: (r.query_name, r.reference_start)
    assert [key(r) for r in actual] == [key(r) for r in sorted(expected, key=lambda r: (
        int(r.query_name.split('-')[1]), bool(r.is_supplementary)))]
    assert [bundle.source_order for bundle in bundles] == list(range(12))[:5] + list(range(6, 12))
    for source, restored in zip(sorted(expected, key=key), sorted(actual, key=key)):
        assert restored.to_string() == source.to_string()
        assert restored.get_tags(with_value_type=True) == source.get_tags(with_value_type=True)
    assert len(seeks) < len(actual) // 2
    assert bool(seeks) == interleaved


@pytest.mark.parametrize('memory_budget', [0, 10000, 32 * 1024 * 1024])
def test_buffered_and_spilled_molecules_agree_with_filtered_and_interleaved_records(memory_budget):
    from services.sv_molecules import molecule_bundles

    records = [_seg([(0, 100)], start=i * 1000, supplementary=i in (0, 4)) for i in range(5)]
    for read, name in zip(records, ('filtered', 'first', 'second', 'filtered', 'first')):
        read.query_name = name
    eligible = lambda read: read.query_name != 'filtered' or read.is_supplementary
    expected = list(molecule_bundles(records, eligible, memory_budget_bytes=0))
    actual = list(molecule_bundles(records, eligible, memory_budget_bytes=memory_budget))
    assert [[r.to_string() for r in bundle] for bundle in actual] == [
        [r.to_string() for r in bundle] for bundle in expected]
    assert [b.source_order for b in actual] == [b.source_order for b in expected]


def test_small_molecule_selections_avoid_spooling_and_copy_the_source(monkeypatch):
    from services import sv_molecules
    from services.background_work import interactive_read

    def unexpected_spool(*args, **kwargs):
        pytest.fail('Small selection opened a disk spool')

    monkeypatch.setattr(sv_molecules.tempfile, 'TemporaryDirectory', unexpected_spool)
    source = _seg([(0, 100)])
    with interactive_read():
        bundle, = sv_molecules.molecule_bundles([source], lambda _: True)
    bundle[0].mapping_quality = 0
    assert source.mapping_quality == 60


def test_spill_cleans_up_on_a_budget_error(monkeypatch, tmp_path):
    from services import sv_molecules
    original = sv_molecules.tempfile.TemporaryDirectory
    directories = []

    def temporary_directory(**kwargs):
        directory = original(dir=tmp_path, **kwargs)
        directories.append(directory.name)
        return directory

    monkeypatch.setattr(sv_molecules.tempfile, 'TemporaryDirectory', temporary_directory)
    with pytest.raises(sv_molecules.MoleculeBudgetError):
        list(sv_molecules.molecule_bundles([_seg([(0, 100)])], lambda _: True, raw_budget_bytes=1))
    assert len(directories) == 1 and not list(tmp_path.iterdir())


def test_memory_limit_spills_before_collecting_the_whole_region(monkeypatch, tmp_path):
    from services import sv_molecules
    original = sv_molecules.tempfile.TemporaryDirectory
    consumed = 0
    opened = []

    def temporary_directory(**kwargs):
        opened.append(consumed)
        return original(dir=tmp_path, **kwargs)

    def records():
        nonlocal consumed
        for i in range(20):
            consumed += 1
            read = _seg([(0, 100)], start=1000 * i)
            read.query_name = f'molecule-{i}'
            yield read

    monkeypatch.setattr(sv_molecules.tempfile, 'TemporaryDirectory', temporary_directory)
    bundles = list(sv_molecules.molecule_bundles(records(), lambda _: True, memory_budget_bytes=10000))
    assert opened == [3] and consumed == len(bundles) == 20
    assert not list(tmp_path.iterdir())


def test_an_unavailable_size_estimate_uses_the_lossless_spool(monkeypatch):
    from services import sv_molecules

    def unavailable(read):
        raise ValueError('Unsupported auxiliary tag')

    monkeypatch.setattr(sv_molecules, '_buffered_record_size', unavailable)
    source = _seg([(0, 100)])
    bundle, = sv_molecules.molecule_bundles([source], lambda _: True, memory_budget_bytes=10000)
    assert bundle[0].to_string() == source.to_string()
