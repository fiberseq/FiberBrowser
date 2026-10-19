from dataclasses import replace
import multiprocessing
import threading
import time

import pytest

from services.background_work import cancel_scope
from services.insertion_consensus import align, band_width, build_consensus, consensus_with_knots, partials_to_consensus
from services.reconstruction_budget import (DEFAULT_LIMITS, RESERVATIONS, Limits, Reservations,
    ResourceResult, WorkBudget, estimate_alignment, isolated)


def test_actual_estimator_and_fail_before_allocation(monkeypatch):
    estimate = estimate_alignment(100_000, 100_000, band_width(100_000, 100_000))
    assert estimate['matrix_bytes'] == 1_548_515_485  # hand-calculated score+trace bytes
    assert estimate['reserved_bytes'] >= 2 * estimate['matrix_bytes']
    def forbidden(*a, **k):
        pytest.fail('worker/allocation must not start')
    monkeypatch.setattr(multiprocessing, 'get_context', forbidden)
    for fn in (lambda: align('A' * 100_000, 'C' * 100_000),
               lambda: build_consensus(['A' * 100_000] * 2),
               lambda: build_consensus(['A' * 11000, 'C' * 11000] * 16),  # aggregate two-round work, beyond the bounded alternative
               lambda: consensus_with_knots(['A' * 100_000], seq='A' * 100_000),
               lambda: partials_to_consensus([('A' * 100_000, 'start')], 'C' * 100_000)):
        with pytest.raises(ResourceResult) as error:
            fn()
        assert error.value.status == 'budget_exceeded'
    assert RESERVATIONS.bytes == 0


def test_aggregate_work_is_charged_across_rounds_and_reads():
    budget = WorkBudget(replace(DEFAULT_LIMITS, request_cells=1000))
    budget.pair(10, 10, 20)  # 451 cells
    budget.pair(10, 10, 20)
    with pytest.raises(ResourceResult, match='request_cells'):
        budget.pair(10, 10, 20)
    assert budget.cells == 902


def test_process_reservation_large_job_queue_and_cancelled_waiter():
    manager = Reservations(replace(DEFAULT_LIMITS, max_queued=1))
    manager.acquire(512, True, time.monotonic() + 2, lambda: None)
    cancelled = threading.Event()
    outcome = []
    def check():
        if cancelled.is_set():
            raise ResourceResult('cancelled', 'server_cancelled')
    def wait():
        try:
            manager.acquire(512, True, time.monotonic() + 2, check)
        except ResourceResult as e:
            outcome.append(e.status)
    thread = threading.Thread(target=wait)
    thread.start()
    deadline = time.monotonic() + 1
    while manager.queued == 0 and time.monotonic() < deadline:
        time.sleep(.005)
    with pytest.raises(ResourceResult, match='queue_full'):
        manager.acquire(512, True, time.monotonic() + 1, lambda: None)
    cancelled.set()
    thread.join(1)
    assert outcome == ['cancelled'] and manager.queued == 0
    manager.release(512, True)
    assert manager.bytes == manager.large == 0


def test_process_bytes_are_reserved_and_released_after_success_and_deadline():
    assert isolated('builtins', 'sum', ([1, 2, 3],), {}, lengths=[]) == 6
    with pytest.raises(ResourceResult, match='deadline'):
        isolated('time', 'sleep', (5,), {}, lengths=[], limits=replace(DEFAULT_LIMITS, deadline_s=.1))
    assert RESERVATIONS.bytes == RESERVATIONS.large == RESERVATIONS.queued == 0
    assert not multiprocessing.active_children()


def test_server_abort_kills_running_compiled_kernel_and_reclaims_reservation(tmp_path, request):
    marker = tmp_path / 'kernel-ready'
    event = threading.Event()
    outcome = []
    def work():
        with cancel_scope(event):
            try:
                isolated('reconstruction_workers', 'compiled_work', (str(marker),), {}, lengths=[])
            except ResourceResult as e:
                outcome.append(e.status)
    thread = threading.Thread(target=work)
    thread.start()
    deadline = time.monotonic() + 25
    while not marker.exists() and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(.01)
    assert marker.exists(), outcome
    started = time.monotonic()
    event.set()
    thread.join(1)
    elapsed = time.monotonic() - started
    request.node.user_properties.append(('cancellation_reclamation_ms', elapsed * 1000))
    assert not thread.is_alive() and outcome == ['cancelled']
    assert elapsed < .250
    assert RESERVATIONS.bytes == 0 and not multiprocessing.active_children()


def test_response_and_input_limits_are_explicit():
    with pytest.raises(ResourceResult, match='input_scope'):
        isolated('builtins', 'sum', ([],), {}, lengths=[1] * (DEFAULT_LIMITS.max_inputs + 1))
    with pytest.raises(ResourceResult, match='response_bytes'):
        isolated('builtins', 'str', ('A' * 1000,), {}, lengths=[1000],
                 limits=replace(DEFAULT_LIMITS, max_response_bytes=100))


def test_worker_setup_failure_releases_reserved_bytes(monkeypatch):
    def fail(*a, **k):
        raise OSError('synthetic process setup failure')
    monkeypatch.setattr(multiprocessing, 'get_context', fail)
    with pytest.raises(ResourceResult, match='worker_setup_failed'):
        isolated('builtins', 'sum', ([],), {}, lengths=[])
    assert RESERVATIONS.bytes == 0 and RESERVATIONS.large == 0
