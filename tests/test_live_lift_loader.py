"""Compact-read loader options for live lift (DESIGN_LIVE_LIFT.md §3.3):
aligned runs, per-call molecular spans and stable call ids, supplementary
handling, SignalWindow off, budget stops."""
import array

import pytest

from live_lift_fixtures import MAT, make_record, write_bam
from services.compact_read_loader import build_compact_reads_from_bam


def _u32(values):
    return array.array("I", values)


def _load(path, **kwargs):
    options = dict(spanning_only=False, include_lift_meta=True, infer_legacy_layers=False)
    options.update(kwargs)
    return build_compact_reads_from_bam(path, MAT, 0, 10_000, **options)


@pytest.fixture
def bam(tmp_path):
    def records(h):
        return [
            # Codex probe: two calls inside / just past a 5 bp insertion.
            make_record(h, "ins", MAT, 100, "10M5I10M", tags=[("ns", _u32([10, 11])), ("nl", _u32([5, 5]))]),
            # A call across a 60 bp deletion is split there; both parts keep its id.
            make_record(h, "del", MAT, 1000, "50M60D50M", tags=[("ns", _u32([40])), ("nl", _u32([20]))]),
            # Reverse record with MA calls (SEQ frame: no coord=molecular header).
            make_record(h, "rev", MAT, 2000, "100M", reverse=True,
                        tags=[("MA", "100;nuc+Q:1-30,51-40"), ("AQ", array.array("B", [200, 100]))]),
            # Supplementaries: soft-clipped, hard-clipped with tags, hard-clipped without tags.
            make_record(h, "supp_soft", MAT, 3000, "20S80M", flag=2048,
                        tags=[("ns", _u32([30])), ("nl", _u32([20])), ("SA", f"{MAT},5001,+,80M20S,60,0;")]),
            make_record(h, "supp_hard_tags", MAT, 3100, "20H80M", flag=2048,
                        tags=[("ns", _u32([30])), ("nl", _u32([20]))]),
            make_record(h, "supp_hard_plain", MAT, 3200, "20H80M", flag=2048),
            # Calls past the whole molecule (100 bp): the annotation scope is undecidable.
            make_record(h, "supp_hard_bad", MAT, 3300, "20H80M", flag=2048,
                        tags=[("ns", _u32([90])), ("nl", _u32([20]))]),
        ]
    return write_bam(tmp_path / "src.bam", records)


def _by_id(reads):
    return {r["id"]: r for r in reads}


def test_insertion_only_calls_keep_distinct_ids_and_spans(bam):
    r = _by_id(_load(bam))["ins"]
    calls = r["_fiberbrowser_calls"]["intervals"]
    footprints = [(iv, c) for iv, c in zip(r["intervals"], calls) if iv[2] >= 0]
    assert [c for _iv, c in footprints] == [["ns:0", 10, 15], ["ns:1", 11, 16]]
    # Both collapse onto the same reference base: only the molecular spans tell them apart.
    assert footprints[0][0][:2] == footprints[1][0][:2] == [110, 111]
    assert r["_fiberbrowser_aligned_runs"] == [[100, 0, 10], [110, 15, 10]]


def test_deletion_split_keeps_call_id_on_both_parts(bam):
    r = _by_id(_load(bam))["del"]
    calls = [c for iv, c in zip(r["intervals"], r["_fiberbrowser_calls"]["intervals"]) if iv[2] > 0]
    assert len(calls) == 2 and calls[0] == calls[1] == ["ns:0", 40, 60]
    assert [iv[:2] for iv in r["intervals"] if iv[2] > 0] == [[1040, 1050], [1110, 1120]]


def test_ma_layer_calls_reverse_record_molecular_spans(bam):
    r = _by_id(_load(bam))["rev"]
    layer = r["layers"]["nuc"]
    assert len(layer["_fiberbrowser_calls"]) == len(layer["intervals"]) == 2
    # SEQ [0, 30) and [50, 90) of a 100 bp reverse record are molecular [70, 100) and [10, 50).
    assert sorted(layer["_fiberbrowser_calls"]) == [["MA0:0", 70, 100], ["MA0:1", 10, 50]]
    assert r["_fiberbrowser_lift_record"] == {"contig": MAT, "reverse": True, "length": 100}
    assert r["_fiberbrowser_aligned_runs"] == [[2000, 99, 100]]


def test_supplementaries_only_on_request_and_hard_clips_follow_the_scope_rule(bam):
    assert "supp_soft" not in _by_id(_load(bam))
    counts = {}
    reads = _by_id(_load(bam, include_supplementary=True, lift_counts=counts))
    assert reads["supp_soft"]["_fiberbrowser_primary"] == {"is_supplementary": True, "sa": f"{MAT},5001,+,80M20S,60,0;"}
    # Stored-SEQ (partial) tags decode; an undecidable record is hidden and counted.
    assert "supp_hard_tags" in reads and "supp_hard_plain" in reads and "supp_hard_bad" not in reads
    assert counts == {"hard_clipped_supplementary": 1,
                      "hard_clipped_scoped": {"partial": 1, "whole": 0, "none": 1}}


def test_no_lift_meta_by_default(bam):
    for r in build_compact_reads_from_bam(bam, MAT, 0, 10_000, spanning_only=False):
        assert not any(k.startswith("_fiberbrowser_") and k != "_fiberbrowser_terminal_gaps" for k in r)
        for layer in (r.get("layers") or {}).values():
            assert "_fiberbrowser_calls" not in layer


def test_signal_window_off_for_lift_loads(bam, monkeypatch):
    import services.signal_windows as sw
    made = []
    original = sw.SignalWindow

    class Spy(original):
        def __init__(self, *a, **k):
            made.append(1)
            super().__init__(*a, **k)

    monkeypatch.setattr(sw, "SignalWindow", Spy)
    _load(bam)
    assert made == []
    build_compact_reads_from_bam(bam, MAT, 0, 10_000, spanning_only=False)
    assert made == [1]


class _Budget:
    def __init__(self, n):
        self.n, self.seen, self.truncated = n, 0, False

    def examine(self):
        if self.seen >= self.n:
            self.truncated = True
            return False
        self.seen += 1
        return True

    def account(self, read):
        pass


def test_load_budget_stops_the_load(bam):
    budget = _Budget(2)
    reads = _load(bam, load_budget=budget)
    assert budget.truncated and len(reads) == 2


def test_sample_bounds_map_sampled_extents(bam):
    from services.read_sampling import Sampler, sampling
    sampler = Sampler(level=10)
    with sampling(sampler):
        _load(bam, sample_bounds=lambda a, b: [(a + 100_000, b + 100_000)])
    starts = list(sampler.kept_starts) + list(sampler.skipped_starts)
    assert starts and all(s >= 100_000 for s in starts)
