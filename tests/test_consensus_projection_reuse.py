"""Only the redundant, same-request display projection may be elided."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from models.domain import WorkingSet
from services import consensus_workflow as workflow
from services.consensus_curation import get_curation, update_curation
from services.read_endpoint import apply_consensus_display_overlays, compact_all_dataset_result
from test_consensus_native_mode import fixture, ws


def display(state, source, reads=None, **kwargs):
    return apply_consensus_display_overlays(state, 'd', 'chr1', 90, 210,
        source.reads if reads is None else reads, total_overlapping=2, total_spanning=2,
        projection_source=source, **kwargs)


def test_exact_sample_skips_second_pass_and_matches_full_projection(monkeypatch):
    state, job, _ = fixture()
    original = deepcopy(job['result'])
    raw = ws()
    before = deepcopy(raw.reads)
    projected = workflow.apply_overlays(state, 'd', 'chr1', 90, 210, raw)
    sample = projected.reads[::-1]
    expected = workflow.apply_overlays(state, 'd', 'chr1', 90, 210,
        WorkingSet(sample, 2, 2, 'chr1', 90, 210)).reads
    def redundant(*args, **kwargs):
        raise AssertionError('A proven duplicate was projected twice')
    monkeypatch.setattr(workflow, 'apply_overlays', redundant)
    actual = display(state, projected, sample)
    assert actual == expected
    assert all(a is b for a, b in zip(actual, sample))
    assert raw.reads == before and job['result'] == original
    assert all('_consensus_overlay_receipt' not in row for row in actual)


@pytest.mark.parametrize('change', ['filters', 'index', 'result', 'job', 'curation', 'cloned_rows'])
def test_changed_revision_or_rows_reprojects(monkeypatch, change):
    state, job, _ = fixture()
    projected = workflow.apply_overlays(state, 'd', 'chr1', 90, 210, ws())
    reads = projected.reads
    if change == 'filters':
        workflow.set_filters(state, 'j', {'classification_reference_percent': 95.})
    elif change == 'index':
        job['index'] = deepcopy(job['index'])
    elif change == 'result':
        job['result'] = deepcopy(job['result'])
        job.pop('_curation', None)
    elif change == 'job':
        replacement = dict(job, job_id='next')
        state.consensus_workflow_jobs['next'] = replacement
        state.consensus_workflow_active = 'next'
    elif change == 'curation':
        revision = get_curation(state, 'j')['revision']
        update_curation(state, 'j', dict(expected_revision=revision,
            operation='ignore', dataset_id='d', family_ids=['d:B']))
    elif change == 'cloned_rows':
        reads = deepcopy(reads)
    expected = workflow.apply_overlays(state, 'd', 'chr1', 90, 210,
        WorkingSet(reads, 2, 2, 'chr1', 90, 210)).reads
    original = workflow.apply_overlays
    called = []
    def tracked(*args, **kwargs):
        called.append(True)
        return original(*args, **kwargs)
    monkeypatch.setattr(workflow, 'apply_overlays', tracked)
    assert display(state, projected, reads) == expected
    assert called == [True]


def test_receipt_does_not_authorize_other_viewport_dataset_or_unprojected_rows():
    state, _, _ = fixture()
    projected = workflow.apply_overlays(state, 'd', 'chr1', 90, 210, ws())
    assert not workflow.projected_subset_is_current(state, 'd', 'chr1', 91, 210,
        projected, projected.reads)
    assert not workflow.projected_subset_is_current(state, 'other', 'chr1', 90, 210,
        projected, projected.reads)
    assert not workflow.projected_subset_is_current(state, 'd', 'chr1', 90, 210,
        ws(), projected.reads)
    assert not workflow.projected_subset_is_current(state, 'd', 'chr1', 90, 210,
        projected, ws().reads)


@pytest.mark.parametrize('fill_gap_size, expected_passes', [(None, 1), (1, 2)])
def test_compact_all_preserves_first_projection_and_skips_only_exact_second(
        monkeypatch, fill_gap_size, expected_passes):
    state, job, dataset = fixture()
    dataset.data_type = 'bam'
    dataset.label = 'native'
    dataset.color = '#123456'
    original = workflow.apply_overlays
    calls = []
    def tracked(*args, **kwargs):
        calls.append(len(args[-1].reads))
        return original(*args, **kwargs)
    monkeypatch.setattr(workflow, 'apply_overlays', tracked)
    raw = ws()
    for row in raw.reads:
        row['intervals'] = [[0, 120, 120]]
    projected_snapshots = []
    def build(_state, _dataset, **kwargs):
        # Equivalent to BrowserState's established full-working-set path.
        result = workflow.apply_overlays(state, 'd', 'chr1', 90, 210, raw)
        assert 'tf_cr' in result.reads[0]['layers']
        projected_snapshots.append((result.reads, deepcopy(result.reads)))
        return result
    options=dict(state=state,
        query=SimpleNamespace(build_working_set=build), dataset_id='d', chrom='chr1',
        start=90, end=210, region_width=120, spanning=True, max_reads=1,
        downsample=None, include_methylation=False, include_layers=True,
        requested_layers=('nuc', 'tf', 'tf_cr', 'tf_xcr'), include_layer_qualities=False,
        ml_threshold=125, fill_gap_size=fill_gap_size, min_fp_quality=0, min_footprints=0,
        include_metaprofile=False, profile_max_reads=100, coverage_sample=False,
        hide_terminal_gaps=True, terminal_gap_threshold=500, infer_legacy_layers=True,
        legacy_nuc_min_size=90, sample_seed='fixed')
    _, payload = compact_all_dataset_result(**options)
    assert len(calls) == expected_passes and calls[0] == 2
    assert payload['working_count'] == 2 and payload['display_count'] == 1
    assert payload['reads'][0]['id'] == 'u1'
    assert payload['reads'][0]['layers']['tf_cr']['consensus_records'][0]['source_call_id'] == 'd:u1:0'
    # Real endpoint sort/profile/sample operations must not mutate any of the
    # borrowed source rows, including rows that were not selected for display.
    assert all(rows == snapshot for rows, snapshot in projected_snapshots)
    monkeypatch.setattr(workflow, 'projected_subset_is_current', lambda *args: False)
    _, forced_two_pass = compact_all_dataset_result(**options)
    ignored = {'server_timings', 'server_elapsed_ms'}
    assert {k:v for k,v in payload.items() if k not in ignored} == {
        k:v for k,v in forced_two_pass.items() if k not in ignored}
    assert all(rows == snapshot for rows, snapshot in projected_snapshots)
