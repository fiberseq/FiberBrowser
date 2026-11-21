"""First paint for deep read views (services/first_paint.py).

A cold compact_all with ``first_paint=true`` decodes only the reads the display
draws and says it is partial; ``background=true`` then builds the full set on
the background pool. These check that the first paint draws exactly the reads
(and rows, in the same order) that the full set draws, that nothing partial is
ever cached as a view's reads, that cached views and ineligible modes answer in
full, and that the full-set job is shared, joined and cancelled as it should be.
"""
from __future__ import annotations

import json
import threading
import time
from types import SimpleNamespace

import pytest

from services import background_work as bw
from services import first_paint as FP


@pytest.fixture(scope="module")
def bam(tmp_path_factory):
    from insertion_fixtures import make_insertion_bam
    return make_insertion_bam(tmp_path_factory.mktemp("first_paint"))


@pytest.fixture
def dataset(client, bam, monkeypatch):
    # Decode a handful more than drawn (the defaults would decode this small BAM whole).
    monkeypatch.setattr(FP, "MIN_MARGIN", 1)
    monkeypatch.setattr(FP, "MARGIN_FRACTION", 0.0)
    monkeypatch.setattr(FP, "MIN_DEPTH_FACTOR", 1.5)
    # (this small BAM's ties would otherwise reach the full-decode share: tests of partial answers keep them partial)
    monkeypatch.setattr(FP, "FULL_DECODE_FRACTION", 1.0)
    import server as srv
    # The full set decodes in this process (no worker pool in tests).
    monkeypatch.setitem(srv.state.performance, "decode_workers", 1)
    resp = client.post("/api/datasets/add", json={"path": bam["bam"], "label": "first paint"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    ds = resp.json()["dataset"]
    srv.state.clear_cache()
    yield ds
    client.delete(f"/api/datasets/{ds['id']}")
    srv.state.clear_cache()


def _compact_all(client, ds, start, end, max_reads, **extra):
    params = {"chrom": "chrT", "start": start, "end": end, "dataset_ids": ds["id"], "max_reads": max_reads,
              "include_layers": "true", "layer_names": "nuc,tf", "coverage_sample": "true",
              "include_metaprofile": "false", "min_footprints": 0, **extra}
    resp = client.get("/api/reads/compact_all", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()["datasets"][ds["id"]]


def _rows(payload):
    return json.dumps(payload["reads"], sort_keys=True)


def _without_flags(payload):
    return {k: v for k, v in payload.items() if k not in ("server_timings", "server_elapsed_ms", "first_paint")}


@pytest.fixture
def no_held_full_set(monkeypatch):
    """The first-paint request starts no full set (tests of the first response alone)."""
    from routers import reads
    started = []
    monkeypatch.setattr(reads, "start_held", lambda *a, **k: started.append(a) or SimpleNamespace(release=lambda: None))
    return started


@pytest.mark.parametrize("window,max_reads", [((-3000, 3000), 6), ((-4500, 1500), 10), ((-1000, 5000), 4),
                                               ((-6000, 6000), 12)])
def test_the_first_paint_draws_the_full_sets_reads_rows_and_order(client, dataset, no_held_full_set, window, max_reads):
    import server as srv
    from insertion_fixtures import SITE
    start, end = SITE + window[0], SITE + window[1]
    first = _compact_all(client, dataset, start, end, max_reads, first_paint="true")
    info = first["first_paint"]
    assert info["partial"] is True and info["shown"] == len(first["reads"]) == max_reads
    assert info["decoded"] < info["total_estimate"]
    # What is computed over every read waits for the full set.
    assert "sv_summary" not in first and first["metaprofile"] is None
    assert no_held_full_set, "a partial first paint starts the full set"
    full = _compact_all(client, dataset, start, end, max_reads, background="true")
    assert "first_paint" not in full
    assert _rows(first) == _rows(full)
    # The full set is the plain request's payload, field for field.
    srv.state.clear_cache()
    plain = _compact_all(client, dataset, start, end, max_reads)
    assert _without_flags(full) == _without_flags(plain)


def test_drawn_reads_decoded_on_worker_processes_are_the_same(client, dataset, no_held_full_set, monkeypatch):
    import server as srv
    from insertion_fixtures import SITE
    from services import parallel_reads
    monkeypatch.setitem(srv.state.performance, "decode_workers", 4)
    monkeypatch.setenv("FIBERBROWSER_FIRST_PAINT_WORKERS", "2")
    pools = []
    original = parallel_reads.parallel_bam_reads
    monkeypatch.setattr(parallel_reads, "parallel_bam_reads",
                        lambda *a, **k: pools.append((a[5], k.get("capacity"), "_only_ids" in a[4])) or original(*a, **k))
    start, end = SITE - 3000, SITE + 3000
    first = _compact_all(client, dataset, start, end, 6, first_paint="true")
    assert "first_paint" in first
    assert pools and all(p == (2, 4, True) for p in pools)
    srv.state.clear_cache()
    monkeypatch.setitem(srv.state.performance, "decode_workers", 1)
    plain = _compact_all(client, dataset, start, end, 6)
    assert _rows(first) == _rows(plain)


def test_ties_at_the_cutoff_are_decoded_until_none_can_enter(client, dataset, no_held_full_set):
    import server as srv
    from insertion_fixtures import SITE
    # A narrow window inside every read: most reads cover all of it (the same coverage).
    start, end = SITE - 400, SITE + 400
    first = _compact_all(client, dataset, start, end, 5, first_paint="true")
    srv.state.clear_cache()
    plain = _compact_all(client, dataset, start, end, 5)
    if "first_paint" in first:
        assert first["first_paint"]["rounds"] >= 1
    assert _rows(first) == _rows(plain)


def test_a_view_whose_ties_need_every_read_is_decoded_once_in_full(client, dataset, no_held_full_set, monkeypatch):
    """Ties at the cutoff that would decode (nearly) every read in view (more reads span a narrow view than are
    drawn): the view is decoded once, as a plain request, with no partial answer and no background full set."""
    import server as srv
    from insertion_fixtures import SITE
    monkeypatch.setattr(FP, "FULL_DECODE_FRACTION", 0.75)
    plans = []
    original = FP.plan_first_paint
    monkeypatch.setattr(FP, "plan_first_paint", lambda *a, **k: plans.append(original(*a, **k)) or plans[-1])
    start, end = SITE - 100, SITE + 100
    first = _compact_all(client, dataset, start, end, 2, first_paint="true")
    assert plans == [None] and "first_paint" not in first and not no_held_full_set
    srv.state.clear_cache()
    plain = _compact_all(client, dataset, start, end, 2)
    assert _rows(first) == _rows(plain)


def test_a_plan_that_decodes_every_read_is_complete_and_starts_no_full_set():
    plan = FP.FirstPaintSet(working_set=None, total_overlapping=3, total_spanning=3, decoded_names=3, rounds=1,
                            complete=True)
    assert plan.info(3)["partial"] is False


def test_a_pinned_read_below_the_cutoff_is_drawn_on_both_paths(client, dataset, no_held_full_set):
    import server as srv
    from insertion_fixtures import SITE
    start, end = SITE - 3000, SITE + 3000
    srv.state.clear_cache()
    everything = _compact_all(client, dataset, start, end, 1000)
    shown = {r["id"] for r in _compact_all(client, dataset, start, end, 6)["reads"]}
    outside = next(r["id"] for r in everything["reads"] if r["id"] not in shown)
    srv.state.clear_cache()
    first = _compact_all(client, dataset, start, end, 6, first_paint="true", pin_ids=outside)
    assert "first_paint" in first and outside in {r["id"] for r in first["reads"]}
    srv.state.clear_cache()
    plain = _compact_all(client, dataset, start, end, 6, pin_ids=outside)
    assert _rows(first) == _rows(plain)


def test_the_first_paint_caches_nothing_as_the_views_reads(client, dataset, no_held_full_set):
    import server as srv
    from insertion_fixtures import SITE
    from services.analysis_query import AnalysisReadQuery
    start, end = SITE - 3000, SITE + 3000
    first = _compact_all(client, dataset, start, end, 6, first_paint="true")
    assert "first_paint" in first
    query = AnalysisReadQuery.from_request(srv.state, capability="compact_all", chrom="chrT", start=start, end=end,
                                           dataset_id=dataset["id"], dataset_ids=None, spanning=False,
                                           sample_seed=None, min_footprints=0, include_methylation=False,
                                           include_layers=True, requested_layers=("nuc", "tf"),
                                           include_layer_qualities=True, infer_legacy_layers=True,
                                           legacy_nuc_min_size=90)
    assert not FP.view_is_cached(srv.state, query, dataset["id"], include_layers=True, requested_layers=("nuc", "tf"),
                                 include_layer_qualities=True)
    # Asked again, it is still a first paint (nothing partial answers as the full set).
    again = _compact_all(client, dataset, start, end, 6, first_paint="true")
    assert "first_paint" in again
    full = _compact_all(client, dataset, start, end, 6)
    assert full["working_count"] > len(first["reads"])


def test_a_cached_view_answers_in_full(client, dataset, no_held_full_set):
    from insertion_fixtures import SITE
    start, end = SITE - 3000, SITE + 3000
    full = _compact_all(client, dataset, start, end, 6)
    first = _compact_all(client, dataset, start, end, 6, first_paint="true")
    assert "first_paint" not in first
    assert _without_flags(first) == _without_flags(full)
    assert not no_held_full_set


@pytest.mark.parametrize("extra", [{"max_reads": 0}, {"spanning": "true"}, {"coverage_sample": "false"},
                                   {"downsample": 4}])
def test_modes_without_a_first_paint_answer_in_full(client, dataset, no_held_full_set, extra):
    from insertion_fixtures import SITE
    params = {"max_reads": 6, **extra}
    max_reads = params.pop("max_reads")
    payload = _compact_all(client, dataset, SITE - 3000, SITE + 3000, max_reads, first_paint="true", **params)
    assert "first_paint" not in payload
    assert not no_held_full_set


def test_the_first_paint_starts_the_full_set_that_the_background_request_joins(client, dataset, monkeypatch):
    from routers import reads
    from insertion_fixtures import SITE
    monkeypatch.setattr(reads, "FIRST_PAINT_HOLD_S", 30.0)
    started_before = bw.stats["started"]
    shared_before = bw.stats["shared"]
    start, end = SITE - 3000, SITE + 3000
    first = _compact_all(client, dataset, start, end, 6, first_paint="true")
    assert "first_paint" in first
    assert bw.stats["started"] == started_before + 1
    full = _compact_all(client, dataset, start, end, 6, background="true")
    # Joined (still running) or, if it had finished, rebuilt from the caches it filled.
    assert bw.stats["shared"] == shared_before + 1 or bw.stats["started"] == started_before + 2
    assert _rows(first) == _rows(full) and "first_paint" not in full
    assert not bw._holds


# ---------------------------------------------------------------------------
# Eligibility, per mode


def _state(**performance):
    return SimpleNamespace(performance=performance, max_working_reads=0, chrom_map={}, datasets={})


@pytest.mark.parametrize("dataset_attrs,state_kw,options,reason", [
    (dict(data_type="bigbed"), {}, {}, "not a BAM dataset"),
    (dict(paths=["s3://bucket/x.bam"]), {}, {}, "remote source"),
    (dict(), {"effective": "low"}, {}, "low memory"),
    (dict(), {}, dict(direct=True), "direct read load"),
    (dict(), {}, dict(max_reads=0), "every read requested"),
    (dict(), {}, dict(downsample=5), "random downsample"),
    (dict(), {}, dict(spanning=True), "not a coverage sample"),
    (dict(molecule_groups=[["a", "b"]]), {}, {}, "molecule groups"),
    # a contig only the dataset's BAM header marks circular (@SQ TP:circular)
    (dict(circular_contigs={"chrT": 5000}), {}, {}, "circular contig"),
])
def test_modes_that_never_answer_partially(monkeypatch, dataset_attrs, state_kw, options, reason):
    ds = SimpleNamespace(id="d", data_type="bam", paths=["/tmp/x.bam"], molecule_groups=[], live_lift=None)
    for k, v in dataset_attrs.items():
        setattr(ds, k, v)
    monkeypatch.setattr("services.lift.capability.is_lifted", lambda dataset: False)
    kwargs = dict(chrom="chrT", start=0, end=1000, spanning=False, max_reads=10, downsample=None,
                  coverage_sample=True, direct=False)
    kwargs.update(options)
    assert FP.ineligible_reason(_state(**state_kw), ds, **kwargs) == reason


def test_a_live_lift_dataset_never_answers_partially(monkeypatch):
    ds = SimpleNamespace(id="d", data_type="bam", paths=["/tmp/x.bam"], molecule_groups=[])
    monkeypatch.setattr("services.lift.capability.is_lifted", lambda dataset: True)
    assert FP.ineligible_reason(_state(), ds, chrom="chrT", start=0, end=1000, spanning=False, max_reads=10,
                                downsample=None, coverage_sample=True, direct=False) == "live lift"


def test_the_bound_is_the_alignments_share_of_the_view():
    assert FP._bound([100, 900, 0], 0, 1000) == 800
    assert FP._bound([-50, 2000, 0], 0, 1000) == 1000
    assert FP._bound([1200, 1300, 0], 0, 1000) == 0


# ---------------------------------------------------------------------------
# Held background jobs (services/background_work.py)


def _wait(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_a_held_job_runs_and_a_joining_request_shares_it():
    import asyncio
    calls = []
    gate = threading.Event()

    def work():
        calls.append(1)
        gate.wait(5)
        return "full set"

    key = ("test-held", time.monotonic())
    hold = bw.start_held(key, work, wait_for_reads=False)
    assert _wait(lambda: calls)

    async def join():
        task = asyncio.ensure_future(bw.run_background(None, key, work, wait_for_reads=False))
        await asyncio.sleep(0.05)
        assert not bw._holds.get(key), "the joining request took the hold over"
        gate.set()
        return await task

    assert asyncio.run(join()) == "full set"
    assert calls == [1]
    hold.release()  # releasing a taken-over hold is harmless


def test_a_held_job_that_finished_before_its_request_came_is_joined_not_run_again():
    import asyncio
    calls = []

    def work():
        calls.append(1)
        return "full set"

    key = ("test-held-done", time.monotonic())
    hold = bw.start_held(key, work, wait_for_reads=False)
    assert _wait(lambda: hold.flight.future.done())
    assert asyncio.run(bw.run_background(None, key, work, wait_for_reads=False)) == "full set"
    assert calls == [1] and key not in bw._flights and not bw._holds.get(key)
    # a held job nobody comes for leaves nothing behind once its hold is released
    other = ("test-held-done-2", time.monotonic())
    h2 = bw.start_held(other, work, wait_for_reads=False)
    assert _wait(lambda: h2.flight.future.done())
    assert other in bw._flights
    h2.release()
    assert other not in bw._flights


def test_a_held_job_nobody_joins_is_cancelled_when_its_hold_lapses():
    started = threading.Event()
    stopped = []

    def work():
        started.set()
        try:
            while True:
                bw.checkpoint()
                time.sleep(0.01)
        except bw.Cancelled:
            stopped.append(1)
            raise

    key = ("test-lapse", time.monotonic())
    hold = bw.start_held(key, work, wait_for_reads=False)
    assert started.wait(5)
    hold.release()
    assert _wait(lambda: stopped)
    assert not bw.in_flight(key)


# ---------------------------------------------------------------------------
# Decode pools sharing a capacity (services/parallel_reads.py)


def test_pools_naming_a_capacity_run_side_by_side_and_exclusive_ones_wait():
    from services import parallel_reads as PR
    PR._enter_pool(4, 8)
    PR._enter_pool(4, 8)  # a second dataset's pool fits beside the first
    assert PR._pool_workers == 8
    entered = threading.Event()
    t = threading.Thread(target=lambda: (PR._enter_pool(2, None), entered.set()))
    t.start()
    assert not entered.wait(0.2), "an exclusive pool waits for the shared ones"
    PR._leave_pool(4, 8)
    PR._leave_pool(4, 8)
    assert entered.wait(5)
    PR._leave_pool(2, None)
    t.join()
    assert PR._pool_workers == 0 and not PR._exclusive


def test_a_full_set_whose_client_went_lingers_for_a_client_asking_again():
    import asyncio
    started = threading.Event()
    stopped = []
    gate = threading.Event()

    def work():
        started.set()
        try:
            while not gate.is_set():
                bw.checkpoint()
                time.sleep(0.01)
            return "full set"
        except bw.Cancelled:
            stopped.append(1)
            raise

    key = ("test-linger", time.monotonic())
    hold = bw.start_held(key, work, wait_for_reads=False)
    assert started.wait(5)
    with bw._flights_lock:
        flight = bw._flights[key]
    bw._linger(key, flight, 0.5)   # the client went: the job stays for 0.5 s
    hold.release()
    time.sleep(0.2)
    assert not stopped and bw.in_flight(key)

    async def again():
        task = asyncio.ensure_future(bw.run_background(None, key, work, wait_for_reads=False))
        await asyncio.sleep(0.05)
        gate.set()
        return await task

    assert asyncio.run(again()) == "full set"
    assert not stopped
    # Without a client asking again, a lingering job stops when its time is up.
    key2 = ("test-linger-2", time.monotonic())
    gate.clear(); started.clear()
    hold2 = bw.start_held(key2, work, wait_for_reads=False)
    assert started.wait(5)
    with bw._flights_lock:
        flight2 = bw._flights[key2]
    bw._linger(key2, flight2, 0.2)
    hold2.release()
    assert _wait(lambda: stopped)


# ---------------------------------------------------------------------------
# A request that left before its worker reached the full set (round-2 audit)


def test_a_finished_held_job_does_not_hold_back_speculative_fills():
    """yield_to_foreground waits for work in progress, not for a finished job kept joinable for its hold."""
    key = ("test-held-finished-yield", time.monotonic())
    hold = bw.start_held(key, lambda: "full set", wait_for_reads=False)
    try:
        assert _wait(lambda: hold.flight.future.done())
        assert key in bw._flights
        done = threading.Event()
        threading.Thread(target=lambda: (bw.yield_to_foreground(), done.set()), daemon=True).start()
        assert done.wait(2.0), "a finished held job blocked yield_to_foreground"
    finally:
        hold.release()
    assert key not in bw._flights


def test_a_full_set_reached_after_the_request_failed_is_never_started(client, bam, monkeypatch):
    """One dataset of a two-dataset first paint fails; the other's worker reaches its full set after the request
    has answered. It must not start a held job nobody will release (it kept the finished flight registered for
    ever, so every speculative fill waited behind it)."""
    import server as srv
    from routers import reads
    from insertion_fixtures import SITE
    monkeypatch.setitem(srv.state.performance, "decode_workers", 1)
    ids = []
    for label in ("first paint A", "first paint B"):
        resp = client.post("/api/datasets/add", json={"path": bam["bam"], "label": label})
        assert resp.status_code == 200 and resp.json()["success"], resp.text
        ids.append(resp.json()["dataset"]["id"])
    srv.state.clear_cache()
    started, failed = [], threading.Event()
    monkeypatch.setattr(FP, "ineligible_reason", lambda *a, **k: None)
    monkeypatch.setattr(FP, "view_is_cached", lambda *a, **k: False)

    def plan(state, query, dataset_id, *, on_partial=None, **kw):
        if dataset_id == ids[0]:
            failed.set()
            raise RuntimeError("sibling dataset failed")
        failed.wait(5)
        time.sleep(0.5)          # the request has answered with the error by now
        on_partial()
        return None

    monkeypatch.setattr(FP, "plan_first_paint", plan)
    monkeypatch.setattr(reads, "start_held", lambda *a, **k: started.append(a) or SimpleNamespace(release=lambda: None))
    try:
        with pytest.raises(RuntimeError):
            client.get("/api/reads/compact_all", params={
                "chrom": "chrT", "start": SITE - 3000, "end": SITE + 3000, "dataset_ids": ",".join(ids),
                "max_reads": 6, "include_layers": "true", "layer_names": "nuc,tf", "coverage_sample": "true",
                "include_metaprofile": "false", "min_footprints": 0, "first_paint": "true"})
        time.sleep(1.0)
        assert not started, "a held full set was started after its request had left"
    finally:
        for d in ids:
            client.delete(f"/api/datasets/{d}")
        srv.state.clear_cache()
