"""Lifted Read Stats follows the duplicate / QC-fail toggles and min_fp_quality it reports as applied.

Native BAM Read Stats loads through the direct read policy when these are set; the lifted path used the
default analysis working set, which hides duplicate and QC-fail records, so a lifted duplicate the read
track shows (toggle on) was missing from Read Stats while the summary said duplicates were included.
"""
import array

from live_lift_fixtures import MAT, TARGET, make_record, write_bam, write_toy_sidecar
from test_live_lift_endpoints import _add, lift_env  # noqa: F401 - fixture


def _u32(values):
    return array.array("I", values)


def _records(h):
    # One low-quality footprint (nq 50): min_fp_quality=100 drops it.
    tags = [("ns", _u32([400, 2450, 3000])), ("nl", _u32([200, 200, 200])), ("nq", array.array("B", [200, 50, 200]))]
    return [
        make_record(h, "plus", MAT, 2500, "3300M", tags=tags),
        make_record(h, "dupread", MAT, 2510, "3300M", flag=0x400, tags=tags),
        make_record(h, "qcread", MAT, 2520, "3300M", flag=0x200, tags=tags),
    ]


def _stats(state, did, **kw):
    from models.requests import ReadStatsRequest
    from services.read_stats import compute_read_stats
    request = ReadStatsRequest(read_ids_by_dataset={did: ["plus", "dupread", "qcread"]}, **kw)
    return compute_read_stats(state, TARGET, 1000, 9000, False, request)


def test_lifted_read_stats_follow_the_read_policy(lift_env, tmp_path):
    client, state, _manifest, _bam = lift_env
    manifest = write_toy_sidecar(tmp_path / "policy_map")
    bam = write_bam(tmp_path / "policy.bam", _records)
    did = _add(client, manifest, bam)["dataset"]["id"]

    default = {r["read_id"] for r in _stats(state, did)["per_read"]}
    assert default == {"plus"}

    shown = _stats(state, did, include_duplicates=True, include_qcfail=True)
    assert {r["read_id"] for r in shown["per_read"]} == {"plus", "dupread", "qcread"}
    agg = shown["aggregate"]
    assert (agg["include_duplicates"], agg["include_qcfail"]) == (True, True)

    only_dup = _stats(state, did, include_duplicates=True)
    assert {r["read_id"] for r in only_dup["per_read"]} == {"plus", "dupread"}


def test_lifted_read_stats_apply_min_fp_quality(lift_env, tmp_path):
    client, state, _manifest, _bam = lift_env
    manifest = write_toy_sidecar(tmp_path / "policy_map")
    bam = write_bam(tmp_path / "policy.bam", _records)
    did = _add(client, manifest, bam)["dataset"]["id"]
    before = {r["read_id"]: r for r in _stats(state, did)["per_read"]}["plus"]
    result = _stats(state, did, min_fp_quality=100)
    after = {r["read_id"]: r for r in result["per_read"]}["plus"]
    assert result["aggregate"]["min_fp_quality"] == 100
    assert after["footprint_count"] == before["footprint_count"] - 1


def test_lifted_read_stats_same_for_a_read_with_or_without_the_toggles(lift_env, tmp_path):
    # The direct load must give a read the same statistics as the analysis working set.
    client, state, _manifest, _bam = lift_env
    manifest = write_toy_sidecar(tmp_path / "policy_map")
    bam = write_bam(tmp_path / "policy.bam", _records)
    did = _add(client, manifest, bam)["dataset"]["id"]
    plain = {r["read_id"]: r for r in _stats(state, did)["per_read"]}["plus"]
    toggled = {r["read_id"]: r for r in _stats(state, did, include_duplicates=True)["per_read"]}["plus"]
    assert plain == toggled
