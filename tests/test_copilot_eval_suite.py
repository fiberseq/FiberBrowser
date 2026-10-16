"""The teach-only Copilot eval suite: its cases are valid and its scorer tells good plans from bad ones."""
import copy
import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT / "browser", ROOT, ROOT / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


@pytest.fixture(scope="module")
def suite():
    return importlib.import_module("eval_copilot_suite")


def _case(suite, case_id):
    return next(c for c in suite.EVAL_CASES if c["id"] == case_id)


def test_dry_run_validates_cases_and_every_reference_plan_passes(suite):
    ok, report = suite.dry_run(verbose=False)
    assert report["case_errors"] == []
    assert report["reference_failures"] == []
    assert ok
    # Core suite plus the eval_cases_* modules (vague requests, panels, …).
    assert 90 <= report["cases"] <= 300


def test_every_diagnostic_code_is_covered(suite):
    codes = {d["code"] for c in suite.EVAL_CASES for d in c.get("diagnostics") or []}
    assert set(suite.DIAGNOSTIC_CODES) <= codes


def test_an_operation_fails_the_hard_axis(suite):
    case = _case(suite, "wf_cluster_fresh")
    plan = copy.deepcopy(case["reference"])
    plan["actions"].append({"type": "cluster_selected_peaks"})
    result = suite.score_plan(case, plan)
    assert result["axes"]["no_operations"] is False


def test_anchor_order_try_it_and_diagnosis_are_checked(suite):
    case = _case(suite, "wf_cluster_fresh")
    plan = copy.deepcopy(case["reference"])
    # Cluster button before the method: out of order; no try_it for `clustered`.
    plan["actions"] = [{"type": "explain", "anchor": "cluster-button", "text": "Cluster."},
                       {"type": "explain", "anchor": "cluster-method", "text": "Method."}]
    axes = suite.score_plan(case, plan)["axes"]
    assert axes["anchors"] is False and axes["try_it"] is False

    diag = _case(suite, "td_filter_none")
    wrong = {"summary": "x", "actions": [{"type": "explain", "anchor": "load-dataset", "text": "Load data."}]}
    assert suite.score_plan(diag, wrong)["axes"]["diagnosis"] is False


def test_a_healthy_state_must_not_get_an_invented_fix(suite):
    case = _case(suite, "rs_looks_fine")
    plan = {"summary": "x", "actions": [
        {"type": "try_it", "anchor": "clear-filter", "wait_for": "filter_cleared", "text": "Clear the filter."}]}
    axes = suite.score_plan(case, plan)["axes"]
    assert axes["diagnosis"] is False and axes["try_it"] is False


def test_unmet_needs_fail_gating(suite):
    case = _case(suite, "wf_cluster_fresh")
    plan = {"summary": "x", "actions": [{"type": "explain", "anchor": "clusters-overview", "text": "Overview."}]}
    assert suite.score_plan(case, plan)["axes"]["gating"] is False
