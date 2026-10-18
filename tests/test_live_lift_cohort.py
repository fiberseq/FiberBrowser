"""Cohort identities are independent of display policy and stable under folding."""
from types import SimpleNamespace
import pytest
from services.lift.live_lift import LiftSettings
from services.lift.cohort import prepare_lift_cohort, raw_qnames
from services.read_selection import read_matches_id_filter


def row(record="r", orientation=0, molecule="group|molecule", supp=False, alt=False, start=0):
    return dict(id="molecule", intervals=[[start, start + 20, 20]],
                reference_start=start, reference_end=start + 20,
                live_lift=dict(molecule=molecule, record=record, row_index=orientation,
                               placement="alt1" if alt else "1", alt=alt, hap="MAT", hap_label="MAT",
                               source={"supplementary": supp}, segments=[[start, start + 20, 1, "+", True]],
                               connectors=[], badges=[], calls={"intervals": ["call"]},
                               call_parts={"intervals": [[0, 0]]}))


@pytest.mark.parametrize("fold_molecule,fold_orientation_rows,expected", [(False, False, 3), (False, True, 2), (True, False, 1), (True, True, 1)])
def test_fold_identity_and_raw_sampler_names(fold_molecule, fold_orientation_rows, expected):
    settings = LiftSettings(fold_molecule=fold_molecule, fold_orientation_rows=fold_orientation_rows,
                            molecule_groups=[['source', 'group']])
    source = [row(), row(orientation=1, start=20), row(record="supp", supp=True, start=40)]
    display = prepare_lift_cohort(source, "display", settings)
    cohort = prepare_lift_cohort(source, "analysis", settings)
    assert len(display.rows) == 3
    assert len(cohort.rows) == expected
    assert {r["analysis_id"] for r in display.rows} == {r["analysis_id"] for r in cohort.rows}
    assert raw_qnames([r["analysis_id"] for r in cohort.rows], SimpleNamespace(
        id='lifted', paths=['source'], live_lift=SimpleNamespace(settings=settings))) == {"molecule"}
    assert all(read_matches_id_filter(r, {r["analysis_id"]}) for r in display.rows)
    assert "analysis_id" not in source[0]


def test_display_and_cohort_options_are_independent():
    settings = LiftSettings(supplementary_display="hide", cohort_alternatives="include")
    rows = [row(), row(record="supp", supp=True), row(alt=True)]
    assert len(prepare_lift_cohort(rows, "display", settings).rows) == 1
    analysis = prepare_lift_cohort(rows, "analysis", settings)
    assert len(analysis.rows) == 3
    assert analysis.description["alternative_rows"] == 1
    assert analysis.description["supplementary_rows"] == 1


def test_inferred_strand_is_a_qualified_molecule_property():
    a, b, unrelated = row(), row(orientation=1), row(molecule="other|molecule")
    a["deam"], b["deam"], unrelated["deam"] = [[1, 1], [2, 1]], [[3, 0]], [[1, 0]]
    prepared = prepare_lift_cohort([a, b, unrelated], "display", LiftSettings()).rows
    assert [r["strand"] for r in prepared] == ["CT", "CT", "GA"]


def test_split_calls_count_once_after_crop_and_record_ids_do_not_merge():
    from services.read_selection import count_footprints
    from services.working_sets import project_broad_read_to_viewport
    a = row()
    a['intervals'] = [[0, 10, 20], [20, 30, 20]]
    a['live_lift']['segments'] = [[0, 10, 1, '+', True], [20, 30, 1, '+', True]]
    a['live_lift']['calls']['intervals'] = ['call', 'call']
    a['live_lift']['call_parts']['intervals'] = [[0, 0], [10, 0]]
    assert count_footprints(a) == 1
    cropped, _ = project_broad_read_to_viewport(a, viewport_offset=20, region_width=10,
                                               include_methylation=False, layer_key=())
    assert count_footprints(cropped) == 1
    b = row(record='other', start=30)
    folded = prepare_lift_cohort([a, b], 'analysis', LiftSettings(fold_molecule=True)).rows[0]
    assert count_footprints(folded) == 2


def test_molecular_overlap_arbitration_is_order_independent():
    a, b = row(start=0), row(record='supp', supp=True, start=100)
    a['live_lift']['molecular_spans'] = [[0, 20, 0, 1, True]]
    b['live_lift']['molecular_spans'] = [[100, 120, 10, 1, True]]
    settings = LiftSettings(fold_molecule=True)
    first = prepare_lift_cohort([a, b], 'analysis', settings).rows
    second = prepare_lift_cohort([b, a], 'analysis', settings).rows
    assert first == second
    assert first[0]['intervals'] == [[0, 20, 20], [110, 120, 20]]


def test_mixed_metaprofile_denominators_and_dynamic_overlap_ignore_connectors():
    import numpy as np
    from services.read_metrics import compute_metaprofile_from_compact_reads, compute_compact_metaprofile_payload, read_covers_regions
    from services.dynamic_clustering import read_peak_overlap_weights
    a = row()
    a['intervals'] = [[0, 100, 100]]  # even a stale hull must not cover a hole
    a['live_lift']['segments'] = [[0, 100, 1, '+', True]]
    a['live_lift']['connectors'] = [[20, 80]]
    assert not read_covers_regions(a, [[30, 40]])
    assert read_peak_overlap_weights(a, [[0, 100], [30, 40]]) == (40, 0)
    # The lifted molecule has no footprint in the hole. Native signal is 1,
    # rather than 1/2 from a false lifted denominator.
    a['intervals'] = [[0, 20, 100], [80, 100, 100]]
    native = dict(id='native', intervals=[[0, 100, 100]])
    profile = compute_metaprofile_from_compact_reads([native, a], 100, 90, 1000)
    assert np.allclose(profile, 1)
    fast = compute_compact_metaprofile_payload([native, a], 100, ['nuc'])
    assert np.allclose(fast['layers']['nuc'], 1)


def test_folded_quality_tracks_and_call_metadata_survive_filtering():
    from services.read_quality_filters import apply_quality_filters
    from services.read_selection import count_footprints
    a, b = row(), row(record='other', start=20)
    for r, quality in [(a, 50), (b, 250)]:
        r['layers'] = {'nuc': {'intervals': r['intervals'], 'quality_names': ['nq'], 'qualities': [[quality]]}}
        r['qualities'] = [quality]
        r['live_lift']['calls']['layer:nuc'] = ['call']
        r['live_lift']['call_parts']['layer:nuc'] = [[0, 0]]
    folded = prepare_lift_cohort([a, b], 'analysis', LiftSettings(fold_molecule=True)).rows[0]
    assert folded['layers']['nuc']['qualities'] == [[50, 250]]
    filtered = apply_quality_filters(folded, [{'layer': 'nuc', 'quality_name': 'nq', 'min_value': 100}])
    assert filtered['live_lift']['calls']['layer:nuc'] == ['other|call']
    assert folded['live_lift']['calls']['layer:nuc'] == ['r|call', 'other|call']


def test_inferred_strand_cache_is_shared_by_molecule_and_separates_libraries():
    from services.read_strand import cached_read_strand
    a, b = row(), row(molecule='other|molecule')
    a['deam'], b['deam'] = [[1, 1]], [[1, 0]]
    reads = prepare_lift_cohort([a, b], 'analysis', LiftSettings()).rows
    calls = {}
    assert [cached_read_strand(r, calls) for r in reads] == ['CT', 'GA']
    assert calls == {'group|molecule': 'CT', 'other|molecule': 'GA'}
    reads[0]['strand'] = 'GA'  # another view's inferred marks cannot change the molecule
    assert cached_read_strand(reads[0], calls) == 'CT'
    reads[0]['_fiberbrowser_inferred_strand'] = False  # primary st remains authoritative
    assert cached_read_strand(reads[0], calls) == 'GA'


def test_three_orientation_rows_share_folded_features_and_molecule_strand():
    from services.clustering_features import extract_features_from_compact
    from services.read_metrics import read_covers_regions
    from services.read_selection import is_read_spanning
    rows = [row(orientation=i, start=20*i) for i in range(3)]
    for r, orientation in zip(rows, ['+', '-', '+']):
        r['live_lift']['segments'][0][3] = orientation
        r['strand'] = 'CT'
    peaks = [[5, 10], [25, 30], [45, 50]]
    assert not any(read_covers_regions(r, peaks) for r in rows)
    folded = prepare_lift_cohort(rows, 'analysis', LiftSettings(fold_orientation_rows=True)).rows
    assert len(folded) == 1 and read_covers_regions(folded[0], peaks)
    assert folded[0]['strand'] == 'CT' and is_read_spanning(folded[0], 60)
    features, ids, _, _ = extract_features_from_compact(folded, peaks, 0)
    assert features.shape[0] == len(ids) == 1 and ids == [folded[0]['analysis_id']]
    assert features.tolist() == [[1, 1, 1]]
