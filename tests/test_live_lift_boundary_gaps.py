"""Independent raw net/block controls for gap ownership (not biological truth)."""
import gzip
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from live_lift_fixtures import MAT, TARGET, SSIZE, _chain, _gaps, write_toy_sidecar
from services.lift.dataset import LiveLiftConfig
from services.lift import differences as diff


def gap_map(tmp_path, dt=200, dq=0, strand="+", t=1100, *, split=True, claims=None):
    path = Path(write_toy_sidecar(tmp_path / "map"))
    blocks = [[t - 100, 100, 100], [t + dt, 200 + dq, 100]]
    other = [[t - 100, 1000, dt + 200]]
    manifest = json.loads(path.read_text())
    manifest["targets"][0]["size"] = max(20000, t + dt + 1000)
    manifest["chains"] = [_chain("gap", "H#1", 0, strand, blocks, SSIZE),
                          _chain("other", "H#1", 0, strand, other, SSIZE)]
    nets = ([[0, t - 100, t, 0, [1]], [0, t + dt, t + dt + 100, 0, [1]]] if split
            else [[0, t - 100, t + dt + 100, 0, [1]]])
    manifest["nets"] = {"H#1": nets if claims is None else claims}
    path.write_text(json.dumps(manifest))
    with gzip.open(path.parent / "toy.t0.chrT.json.gz", "wt") as fh:
        json.dump(dict(target=TARGET, blocks={"0": blocks, "1": other},
                       gaps={"0": _gaps(blocks, ["too_big"]), "1": []}), fh)
    return LiveLiftConfig(str(path), [])


@pytest.mark.parametrize("dt", [199, 200, 201])
@pytest.mark.parametrize("dq", [0, 1, 37])
@pytest.mark.parametrize("strand", ["+", "-"])
@pytest.mark.parametrize("split", [False, True])
def test_owned_gap_geometry_and_tiny_views(tmp_path, dt, dq, strand, split):
    config = gap_map(tmp_path, dt, dq, strand, split=split)
    kind = "replacement" if dq else "deletion"
    expected_src = (200, 200 + dq) if strand == "+" else (SSIZE - 200 - dq, SSIZE - 200)
    for a, b in [(1000, 1500), (1100, 1101), (1100 + dt // 2, 1101 + dt // 2), (1099 + dt, 1100 + dt)]:
        items = diff.assembly_items_for_region(config, TARGET, a, b)
        gap, = [i for i in items if i["kind"] == kind]
        assert (gap["t_start"], gap["t_end"], gap["ref_bp"], gap["alt_bp"]) == (1100, 1100 + dt, dt, dq)
        assert tuple(gap["src"][k] for k in ("start", "end")) == expected_src
        assert gap["reason"] == "too_big" and gap["sequence_status"] == "unresolved"
        assert not any(i["kind"] == "no_correspondence" and i["t_start"] < b and i["t_end"] > a for i in items if a >= 1100 and b <= 1100 + dt)
        if split:
            assert gap["aliases"] == [f"MAT:{TARGET}:1100-{1100 + dt}:no_correspondence"]


@pytest.mark.parametrize("claims", [
    [[0, 1000, 1100, 0, []], [0, 1300, 1400, 1, [0]]],  # different winners
    [[0, 1000, 1100, 0, []], [0, 1301, 1400, 0, []]],  # unrelated hole
    [[0, 1000, 1100, 0, []], [0, 1150, 1250, 1, []], [0, 1300, 1400, 0, []]],
    [[0, 1000, 1200, 0, []], [0, 1200, 1400, 1, [0]]],  # gap crosses a winner
    [[0, 1000, 1400, 0, []], [0, 1150, 1250, 1, []]],  # conflicting claim
    [[0, 1010, 1400, 0, []], [0, 1000, 1100, 1, []]],  # conflict at the left flank only
    [[0, 1000, 1400, 0, []], [0, 1300, 1400, 1, []]],  # conflict at the right flank only
    [[0, 1000, 1400, 1, []], [0, 1020, 1030, 1, []],
     [0, 1050, 1100, 0, []], [0, 1300, 1350, 0, []]],  # nested claims cannot hide an outer winner
])
def test_other_winners_and_holes_are_not_gap_evidence(tmp_path, claims):
    config = gap_map(tmp_path, claims=claims)
    items = diff.assembly_items_for_region(config, TARGET, 1100, 1300)
    assert not any(i["kind"] in ("deletion", "replacement") for i in items)


@pytest.mark.parametrize('strand', ['+', '-'])
@pytest.mark.parametrize('dt,dq', [(200, 0), (200, 37), (201, 1)])
def test_conflicting_gap_retains_full_unresolved_geometry_across_bins(tmp_path, strand, dt, dq):
    t = 999900
    claims = [[0, t - 100, t + dt + 100, 0, []], [0, t + 50, t + 150, 1, []]]
    config = gap_map(tmp_path, dt, dq, strand, t, claims=claims)
    left = diff.assembly_items_for_region(config, TARGET, t, t + 1)
    right = diff.assembly_items_for_region(config, TARGET, t + dt - 1, t + dt)
    unresolved = [i for i in left if i['reason'] == 'conflicting_map_ownership']
    assert len(unresolved) == 1
    item, = unresolved
    assert item in right
    assert (item['t_start'], item['t_end'], item['ref_bp'], item['alt_bp']) == (t, t + dt, dt, dq)
    assert item['ownership_status'] == 'unresolved' and item['sequence_status'] == 'unresolved'
    assert item['kind'] == 'no_correspondence' and 't' not in item
    assert item['raw_gap'] == {'chain': 0, 't': t, 'q': 200, 'dt': dt, 'dq': dq, 'reason': 'too_big'}
    assert item['competing_claims'] == [{'start': t + 50, 'end': t + 150, 'chain': 1}]
    with config.handle.lock:
        assert not diff.primary_gaps_for_region(config.handle, TARGET, 'H#1', t, t + dt)


def test_gap_crossing_cache_bin_keeps_id_and_bin_count(tmp_path):
    config = gap_map(tmp_path, 201, 1, t=999900)
    left = diff.assembly_items_for_region(config, TARGET, 999999, 1000000)
    right = diff.assembly_items_for_region(config, TARGET, 1000000, 1000001)
    assert left == right and len(left) == 1
    ds = SimpleNamespace(id="toy", live_lift=config)
    payload = diff.differences_for_region(SimpleNamespace(fasta=None), ds, TARGET, 999800, 1000200, detail_bp=1)
    assert sum(b["count"] for b in payload["bins"] if b["kind"] == "replacement") == 1


@pytest.mark.parametrize("dt,dq", [(200, 0), (0, 80)])
@pytest.mark.parametrize("edge", ["left", "right"])
def test_net_switch_edge_requires_both_winning_flanks(tmp_path, dt, dq, edge):
    claims = ([[0, 1000, 1100, 1, []], [0, 1100, 1400 + dt, 0, []]] if edge == "left" else
              [[0, 1000, 1100 + dt, 0, []], [0, 1100 + dt, 1400 + dt, 1, []]])
    config = gap_map(tmp_path, dt, dq, claims=claims)
    with config.handle.lock:
        assert diff.primary_gap_records(config.handle, TARGET, "H#1") == []


def test_bin_scan_bounds_inferred_work_and_reuses_gap_index(tmp_path, monkeypatch):
    config = gap_map(tmp_path, t=999900, split=False)
    handle = config.handle
    original = handle.map.inferred_runs
    calls = []
    def inferred(ci, a, b):
        calls.append((a, b))
        assert 0 <= a < b <= 1000000
        return original(ci, a, b)
    monkeypatch.setattr(handle.map, "inferred_runs", inferred)
    diff._bin_items(config, TARGET, 0, "H#1")
    assert calls
    with handle.lock:
        first = diff.primary_gap_records(handle, TARGET, "H#1")
        def unexpected(_ci):
            pytest.fail("warm ownership lookup rescanned chain payload")
        monkeypatch.setattr(handle.map, "chain_data", unexpected)
        assert diff.primary_gap_records(handle, TARGET, "H#1") is first


def test_real_owned_boundary_gaps():
    """Optional local cohort; expected spans come directly from raw nets/gaps."""
    manifest = os.environ.get("FIBERBROWSER_TEST_LIFT_MAP")
    if not manifest:
        pytest.skip("Set FIBERBROWSER_TEST_LIFT_MAP for the regional gap regression")
    config = LiveLiftConfig(manifest, [])
    for chrom, start, end, count in [("chr6", 30999999, 31500000, 12), ("chr1", 19499999, 24000000, 4)]:
        expected = []
        handle = config.handle
        for hap in config.haplotypes:
            nets = handle.map.nets.get((hap, handle.map.targets[chrom]), [])
            for left, right in zip(nets, nets[1:]):
                if left[2] != right[2] or not start <= left[1] < right[0] <= end:
                    continue
                for t, q, dt, dq, reason in handle.map.chain_data(left[2])["gaps"]:
                    if (t, t + dt) == (left[1], right[0]):
                        expected.append((hap, left[2], t, t + dt, dt, dq, handle.map.reasons[reason]))
        assert len(expected) == count
        items = diff.assembly_items_for_region(config, chrom, start, end)
        actual = {(i["hap"], i["chain"], i["t_start"], i["t_end"], i["ref_bp"], i["alt_bp"], i["reason"])
                  for i in items if i["kind"] in ("deletion", "replacement")}
        assert set(expected) <= actual
        assert not any(i["kind"] == "no_correspondence" for i in items)
