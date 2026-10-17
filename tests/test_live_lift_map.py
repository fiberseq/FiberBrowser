"""Vendored graphlift reader (services/lift/graphlift_map.py): body identical to
graphlift v0.4's scripts/graphlift_map.py, and query parity with it."""
import hashlib
import importlib.util
import os
import random

import pytest

from services.lift import graphlift_map

GL = os.path.expanduser("~/pglift_work/pglift_20261017/native/graphlift")
V4 = os.path.join(GL, "scratch", "v4")
MARKER = "# --- end of vendoring header ---\n"


def _vendored_body():
    with open(graphlift_map.__file__, encoding="utf-8") as fh:
        text = fh.read()
    head, body = text.split(MARKER, 1)
    return head, body


def test_vendored_body_matches_recorded_hash():
    head, body = _vendored_body()
    digest = hashlib.sha256(body.encode()).hexdigest()
    assert f"body sha256: {digest}" in head


def test_vendored_body_identical_to_graphlift_checkout():
    original = os.path.join(GL, "scripts", "graphlift_map.py")
    if not os.path.exists(original):
        pytest.skip("graphlift checkout not present")
    with open(original, encoding="utf-8") as fh:
        assert fh.read() == _vendored_body()[1]


def _original_module():
    path = os.path.join(GL, "scripts", "graphlift_map.py")
    spec = importlib.util.spec_from_file_location("graphlift_map_original", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("sidecar", ["alu.MAT.chain.graphlift.json", "flip.MAT.chain.graphlift.json",
                                     "hprc.GRCh38.HG002.chain.graphlift.json"])
def test_query_parity_with_graphlift(sidecar):
    path = os.path.join(V4, sidecar)
    if not os.path.exists(path):
        pytest.skip("graphlift v4 sidecars not present")
    ours, theirs = graphlift_map.LiftMap.open(path), _original_module().LiftMap.open(path)
    rng = random.Random(7)
    targets = [t for t in ours.m["targets"] if t["name"] in ("chr1", "chr3")] or ours.m["targets"]
    for _ in range(200):
        t = rng.choice(targets)
        s = rng.randrange(0, max(1, t["size"] - 100_000))
        e = s + rng.randrange(1, 100_000)
        a = ours.target_to_source(t["name"], s, e)
        assert [tuple(p) for p in a] == [tuple(p) for p in theirs.target_to_source(t["name"], s, e)]
        for p in a[:3]:
            src = ours.m["sources"][ours.chains[p.chain]["source"]]["name"]
            assert ([tuple(x) for x in ours.source_to_target(src, p.q_start, p.q_end)]
                    == [tuple(x) for x in theirs.source_to_target(src, p.q_start, p.q_end)])
            assert ours.gap_span(src, p.q_end) == theirs.gap_span(src, p.q_end)
