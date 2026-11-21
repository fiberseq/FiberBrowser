"""The toolbar's Show QC-fail reads (incl. FiberHMM chimeras) in the dev-only panels: nucleosomes, the feature hub,
scans and Differences hide QC-fail reads by default and show them when the toggle is on, as the read track does."""
from array import array
from types import SimpleNamespace as NS

import pysam
import pytest

from test_circular_origin_spanning import CONTIG, L, _record, _sequence, _state


class _Stop(Exception):
    pass


@pytest.fixture
def chimera_state(tmp_path):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"},
                                              "SQ": [{"SN": CONTIG, "LN": L}]})
    tags = {"ns": array("i", [20]), "nl": array("i", [100])}
    records = [_record(header, "unique", 100, 300, _sequence(), tags=tags),
               _record(header, "chimera", 100, 300, _sequence(), tags={**tags, "xc": "strand_swap"}, flag=0x200)]
    path = tmp_path / "chimera.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in records:
            out.write(read)
    pysam.index(str(path))
    return _state({"bam": str(path)})


def _capture_policy(monkeypatch, module, seen):
    def fake(state, include_duplicates=False, include_qcfail=False):
        seen.append(include_qcfail)
        raise _Stop()
    monkeypatch.setattr(module, "browser_read_policy", fake)


# ------------------------------------------------------------------ the shared read policy
@pytest.mark.parametrize("include_qcfail", [False, True])
def test_read_policy_follows_the_toggle(include_qcfail):
    from fiberhmm.scan.reads import resolve_read_policy
    from services.scan.planning import read_policy
    policy = read_policy(NS(performance={"effective": "standard"}), include_qcfail=include_qcfail)
    assert resolve_read_policy(policy)["filters"]["chimeras"] == ("include" if include_qcfail else "exclude")
    both = read_policy(NS(performance={"effective": "standard"}), include_duplicates=True, include_qcfail=True)
    assert both["filters"] == {"duplicates": "include", "chimeras": "include"}


# ------------------------------------------------------------------ nucleosomes
@pytest.mark.parametrize("include_qcfail", [False, True])
def test_nucleosome_records_obey_the_toggle(chimera_state, include_qcfail):
    from services.nuc.inputs import browser_read_policy, nuc_source
    from services.nuc.live import view_records
    policy = browser_read_policy(chimera_state, include_qcfail=include_qcfail)
    names = sorted(r.qname for r in view_records(nuc_source(chimera_state, "wrap"), [(CONTIG, 0, 500)], policy))
    assert names == (["chimera", "unique"] if include_qcfail else ["unique"])


def test_nucleosome_routes_and_jobs_forward_the_toggle(chimera_state, monkeypatch):
    import services.nuc.inputs as ni
    import services.nuc.observations as obs
    from services.nuc import jobs
    seen = []
    _capture_policy(monkeypatch, ni, seen)
    for flag in (False, True):
        with pytest.raises(_Stop):
            obs.record_rows(chimera_state, "wrap", CONTIG, 0, 500, include_qcfail=flag)
    assert seen == [False, True]
    # A job's identity carries the toggle (a QC-fail run never reuses the default run's outputs).
    plan = dict(sources=[], views={}, source_regions={}, settings_hash="s", include_duplicates=False)
    assert jobs._plan_key({**plan, "include_qcfail": True}) != jobs._plan_key({**plan, "include_qcfail": False})


def test_lifted_nucleosome_rows_follow_the_policy(monkeypatch):
    import services.lift.reads as lr
    import services.nuc.observations as obs
    seen = []
    monkeypatch.setattr(lr, "lifted_reads_for_region", lambda ds, c, s, e, options: seen.append(options) or [])
    state = NS(datasets={"lift": NS()})
    source = NS(browser_id="lift", paths=())
    obs._lifted_records(state, source, CONTIG, 0, 500, None, [], {"filters": {"chimeras": "include"}})
    obs._lifted_records(state, source, CONTIG, 0, 500, None, [], {"filters": {}})
    assert [o["include_qcfail"] for o in seen] == [True, False]


# ------------------------------------------------------------------ scans
def test_scan_plans_forward_the_toggle(monkeypatch):
    import services.scan.planning as planning
    seen = []
    monkeypatch.setattr(planning, "scan_engine", lambda: None)
    monkeypatch.setattr(planning, "_dataset_inputs", lambda state, ids: [])

    def fake(state, caps=None, include_duplicates=False, include_qcfail=False):
        seen.append(include_qcfail)
        raise _Stop()
    monkeypatch.setattr(planning, "read_policy", fake)
    for flag in (False, True):
        with pytest.raises(_Stop):
            planning.build_plan(NS(), dict(datasets=[], modules=["nuc"], include_qcfail=flag))
    assert seen == [False, True]


# ------------------------------------------------------------------ feature hub
def test_hub_overlay_association_and_decoding_forward_the_toggle(chimera_state, monkeypatch):
    import services.hub.overlay as ov
    import services.hub.assoc_inputs as ai
    import services.nuc.inputs as ni
    from services.hub.assoc import normalize_request
    seen = []
    _capture_policy(monkeypatch, ni, seen)
    obs = [dict(obsId="o", label="wrap", datasetId="wrap", kind="linear")]
    locus = dict(key="l", chrom=CONTIG, start=100, end=200, anchor=150)
    for flag in (False, True):
        with pytest.raises(_Stop):
            ov.overlay(chimera_state, dict(loci=[locus], layer="regular", align="left", flank=100, observations=obs,
                                           pileMax=0, includeQcFail=flag))
    for flag in (False, True):
        with pytest.raises(_Stop):
            ai.decoded_molecules(chimera_state, ["wrap"], [(CONTIG, 0, 500)], include_qcfail=flag)
    assert seen == [False, True, False, True]
    request = dict(mode="M3", a=dict(kind="marks", typeId="nuc.seg.regular"))
    assert normalize_request({**request, "options": {"includeQcFail": True}})["options"]["includeQcFail"] is True
    assert normalize_request(request)["options"]["includeQcFail"] is False


# ------------------------------------------------------------------ Differences
@pytest.mark.parametrize("include_qcfail", [False, True])
def test_differences_records_obey_the_toggle(chimera_state, include_qcfail):
    from services.differences.projected_service import native_bundles
    from services.differences.projection import ProjectionBudget, ProjectionPolicy
    bundles, _reasons, _interrupted = native_bundles(chimera_state, "wrap", CONTIG, 0, 500, include_sequence=False,
                                                     include_duplicates=False, include_qcfail=include_qcfail,
                                                     budget=ProjectionBudget(ProjectionPolicy()))
    names = sorted({record.molecule.raw_name for records in bundles.values() for record in records})
    assert names == (["chimera", "unique"] if include_qcfail else ["unique"])


def test_differences_requests_carry_the_toggle(monkeypatch):
    from routers.differences import WorkspaceRequest
    from routers.lift import DifferenceAnalysisRequest
    import services.differences.workspace as ws
    assert WorkspaceRequest(dataset_id="d", chrom="c", start=0, end=1, target={}, include_qcfail=True).include_qcfail
    assert DifferenceAnalysisRequest(dataset_id="d", chrom="c", start=0, end=1, include_qcfail=True).include_qcfail
    seen = {}

    def fake_split(state, **kw):
        seen.update(kw)
        raise _Stop()
    monkeypatch.setattr("services.sv_endpoint.sv_split_payload", fake_split)
    monkeypatch.setattr(ws, "_workspace_revision", lambda state, ids: "r")
    dataset = NS(id="d", data_type="bam", paths=[])
    target = dict(target_id="t", revision=1, target_type="geometry", chrom="chrT", ref_start=100, ref_end=100, alt_bp=60)
    with pytest.raises(_Stop):
        ws.inspect(NS(datasets={"d": dataset}), dataset, chrom="chrT", start=0, end=1000, target=target, include_qcfail=True)
    assert seen["include_qcfail"] is True
