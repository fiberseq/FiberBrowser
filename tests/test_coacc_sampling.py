"""Plots' Random N reads for co-accessibility: the reads in scope by the stable rule, sent as a read-ID scope."""
import json
from types import SimpleNamespace

from services import coaccessibility_endpoint as C
from services.stable_sample import sample_names


def test_sampled_scope_keeps_the_lowest_keys_per_dataset(monkeypatch):
    reads = {"d1": [{"id": f"r{i}"} for i in range(50)], "d2": [{"id": f"x{i}"} for i in range(8)]}
    scope = SimpleNamespace(query=SimpleNamespace(dataset_ids=["d1", "d2"], build_working_set=lambda state, ds: SimpleNamespace(reads=list(reversed(reads[ds])))))
    seen = {}
    monkeypatch.setattr(C, "_coacc_scope", lambda state, **k: seen.update(k) or "scoped")
    assert C.sampled_scope(None, scope, 10, 2, chrom="chrT", start=0, end=100) == "scoped"
    by = json.loads(seen["read_ids_by_dataset"])
    assert by["d1"] == sample_names([r["id"] for r in reads["d1"]], 10, 2, "d1")
    assert sorted(by["d2"]) == sorted(r["id"] for r in reads["d2"])
