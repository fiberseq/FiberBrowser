"""Regression cases for reconstruction shapes, cohorts and staged fallbacks."""
from dataclasses import replace

import pytest

from services import insertion_consensus as consensus
from services.alt_allele_align import AltLayout, KIND_CIGAR, KIND_REFERENCE, realign_batch
from services.reconstruction_budget import DEFAULT_LIMITS, ResourceResult, WorkBudget, _current


@pytest.mark.parametrize('replacement', [False, True])
def test_middle_preflight_includes_flanks_offsets_and_reference_replacements(replacement):
    if replacement:
        layout = AltLayout('chrT', 1000, 10000, 1000, 1000, replaced_len=6000)
        jobs = [([(0, 8000)], 0, {'kind': KIND_REFERENCE}, 'A' * 8000)]
    else:
        layout = AltLayout('chrT', 2000, 6000, 2000, 2000)
        jobs = [([(0, 1000), (1, 3000), (2, 2000), (0, 1000)], 0,
                 {'kind': KIND_CIGAR, 'q': 1000, 'len': 3000}, 'A' * 5000)]
    result, = realign_batch(jobs, layout, 'A' * layout.length)
    assert result is not None and result.insert_bases > 0
    assert sum(n for op, n in result.cigar if op in (0, 1, 4, 7, 8)) == len(jobs[0][3])
    # All bases are identical: an optimal alignment consumes every query base
    # as a match and only needs target deletions for the length difference.
    assert sum(n for op, n in result.cigar if op == 0) == len(jobs[0][3])
    assert sum(n for op, n in result.cigar if op in (0, 2, 3, 7, 8)) == layout.length


def test_default_depth_lens_keeps_consensus_and_knots(tmp_path):
    from live_lift_fixtures import make_record, write_bam
    from services.insertion_lens import build_lens
    path = write_bam(tmp_path / 'depth.bam', lambda h: [make_record(
        h, f'synthetic-{i}', 'chrT', 900, '100M100I100M', seq='A' * 100 + 'C' * 100 + 'G' * 100)
        for i in range(300)], contigs=(('chrT', 3000),))
    lens = build_lens([path], 'chrT', pos=1000, ref=1000, length=100, loader=lambda *a, **k: [])
    assert not lens.get('consensus_resource')
    assert lens['consensus']['seq'] == 'C' * 100
    assert len(lens['carriers']) == 300 and all('knots' in row for row in lens['carriers'])


def test_daf_no_consensus_preflights_native_fallback_before_voting(monkeypatch):
    truth = 'ACGT' * 100
    budget = WorkBudget(replace(DEFAULT_LIMITS, request_cells=1_000_000))
    monkeypatch.setattr(consensus, '_daf_from_carriers', lambda values: (None, 'synthetic no consensus'))
    token = _current.set(budget)
    try:
        result = consensus._lens_reconstruction([truth] * 16, [truth] * 16, [], [('synthetic',)], None)
    finally:
        _current.reset(token)
    assert result['full']['seq'] == truth and result['method'] == 'majority'
    assert result['alignment_algorithms']['consensus'] == 'weighted_wavefront:v1'
    assert 0 < budget.cells <= budget.limits.request_cells


def test_wavefront_score_shrinks_to_fit_matrix_bytes_instead_of_refusing():
    limits = replace(DEFAULT_LIMITS, job_bytes=2_000_000, pair_cells=100_000_000, wavefront_pair_states=100_000_000)
    budget = WorkBudget(limits)
    score, states = budget.wavefront(1000, 1000)
    allocation = (score + 1) * (2 * (score // 6) + 1)
    assert 10 * allocation + 128 * 2002 <= limits.job_bytes
    assert states <= limits.wavefront_pair_states


def test_wavefront_charges_actual_work_once_across_successive_pairs():
    budget = WorkBudget(replace(DEFAULT_LIMITS, request_cells=1000))
    budget.algorithm = 'weighted_wavefront:v1'
    token = _current.set(budget)
    try:
        previous = 0
        for _ in range(3):
            consensus.align('A' * 100, 'A' * 100)
            assert budget.cells == previous + 1
            previous = budget.cells
        with pytest.raises(ResourceResult, match='wavefront_states'):
            for _ in range(20):
                consensus.align('A' * 100, 'C' * 100)
        assert budget.cells <= 1000
    finally:
        _current.reset(token)


def test_wavefront_preflight_accumulates_unavoidable_work():
    budget = WorkBudget(replace(DEFAULT_LIMITS, request_cells=20))
    budget.plan_wavefront(10, 19)
    budget.plan_wavefront(19, 10)
    assert budget.cells == 20
    with pytest.raises(ResourceResult, match='wavefront_states'):
        budget.plan_wavefront(10, 10)
