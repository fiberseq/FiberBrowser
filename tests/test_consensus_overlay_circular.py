"""Consensus overlays in a circular contig's views (review round 3 follow-up).

Consensus records are in reference coordinates; a wrapped circular view's
coordinates are logical (below 0 or past the contig length), and a window at
the start of the contig shows the wrapped tail of an origin-spanning record.
Records were placed with ``interval - start`` in the view's own coordinates,
so a call on the far side of the origin was dropped or drawn in the wrong
place, and a view wholly below 0 got no overlay at all."""
from copy import deepcopy
from types import SimpleNamespace
import threading

import pytest

from models.domain import WorkingSet
from services.consensus_workflow import _index, apply_overlays

L = 1000


def _state(calls, *, circular=True):
    units = [dict(unit_id='u', read_name='wrap', strand='CT', source_members=[],
                  native_intervals=[list(call) for call in calls])]
    rows = [dict(unit_id='u', strand='CT', calls=[dict(
        raw=list(call), interval=list(call), action='projection_equivalent_normalization',
        reason='accepted', selected={'joint_native_log_lr': 0.}) for call in calls])]
    result = dict(manifest=dict(region=dict(chrom='pWrap', start=0, end=L)),
        datasets={'d': dict(chemistry='ddda', units=units, sr=dict(status='complete', records=rows))},
        cross=dict(status='disabled', edges=[]))
    index, layers = _index(result)
    job = dict(job_id='j', status='complete', result=result, index=index, layers=layers,
               filters=dict(show_quality_outlines=True))
    return SimpleNamespace(
        consensus_workflow_jobs={'j': job}, consensus_workflow_active='j',
        consensus_workflow_lock=threading.RLock(),
        circular_chroms={'pWrap': {'size': L, 'source': 'bam_topology'}} if circular else {})


def _project(state, start, end):
    read = dict(id='wrap', strand='CT', layers={})
    before = deepcopy(read)
    row = apply_overlays(state, 'd', 'pWrap', start, end,
                         WorkingSet([read], 1, 1, 'pWrap', start, end)).reads[0]
    assert read == before
    layer = row['layers'].get('tf_sr_lattice') or {}
    return layer.get('intervals'), layer.get('consensus_records')


# A molecule across the origin: a call in its head (960..990) and one in its
# wrapped tail (reference 20..40).
CALLS = [(960, 990), (20, 40)]


@pytest.mark.parametrize('start, end, expected', [
    (900, 1100, [[60, 90, 30], [120, 140, 20]]),    # wrapped view across the seam
    (-100, 100, [[60, 90, 30], [120, 140, 20]]),    # the same, from below 0
    (0, 200, [[20, 40, 20]]),                       # linear window at the start
    (900, 1000, [[60, 90, 30]]),                    # linear window at the end
])
def test_calls_are_placed_where_the_view_shows_their_bases(start, end, expected):
    intervals, records = _project(_state(CALLS), start, end)
    assert intervals == expected
    # Records move with their calls (the canvas draws edge ranges from them).
    for (lo, hi, _size), record in zip(intervals, records):
        assert record['interval'] == [start + lo, start + hi]
        assert tuple(record.get('reference_interval') or record['interval']) in CALLS


def test_a_view_wholly_below_zero_is_projected():
    # -500..-100 shows reference 500..900: the run's region 0..1000 is in it.
    intervals, records = _project(_state([(600, 650)]), -500, -100)
    assert intervals == [[100, 150, 50]]
    assert records[0]['interval'] == [-400, -350] and records[0]['reference_interval'] == [600, 650]


def test_a_call_across_the_origin_is_one_call_at_the_seam():
    # Record coordinates past the contig end (an origin-spanning record's own frame).
    intervals, _records = _project(_state([(950, 1050)]), 900, 1100)
    assert intervals == [[50, 150, 100]]
    intervals, _records = _project(_state([(950, 1050)]), 0, 200)
    assert intervals == [[0, 50, 100]]


def test_linear_contigs_are_unchanged():
    intervals, records = _project(_state(CALLS, circular=False), 900, 1000)
    assert intervals == [[60, 90, 30]] and 'reference_interval' not in records[0]
