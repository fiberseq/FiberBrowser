"""The Copilot dataset validator checks api_call examples the way the server parses them."""
import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT / "browser", ROOT, ROOT / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


@pytest.fixture(scope="module")
def schemas():
    build = importlib.import_module("build_copilot_dataset")
    _nlc, app = build._load_runtime()
    return build, build._route_schemas(app)


def test_region_in_the_body_and_unknown_fields_are_rejected(schemas):
    build, sc = schemas
    old = {"type": "api_call", "method": "POST", "path": "/api/sort_reads",
           "body": {"chrom": "2R", "start": 1, "end": 2, "metric": "accessibility"}}
    errors = build._check_api_call(old, sc)
    assert any("required query parameter 'chrom' is missing (it is in the body" in e for e in errors)
    assert any("'metric' is not a field of SortReadsRequest" in e for e in errors)
    fixed = {"type": "api_call", "method": "POST", "path": "/api/sort_reads?chrom=2R&start=1&end=2",
             "body": {"sort_by": "accessibility"}}
    assert build._check_api_call(fixed, sc) == []


def test_wrong_query_names_and_invalid_bodies_are_rejected(schemas):
    build, sc = schemas
    errors = build._check_api_call({"type": "api_call", "method": "GET", "path": "/api/gene_search?q=ftz"}, sc)
    assert any("'q' is not accepted" in e for e in errors) and any("'query' is missing" in e for e in errors)
    errors = build._check_api_call({"type": "api_call", "method": "POST", "path": "/api/jupyter/settings",
                                    "body": {"analysis_sample_seed": 42}}, sc)
    assert any("does not validate" in e for e in errors)
    assert build._check_api_call({"type": "api_call", "method": "POST", "path": "/api/jupyter/settings",
                                  "body": {"analysis_sample_seed": "42"}}, sc) == []


def test_routes_reading_the_raw_request_are_not_second_guessed(schemas):
    build, sc = schemas
    action = {"type": "api_call", "method": "POST", "path": "/api/quality_filters", "body": {"filters": []}}
    assert build._check_api_call(action, sc) == []


def test_every_record_validates_against_the_routes(schemas):
    build, sc = schemas
    nlc, app = build._load_runtime()
    real = build._real_route_set(app)
    from data.copilot_dataset.records import RECORDS
    bad = {r["id"]: errs for r in RECORDS if (errs := build._validate_record(nlc, r, real, sc))}
    assert bad == {}
