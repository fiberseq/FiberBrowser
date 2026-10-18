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
    settings = LiftSettings(fold_molecule=fold_molecule, fold_orientation_rows=fold_orientation_rows)
    source = [row(), row(orientation=1, start=20), row(record="supp", supp=True, start=40)]
    display = prepare_lift_cohort(source, "display", settings)
    cohort = prepare_lift_cohort(source, "analysis", settings)
    assert len(display.rows) == 3
    assert len(cohort.rows) == expected
    assert {r["analysis_id"] for r in display.rows} == {r["analysis_id"] for r in cohort.rows}
    assert raw_qnames([r["analysis_id"] for r in cohort.rows], SimpleNamespace(live_lift=SimpleNamespace(settings=settings))) == {"molecule"}
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
