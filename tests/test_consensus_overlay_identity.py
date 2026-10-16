"""Consensus transport must not merge distinct units sharing a QNAME."""
from copy import deepcopy
from types import SimpleNamespace
import threading

import pytest

from models.domain import WorkingSet
from services.consensus_workflow import _index, apply_overlays


def fixture(units, chemistry='ddda'):
    rows = [dict(unit_id=u['unit_id'], strand=u['strand'], calls=[dict(
        raw=u['native_intervals'][0], interval=[u['native_intervals'][0][0] + 1,
                                              u['native_intervals'][0][1]],
        action='projection_equivalent_normalization', reason='accepted',
        selected={'joint_native_log_lr': 0.})]) for u in units]
    result = dict(manifest=dict(region=dict(chrom='chr1', start=100, end=200)),
        datasets={'d': dict(chemistry=chemistry, units=units,
            sr=dict(status='complete', records=rows))},
        cross=dict(status='disabled', edges=[]))
    index, layers = _index(result)
    job = dict(job_id='j', status='complete', result=result, index=index, layers=layers,
        filters=dict(show_quality_outlines=True))
    state = SimpleNamespace(consensus_workflow_jobs={'j': job},
        consensus_workflow_active='j', consensus_workflow_lock=threading.RLock())
    return state, job


def unit(uid, strand, interval, *, name='same', **extra):
    return dict(unit_id=uid, read_name=name, strand=strand, source_members=[],
                native_intervals=[interval], **extra)


def project(state, read):
    before = deepcopy(read)
    output = apply_overlays(state, 'd', 'chr1', 100, 200,
        WorkingSet([read], 1, 1, 'chr1', 100, 200)).reads[0]
    assert read == before
    return output


@pytest.mark.parametrize('reverse_units', [False, True])
def test_same_qname_ct_ga_projects_only_the_explicit_recipient_strand(reverse_units):
    units = [unit('ct', 'CT', [110, 120]), unit('ga', 'GA', [150, 160])]
    if reverse_units:
        units.reverse()
    state, job = fixture(units)
    frozen = deepcopy(job['result'])
    for strand, expected in [('CT', [11, 20, 9]), ('GA', [51, 60, 9])]:
        row = project(state, dict(id='same', strand=strand, layers={}))
        assert row['layers']['tf_sr_lattice']['intervals'] == [expected]
        assert row['consensus_projection']['unit_id'] == strand.lower()
        record = row['layers']['tf_sr_lattice']['consensus_records'][0]
        assert record['sr_decision']['selected'] == {'joint_native_log_lr': 0.}
        assert record['source_intervals'] == [[expected[0] + 99, expected[1] + 100]]
    assert job['result'] == frozen


def test_qname_only_collision_is_unassigned_and_keeps_native_layers():
    state, _ = fixture([unit('ct', 'CT', [110, 120]), unit('ga', 'GA', [150, 160])])
    native = {'tf': {'intervals': [[10, 20, 10]]}}
    row = project(state, dict(id='same', layers=deepcopy(native)))
    assert row['layers'] == native
    assert row['consensus_projection']['status'] == 'ambiguous_identity'
    assert row['consensus_projection']['candidate_units'] == 2


def test_same_qname_multi_library_requires_explicit_matching_library():
    state, _ = fixture([unit('a', 'CT', [110, 120], library_id='library-A'),
                        unit('b', 'CT', [150, 160], library_id='library-B')])
    row = project(state, dict(id='same', strand='CT', library_id='library-B', layers={}))
    assert row['layers']['tf_sr_lattice']['intervals'] == [[51, 60, 9]]
    assert row['consensus_projection']['unit_id'] == 'b'
    unknown = project(state, dict(id='same', strand='CT', layers={}))
    assert unknown['layers'] == {}
    assert unknown['consensus_projection']['status'] == 'ambiguous_identity'
    mismatch = project(state, dict(id='same', library_id='library-C', layers={}))
    assert mismatch['layers'] == {}
    assert mismatch['consensus_projection']['status'] == 'identity_mismatch'


def test_missing_member_identity_remains_unknown_not_a_negative_match():
    state, _ = fixture([unit('a', 'CT', [110, 120], library_id='library-A'),
                        unit('b', 'CT', [150, 160])])
    row = project(state, dict(id='same', library_id='library-A', layers={}))
    assert row['layers'] == {}
    assert row['consensus_projection']['status'] == 'ambiguous_identity'


def test_explicit_alignment_digest_resolves_same_name_same_strand_same_library():
    state, _ = fixture([unit('a', 'CT', [110, 120], library_id='library-A', record_sha256='record-a'),
                        unit('b', 'CT', [150, 160], library_id='library-A', record_sha256='record-b')])
    row = project(state, dict(id='same', strand='CT', library_id='library-A',
                              record_sha256='record-b', layers={}))
    assert row['consensus_projection']['unit_id'] == 'b'
    assert row['layers']['tf_sr_lattice']['intervals'] == [[51, 60, 9]]


def test_same_strand_duplicate_alias_uses_its_own_record_identity():
    u = unit('ct', 'CT', [110, 120], name='representative', record_sha256='representative-record')
    u['source_members'] = [dict(read_name='copy', strand='CT', record_sha256='copy-record')]
    state, _ = fixture([u])
    row = project(state, dict(id='copy', record_sha256='copy-record', layers={}))
    assert row['consensus_projection']['unit_id'] == 'ct'
    assert row['layers']['tf_sr_lattice']['intervals'] == [[11, 20, 9]]
    wrong = project(state, dict(id='copy', record_sha256='representative-record', layers={}))
    assert wrong['layers'] == {}
    assert wrong['consensus_projection']['status'] == 'identity_mismatch'


def test_member_identity_is_not_bypassed_by_a_weaker_representative_alias():
    u = unit('ct', 'CT', [110, 120])
    u['source_members'] = [dict(read_name='same', strand='CT', library_id='library-A')]
    state, _ = fixture([u])
    row = project(state, dict(id='same', library_id='library-B', layers={}))
    assert row['layers'] == {}
    assert row['consensus_projection']['status'] == 'identity_mismatch'


def test_hia5_mapping_orientation_does_not_become_a_chemical_strand():
    units = [unit('forward', 'pooled', [110, 120]), unit('reverse', 'pooled', [150, 160])]
    for u, orientation in zip(units, ['+', '-']):
        u['source_members'] = [dict(read_name='same', strand=orientation)]
    state, _ = fixture(units, chemistry='hia5-pacbio')
    row = project(state, dict(id='same', strand='-', layers={}))
    assert row['consensus_projection']['unit_id'] == 'reverse'
    assert row['layers']['tf_sr_lattice']['intervals'] == [[51, 60, 9]]
    # CT/GA must not be translated to +/- to manufacture a match.
    ambiguous = project(state, dict(id='same', strand='GA', layers={}))
    assert ambiguous['layers'] == {}
    assert ambiguous['consensus_projection']['status'] == 'ambiguous_identity'


def test_clipped_native_geometry_cannot_disambiguate_an_identity_collision():
    state, _ = fixture([unit('ct', 'CT', [110, 120]), unit('ga', 'GA', [150, 160])])
    row = project(state, dict(id='same', intervals=[[10, 20, 10]],
                              layers={'tf': {'intervals': [[10, 20, 10]]}}))
    assert row['consensus_projection']['status'] == 'ambiguous_identity'
    assert set(row['layers']) == {'tf'}


def bam_fixture(tmp_path, name, specifications, *, tagged=False):
    """Real BAM transport fixture, not a test of footprint inference."""
    import array
    import hashlib
    import pysam
    from services.compact_read_loader import build_compact_reads_from_bam
    path = tmp_path / name
    with pysam.AlignmentFile(path, 'wb', header={
        'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': 'chr1', 'LN': 1000}]}) as bam:
        for orientation, mapq in specifications:
            read = pysam.AlignedSegment(bam.header)
            read.query_name = 'same'
            read.query_sequence = 'ACGT' * 50
            read.reference_id = 0
            read.reference_start = 100
            read.cigarstring = '200M'
            read.mapping_quality = mapq
            read.flag = 16 if orientation == 'GA' else 0
            if tagged:
                read.set_tag('ns', array.array('I', [10]))
                read.set_tag('nl', array.array('I', [10]))
            bam.write(read)
    pysam.index(str(path))
    members, occurrences = [], {}
    with pysam.AlignmentFile(path, 'rb') as bam:
        alignments = list(bam.fetch('chr1', 100, 200))
        for alignment, (strand, _) in zip(alignments, specifications):
            digest = hashlib.sha256(alignment.to_string().encode('utf-8')).hexdigest()
            occurrence = occurrences.get(digest, 0)
            occurrences[digest] = occurrence + 1
            members.append(SimpleNamespace(name='same', strand=strand,
                library_id='browser:d:' + str(path.resolve()),
                _browser_original_library_id=str(path.resolve()), _browser_dataset_id='d',
                molecule_id=('browser:d:' + str(path.resolve()), 'same', strand),
                record_sha256=digest, alignment_occurrence=occurrence,
                ref_start=alignment.reference_start, ref_end=alignment.reference_end,
                alignment_flag=alignment.flag, input_index=0))
        rows = build_compact_reads_from_bam(str(path), 'chr1', 100, 200,
            spanning_only=False, hide_terminal_gaps=False, bam_handle_getter=lambda _: bam)
    return rows, members


def units_from_members(members):
    from services.consensus_evidence import _projection_members, _projection_member_key
    projections = _projection_members(members, members, exact_records=True)
    assert len(projections) == len(members)
    units = []
    for i, member in enumerate(members):
        u = unit(f'u{i}', member.strand, [110 + 30 * i, 120 + 30 * i])
        u['source_members'] = projections[_projection_member_key(member)]
        units.append(u)
    return units


@pytest.mark.parametrize('tagged', [False, True])
def test_real_compact_bam_rows_resolve_ct_ga_without_chemical_strand_guessing(tmp_path, tagged):
    rows, members = bam_fixture(tmp_path, 'strands.bam', [('CT', 60), ('GA', 60)], tagged=tagged)
    state, _ = fixture(units_from_members(members))
    assert len(rows) == 2
    for i, row in enumerate(rows):
        assert 'strand' not in row  # Actual compact rows need not carry CT/GA.
        assert row['record_sha256'] == members[i].record_sha256
        assert row['reference_end'] == 300  # Not the clipped viewport edge 200.
        projected = project(state, row)
        assert projected['consensus_projection']['unit_id'] == f'u{i}'
        assert projected['layers']['tf_sr_lattice']['intervals'] == [[11 + 30 * i, 20 + 30 * i, 9]]


def test_real_bam_same_qname_same_sam_different_libraries_do_not_cross_project(tmp_path):
    rows_a, members_a = bam_fixture(tmp_path, 'library_a.bam', [('CT', 60)])
    rows_b, members_b = bam_fixture(tmp_path, 'library_b.bam', [('CT', 60)])
    assert rows_a[0]['record_sha256'] == rows_b[0]['record_sha256']
    assert rows_a[0]['library_id'] != rows_b[0]['library_id']
    state, _ = fixture(units_from_members(members_a + members_b))
    assert project(state, rows_a[0])['consensus_projection']['unit_id'] == 'u0'
    assert project(state, rows_b[0])['consensus_projection']['unit_id'] == 'u1'


@pytest.mark.parametrize('tagged', [False, True])
def test_broad_cache_crop_preserves_absolute_alignment_identity(tmp_path, tagged):
    from services.working_sets import project_broad_read_to_viewport

    rows, members = bam_fixture(tmp_path, 'cropped_strands.bam', [('CT', 60), ('GA', 60)],
                                tagged=tagged)
    state, _ = fixture(units_from_members(members))
    for i, row in enumerate(rows):
        row['consensus_projection'] = {'status': 'stale_broad_cache_value'}
        cropped, _ = project_broad_read_to_viewport(row, viewport_offset=10,
            region_width=80, include_methylation=False, layer_key=None)
        assert cropped is not None
        for key in ('library_id', 'record_sha256', 'alignment_occurrence',
                    'reference_start', 'reference_end', 'alignment_orientation'):
            assert cropped[key] == row[key]
        assert cropped['reference_start'] == 100
        assert cropped['reference_end'] == 300
        assert 'consensus_projection' not in cropped
        projected = apply_overlays(state, 'd', 'chr1', 110, 190,
            WorkingSet([cropped], 1, 1, 'chr1', 110, 190)).reads[0]
        assert projected['consensus_projection']['unit_id'] == f'u{i}'
        assert projected['layers']['tf_sr_lattice']['intervals'] == [[1 + 30 * i, 10 + 30 * i, 9]]


def test_identical_sam_occurrences_do_not_overwrite_source_members(tmp_path):
    rows, members = bam_fixture(tmp_path, 'duplicate_records.bam', [('CT', 60), ('CT', 60)])
    assert rows[0]['record_sha256'] == rows[1]['record_sha256']
    assert [row['alignment_occurrence'] for row in rows] == [0, 1]
    state, _ = fixture(units_from_members(members))
    assert [project(state, row)['consensus_projection']['unit_id'] for row in rows] == ['u0', 'u1']


def test_unique_catalog_qname_still_rejects_a_different_alignment(tmp_path):
    rows, members = bam_fixture(tmp_path, 'filtered_alignment.bam', [('CT', 60), ('CT', 10)])
    # The low-MAPQ alignment was excluded from inference but is still displayed.
    state, _ = fixture(units_from_members(members[:1]))
    assert project(state, rows[0])['consensus_projection']['status'] == 'matched'
    excluded = project(state, rows[1])
    assert excluded['consensus_projection']['status'] == 'identity_mismatch'
    assert excluded['layers'] == rows[1].get('layers', {})
