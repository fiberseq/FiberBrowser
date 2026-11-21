"""A load that stops early (a budget, a cancellation) closes its record
iterators in its own thread, so the file's reader lock is released there
(services/file_handles.py). Left to the garbage collector, another thread
failed to release it and the file stayed locked for every later reader."""
import array
import threading

import pytest

from live_lift_fixtures import MAT, make_record, write_bam
from services.lift import live_lift as ll


def _records(h):
    u32 = lambda v: array.array("I", v)  # noqa: E731
    return [make_record(h, f"r{i}", MAT, 100 + 50 * i, "500M", tags=[("ns", u32([10, 200, 300])), ("nl", u32([50, 50, 50]))])
            for i in range(20)]


@pytest.mark.parametrize("stop", ["budget", "error"])
def test_early_stop_closes_the_record_iterators(tmp_path, monkeypatch, stop):
    import services.read_edge_cache as edge
    from services.compact_read_loader import build_compact_reads_from_bam
    bam = write_bam(tmp_path / "s.bam", _records)
    closed = []
    real = edge.iter_edge_records

    def tracked(*args, **kwargs):
        try:
            yield from real(*args, **kwargs)
        finally:
            closed.append(threading.get_ident())

    monkeypatch.setattr(edge, "iter_edge_records", tracked)
    budget = ll.LoadBudget(max_records=2)
    kwargs = dict(include_lift_meta=True, spanning_only=False, load_budget=budget if stop == "budget" else None,
                  fetch_regions=[(0, 5000)])
    if stop == "error":
        calls = {"n": 0}

        def failing(read):
            calls["n"] += 1
            if calls["n"] == 3:
                raise RuntimeError("stop here")
            return False
        import services.graph_lift as graph_lift
        monkeypatch.setattr(graph_lift, "lift_hidden_predicate", lambda header: failing)
        # The traceback (kept here, as a logger or a background job keeps it) holds the loader's frame.
        with pytest.raises(RuntimeError) as kept_traceback:
            build_compact_reads_from_bam(bam, MAT, 0, 5000, **kwargs)
        assert kept_traceback.value
    else:
        reads = build_compact_reads_from_bam(bam, MAT, 0, 5000, **kwargs)
        assert budget.truncated and len(reads) == 2
    assert closed == [threading.get_ident()]
    # Another thread can read the file at once.
    from services.bam_handles import get_bam_handle
    out = []
    t = threading.Thread(target=lambda: out.append(sum(1 for _ in get_bam_handle(bam).fetch(MAT, 0, 5000))))
    t.start()
    t.join(5)
    assert out == [20]
