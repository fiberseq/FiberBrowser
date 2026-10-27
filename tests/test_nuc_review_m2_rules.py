"""Codex M2 review fixes: nucleosome label-rule conditions in Filter/Sort counts and Cluster rules (group D, finding 1),
and cohort-wide molecule-metric ranks in columnar and windowed clustering (group C, finding 4).

The nucleosome predicates mirror the browser's (utils/ruleMatching.ts ``nucMarkMatchesRule`` through
utils/nucLayers.ts ``nucSizeMarkFor``): an item's ``nucsz`` mark (CONTRACTS §11.3 bytes: coarse, named, posterior,
z) must satisfy every set condition, and an item without a mark never matches a rule that sets one.
"""
from __future__ import annotations

import numpy as np
import pytest

NUCSZ_NAMES = ['coarse', 'named', 'posterior', 'z']


def _nucsz(marks):
    """A nucsz layer from (start, end, coarse, named, posterior, z) marks."""
    return {
        'intervals': [[s, e, e - s] for s, e, *_ in marks],
        'quality_names': list(NUCSZ_NAMES),
        'qualities': [[m[2 + q] for m in marks] for q in range(4)],
    }


def _long_read(**layers):
    """A read whose only footprint (100-260) carries a long-class mark (coarse 3), z byte 150 (z = 1.1)."""
    return {
        'id': 'r1',
        'intervals': [[0, 100, 0], [100, 260, 160], [260, 400, 0]],
        'layers': {'nucsz': _nucsz([(100, 260, 3, 3, 200, 150)]), **layers},
    }


# The payload the Filter/Sort request builders sent for a label rule with nucCoarse [2] before the fix.
OLD_PAYLOAD = {'size_min': 1, 'size_max': None, 'conditions': [], 'quality_gates': []}


def _count(read, rule, layer=None):
    from services.read_metrics import compute_rule_metric
    return compute_rule_metric(read, 0, rule, [], [], layer=layer)


# ---------------------------------------------------------------------------
# D-1: Filter/Sort counts


def test_reviewer_reproducer_count_metric_reads_the_nuc_conditions():
    read = _long_read()
    assert _count(read, OLD_PAYLOAD) == 1                       # no nucleosome condition: counted as before
    assert _count(read, {**OLD_PAYLOAD, 'nuc_coarse': [2]}) == 0  # mono only: the long footprint fails
    assert _count(read, {**OLD_PAYLOAD, 'nuc_coarse': [3]}) == 1
    # The Cluster path sends the raw ColorRule (camelCase); both spellings are read.
    assert _count(read, {**OLD_PAYLOAD, 'nucCoarse': [2]}) == 0
    assert _count(read, {**OLD_PAYLOAD, 'nucCoarse': [1, 3]}) == 1


@pytest.mark.parametrize('extra, expected', [
    ({'nuc_named': [3]}, 1), ({'nuc_named': [2]}, 0),
    ({'z_min': 1.0}, 1), ({'z_min': 1.2}, 0), ({'z_max': 1.1}, 1), ({'z_max': 1.0}, 0),
    ({'z_min': -1, 'z_max': 2}, 1),
    ({'nuc_tf': False}, 1), ({'nuc_tf': True}, 0),
    # Empty lists and null bounds are no condition (the browser's ruleHasNucConditions).
    ({'nuc_coarse': [], 'nuc_named': [], 'z_min': None, 'z_max': None, 'nuc_tf': None}, 1),
])
def test_each_nuc_predicate(extra, expected):
    assert _count(_long_read(), {**OLD_PAYLOAD, **extra}) == expected


def test_missing_marks_and_missing_bytes_fail_the_nuc_predicates():
    read = _long_read()
    no_layer = {**read, 'layers': {}}
    no_bytes = {**read, 'layers': {'nucsz': {'intervals': [[100, 260, 160]]}}}
    rule = {**OLD_PAYLOAD, 'nuc_coarse': [3]}
    assert _count(no_layer, rule) == 0 and _count(no_bytes, rule) == 0
    assert _count(no_layer, OLD_PAYLOAD) == 1
    # z 255 = none: a z condition fails, other conditions still read the mark.
    no_z = {**read, 'layers': {'nucsz': _nucsz([(100, 260, 3, 0, 200, 255)])}}
    assert _count(no_z, {**OLD_PAYLOAD, 'z_max': 5}) == 0
    assert _count(no_z, {**OLD_PAYLOAD, 'nuc_coarse': [3]}) == 1


def test_tf_bit_and_layers_with_marks():
    # A TF call (coarse byte 16 | 1) on the tf layer, a nucleosome on the nuc layer, an MSP that has no mark.
    read = {
        'id': 'r2',
        'intervals': [[0, 400, 0]],
        'layers': {
            'tf': {'intervals': [[40, 60, 20]]},
            'nuc': {'intervals': [[100, 247, 147]]},
            'msp': {'intervals': [[300, 380, 80]]},
            'nucsz': _nucsz([(40, 60, 17, 0, 0, 255), (100, 247, 2, 3, 0, 128)]),
        },
    }
    assert _count(read, {**OLD_PAYLOAD, 'nuc_tf': True}, layer='tf') == 1
    assert _count(read, {**OLD_PAYLOAD, 'nuc_tf': True}, layer='nuc') == 0
    assert _count(read, {**OLD_PAYLOAD, 'nuc_coarse': [2]}, layer='nuc') == 1
    assert _count(read, {**OLD_PAYLOAD, 'nuc_coarse': [1]}, layer='tf') == 1   # coarse = byte & 15
    # all_fp: every footprint layer, each item through its own mark.
    assert _count(read, {**OLD_PAYLOAD, 'nuc_coarse': [1, 2]}, layer='all_fp') == 2
    assert _count(read, {**OLD_PAYLOAD, 'nuc_tf': False}, layer='all_fp') == 1
    # An MSP item never has a mark: any nucleosome condition fails it.
    assert _count(read, OLD_PAYLOAD, layer='msp') == 1
    assert _count(read, {**OLD_PAYLOAD, 'nuc_tf': False}, layer='msp') == 0


def test_mark_lookup_mirrors_the_browser():
    """Identical span first; else the mark containing the item's midpoint that overlaps it most (ties: the shorter)."""
    from services.clustering_features import nuc_size_index, nuc_size_mark_for
    read = {'layers': {'nucsz': _nucsz([(0, 300, 4, 0, 0, 255), (100, 200, 2, 0, 0, 255), (150, 160, 17, 0, 0, 255)])}}
    index = nuc_size_index(read)
    assert nuc_size_mark_for(index, 100, 200)['coarse'] == 2       # exact span
    assert nuc_size_mark_for(index, 0, 300)['coarse'] == 4
    assert nuc_size_mark_for(index, 120, 190)['coarse'] == 2       # split call piece inside the mono mark
    assert nuc_size_mark_for(index, 152, 158)['coarse'] == 17      # equal overlap: the shorter mark
    assert nuc_size_mark_for(index, 310, 330) is None
    assert nuc_size_index({'layers': {'nucsz': {'intervals': [[0, 10, 10]], 'qualities': []}}}) is None
    # Footprints clipped to the same displayed span: told apart by molecular length; still ambiguous -> no mark.
    clipped = {'layers': {'nucsz': {'intervals': [[0, 100, 147], [0, 100, 300]],
                                    'qualities': [[2, 4], [0, 0], [0, 0], [255, 255]]}}}
    index = nuc_size_index(clipped)
    assert nuc_size_mark_for(index, 0, 100, 147)['coarse'] == 2
    assert nuc_size_mark_for(index, 0, 100, 300)['coarse'] == 4
    assert nuc_size_mark_for(index, 0, 100) is None


def test_rule_layer_request_adds_nucsz_only_for_nuc_rules():
    from services.read_metrics import rule_layer_request
    nuc_rule = {**OLD_PAYLOAD, 'nuc_coarse': [2]}
    assert rule_layer_request(OLD_PAYLOAD, False, None) == (False, None)
    assert rule_layer_request(OLD_PAYLOAD, True, ['nuc']) == (True, ['nuc'])
    assert rule_layer_request(None, True, ['nuc']) == (True, ['nuc'])
    assert rule_layer_request(nuc_rule, False, None) == (True, ['nucsz'])
    assert rule_layer_request(nuc_rule, True, ['nuc']) == (True, ['nuc', 'nucsz'])
    assert rule_layer_request(nuc_rule, True, None) == (True, None)          # every layer already
    assert rule_layer_request(nuc_rule, True, ['nucsz']) == (True, ['nucsz'])


# ---------------------------------------------------------------------------
# D-1: Cluster rules


def _label_rule(**nuc):
    color_rule = {'id': 'c1', 'name': 'Mono', 'color': '#16a34a', 'opacity': 1, 'sizeMin': 1, 'sizeMax': None,
                  'targetLayers': [], 'conditions': [], 'enabled': True, **nuc}
    return {'id': 'k1', 'name': 'Mono', 'enabled': True,
            'terms': [{'id': 't1', 'source': 'label_rule', 'rule': color_rule}]}


def test_reviewer_reproducer_cluster_rule_reads_the_nuc_conditions():
    from services.clustering_features import _cluster_feature_rule_intervals, extract_features_from_compact
    read = _long_read()
    span = [(100, 260, 1.0)]
    assert _cluster_feature_rule_intervals(read, _label_rule(), region_start=0, peak_regions=[]) == span
    assert _cluster_feature_rule_intervals(read, _label_rule(nucCoarse=[2]), region_start=0, peak_regions=[]) == []
    assert _cluster_feature_rule_intervals(read, _label_rule(nucCoarse=[3]), region_start=0, peak_regions=[]) == span
    assert _cluster_feature_rule_intervals(read, _label_rule(zMin=2.0), region_start=0, peak_regions=[]) == []
    assert _cluster_feature_rule_intervals(read, _label_rule(nucTf=False), region_start=0, peak_regions=[]) == span
    for nuc, expected in (({}, 1.0), ({'nucCoarse': [2]}, 0.0), ({'nucNamed': [3]}, 1.0)):
        rule = _label_rule(**nuc)
        X, _ids, widths, _modes = extract_features_from_compact(
            [read], [(100, 260)], 0, peak_modes=['cluster_rule:k1'], cluster_feature_rules=[rule])
        assert widths == [16] and set(X[0].tolist()) == {expected}


def test_cluster_rule_items_without_marks_fail():
    from services.clustering_features import _cluster_feature_rule_intervals
    read = {**_long_read(), 'layers': {'msp': {'intervals': [[300, 380, 80]]}}}
    # No nucsz layer: nothing matches a nucleosome rule; MSP items never have marks.
    assert _cluster_feature_rule_intervals(read, _label_rule(nucTf=False), region_start=0, peak_regions=[]) == []
    assert _cluster_feature_rule_intervals(read, _label_rule(), region_start=0, peak_regions=[]) == [
        (100, 260, 1.0), (300, 380, 1.0)]


def test_term_normalization_keeps_nuc_fields_only_when_set():
    from services.clustering_features import _term_to_rule
    plain = _label_rule()['terms'][0]
    assert set(_term_to_rule(plain, plain['rule'])) == {'sizeMin', 'sizeMax', 'targetLayers', 'qualityGates',
                                                        'conditions'}
    nuc = _label_rule(nucCoarse=[2], zMax=1.5, nucTf=False)['terms'][0]
    normalized = _term_to_rule(nuc, nuc['rule'])
    assert normalized['nucCoarse'] == [2] and normalized['zMax'] == 1.5 and normalized['nucTf'] is False


# ---------------------------------------------------------------------------
# C-4: molecule-metric ranks over the whole cohort


NRLS = [180.0, 190.0, 200.0, 210.0]
METRIC_RULE = {'id': 'm', 'enabled': True,
               'terms': [{'id': 't', 'source': 'molecule_metric', 'moleculeMetric': 'nuc.nrl'}]}


def _metric_reads(values):
    return [{'id': f'r{i}', 'intervals': [[0, 100, 100]], '_fiberbrowser_scalars': {'nuc.nrl': v}}
            for i, v in enumerate(values)]


def _metric_bits(builder, n):
    _assignments, _counts, _order, info = builder.finish()
    on = set(info['element_read_ids'][0])
    return [int(f'r{i}' in on) for i in range(n)]


@pytest.mark.parametrize('block_rows', [1, 2, 3, 512])
def test_reviewer_reproducer_columnar_metric_bits_ignore_block_boundaries(block_rows):
    from services.cluster_assignment import cluster_compact_reads
    from services.columnar_clustering import ColumnarPatterns
    kwargs = dict(peak_modes=['cluster_rule:m'], cluster_feature_rules=[METRIC_RULE])
    reads = _metric_reads(NRLS)
    builder = ColumnarPatterns([(0, 100)], 0, block_rows=block_rows, **kwargs)
    for read in reads:
        builder.append(read)
    assert _metric_bits(builder, 4) == [0, 0, 1, 1]
    # And it matches the native (all reads at once) path exactly.
    native = cluster_compact_reads(reads, [(0, 100)], 0, 5, method='combinatorial', **kwargs)
    builder = ColumnarPatterns([(0, 100)], 0, block_rows=block_rows, **kwargs)
    for read in reads:
        builder.append(read)
    actual = builder.finish()
    assert actual[0] == native[0] and actual[1] == native[1] and actual[3] == native[3]
    np.testing.assert_array_equal(actual[2], native[2])


def test_columnar_metric_bits_read_order_and_missing_values():
    from services.columnar_clustering import ColumnarPatterns
    values = [210.0, None, 180.0, 200.0, 190.0]
    builder = ColumnarPatterns([(0, 100)], 0, block_rows=2, peak_modes=['cluster_rule:m'],
                               cluster_feature_rules=[METRIC_RULE])
    for read in _metric_reads(values):
        builder.append(read)
    # Ranks over the four known values: 210 -> .875, 180 -> .125, 200 -> .625, 190 -> .375; missing -> .5 (off).
    assert _metric_bits(builder, 5) == [1, 0, 0, 1, 0]


def test_windowed_extraction_ranks_over_the_whole_cohort():
    """Reads at other loci (extract_features_grouped windows) rank against one cohort, not per window."""
    from services.clustering_features import extract_features_from_compact, extract_features_grouped
    reads = _metric_reads(NRLS)
    for read, group in zip(reads, ['a', 'a', 'b', 'b']):
        read['_cluster_group'] = group
    groups = {'a': ([(0, 100)], 0, None), 'b': ([(0, 100)], 0, None)}
    kwargs = dict(peak_modes=['cluster_rule:m'], cluster_feature_rules=[METRIC_RULE])
    X, ids, _widths, _modes = extract_features_grouped(reads, [(0, 100)], 0, groups, **kwargs)
    whole, whole_ids, _w, _m = extract_features_from_compact(_metric_reads(NRLS), [(0, 100)], 0, **kwargs)
    assert ids == whole_ids
    np.testing.assert_allclose(X[:, 0], whole[:, 0])
    assert [round(float(v), 3) for v in X[:, 0]] == [0.125, 0.375, 0.625, 0.875]
