"""Co-occupancy counts only reads that cover a site (release audit F5, geometric/layer groups).

A read that ends before a site was never observed there; counting it as 'unoccupied' biased odds ratios, p-values
and per-group occupancy towards the null whenever reads end inside the window (default spanningOnly=false)."""
import pytest

from services.footprint_analysis import build_interval_table, compute_cooccupancy_result, read_reference_extent

SITES = [{'absStart': 100, 'absEnd': 150}, {'absStart': 800, 'absEnd': 850}]
GROUPS = [{'referenceAbsStart': 100, 'referenceAbsEnd': 150}, {'referenceAbsStart': 800, 'referenceAbsEnd': 850}]


def _reads(with_bounds):
    """20 reads span both sites with perfect co-occupancy; 20 more cover only one site each (10 occupied there)."""
    reads = []
    def add(name, intervals, start, end):
        read = {'id': name, 'intervals': intervals}
        if with_bounds:
            read.update(reference_start=start, reference_end=end)
        reads.append(read)
    for i in range(10): add(f'full_both{i}', [[0, 100, -100], [100, 150, 50], [150, 800, -650], [800, 850, 50], [850, 1000, -150]], 0, 1000)
    for i in range(10): add(f'full_none{i}', [[0, 1000, -1000]], 0, 1000)
    for i in range(10): add(f'left_occ{i}', [[0, 100, -100], [100, 150, 50], [150, 400, -250]], 0, 400)
    for i in range(10): add(f'left_free{i}', [[0, 400, -400]], 0, 400)
    for i in range(10): add(f'right_occ{i}', [[600, 800, -200], [800, 850, 50], [850, 1000, -150]], 600, 1000)
    for i in range(10): add(f'right_free{i}', [[600, 1000, -400]], 600, 1000)
    return reads


@pytest.mark.parametrize('with_bounds', [True, False])
def test_only_reads_covering_a_site_count_for_it(with_bounds):
    reads = _reads(with_bounds)
    table = build_interval_table(reads, lambda r: r['intervals'], 0)
    result = compute_cooccupancy_result(table, GROUPS, SITES)
    pair = result['pairs'][0]
    assert pair['table'] == [[10, 0], [0, 10]]            # the 20 reads covering both sites
    assert pair['eligible_reads'] == 20 and pair['p_value'] < 1e-4
    assert [g['n_with'] for g in result['per_group']] == [20, 20]
    assert [g['eligible_reads'] for g in result['per_group']] == [40, 40]   # 20/40 occupied, not 20/60
    assert not any(name.startswith('right') for name in result['per_group'][0]['ids_without'])


def test_hidden_terminal_gaps_use_the_alignment_bounds():
    # Displayed intervals start at 120 (a hidden terminal gap), but the alignment covers the whole site.
    read = {'id': 'r', 'intervals': [[120, 400, -280]], 'reference_start': 50, 'reference_end': 400}
    assert read_reference_extent(read, 0) == (50, 400)
    # Shifted display coordinates (wrapped circular view) fall back to the displayed extent.
    shifted = dict(read, intervals=[[5120, 5400, -280]])
    assert read_reference_extent(shifted, 0) == (5120, 5400)


def test_unpinned_size_rules_keep_every_read_eligible():
    reads = _reads(True)
    table = build_interval_table(reads, lambda r: r['intervals'], 0)
    result = compute_cooccupancy_result(table, [{'sizeMin': 40, 'sizeMax': 60}], [])
    assert result['per_group'][0]['eligible_reads'] == 60
