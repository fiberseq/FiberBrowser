"""Live-lift capability refusals (DESIGN_LIVE_LIFT.md §3.10; Codex P2a review #1).

- The refusal matrix: every /api route that names a dataset, called with a
  lifted dataset, either is a display route (``guard.LIFT_ALLOWED``) or
  answers 409 with one notice, never 200 with data, a 422 with BAM/BigBed
  guidance or a 500.
- The services refuse on their own too (called without the HTTP guard):
  merge, figure read tracks, consensus; compact metaprofiles are suppressed
  with a notice.
"""
import re

import pytest
from starlette.routing import Match  # noqa: F401 - the guard's matcher

from live_lift_fixtures import TARGET
from test_live_lift_endpoints import _add, lift_env  # noqa: F401 - fixture

from services.lift.guard import LIFT_ALLOWED, LIFT_PREFIX, named_dataset_ids


_CARRIERS = {"dataset_id", "dataset_ids", "source_dataset_id", "read_ids_by_dataset", "viewports", "windows"}


def _routes(app):
    """Every (method, route) that can name a dataset: a ``{dataset_id}`` path, a carrier query parameter
    or body field, or an untyped JSON body (``request: dict``)."""
    spec = app.openapi()
    schemas = spec.get("components", {}).get("schemas", {})
    for path, ops in spec["paths"].items():
        if not path.startswith("/api/") or path.startswith(LIFT_PREFIX):
            continue
        for method, op in ops.items():
            names = {p["name"] for p in op.get("parameters", [])}
            body = (op.get("requestBody") or {}).get("content", {}).get("application/json", {}).get("schema", {})
            if "$ref" in body:
                names |= set(schemas.get(body["$ref"].split("/")[-1], {}).get("properties", {}))
            untyped = bool(body) and "$ref" not in body and body.get("type") == "object" and not body.get("properties")
            if names & _CARRIERS or "{dataset_id}" in path or untyped:
                yield method.upper(), path


def _fill(path, did):
    path = path.replace("{dataset_id}", did)
    return re.sub(r"\{[^}]+\}", "x", path)


def test_refusal_matrix(lift_env):
    import server as srv

    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    query = dict(chrom=TARGET, start=1000, end=9000, dataset_id=did, dataset_ids=did, pos=4000)
    body = dict(chrom=TARGET, start=1000, end=9000, dataset_id=did, dataset_ids=[did],
                read_ids_by_dataset={did: ["plus"]}, viewports=[dict(chrom=TARGET, start=1000, end=9000,
                                                                      dataset_id=did)])
    checked, allowed = [], []
    for method, path in _routes(srv.app):
        if (method, path) in LIFT_ALLOWED:
            allowed.append((method, path))
            continue
        url = _fill(path, did)
        if method in ("GET", "DELETE"):
            r = client.request(method, url, params=query)
        else:
            r = client.request(method, url, params=query, json=body)
        checked.append((method, path))
        assert r.status_code == 409, (method, path, r.status_code, r.text[:300])
        data = r.json()
        assert data["notice"] and "live-lift" in data["notice"], (method, path, data)
        assert "BigBed" not in data["notice"]
    assert len(checked) > 60, len(checked)
    # The display paths stay open, and the dataset is still a lifted one (nothing merged it away).
    assert client.get("/api/reads/compact", params=dict(query, dataset_ids=None)).status_code == 200
    assert state.datasets[did].data_type == "bam_livelift"


def test_named_dataset_ids_finds_every_carrier():
    class Q:
        def __init__(self, d):
            self.d = d

        def getlist(self, k):
            return self.d.get(k, [])

    ids = named_dataset_ids(Q({"dataset_id": ["a"], "dataset_ids": ["b,c"]}), {"dataset_id": "d"},
                            {"dataset_ids": ["e"], "source_dataset_id": "f", "read_ids_by_dataset": {"g": []},
                             "viewports": [{"dataset_id": "h"}], "windows": [{"dataset_ids": ["i"]}]})
    assert sorted(ids) == list("abcdefghi")


def test_services_refuse_without_the_guard(lift_env):
    """Merge, figures and consensus refuse in the service; compact metaprofiles are left out with a notice."""
    from types import SimpleNamespace

    from models.requests import MergeDatasetsRequest
    from services.dataset_endpoint import merge_datasets_for_request
    from services.lift.capability import LiveLiftUnsupported
    from services.lift.registration import add_live_lift_dataset
    from services.read_endpoint import compact_all_dataset_result, compact_reads_payload_for_request

    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    other = add_live_lift_dataset(state, paths=[bam], manifest=manifest, dataset_id="other")["dataset"]["id"]
    with pytest.raises(LiveLiftUnsupported):
        merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=[did, other]))
    assert {d: ds.data_type for d, ds in state.datasets.items()} == {did: "bam_livelift", other: "bam_livelift"}

    from services.figure.data import DataCache
    with pytest.raises(LiveLiftUnsupported):
        DataCache(state, SimpleNamespace(fe={}, chrom=TARGET, start=1000, end=9000)).compact_reads(did)

    from services.consensus_workflow import submit
    with pytest.raises(LiveLiftUnsupported):
        submit(state, {"dataset_ids": [did], "chrom": TARGET, "start": 1000, "end": 9000})

    payload = compact_reads_payload_for_request(state, chrom=TARGET, start=1000, end=9000, dataset_id=did,
                                                include_metaprofile=True, include_layers=True)
    assert payload.get("metaprofile") in (None, {}) and payload["live_lift_notices"]
    assert "Metaprofiles" in payload["live_lift_notices"][0]
    from services.analysis_query import AnalysisReadQuery
    query = AnalysisReadQuery.from_request(state, capability="compact_all", chrom=TARGET, start=1000, end=9000,
                                           dataset_ids=[did])
    result = compact_all_dataset_result(
        state=state, query=query, dataset_id=did, chrom=TARGET, start=1000, end=9000, region_width=8000,
        spanning=False, max_reads=100, downsample=None, include_methylation=False, include_layers=False,
        requested_layers=None, include_layer_qualities=False, ml_threshold=125, fill_gap_size=None,
        min_fp_quality=0, min_footprints=0, include_metaprofile=True, profile_max_reads=100, coverage_sample=False,
        hide_terminal_gaps=True, terminal_gap_threshold=500, infer_legacy_layers=True, legacy_nuc_min_size=90,
        sample_seed="s", include_sv_summary=True)
    result = result[1] if isinstance(result, tuple) else result
    assert result["metaprofile"] is None and result["live_lift_notices"]
    assert "sv_summary" not in result or not result["sv_summary"]
