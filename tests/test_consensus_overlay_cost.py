"""An active footprint-class run is projected onto the reads once, not on every pass.

After Find footprint classes, every read request and every analysis in the run's
region projects the run's calls onto its reads (``apply_overlays``). That walked
every read and record with deep copies, and it was redone for the same reads:
two or three times within one strand request (the working set, the broad-cache
pass, then the display sample) and again for every analysis request on the same
cached working set. The Footprints panel fires several analyses at once (most
aborted by the browser but still run by the server), so a read request made at
the same time took 15 s or more: the tour's reads badge stayed at "Loading..."
and panels split by strand loaded for a long time.
"""
from __future__ import annotations

import time
from copy import deepcopy
from pathlib import Path

import pytest

from models.domain import WorkingSet
from services import consensus_workflow as workflow
from services.consensus_curation import get_curation, update_curation
from services.read_endpoint import project_consensus_working_set
from test_consensus_native_mode import fixture, ws

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
# One recaller tile inside the demo reads (as tests/test_consensus_http_roundtrip.py).
REGION = dict(chrom="chr19", start=47515000, end=47515300)


def count_projections(monkeypatch):
    """Read ids each full projection pass matched to the run (one entry per read per pass)."""
    seen = []
    original = workflow._match_projection_unit
    def tracked(index, read):
        seen.append(str(read.get('id')))
        return original(index, read)
    monkeypatch.setattr(workflow, '_match_projection_unit', tracked)
    return seen


def test_a_working_set_is_projected_once_while_the_run_is_unchanged(monkeypatch):
    state, _, _ = fixture()
    source = ws()
    seen = count_projections(monkeypatch)
    first = workflow.apply_overlays(state, 'd', 'chr1', 90, 210, source)
    assert len(seen) == 2
    again = workflow.apply_overlays(state, 'd', 'chr1', 90, 210, source)
    assert again is first and len(seen) == 2
    # Rows already projected come back as they are, and so does a subset of them
    # taken from the projection it came from (a strand or read filter).
    assert workflow.apply_overlays(state, 'd', 'chr1', 90, 210, first) is first
    subset = project_consensus_working_set(state, 'd', 'chr1', 90, 210,
        WorkingSet(first.reads[:1], 1, 1, 'chr1', 90, 210), projection_source=first)
    assert subset.reads[0] is first.reads[0]
    assert workflow.apply_overlays(state, 'd', 'chr1', 90, 210, subset) is subset
    assert len(seen) == 2
    # The saved projection is the one a fresh pass makes.
    assert first.reads == workflow.apply_overlays(state, 'd', 'chr1', 90, 210, ws()).reads


@pytest.mark.parametrize('change', ['filters', 'index', 'result', 'job', 'curation', 'region'])
def test_a_changed_run_or_view_is_projected_again(monkeypatch, change):
    state, job, _ = fixture()
    source = ws()
    first = workflow.apply_overlays(state, 'd', 'chr1', 90, 210, source)
    start = 90
    if change == 'filters':
        workflow.set_filters(state, 'j', {'classification_reference_percent': 95.})
    elif change == 'index':
        job['index'] = deepcopy(job['index'])
    elif change == 'result':
        job['result'] = deepcopy(job['result'])
        job.pop('_curation', None)
    elif change == 'job':
        state.consensus_workflow_jobs['next'] = dict(job, job_id='next')
        state.consensus_workflow_active = 'next'
    elif change == 'curation':
        revision = get_curation(state, 'j')['revision']
        update_curation(state, 'j', dict(expected_revision=revision,
            operation='ignore', dataset_id='d', family_ids=['d:B']))
    elif change == 'region':
        start = 91
    seen = count_projections(monkeypatch)
    again = workflow.apply_overlays(state, 'd', 'chr1', start, 210, source)
    assert again is not first and len(seen) == 2
    assert again.reads == workflow.apply_overlays(state, 'd', 'chr1', start, 210, ws()).reads


def test_projection_leaves_the_run_and_the_source_rows_unchanged():
    state, job, _ = fixture()
    result, index = deepcopy(job['result']), deepcopy(job['index'])
    source = ws()
    before = deepcopy(source.reads)
    projected = workflow.apply_overlays(state, 'd', 'chr1', 90, 210, source)
    workflow.apply_overlays(state, 'd', 'chr1', 90, 210, source)
    assert source.reads == before and job['result'] == result and job['index'] == index
    # Records are shared with the run read-only: its own records are never the ones changed.
    records = [r for row in projected.reads for layer in row['layers'].values()
               for r in layer.get('consensus_records', ())]
    assert records and all('manual_curation' not in r for row in job['index']['d']['per_unit'].values()
                           for r in row.get('tf_cr', ()))


@pytest.fixture(scope='module')
def demo_run(tmp_path_factory):
    """The demo BAM with a finished lattice-recaller run on one tile (as the tour's Find classes)."""
    if not DEMO_BAM.exists():
        pytest.skip('tracked demo BAM browser/data/demo/napa_ddda.bam missing')
    from state.browser_state import BrowserState
    state = BrowserState(None, None, None, None)
    state.add_dataset('demo', str(DEMO_BAM), 'demo')
    job = workflow.submit(state, dict(dataset_ids=['demo'], **REGION, parameters=dict(compute=dict(cores=2))))
    deadline = time.time() + 600
    while workflow.get_job(state, job['job_id'])['status'] not in ('complete', 'error', 'cancelled'):
        assert time.time() < deadline, 'the class run did not finish'
        time.sleep(0.5)
    summary = workflow.get_job(state, job['job_id'])
    assert summary['status'] == 'complete', summary.get('message')
    return state


READS = dict(dataset_id='demo', **REGION, max_reads=0, include_layers=True, layer_names='nuc,tf,tf_rc',
             include_layer_qualities=False, min_footprints=0, sample_seed='fiberbrowser-analysis')


@pytest.mark.slow
@pytest.mark.parametrize('request_kind', ['all reads', 'one strand', 'one strand, sampled', 'methylation'])
def test_a_read_request_projects_each_read_once(demo_run, monkeypatch, request_kind):
    from services.read_endpoint import compact_reads_payload_for_request
    extra = {'all reads': {}, 'one strand': dict(strand='CT'),
             'one strand, sampled': dict(strand='GA', max_reads=50, include_methylation=True),
             'methylation': dict(include_methylation=True, hide_terminal_gaps=False)}[request_kind]
    for attempt in ('cold', 'warm'):
        seen = count_projections(monkeypatch)
        payload = compact_reads_payload_for_request(demo_run, **{**READS, **extra})
        assert payload['reads'], request_kind
        assert all(r['layers'].get('tf_rc') is not None or r.get('consensus_projection') for r in payload['reads'])
        assert len(seen) == len(set(seen)), f'{request_kind} ({attempt}): reads projected more than once'


@pytest.mark.slow
def test_analyses_reuse_the_projected_working_set(demo_run, monkeypatch):
    """Footprint analysis, quality impact, clustering: the same cached working set, projected once."""
    first = demo_run.build_working_set('demo', REGION['chrom'], REGION['start'], REGION['end'])
    assert any('consensus_projection' in r for r in first.reads)
    seen = count_projections(monkeypatch)
    for _ in range(5):
        again = demo_run.build_working_set('demo', REGION['chrom'], REGION['start'], REGION['end'])
        assert again is first
    assert seen == []
